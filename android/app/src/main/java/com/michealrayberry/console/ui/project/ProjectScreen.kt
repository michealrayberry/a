package com.michealrayberry.console.ui.project

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import com.michealrayberry.console.data.repo.AuthRepository
import com.michealrayberry.console.domain.Identity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import androidx.lifecycle.viewModelScope
import javax.inject.Inject

/**
 * Project / account screen. Displays the SERVER-provided identity, including
 * role. Role is shown for information only — the app never grants itself
 * capabilities based on it or on the account's email; the backend authorizes
 * every action.
 */
@HiltViewModel
class ProjectViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {
    val identity: StateFlow<Identity?> =
        authRepository.identity.stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), null,
        )

    fun signOut() = authRepository.signOut()
}

@Composable
fun ProjectScreen(viewModel: ProjectViewModel = hiltViewModel()) {
    val identity by viewModel.identity.collectAsStateWithLifecycle()
    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Project", style = MaterialTheme.typography.headlineSmall)
        if (identity != null) {
            Text(identity!!.displayName, style = MaterialTheme.typography.titleLarge)
            Text(
                "Role (server-assigned): ${identity!!.role}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "User id: ${identity!!.userId}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text("Not signed in.")
        }
        OutlinedButton(onClick = viewModel::signOut, modifier = Modifier.fillMaxWidth()) {
            Text("Sign out")
        }
    }
}
