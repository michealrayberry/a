package com.michealrayberry.console.data.remote.dto

import com.squareup.moshi.JsonClass

/** POST /participant/integrity/heartbeat. The server stamps the trusted receipt time. */
@JsonClass(generateAdapter = true)
data class HeartbeatRequest(
    val deviceId: String,
    val privateDnsMode: String,
    val privateDnsHost: String?,
    val network: String,
    val recordingReady: Boolean,
    val appVersion: String,
    /** Display/debug only — never used by the server for timing decisions. */
    val clientTime: String,
)

@JsonClass(generateAdapter = true)
data class HeartbeatResponse(
    val heartbeatId: String,
    val serverReceivedAt: String,
    /** CONFIRMED | DISABLED | MISCONFIGURED | UNKNOWN */
    val privateDns: String,
    val nextHeartbeatWithinMinutes: Int,
)
