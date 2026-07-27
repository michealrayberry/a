package com.michealrayberry.console.work

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** SHA-256 of known bytes must match the canonical digest. */
class HashingTest {

    @Test
    fun `sha256 of empty file matches known digest`() {
        val f = File.createTempFile("evidence", ".bin").apply { writeBytes(ByteArray(0)) }
        try {
            assertEquals(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                Hashing.sha256(f),
            )
        } finally {
            f.delete()
        }
    }

    @Test
    fun `sha256 of abc matches known digest`() {
        val f = File.createTempFile("evidence", ".bin").apply { writeBytes("abc".toByteArray()) }
        try {
            assertEquals(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                Hashing.sha256(f),
            )
        } finally {
            f.delete()
        }
    }
}
