package com.michealrayberry.console.work

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import okhttp3.OkHttpClient
import java.io.File
import java.util.UUID
import javax.inject.Inject
import kotlin.coroutines.coroutineContext

/**
 * Reference resumable transport.
 *
 * This implementation walks the file in fixed chunks, reporting a resume cursor
 * after each so a partial transfer can continue after process death (the worker
 * persists [EvidenceUploadTransport.Progress.bytesUploaded] to Room between
 * chunks). The chunk loop honors coroutine cancellation, so WorkManager can
 * stop and later resume it cleanly.
 *
 * The actual per-chunk PUT is left as the single clearly-marked seam
 * ([putChunk]) because the storage endpoint / signed-URL scheme is a deployment
 * detail outside the listed backend API. Wire it to your resumable storage
 * (signed PUT with Content-Range, GCS resumable, or TUS) to make transfers real
 * — the resume bookkeeping around it is already correct.
 */
class ChunkedUploadTransport @Inject constructor(
    @Suppress("unused") private val client: OkHttpClient,
) : EvidenceUploadTransport {

    override suspend fun upload(
        file: File,
        resumeFrom: EvidenceUploadTransport.Progress?,
        onProgress: suspend (EvidenceUploadTransport.Progress) -> Unit,
    ): EvidenceUploadTransport.Progress {
        val total = file.length()
        val sessionId = resumeFrom?.uploadSessionId ?: UUID.randomUUID().toString()
        var offset = resumeFrom?.bytesUploaded ?: 0L

        file.inputStream().use { input ->
            if (offset > 0) input.skip(offset)
            val buffer = ByteArray(CHUNK_BYTES)
            while (offset < total) {
                coroutineContext.ensureActive() // cooperative cancellation -> resumable
                val read = input.read(buffer)
                if (read <= 0) break

                putChunk(sessionId, offset, buffer, read, total)
                offset += read

                val progress = EvidenceUploadTransport.Progress(
                    bytesUploaded = offset,
                    totalBytes = total,
                    uploadSessionId = sessionId,
                    complete = offset >= total,
                )
                onProgress(progress)
            }
        }

        return EvidenceUploadTransport.Progress(
            bytesUploaded = offset,
            totalBytes = total,
            uploadSessionId = sessionId,
            complete = offset >= total,
        )
    }

    /**
     * SEAM: transfer a single chunk to storage. Replace with a real resumable
     * PUT (e.g. Content-Range: bytes offset-(offset+len-1)/total) against your
     * object store. Kept as a no-network default so this skeleton neither
     * fabricates a working upload nor invents an endpoint.
     */
    @Suppress("UNUSED_PARAMETER")
    private suspend fun putChunk(
        sessionId: String,
        offset: Long,
        data: ByteArray,
        length: Int,
        total: Long,
    ) {
        try {
            // No-op placeholder. A production build issues an authenticated,
            // resumable chunk PUT here and throws on non-2xx so the worker
            // retries with backoff.
        } catch (c: CancellationException) {
            throw c
        }
    }

    private companion object {
        const val CHUNK_BYTES = 1 * 1024 * 1024 // 1 MiB
    }
}
