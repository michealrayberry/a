package com.michealrayberry.console.domain

/**
 * UI-facing domain models. These are intentionally decoupled from the wire DTOs
 * so the UI depends on stable shapes and the repository owns the mapping.
 */

/** A requirement as shown on the Today screen. Status/timeliness are SERVER truth. */
data class Requirement(
    val id: String,
    val code: String,
    val name: String,
    val evidenceType: EvidenceType,
    val status: String,
    /** Trusted server deadline (ISO-8601), if any. */
    val deadlineAt: String?,
    val timeliness: Timeliness,
    /**
     * Device-side upload status of the most recent local capture for this
     * requirement, if any. Distinct from [status] — a file existing locally is
     * never a submission.
     */
    val localUpload: LocalUpload? = null,
)

enum class EvidenceType {
    VIDEO, WEIGHT, EXTERNAL_LINK, TRACKING, PHOTO, UNKNOWN;

    companion object {
        fun from(raw: String): EvidenceType =
            entries.firstOrNull { it.name == raw.uppercase() } ?: UNKNOWN
    }
}

enum class Timeliness {
    ON_TIME, GRACE, LATE, MISSED, NOT_SUBMITTED, UNKNOWN;

    companion object {
        fun from(raw: String?): Timeliness =
            entries.firstOrNull { it.name == raw?.uppercase() } ?: UNKNOWN
    }
}

/** Snapshot of a local capture's upload progress for a requirement. */
data class LocalUpload(
    val pendingEvidenceId: String,
    val state: com.michealrayberry.console.data.local.UploadState,
    val bytesUploaded: Long,
    val sizeBytes: Long,
    val serverReceivedAt: String?,
)

/** The full Today view model input. */
data class TodaySnapshot(
    val localDate: String,
    val dayNumber: Int,
    val timeZone: String,
    val overallStatus: String,
    /** Trusted server end-of-day deadline (ISO-8601). */
    val dayDeadline: String,
    /** Trusted server "now" at last sync (ISO-8601). Anchors the countdown. */
    val serverTimeAtSync: String,
    /** elapsedRealtime() captured with [serverTimeAtSync]; monotonic. */
    val deviceElapsedRealtimeAtSync: Long,
    val requirements: List<Requirement>,
)

/**
 * Everything the guided recorder needs for one requirement: the server
 * recording template plus identifiers to register the resulting evidence.
 */
data class RecordingContext(
    val requirementId: String,
    val requirementName: String,
    val projectDayId: String,
    val localDate: String,
    val dayNumber: Int,
    val scriptVersion: String,
    val requiredVariables: List<String>,
    val steps: List<com.michealrayberry.console.data.remote.dto.RecordingStepDto>,
)

/** The signed-in identity as reported by the backend. */
data class Identity(
    val userId: String,
    val displayName: String,
    /** Authority source of truth — never derived on device. */
    val role: String,
)
