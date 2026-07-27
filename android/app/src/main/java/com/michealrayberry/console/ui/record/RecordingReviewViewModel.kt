package com.michealrayberry.console.ui.record

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.michealrayberry.console.data.local.entity.PendingEvidenceEntity
import com.michealrayberry.console.data.repo.ProjectRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Review a captured take. The only two outcomes are ACCEPT (queue the durable
 * upload) and RE-RECORD (discard the local take). There is deliberately no
 * trim/filter/splice action — playback and a binary decision only.
 */
@HiltViewModel
class RecordingReviewViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repository: ProjectRepository,
) : ViewModel() {

    private val pendingId: String = checkNotNull(savedStateHandle["pendingId"])

    private val _ui = MutableStateFlow(ReviewUiState())
    val ui: StateFlow<ReviewUiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            _ui.value = _ui.value.copy(pending = repository.pendingById(pendingId), loading = false)
        }
    }

    /** Accept: schedule the resumable upload. Submission still requires the
     *  server to register the evidence and return the trusted receipt time. */
    fun accept(onDone: () -> Unit) {
        viewModelScope.launch {
            repository.confirmAndUpload(pendingId)
            onDone()
        }
    }

    /** Re-record: discard this local take and its file. */
    fun reRecord(onDone: () -> Unit) {
        viewModelScope.launch {
            repository.discardPending(pendingId)
            onDone()
        }
    }
}

data class ReviewUiState(
    val loading: Boolean = true,
    val pending: PendingEvidenceEntity? = null,
)
