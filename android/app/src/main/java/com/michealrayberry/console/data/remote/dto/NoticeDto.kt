package com.michealrayberry.console.data.remote.dto

import com.squareup.moshi.JsonClass

/** GET /participant/notices item. */
@JsonClass(generateAdapter = true)
data class NoticeDto(
    val id: String,
    val projectId: String? = null,
    val kind: String? = null,
    val title: String? = null,
    val body: String? = null,
    val issuedAt: String? = null,
    val acknowledgedAt: String? = null,
)

/** Generic acknowledgement response for notices/violations. */
@JsonClass(generateAdapter = true)
data class AckResponse(
    val ok: Boolean = true,
)
