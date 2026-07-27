package com.michealrayberry.console.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Offline cache of the day-level header from GET /participant/today.
 *
 * [serverTimeAtSync] and [deviceElapsedRealtimeAtSync] together let the client
 * animate the deadline countdown offline without ever trusting the wall clock:
 * elapsed time is measured with [android.os.SystemClock.elapsedRealtime] (which
 * cannot be back-dated by the user) and added to the server anchor. The result
 * is display-only; the server still adjudicates true timeliness on submission.
 */
@Entity(tableName = "cached_day")
data class CachedDayEntity(
    @PrimaryKey val localDate: String,
    val projectDayId: String,
    val dayNumber: Int,
    val timeZone: String,
    val overallStatus: String,
    /** ISO-8601 end-of-day deadline (server-computed). */
    val dayDeadline: String,
    /** Trusted server "now" at the moment of sync (ISO-8601). */
    val serverTimeAtSync: String,
    /** SystemClock.elapsedRealtime() captured alongside the server time. */
    val deviceElapsedRealtimeAtSync: Long,
    val cachedAt: Long = System.currentTimeMillis(),
)
