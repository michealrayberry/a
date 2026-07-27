package com.michealrayberry.console.work

import java.io.File
import java.security.DigestInputStream
import java.security.MessageDigest

/**
 * SHA-256 utilities. The hash binds an evidence record to the exact bytes that
 * were captured and uploaded, so integrity can be re-verified later and the
 * original recording is provably the one that was submitted.
 */
object Hashing {

    /** Streamed SHA-256 of a file, hex-encoded lowercase. Never loads it fully. */
    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        DigestInputStream(file.inputStream().buffered(), digest).use { stream ->
            val buffer = ByteArray(64 * 1024)
            @Suppress("ControlFlowWithEmptyBody")
            while (stream.read(buffer) != -1) { /* digest updated as a side effect */ }
        }
        return digest.digest().toHex()
    }

    private fun ByteArray.toHex(): String = buildString(size * 2) {
        for (b in this@toHex) {
            val i = b.toInt() and 0xFF
            append(HEX[i ushr 4])
            append(HEX[i and 0x0F])
        }
    }

    private const val HEX = "0123456789abcdef"
}
