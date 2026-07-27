package com.michealrayberry.console.work

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Schedules durable, resumable uploads.
 *
 * Each pending-evidence row gets a uniquely-named one-time work request keyed by
 * its id, so re-enqueuing the same item (e.g. after a retry tap or app restart)
 * does not create duplicates. WorkManager persists the request across process
 * death and reboots; a NETWORK-CONNECTED constraint plus exponential backoff
 * means a queued upload simply completes when connectivity returns.
 */
@Singleton
class UploadEnqueuer @Inject constructor(
    private val workManager: WorkManager,
) {
    fun enqueue(pendingEvidenceId: String) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<ResumableUploadWorker>()
            .setInputData(workDataOf(ResumableUploadWorker.KEY_PENDING_ID to pendingEvidenceId))
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG_UPLOAD)
            .build()

        workManager.enqueueUniqueWork(
            uniqueName(pendingEvidenceId),
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    private fun uniqueName(id: String) = "upload-evidence-$id"

    companion object {
        const val TAG_UPLOAD = "evidence-upload"
    }
}
