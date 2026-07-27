package com.michealrayberry.console.ui.history

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.michealrayberry.console.data.local.entity.PendingEvidenceEntity
import com.michealrayberry.console.data.repo.ProjectRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import androidx.lifecycle.viewModelScope
import javax.inject.Inject

/**
 * History shows the durable upload queue — each captured take and its exact
 * device-side state (RECORDED_LOCALLY → QUEUED → UPLOADING → UPLOADED →
 * SUBMITTED → VERIFIED, or FAILED). This is the participant's honest audit of
 * what has actually reached the server versus what is only on the phone.
 */
@HiltViewModel
class HistoryViewModel @Inject constructor(
    repository: ProjectRepository,
) : ViewModel() {
    val queue: StateFlow<List<PendingEvidenceEntity>> =
        repository.observeUploadQueue().stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList(),
        )
}

@Composable
fun HistoryScreen(viewModel: HistoryViewModel = hiltViewModel()) {
    val items by viewModel.queue.collectAsStateWithLifecycle()
    LazyColumn(
        Modifier
            .fillMaxSize()
            .padding(16.dp),
    ) {
        items(items, key = { it.id }) { item ->
            Card(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 6.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text("${item.type} · ${item.requirementInstanceId}", style = MaterialTheme.typography.titleMedium)
                    Text(item.state.name, style = MaterialTheme.typography.labelLarge, fontFamily = FontFamily.Monospace)
                    item.serverReceivedAt?.let {
                        Text("Server receipt: $it", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                    }
                    item.lastError?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}
