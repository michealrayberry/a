package com.michealrayberry.console.ui.notices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.michealrayberry.console.data.remote.dto.NoticeDto
import com.michealrayberry.console.data.repo.ProjectRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Notices from the compliance engine. The participant can ACKNOWLEDGE a notice
 * (and, via the violation endpoint, acknowledge — never edit — a violation).
 * Acknowledgement is an action the server records; the app cannot alter the
 * notice itself.
 */
@HiltViewModel
class NoticesViewModel @Inject constructor(
    private val repository: ProjectRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(NoticesUiState())
    val state: StateFlow<NoticesUiState> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true)
            repository.notices()
                .onSuccess { _state.value = NoticesUiState(loading = false, notices = it) }
                .onFailure { _state.value = _state.value.copy(loading = false, error = it.message) }
        }
    }

    fun acknowledge(id: String) {
        viewModelScope.launch {
            repository.acknowledgeNotice(id).onSuccess { refresh() }
        }
    }
}

data class NoticesUiState(
    val loading: Boolean = true,
    val notices: List<NoticeDto> = emptyList(),
    val error: String? = null,
)

@Composable
fun NoticesScreen(viewModel: NoticesViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LazyColumn(
        Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(state.notices, key = { it.id }) { notice ->
            Card(
                Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text(notice.title ?: notice.kind ?: "Notice", style = MaterialTheme.typography.titleMedium)
                    notice.body?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    if (notice.acknowledgedAt == null) {
                        OutlinedButton(onClick = { viewModel.acknowledge(notice.id) }) {
                            Text("Acknowledge")
                        }
                    } else {
                        Text(
                            "Acknowledged ${notice.acknowledgedAt}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
