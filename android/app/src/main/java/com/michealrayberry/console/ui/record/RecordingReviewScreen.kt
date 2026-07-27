package com.michealrayberry.console.ui.record

import android.widget.VideoView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.File

/**
 * Review + accept/re-record. Plays back the preserved original file. The UI
 * offers exactly two choices — Accept (upload) or Re-record (discard) — and
 * NOTHING that alters the recording. No trim, no filters, no splice.
 */
@Composable
fun RecordingReviewScreen(
    onAccepted: () -> Unit,
    onReRecord: () -> Unit,
    viewModel: RecordingReviewViewModel = hiltViewModel(),
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()

    if (ui.loading) {
        Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        return
    }
    val pending = ui.pending
    if (pending == null) {
        Box(Modifier.fillMaxSize(), Alignment.Center) { Text("Recording not found.") }
        return
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Review your recording", style = MaterialTheme.typography.headlineSmall)

        // Playback only — a plain VideoView pointed at the preserved original.
        AndroidView(
            factory = { context ->
                VideoView(context).apply {
                    setVideoURI(File(pending.localFilePath).toUri())
                    setOnPreparedListener { it.isLooping = false }
                    seekTo(1)
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(9f / 16f),
            update = { it.start() },
        )

        // Integrity facts about the exact bytes captured.
        Text(
            "Duration ${(pending.durationMs ?: 0) / 1000}s  ·  " +
                "${pending.sizeBytes / (1024 * 1024)} MB",
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.labelLarge,
        )
        Text(
            "SHA-256 ${pending.sha256.take(16)}…",
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "Accepting queues a durable upload. Your requirement is only marked " +
                "submitted after the server registers the evidence and returns a " +
                "receipt time.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(
                onClick = { viewModel.reRecord(onReRecord) },
                modifier = Modifier.weight(1f),
            ) { Text("Re-record") }
            Button(
                onClick = { viewModel.accept(onAccepted) },
                modifier = Modifier.weight(1f),
            ) { Text("Accept & upload") }
        }
    }
}
