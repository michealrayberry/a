package com.michealrayberry.console.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Offline cache of the last GET /participant/today snapshot at the requirement
 * grain, so the Today screen renders instantly and remains legible without a
 * network connection.
 *
 * All fields reflect SERVER state. This cache is display-only truth from the
 * last sync; it is never mutated to fake a submission. When a local upload
 * completes, the app re-fetches /today and overwrites this cache rather than
 * editing rows optimistically.
 */
@Entity(tableName = "cached_requirements")
data class CachedRequirementEntity(
    @PrimaryKey val id: String,
    val localDate: String,
    val requirementCode: String,
    val name: String,
    val evidenceType: String,
    /** Server requirement status. */
    val status: String,
    val deadlineAt: String?,
    val grace: String?,
    /** Server timeliness verdict, if evaluated. */
    val timeliness: String?,
    val cachedAt: Long = System.currentTimeMillis(),
)
