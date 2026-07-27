package com.michealrayberry.console.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import com.michealrayberry.console.data.local.dao.PendingEvidenceDao
import com.michealrayberry.console.data.local.dao.RequirementCacheDao
import com.michealrayberry.console.data.local.entity.CachedDayEntity
import com.michealrayberry.console.data.local.entity.CachedRequirementEntity
import com.michealrayberry.console.data.local.entity.PendingEvidenceEntity

/**
 * Room database holding two concerns:
 *  1. The durable evidence upload queue ([PendingEvidenceEntity]).
 *  2. An offline cache of the last /today snapshot ([CachedDayEntity],
 *     [CachedRequirementEntity]).
 *
 * Schemas are exported to app/schemas for migration review. Bump [version] and
 * supply a Migration for any change — never destructively rebuild a table that
 * could hold un-uploaded evidence.
 */
@Database(
    entities = [
        PendingEvidenceEntity::class,
        CachedRequirementEntity::class,
        CachedDayEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class ConsoleDatabase : RoomDatabase() {
    abstract fun pendingEvidenceDao(): PendingEvidenceDao
    abstract fun requirementCacheDao(): RequirementCacheDao

    companion object {
        const val NAME = "console.db"
    }
}
