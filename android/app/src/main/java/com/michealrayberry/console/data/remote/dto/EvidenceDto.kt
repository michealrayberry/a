package com.michealrayberry.console.data.remote.dto

import com.squareup.moshi.JsonClass

/**
 * POST /participant/evidence request.
 *
 * The client asserts capture metadata for the audit trail — [captureStartedAt]
 * / [captureCompletedAt] are DEVICE time and explicitly advisory. The server
 * stamps the only trusted instant (serverReceivedAt in the response) and uses
 * that to decide timeliness. [sha256] binds this record to the exact bytes
 * that were uploaded so the original recording can be integrity-checked later.
 */
@JsonClass(generateAdapter = true)
data class EvidenceRequest(
    val requirementInstanceId: String,
    /** VIDEO | WEIGHT | EXTERNAL_LINK | TRACKING | PHOTO. */
    val type: String,
    val sha256: String,
    val sizeBytes: Long,
    val durationMs: Long? = null,
    /** Device capture start (ISO-8601). Advisory only. */
    val captureStartedAt: String? = null,
    /** Device capture completion (ISO-8601). Advisory only. */
    val captureCompletedAt: String? = null,
    val appVersion: String,
    val scriptVersion: String? = null,
    val recordingTemplateVersion: String? = null,
)

/**
 * POST /participant/evidence response.
 *
 * [serverReceivedAt] is the trusted receipt time. Once this record exists the
 * requirement is considered SUBMITTED — never before.
 */
@JsonClass(generateAdapter = true)
data class EvidenceResponse(
    val evidenceId: String,
    val shortCode: String,
    val serverReceivedAt: String,
)

/** POST /participant/weights request. */
@JsonClass(generateAdapter = true)
data class WeightRequest(
    val projectDayId: String,
    val weight: Double,
    val unit: String,
    val requirementInstanceId: String? = null,
)

@JsonClass(generateAdapter = true)
data class WeightResponse(
    val weightId: String,
)

/** POST /participant/external-links request. */
@JsonClass(generateAdapter = true)
data class ExternalLinkRequest(
    val requirementInstanceId: String,
    val platform: String,
    val url: String,
)

@JsonClass(generateAdapter = true)
data class ExternalLinkResponse(
    val publicationId: String? = null,
)
