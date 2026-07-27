package com.michealrayberry.console.ui.today

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.michealrayberry.console.data.repo.ProjectRepository
import com.michealrayberry.console.domain.TodaySnapshot
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Immutable UI state for the Today screen (single source of truth). */
data class TodayUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val snapshot: TodaySnapshot? = null,
    val error: String? = null,
)

/**
 * ViewModel for Today. Exposes a single [StateFlow] of [TodayUiState] and
 * accepts intents (refresh) — unidirectional data flow. It never computes
 * timeliness; it renders server state cached by the repository and triggers a
 * server refresh to reconcile after actions elsewhere.
 */
@HiltViewModel
class TodayViewModel @Inject constructor(
    private val repository: ProjectRepository,
) : ViewModel() {

    private val loadingFlags = MutableStateFlow(TransientFlags())

    val uiState: StateFlow<TodayUiState> =
        combine(repository.observeToday(), loadingFlags) { snapshot, flags ->
            TodayUiState(
                loading = snapshot == null && flags.everLoaded.not(),
                refreshing = flags.refreshing,
                snapshot = snapshot,
                error = flags.error,
            )
        }.stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = TodayUiState(),
        )

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            loadingFlags.value = loadingFlags.value.copy(refreshing = true, error = null)
            val result = repository.refreshToday()
            loadingFlags.value = loadingFlags.value.copy(
                refreshing = false,
                everLoaded = true,
                error = result.exceptionOrNull()?.let { "Couldn't reach the server. Showing last synced data." },
            )
        }
    }

    private data class TransientFlags(
        val refreshing: Boolean = false,
        val everLoaded: Boolean = false,
        val error: String? = null,
    )
}
