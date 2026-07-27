package com.michealrayberry.console.ui.common

import android.os.SystemClock
import java.time.Instant
import java.time.Duration
import kotlin.math.max

/**
 * Server-authoritative countdown math.
 *
 * The remaining time to a deadline is derived from the SERVER clock, not the
 * device wall clock. At sync we stored the server "now" plus the device's
 * monotonic [SystemClock.elapsedRealtime]. To render a live value we add the
 * monotonic elapsed delta (which the user cannot back-date) to the server
 * anchor. This keeps the ticking display honest offline while never letting the
 * device clock influence the number — and the true timeliness verdict still
 * comes from the server at submission time.
 */
object ServerCountdown {

    /** Best current estimate of server time, in epoch millis. */
    fun estimatedServerNowMillis(
        serverTimeAtSyncIso: String,
        deviceElapsedRealtimeAtSync: Long,
        nowElapsedRealtime: Long = SystemClock.elapsedRealtime(),
    ): Long {
        val anchor = Instant.parse(serverTimeAtSyncIso).toEpochMilli()
        val monotonicDelta = nowElapsedRealtime - deviceElapsedRealtimeAtSync
        return anchor + monotonicDelta
    }

    /** Milliseconds remaining until [deadlineIso]; never negative. */
    fun remainingMillis(
        deadlineIso: String,
        serverTimeAtSyncIso: String,
        deviceElapsedRealtimeAtSync: Long,
        nowElapsedRealtime: Long = SystemClock.elapsedRealtime(),
    ): Long {
        val deadline = Instant.parse(deadlineIso).toEpochMilli()
        val now = estimatedServerNowMillis(serverTimeAtSyncIso, deviceElapsedRealtimeAtSync, nowElapsedRealtime)
        return max(0L, deadline - now)
    }

    /** Format a millisecond duration as HH:MM:SS for a tabular countdown. */
    fun format(millis: Long): String {
        val d = Duration.ofMillis(millis)
        val h = d.toHours()
        val m = d.toMinutes() % 60
        val s = d.seconds % 60
        return "%02d:%02d:%02d".format(h, m, s)
    }
}
