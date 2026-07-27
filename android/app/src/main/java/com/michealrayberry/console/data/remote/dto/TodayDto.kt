package com.michealrayberry.console.data.remote.dto

import com.squareup.moshi.JsonClass

/**
 * GET /participant/today response.
 *
 * Server-authoritative time surface: [serverTime], [dayDeadline] and each
 * requirement's [RequirementDto.deadlineAt] are computed by the backend in the
 * project [timeZone]. The client treats these as the truth and uses the device
 * clock only to animate the countdown *between* server refreshes — never to
 * decide timeliness.
 */
@JsonClass(generateAdapter = true)
data class TodayResponse(
    /** Trusted server "now" (ISO-8601). Anchors the countdown. */
    val serverTime: String,
    /** IANA zone the project runs in. */
    val timeZone: String,
    /** Server-resolved local date, e.g. "2026-07-27". */
    val localDate: String,
    /** 1-based project day number. */
    val dayNumber: Int,
    /** End-of-day deadline for the whole day (ISO-8601). */
    val dayDeadline: String,
    /** Server-computed overall status for the day. */
    val overallStatus: String,
    val day: ProjectDayDto,
    val requirements: List<RequirementDto>,
    val recordingTemplate: RecordingTemplateDto,
)

@JsonClass(generateAdapter = true)
data class ProjectDayDto(
    val id: String,
    val projectId: String? = null,
    val localDate: String? = null,
    val dayNumber: Int? = null,
    val status: String? = null,
)

/**
 * A single requirement instance for the day.
 *
 * [status] and [timeliness] are SERVER state. The app never promotes a
 * requirement to "submitted" on its own; it renders whatever the server last
 * reported and reconciles after each evidence POST (see ProjectRepository).
 */
@JsonClass(generateAdapter = true)
data class RequirementDto(
    val id: String,
    val requirementCode: String,
    val name: String,
    /** VIDEO | WEIGHT | EXTERNAL_LINK | TRACKING | PHOTO. */
    val evidenceType: String,
    /** Server requirement state (NOT_STARTED, SUBMITTED, VERIFIED, ...). */
    val status: String,
    /** Requirement deadline (ISO-8601), server-computed. */
    val deadlineAt: String? = null,
    /** Grace deadline (ISO-8601) or null. */
    val grace: String? = null,
    /** ON_TIME | GRACE | LATE | MISSED | NOT_SUBMITTED, or null if not yet evaluated. */
    val timeliness: String? = null,
)

/** recordingTemplate: drives the guided capture sequence engine. */
@JsonClass(generateAdapter = true)
data class RecordingTemplateDto(
    val name: String,
    val scriptVersion: String,
    val requiredVariables: List<String> = emptyList(),
    val steps: List<RecordingStepDto> = emptyList(),
)

/**
 * One step in the guided recording. The client renders [teleprompter] text,
 * enforces [minHoldSeconds] before the step can advance, and suggests stopping
 * near [maxRecommendedSeconds]. It performs NO editing — steps are recorded in
 * one continuous take.
 */
@JsonClass(generateAdapter = true)
data class RecordingStepDto(
    val name: String,
    val instruction: String,
    val teleprompter: String = "",
    val minHoldSeconds: Int = 0,
    val maxRecommendedSeconds: Int = 0,
    val speechRequired: Boolean = false,
    val pauseAllowed: Boolean = false,
    val skippable: Boolean = false,
)
