package com.michealrayberry.console.ui.common

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Verifies the server-authoritative countdown math: remaining time is derived
 * from the server anchor plus the MONOTONIC device delta, never from the wall
 * clock. These are pure-JVM tests (no Android framework needed).
 */
class ServerCountdownTest {

    @Test
    fun `remaining uses monotonic delta from server anchor`() {
        // Server said "now" was 12:00:00Z when elapsedRealtime was 1_000 ms.
        val serverNow = "2026-07-27T12:00:00Z"
        val deadline = "2026-07-27T12:00:10Z" // 10s after the anchor
        val elapsedAtSync = 1_000L

        // 3 seconds of monotonic time have passed (elapsedRealtime = 4_000).
        val remaining = ServerCountdown.remainingMillis(
            deadlineIso = deadline,
            serverTimeAtSyncIso = serverNow,
            deviceElapsedRealtimeAtSync = elapsedAtSync,
            nowElapsedRealtime = 4_000L,
        )

        assertEquals(7_000L, remaining)
    }

    @Test
    fun `remaining never negative past deadline`() {
        val remaining = ServerCountdown.remainingMillis(
            deadlineIso = "2026-07-27T12:00:00Z",
            serverTimeAtSyncIso = "2026-07-27T12:00:00Z",
            deviceElapsedRealtimeAtSync = 0L,
            nowElapsedRealtime = 60_000L,
        )
        assertEquals(0L, remaining)
    }

    @Test
    fun `format renders tabular HH_MM_SS`() {
        assertEquals("01:02:03", ServerCountdown.format(3_723_000L))
        assertEquals("00:00:09", ServerCountdown.format(9_000L))
    }
}
