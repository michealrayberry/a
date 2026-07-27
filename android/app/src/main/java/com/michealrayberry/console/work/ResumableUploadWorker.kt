package com.michealrayberry.console.work

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.michealrayberry.console.R
import com.michealrayberry.console.data.local.UploadState
import com.michealrayberry.console.data.local.dao.PendingEvidenceDao
import com.michealrayberry.console.data.remote.ApiService
import com.michealrayberry.console.data.remote.dto.EvidenceRequest
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.io.File

/**
 * Durable, resumable evidence upload.
 *
 * Lifecycle for one pending-evidence row:
 *  1. Load the row and its preserved original file.
 *  2. Verify the stored SHA-256 against the file on disk (integrity gate — the
 *     bytes we register must be exactly the bytes we captured).
 *  3. Transfer bytes via a resumable [EvidenceUploadTransport], persisting the
 *     resume cursor after each chunk so process death loses no progress.
 *  4. Register the evidence with the server (`POST /participant/evidence`),
 *     which returns the TRUSTED serverReceivedAt. Only now does the row become
 *     SUBMITTED — this is the evidence-before-status rule in code.
 *
 * Runs as a foreground service so a large upload survives the app being
 * backgrounded or killed. On any failure the original file is untouched and the
 * work is retried with backoff.
 */
@HiltWorker
class ResumableUploadWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val dao: PendingEvidenceDao,
    private val api: ApiService,
    private val transport: EvidenceUploadTransport,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val id = inputData.getString(KEY_PENDING_ID) ?: return Result.failure()
        val row = dao.byId(id) ?: return Result.success() // nothing to do; row gone

        // Already registered — idempotent no-op (e.g. a duplicate re-enqueue).
        if (row.state == UploadState.SUBMITTED || row.state == UploadState.VERIFIED) {
            return Result.success()
        }

        val file = File(row.localFilePath)
        if (!file.exists()) {
            dao.markFailed(id, "original file missing: ${row.localFilePath}")
            return Result.failure()
        }

        return try {
            setForeground(foregroundInfo())

            // (2) Integrity gate: re-verify the preserved original.
            val actual = Hashing.sha256(file)
            if (!actual.equals(row.sha256, ignoreCase = true)) {
                dao.markFailed(id, "sha256 mismatch (expected ${row.sha256}, got $actual)")
                return Result.failure()
            }

            // (3) Resumable byte transfer.
            dao.setState(id, UploadState.UPLOADING)
            val resume = if (row.bytesUploaded > 0) {
                EvidenceUploadTransport.Progress(
                    bytesUploaded = row.bytesUploaded,
                    totalBytes = row.sizeBytes,
                    uploadSessionId = row.uploadSessionId,
                    complete = false,
                )
            } else {
                null
            }

            val finalProgress = transport.upload(file, resume) { progress ->
                dao.setProgress(
                    id = id,
                    bytes = progress.bytesUploaded,
                    sessionId = progress.uploadSessionId,
                    state = if (progress.complete) UploadState.UPLOADED else UploadState.UPLOADING,
                )
            }

            if (!finalProgress.complete) {
                // Partial — keep the cursor and retry later. Nothing is lost.
                dao.markFailed(id, "partial upload; will resume")
                return Result.retry()
            }

            // (4) Register with the server. serverReceivedAt is TRUSTED time.
            val response = api.submitEvidence(
                EvidenceRequest(
                    requirementInstanceId = row.requirementInstanceId,
                    type = row.type,
                    sha256 = row.sha256,
                    sizeBytes = row.sizeBytes,
                    durationMs = row.durationMs,
                    captureStartedAt = row.captureStartedAt,
                    captureCompletedAt = row.captureCompletedAt,
                    appVersion = row.appVersion,
                    scriptVersion = row.scriptVersion,
                    recordingTemplateVersion = row.recordingTemplateVersion,
                ),
            )

            dao.markSubmitted(
                id = id,
                evidenceId = response.evidenceId,
                shortCode = response.shortCode,
                serverReceivedAt = response.serverReceivedAt,
            )
            Result.success()
        } catch (t: Throwable) {
            dao.markFailed(id, t.message)
            // Retry transient failures; WorkManager applies exponential backoff.
            Result.retry()
        }
    }

    private fun foregroundInfo(): ForegroundInfo {
        val context = applicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.upload_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = context.getString(R.string.upload_channel_description) }
            manager.createNotificationChannel(channel)
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(context.getString(R.string.upload_notification_title))
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setSilent(true)
            .build()

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val KEY_PENDING_ID = "pending_evidence_id"
        private const val CHANNEL_ID = "evidence_uploads"
        private const val NOTIFICATION_ID = 4201
    }
}
