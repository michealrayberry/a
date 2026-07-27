package com.michealrayberry.console.data.local

/**
 * Lifecycle of a piece of captured evidence on the device.
 *
 * This models the blueprint's "evidence-before-status" rule: a locally recorded
 * file is emphatically NOT a submission. A requirement only becomes SUBMITTED
 * once the server has registered the evidence record (which returns the trusted
 * receipt time). The UI must visually distinguish every state below so the
 * participant is never misled into thinking a recording that merely exists on
 * the phone has been counted.
 *
 * States roughly mirror the server's evidence state machine but are strictly
 * device-side bookkeeping; VERIFIED is reflected from the server, never decided
 * locally.
 */
enum class UploadState {
    /** Captured and hashed on device. Original file preserved. Not yet queued. */
    RECORDED_LOCALLY,

    /** Enqueued for durable upload via WorkManager. Survives process death. */
    QUEUED,

    /** Bytes are actively transferring (resumable). */
    UPLOADING,

    /** All bytes received by the server; evidence record not yet registered. */
    UPLOADED,

    /** Evidence record registered with the server — requirement is SUBMITTED. */
    SUBMITTED,

    /** Server has reviewed and verified the evidence. Terminal (success). */
    VERIFIED,

    /** Upload/registration failed; will be retried. Original is never destroyed. */
    FAILED,
}
