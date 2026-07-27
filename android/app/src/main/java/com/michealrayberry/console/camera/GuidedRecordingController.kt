package com.michealrayberry.console.camera

import android.annotation.SuppressLint
import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.michealrayberry.console.data.remote.dto.RecordingStepDto
import com.michealrayberry.console.data.remote.dto.RecordingTemplateDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * Drives the guided recording *sequence engine* defined by a server
 * [RecordingTemplateDto].
 *
 * Design commitments:
 *  - ONE continuous take. Steps are teleprompter/instruction overlays advanced
 *    over a single recording; the app does NOT splice, trim, or filter — there
 *    is no in-app editing anywhere in this class.
 *  - The original captured file is preserved verbatim at [outputFile]; its hash
 *    is computed by the upload pipeline, not here, so the exact recorded bytes
 *    are what gets submitted.
 *  - Step gating: a step cannot be marked done before its [RecordingStepDto.
 *    minHoldSeconds] has elapsed; [maxRecommendedSeconds] only nudges the user.
 *  - Teleprompter text has template variables (e.g. {participantName},
 *    {currentWeight}) interpolated from values the caller supplies.
 *
 * This is a plain controller (not a ViewModel) so it can be owned by the record
 * screen's ViewModel and unit-reasoned independently of Compose.
 */
class GuidedRecordingController(
    private val appContext: Context,
    private val scope: CoroutineScope,
    private val template: RecordingTemplateDto,
    private val variables: Map<String, String>,
) {

    /** Immutable snapshot of guided-recording UI state (unidirectional flow). */
    data class State(
        val phase: Phase = Phase.IDLE,
        val stepIndex: Int = 0,
        val stepCount: Int = 0,
        val currentStep: RecordingStepDto? = null,
        /** Teleprompter text with variables resolved. */
        val teleprompter: String = "",
        /** Whole-second elapsed time on the current step. */
        val stepElapsedSeconds: Int = 0,
        /** True once the current step's minimum hold has been satisfied. */
        val minHoldSatisfied: Boolean = false,
        val totalElapsedSeconds: Int = 0,
        val outputPath: String? = null,
        val error: String? = null,
    )

    enum class Phase { IDLE, PREPARING, RECORDING, FINALIZING, COMPLETED, ERROR }

    /** Terminal result handed to the repository to queue for upload. */
    data class Capture(
        val file: File,
        val durationMs: Long,
        val scriptVersion: String,
        val captureStartedAtIso: String,
        val captureCompletedAtIso: String,
    )

    private val _state = MutableStateFlow(State(stepCount = template.steps.size))
    val state: StateFlow<State> = _state.asStateFlow()

    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private var outputFile: File? = null
    private var startedAtMs: Long = 0

    /**
     * Bind CameraX to the given lifecycle and preview surface. Recorder quality
     * is capped to keep files uploadable on mobile networks without any
     * post-processing.
     */
    suspend fun bind(
        lifecycleOwner: LifecycleOwner,
        previewView: PreviewView,
        useFrontCamera: Boolean,
    ) {
        _state.value = _state.value.copy(phase = Phase.PREPARING)
        // CameraX 1.4+ suspend accessor — no guava/ListenableFuture bridging.
        val provider = ProcessCameraProvider.awaitInstance(appContext)

        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.fromOrderedList(listOf(Quality.HD, Quality.SD)),
            )
            .build()
        val capture = VideoCapture.withOutput(recorder)

        val preview = androidx.camera.core.Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }

        val selector = if (useFrontCamera) {
            CameraSelector.DEFAULT_FRONT_CAMERA
        } else {
            CameraSelector.DEFAULT_BACK_CAMERA
        }

        provider.unbindAll()
        provider.bindToLifecycle(lifecycleOwner, selector, preview, capture)
        videoCapture = capture

        _state.value = _state.value.copy(
            phase = Phase.IDLE,
            currentStep = template.steps.firstOrNull(),
            teleprompter = resolve(template.steps.firstOrNull()?.teleprompter.orEmpty()),
        )
    }

    /**
     * Start the single continuous recording and the step timer loop. Audio is
     * enabled because most templates require spoken verification.
     */
    @SuppressLint("MissingPermission")
    fun start() {
        val capture = videoCapture ?: run {
            _state.value = _state.value.copy(phase = Phase.ERROR, error = "camera not bound")
            return
        }
        val file = File(
            appContext.filesDir,
            "evidence/${System.currentTimeMillis()}.mp4",
        ).also { it.parentFile?.mkdirs() }
        outputFile = file
        startedAtMs = System.currentTimeMillis()

        val options = FileOutputOptions.Builder(file).build()
        recording = capture.output
            .prepareRecording(appContext, options)
            .withAudioEnabled()
            .start(ContextCompat.getMainExecutor(appContext)) { event ->
                if (event is VideoRecordEvent.Finalize && event.hasError()) {
                    _state.value = _state.value.copy(
                        phase = Phase.ERROR,
                        error = "record error ${event.error}",
                    )
                }
            }

        _state.value = _state.value.copy(phase = Phase.RECORDING, outputPath = file.absolutePath)
        runStepClock()
    }

    /**
     * Advance to the next step. Refuses while the current step's minimum hold is
     * unmet (unless the step is skippable) — this is enforced, not advisory.
     */
    fun advanceStep(): Boolean {
        val s = _state.value
        val step = s.currentStep ?: return false
        if (!s.minHoldSatisfied && !step.skippable) return false

        val next = s.stepIndex + 1
        if (next >= template.steps.size) return false
        val nextStep = template.steps[next]
        _state.value = s.copy(
            stepIndex = next,
            currentStep = nextStep,
            teleprompter = resolve(nextStep.teleprompter),
            stepElapsedSeconds = 0,
            minHoldSatisfied = nextStep.minHoldSeconds <= 0,
        )
        return true
    }

    /** Stop recording; finalizes the single file and reports it for upload. */
    fun stopAndFinalize(onComplete: (Capture) -> Unit) {
        _state.value = _state.value.copy(phase = Phase.FINALIZING)
        recording?.stop()
        recording = null
        val file = outputFile ?: return
        val completedAt = System.currentTimeMillis()
        _state.value = _state.value.copy(phase = Phase.COMPLETED)
        onComplete(
            Capture(
                file = file,
                durationMs = completedAt - startedAtMs,
                scriptVersion = template.scriptVersion,
                captureStartedAtIso = IsoTime.iso(startedAtMs),
                captureCompletedAtIso = IsoTime.iso(completedAt),
            ),
        )
    }

    /** Discard an in-progress take (used by "re-record"). Original of an already
     *  completed take is never deleted here — only an aborted, unsubmitted file. */
    fun cancel() {
        recording?.stop()
        recording = null
        outputFile?.takeIf { _state.value.phase != Phase.COMPLETED }?.delete()
        _state.value = State(stepCount = template.steps.size)
    }

    private fun runStepClock() {
        scope.launch {
            while (isActive && _state.value.phase == Phase.RECORDING) {
                delay(1000)
                val s = _state.value
                if (s.phase != Phase.RECORDING) break
                val step = s.currentStep
                val stepElapsed = s.stepElapsedSeconds + 1
                _state.value = s.copy(
                    stepElapsedSeconds = stepElapsed,
                    totalElapsedSeconds = s.totalElapsedSeconds + 1,
                    minHoldSatisfied = step == null || stepElapsed >= step.minHoldSeconds,
                )
            }
        }
    }

    /** Interpolate {variable} tokens in teleprompter text. */
    private fun resolve(text: String): String {
        if (text.isEmpty()) return text
        var out = text
        for ((k, v) in variables) out = out.replace("{$k}", v)
        return out
    }
}

/** Minimal ISO-8601 formatting for device-side (advisory) capture timestamps. */
object IsoTime {
    fun iso(epochMillis: Long): String =
        java.time.Instant.ofEpochMilli(epochMillis).toString()
}
