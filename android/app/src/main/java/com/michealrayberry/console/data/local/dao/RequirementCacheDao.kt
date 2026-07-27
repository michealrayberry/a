package com.michealrayberry.console.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.michealrayberry.console.data.local.entity.CachedDayEntity
import com.michealrayberry.console.data.local.entity.CachedRequirementEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface RequirementCacheDao {

    @Query("SELECT * FROM cached_day WHERE localDate = :localDate LIMIT 1")
    fun observeDay(localDate: String): Flow<CachedDayEntity?>

    @Query("SELECT * FROM cached_day ORDER BY localDate DESC LIMIT 1")
    fun observeLatestDay(): Flow<CachedDayEntity?>

    @Query("SELECT * FROM cached_requirements WHERE localDate = :localDate ORDER BY requirementCode")
    fun observeRequirements(localDate: String): Flow<List<CachedRequirementEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDay(day: CachedDayEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertRequirements(items: List<CachedRequirementEntity>)

    @Query("DELETE FROM cached_requirements WHERE localDate = :localDate")
    suspend fun clearRequirements(localDate: String)

    /** Replace the whole snapshot for a day atomically after a /today fetch. */
    @Transaction
    suspend fun replaceSnapshot(day: CachedDayEntity, requirements: List<CachedRequirementEntity>) {
        upsertDay(day)
        clearRequirements(day.localDate)
        upsertRequirements(requirements)
    }
}
