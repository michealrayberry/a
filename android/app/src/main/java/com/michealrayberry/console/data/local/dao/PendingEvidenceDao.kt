package com.michealrayberry.console.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import com.michealrayberry.console.data.local.UploadState
import com.michealrayberry.console.data.local.entity.PendingEvidenceEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface PendingEvidenceDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(item: PendingEvidenceEntity)

    @Update
    suspend fun update(item: PendingEvidenceEntity)

    @Query("SELECT * FROM pending_evidence WHERE id = :id")
    suspend fun byId(id: String): PendingEvidenceEntity?

    @Query("DELETE FROM pending_evidence WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("SELECT * FROM pending_evidence ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<PendingEvidenceEntity>>

    @Query("SELECT * FROM pending_evidence WHERE requirementInstanceId = :reqId ORDER BY createdAt DESC")
    fun observeForRequirement(reqId: String): Flow<List<PendingEvidenceEntity>>

    /** Items still needing work — used to reconcile the queue on app start. */
    @Query(
        "SELECT * FROM pending_evidence " +
            "WHERE state IN ('RECORDED_LOCALLY','QUEUED','UPLOADING','UPLOADED','FAILED') " +
            "ORDER BY createdAt ASC",
    )
    suspend fun pending(): List<PendingEvidenceEntity>

    @Query("UPDATE pending_evidence SET state = :state, updatedAt = :now WHERE id = :id")
    suspend fun setState(id: String, state: UploadState, now: Long = System.currentTimeMillis())

    @Query(
        "UPDATE pending_evidence SET bytesUploaded = :bytes, uploadSessionId = :sessionId, " +
            "state = :state, updatedAt = :now WHERE id = :id",
    )
    suspend fun setProgress(
        id: String,
        bytes: Long,
        sessionId: String?,
        state: UploadState,
        now: Long = System.currentTimeMillis(),
    )

    /**
     * Record a successful server registration: pins the trusted receipt time
     * and advances to SUBMITTED. The device never invents this timestamp.
     */
    @Query(
        "UPDATE pending_evidence SET evidenceId = :evidenceId, shortCode = :shortCode, " +
            "serverReceivedAt = :serverReceivedAt, state = 'SUBMITTED', lastError = NULL, " +
            "updatedAt = :now WHERE id = :id",
    )
    suspend fun markSubmitted(
        id: String,
        evidenceId: String,
        shortCode: String,
        serverReceivedAt: String,
        now: Long = System.currentTimeMillis(),
    )

    @Query(
        "UPDATE pending_evidence SET state = 'FAILED', lastError = :error, " +
            "attemptCount = attemptCount + 1, updatedAt = :now WHERE id = :id",
    )
    suspend fun markFailed(id: String, error: String?, now: Long = System.currentTimeMillis())
}
