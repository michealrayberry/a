package com.michealrayberry.console.ui.record

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.michealrayberry.console.BuildConfig
import com.michealrayberry.console.camera.GuidedRecordingController
import com.michealrayberry.console.data.local.entity.PendingEvidenceEntity
import com.michealrayberry.console.data.remote.dto.RecordingTemplateDto
import com.michealrayberry.console.data.repo.AuthRepository
import com.michealrayberry.console.data.repo.ProjectRepository
import com.michealrayberry.console.domain.RecordingContext
import com.michealrayberry.console.work.Hashing
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import javax.inject.Inject

/**
 * Owns the guided-recording flow for one requirement.
 *
 * Responsibilities:
 *  - Load the [RecordingContext] (template + ids) from the repository.
 *  - Own a [GuidedRecordingController] that runs the sequence engine.
 *  - On finalize: preserve the original file, compute its SHA-256, persist a
 *    durable pending-evidence row, and schedule the resumable upload. It does
 *    NOT mark anything submitted — that only happens when the server registers
 *    the evidence and returns the trusted receipt time.
 */
@HiltViewModel
class RecordViewModel @Inject constructor(
    @ApplicationContext private val appContext: Context,
    savedStateHandle: SavedStateHandle,
    private val projectRepository: ProjectRepository,
    private val authRepository: AuthRepository,
) : ViewModel() {

    private val requirementId: String = checkNotNull(savedStateHandle["requirementId"])

    private val _ui = MutableStateFlow(RecordUiState())
    val ui: StateFlow<RecordUiState> = _ui.asStateFlow()

    /** Non-null once the context loads and camera is ready to bind. */
    var controller: GuidedRecordingController? = null
        private set

    init {
        loadContext()
    }

    private fun loadContext() {
        viewModelScope.launch {
            _ui.value = _ui.value.copy(loading = true, error = null)
            projectRepository.recordingContext(requirementId)
                .onSuccess { context ->
                    controller = GuidedRecordingController(
                        appContext = appContext,
                        scope = viewModelScope,
                        template = RecordingTemplateDto(
                            name = context.requirementName,
                            scriptVersion = context.scriptVersion,
                            requiredVariables = context.requiredVariables,
                            steps = context.steps,
                        ),
                        variables = buildVariables(context),
                    )
                    _ui.value = _ui.value.copy(loading = false, context = context)
                }
                .onFailure {
                    _ui.value = _ui.value.copy(loading = false, error = it.message)
                }
        }
    }

    /** Preflight checklist gates before the camera can start. */
    fun updatePreflight(cameraGranted: Boolean, micGranted: Boolean) {
        _ui.value = _ui.value.copy(
            cameraGranted = cameraGranted,
            micGranted = micGranted,
        )
    }

    /**
     * Finalize the take: hash on a background dispatcher and persist it as a
     * RECORDED_LOCALLY row (preserving the original). It is NOT queued for
     * upload yet — the participant must accept it in review first. Emits the new
     * pending id so the UI can navigate to review.
     */
    fun finalizeCapture(capture: GuidedRecordingController.Capture) {
        val context = _ui.value.context ?: return
        viewModelScope.launch {
            _ui.value = _ui.value.copy(finalizing = true)
            val sha = withContext(Dispatchers.IO) { Hashing.sha256(capture.file) }
            val pendingId = UUID.randomUUID().toString()
            val entity = PendingEvidenceEntity(
                id = pendingId,
                requirementInstanceId = context.requirementId,
                type = "VIDEO",
                localFilePath = capture.file.absolutePath,
                sha256 = sha,
                sizeBytes = capture.file.length(),
                durationMs = capture.durationMs,
                captureStartedAt = capture.captureStartedAtIso,
                captureCompletedAt = capture.captureCompletedAtIso,
                scriptVersion = capture.scriptVersion,
                recordingTemplateVersion = capture.scriptVersion,
                appVersion = BuildConfig.VERSION_NAME,
            )
            projectRepository.saveRecordedLocally(entity)
            _ui.value = _ui.value.copy(finalizing = false, capturedPendingId = pendingId)
        }
    }

    /**
     * Teleprompter variable values. Date/day come from the server snapshot;
     * participantName would be resolved from [AuthRepository.identity] and
     * currentWeight from the latest verified weight in a full build. Left as
     * explicit blanks rather than fabricated values.
     */
    private fun buildVariables(context: RecordingContext): Map<String, String> = mapOf(
        "participantName" to "",
        "fullDate" to context.localDate,
        "projectDay" to context.dayNumber.toString(),
        "currentWeight" to "",
    )

    override fun onCleared() {
        controller?.cancel()
        super.onCleared()
    }
}

/** Immutable UI state for the record flow. */
data class RecordUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val context: RecordingContext? = null,
    val cameraGranted: Boolean = false,
    val micGranted: Boolean = false,
    val finalizing: Boolean = false,
    /** Set once a take is captured and queued; drives navigation to review. */
    val capturedPendingId: String? = null,
) {
    val preflightPassed: Boolean get() = cameraGranted && micGranted
}
