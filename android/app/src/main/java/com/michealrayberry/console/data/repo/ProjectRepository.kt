package com.michealrayberry.console.data.repo

import android.os.SystemClock
import com.michealrayberry.console.data.local.UploadState
import com.michealrayberry.console.data.local.dao.PendingEvidenceDao
import com.michealrayberry.console.data.local.dao.RequirementCacheDao
import com.michealrayberry.console.data.local.entity.CachedDayEntity
import com.michealrayberry.console.data.local.entity.CachedRequirementEntity
import com.michealrayberry.console.data.local.entity.PendingEvidenceEntity
import com.michealrayberry.console.data.prefs.AppPreferences
import com.michealrayberry.console.data.remote.ApiService
import com.michealrayberry.console.data.remote.dto.ExternalLinkRequest
import com.michealrayberry.console.data.remote.dto.NoticeDto
import com.michealrayberry.console.data.remote.dto.WeightRequest
import com.michealrayberry.console.domain.EvidenceType
import com.michealrayberry.console.domain.LocalUpload
import com.michealrayberry.console.domain.RecordingContext
import com.michealrayberry.console.domain.Requirement
import com.michealrayberry.console.domain.Timeliness
import com.michealrayberry.console.domain.TodaySnapshot
import com.michealrayberry.console.work.UploadEnqueuer
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single mediator between the network, the offline cache, and the durable
 * upload queue. ViewModels depend only on this — never on Retrofit or Room
 * directly — which keeps the unidirectional data flow honest.
 *
 * Core rules enforced here:
 *  - The Today snapshot exposed to the UI is a *cached projection of server
 *    state*, layered with local upload progress. Server fields are never
 *    optimistically edited to fake a submission.
 *  - Captured evidence is registered with the server through the durable
 *    WorkManager queue ([saveRecordedLocally] then [confirmAndUpload]); only a
 *    successful server registration (which returns the trusted receipt time)
 *    advances a requirement to SUBMITTED.
 */
@Singleton
class ProjectRepository @Inject constructor(
    private val api: ApiService,
    private val requirementCacheDao: RequirementCacheDao,
    private val pendingEvidenceDao: PendingEvidenceDao,
    private val prefs: AppPreferences,
    private val uploadEnqueuer: UploadEnqueuer,
) {

    /**
     * Reactive Today snapshot. Combines the cached day header, cached
     * requirements, and the local upload queue so the UI updates instantly when
     * an upload progresses — all offline-safe.
     */
    @Suppress("OPT_IN_USAGE")
    fun observeToday(): Flow<TodaySnapshot?> =
        requirementCacheDao.observeLatestDay().flatMapLatest { day ->
            if (day == null) {
                flowOf(null)
            } else {
                combine(
                    requirementCacheDao.observeRequirements(day.localDate),
                    pendingEvidenceDao.observeAll(),
                ) { requirements, pending ->
                    val byRequirement = pending
                        .groupBy { it.requirementInstanceId }
                        .mapValues { (_, items) -> items.maxByOrNull { it.updatedAt } }
                    TodaySnapshot(
                        localDate = day.localDate,
                        dayNumber = day.dayNumber,
                        timeZone = day.timeZone,
                        overallStatus = day.overallStatus,
                        dayDeadline = day.dayDeadline,
                        serverTimeAtSync = day.serverTimeAtSync,
                        deviceElapsedRealtimeAtSync = day.deviceElapsedRealtimeAtSync,
                        requirements = requirements.map { req ->
                            req.toDomain(byRequirement[req.id])
                        },
                    )
                }
            }
        }

    /**
     * Fetch /today from the server and replace the offline cache atomically.
     *
     * We capture [SystemClock.elapsedRealtime] at the same moment we receive
     * the server time. The pair is the anchor for an offline countdown that
     * cannot be tampered with by changing the device wall clock — but which is
     * still display-only; the server has final say on timeliness at submission.
     */
    suspend fun refreshToday(): Result<Unit> = runCatching {
        val elapsedAtRequest = SystemClock.elapsedRealtime()
        val today = api.today()

        val dayEntity = CachedDayEntity(
            localDate = today.localDate,
            projectDayId = today.day.id,
            dayNumber = today.dayNumber,
            timeZone = today.timeZone,
            overallStatus = today.overallStatus,
            dayDeadline = today.dayDeadline,
            serverTimeAtSync = today.serverTime,
            deviceElapsedRealtimeAtSync = elapsedAtRequest,
        )
        val requirementEntities = today.requirements.map {
            CachedRequirementEntity(
                id = it.id,
                localDate = today.localDate,
                requirementCode = it.requirementCode,
                name = it.name,
                evidenceType = it.evidenceType,
                status = it.status,
                deadlineAt = it.deadlineAt,
                grace = it.grace,
                timeliness = it.timeliness,
            )
        }
        requirementCacheDao.replaceSnapshot(dayEntity, requirementEntities)
        prefs.setLastSyncedLocalDate(today.localDate)
    }

    /**
     * Resolve the guided-recording context for a requirement by reading a fresh
     * /today snapshot (the only endpoint that carries the recording template).
     * Uses no invented endpoints.
     */
    suspend fun recordingContext(requirementId: String): Result<RecordingContext> = runCatching {
        val today = api.today()
        val requirement = today.requirements.firstOrNull { it.id == requirementId }
            ?: error("requirement $requirementId not found for today")
        RecordingContext(
            requirementId = requirement.id,
            requirementName = requirement.name,
            projectDayId = today.day.id,
            localDate = today.localDate,
            dayNumber = today.dayNumber,
            scriptVersion = today.recordingTemplate.scriptVersion,
            requiredVariables = today.recordingTemplate.requiredVariables,
            steps = today.recordingTemplate.steps,
        )
    }

    suspend fun pendingById(id: String): PendingEvidenceEntity? = pendingEvidenceDao.byId(id)

    /** Reactive view of the whole durable upload queue for the History screen. */
    fun observeUploadQueue(): Flow<List<PendingEvidenceEntity>> = pendingEvidenceDao.observeAll()

    /**
     * Persist a freshly captured evidence file as RECORDED_LOCALLY. This is
     * explicitly NOT a submission and NOT yet queued — the participant must
     * accept the take in review first. The original file is preserved with its
     * SHA-256 already computed.
     */
    suspend fun saveRecordedLocally(item: PendingEvidenceEntity) {
        pendingEvidenceDao.upsert(item.copy(state = UploadState.RECORDED_LOCALLY))
    }

    /**
     * Accept a reviewed take: move it to QUEUED and schedule the durable,
     * resumable upload. The requirement still does NOT become SUBMITTED here —
     * only once [com.michealrayberry.console.work.ResumableUploadWorker]
     * registers the evidence and records the trusted server receipt time.
     */
    suspend fun confirmAndUpload(pendingId: String) {
        pendingEvidenceDao.setState(pendingId, UploadState.QUEUED)
        uploadEnqueuer.enqueue(pendingId)
    }

    /**
     * Discard an un-accepted local take (the "re-record" path). Only deletes a
     * take that was never queued/uploaded; a submitted original is never
     * removed here.
     */
    suspend fun discardPending(pendingId: String) {
        val row = pendingEvidenceDao.byId(pendingId) ?: return
        if (row.state == UploadState.RECORDED_LOCALLY || row.state == UploadState.FAILED) {
            runCatching { java.io.File(row.localFilePath).delete() }
            pendingEvidenceDao.deleteById(pendingId)
        }
    }

    /** Structured weight entry (not a video). */
    suspend fun submitWeight(
        projectDayId: String,
        weight: Double,
        unit: String,
        requirementInstanceId: String?,
    ): Result<Unit> = runCatching {
        api.submitWeight(
            WeightRequest(
                projectDayId = projectDayId,
                weight = weight,
                unit = unit,
                requirementInstanceId = requirementInstanceId,
            ),
        )
        refreshToday()
        Unit
    }

    suspend fun submitExternalLink(
        requirementInstanceId: String,
        platform: String,
        url: String,
    ): Result<Unit> = runCatching {
        api.submitExternalLink(
            ExternalLinkRequest(requirementInstanceId, platform, url),
        )
        refreshToday()
        Unit
    }

    suspend fun notices(): Result<List<NoticeDto>> = runCatching { api.notices() }

    suspend fun acknowledgeNotice(id: String): Result<Unit> = runCatching {
        api.acknowledgeNotice(id); Unit
    }

    suspend fun acknowledgeViolation(id: String): Result<Unit> = runCatching {
        api.acknowledgeViolation(id); Unit
    }
}

/** Map a cached requirement + its latest local capture to the UI domain model. */
private fun CachedRequirementEntity.toDomain(latestUpload: PendingEvidenceEntity?): Requirement =
    Requirement(
        id = id,
        code = requirementCode,
        name = name,
        evidenceType = EvidenceType.from(evidenceType),
        status = status,
        deadlineAt = deadlineAt,
        timeliness = Timeliness.from(timeliness),
        localUpload = latestUpload?.let {
            LocalUpload(
                pendingEvidenceId = it.id,
                state = it.state,
                bytesUploaded = it.bytesUploaded,
                sizeBytes = it.sizeBytes,
                serverReceivedAt = it.serverReceivedAt,
            )
        },
    )
