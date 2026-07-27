package com.michealrayberry.console.data.local.entity

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.michealrayberry.console.data.local.UploadState

/**
 * The durable upload queue. One row per captured evidence file.
 *
 * This table is the source of truth for offline resilience: because it is
 * persisted, a queued or partially-uploaded item survives app kill, reboot, and
 * network loss. [ResumableUploadWorker] reads rows here, resumes byte transfer
 * from [bytesUploaded], and on success registers the evidence with the server.
 *
 * The [localFilePath] original recording is never modified or deleted while the
 * row is non-terminal; [sha256] pins the exact bytes for integrity.
 */
@Entity(
    tableName = "pending_evidence",
    indices = [
        Index(value = ["requirementInstanceId"]),
        Index(value = ["state"]),
    ],
)
data class PendingEvidenceEntity(
    @PrimaryKey val id: String,

    /** Requirement this evidence satisfies. */
    val requirementInstanceId: String,

    /** VIDEO | WEIGHT | EXTERNAL_LINK | TRACKING | PHOTO. */
    val type: String,

    /** Absolute path to the preserved original capture. */
    val localFilePath: String,

    /** SHA-256 of the original file, computed at capture time. */
    val sha256: String,

    val sizeBytes: Long,
    val durationMs: Long?,

    /** Device capture window (advisory; server time is authoritative). */
    val captureStartedAt: String?,
    val captureCompletedAt: String?,

    /** Template provenance for the audit trail. */
    val scriptVersion: String?,
    val recordingTemplateVersion: String?,
    val appVersion: String,

    /** Current device-side upload state. */
    val state: UploadState = UploadState.RECORDED_LOCALLY,

    /** Resume cursor — bytes confirmed transferred so far. */
    val bytesUploaded: Long = 0,

    /** Opaque server upload/session id for resumable transfer, if issued. */
    val uploadSessionId: String? = null,

    /** Populated after successful registration. */
    val evidenceId: String? = null,
    val shortCode: String? = null,

    /**
     * The TRUSTED server receipt time, captured verbatim from the evidence POST
     * response. This — not any device clock value — is what determines
     * timeliness. Display-only device times live in [captureStartedAt] etc.
     */
    val serverReceivedAt: String? = null,

    val attemptCount: Int = 0,
    val lastError: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
)
