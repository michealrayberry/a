package com.michealrayberry.console.integrity

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject

@HiltViewModel
class HeartbeatLinkViewModel @Inject constructor(
    private val store: HeartbeatTokenStore,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    val linked = store.linked
    fun lastResult(): String? = store.lastResult()

    fun link(token: String): String? = runCatching {
        store.save(token)
        HeartbeatScheduler.schedule(context)
    }.exceptionOrNull()?.message
}

/**
 * Links this phone to the AP's Web Controls integrity monitoring. Unlinking is
 * deliberately not offered here: removing the heartbeat is a change to an
 * accountability control and needs AP approval (the AP revokes the token in
 * the portal). The participant always retains physical control of the phone;
 * stopping heartbeats by other means simply shows up as a reporting gap.
 */
@Composable
fun HeartbeatLinkCard(viewModel: HeartbeatLinkViewModel = hiltViewModel()) {
    val linked by viewModel.linked.collectAsStateWithLifecycle()
    var token by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Accountability heartbeat", style = MaterialTheme.typography.titleMedium)
            if (linked) {
                Text("Linked. Reports Private DNS status to the AP every ~15 minutes.")
                viewModel.lastResult()?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                Text("Enter the heartbeat token issued in the AP Portal.")
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("Heartbeat token") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                OutlinedButton(onClick = { error = viewModel.link(token) }, modifier = Modifier.fillMaxWidth()) {
                    Text("Link this phone")
                }
            }
        }
    }
}
