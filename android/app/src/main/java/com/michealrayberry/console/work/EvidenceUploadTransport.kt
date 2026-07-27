package com.michealrayberry.console.work

import java.io.File

/**
 * Seam for the binary blob transfer.
 *
 * The reference backend's `POST /participant/evidence` accepts evidence
 * *metadata* (sha256, sizeBytes, duration, capture times) — it does not itself
 * receive the video bytes. In production the bytes go to object storage via a
 * resumable transport (e.g. a signed resumable PUT, GCS resumable upload, or
 * TUS), and only then is the metadata registered. That transport is
 * intentionally abstracted here so it can be swapped without touching the
 * worker, and so this skeleton does not invent a storage endpoint it cannot
 * verify.
 *
 * Implementations MUST be resumable: given a previously returned [Progress],
 * they continue from [Progress.bytesUploaded] rather than restarting.
 */
interface EvidenceUploadTransport {

    data class Progress(
        val bytesUploaded: Long,
        val totalBytes: Long,
        val uploadSessionId: String?,
        val complete: Boolean,
    )

    /**
     * Push (more of) [file] to storage, resuming from [resumeFrom] if given.
     * [onProgress] is called as chunks are confirmed so the durable queue can
     * persist a resume cursor that survives process death.
     */
    suspend fun upload(
        file: File,
        resumeFrom: Progress?,
        onProgress: suspend (Progress) -> Unit,
    ): Progress
}
