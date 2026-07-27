package com.michealrayberry.console.ui.record

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.michealrayberry.console.camera.GuidedRecordingController

/**
 * Record flow container. Shows a preflight checklist until camera + mic are
 * granted, then binds CameraX and drives the guided sequence. There is no
 * editing UI anywhere — only capture. On completion it hands off to review.
 */
@Composable
fun RecordScreen(
    onCaptured: (pendingId: String) -> Unit,
    onCancel: () -> Unit,
    viewModel: RecordViewModel = hiltViewModel(),
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // Reflect currently-granted permissions into the preflight state.
    LaunchedEffect(Unit) {
        viewModel.updatePreflight(
            cameraGranted = context.hasPermission(Manifest.permission.CAMERA),
            micGranted = context.hasPermission(Manifest.permission.RECORD_AUDIO),
        )
    }

    // Navigate onward once a take is queued.
    LaunchedEffect(ui.capturedPendingId) {
        ui.capturedPendingId?.let(onCaptured)
    }

    when {
        ui.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        ui.error != null -> Box(Modifier.fillMaxSize(), Alignment.Center) { Text(ui.error!!) }
        !ui.preflightPassed -> PreflightChecklist(
            cameraGranted = ui.cameraGranted,
            micGranted = ui.micGranted,
            onGranted = { cam, mic -> viewModel.updatePreflight(cam, mic) },
            onCancel = onCancel,
        )
        else -> {
            val controller = viewModel.controller
            if (controller == null) {
                Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            } else {
                GuidedRecorder(
                    controller = controller,
                    onFinalize = viewModel::finalizeCapture,
                    onCancel = onCancel,
                )
            }
        }
    }
}

/** Preflight checklist: explicit gates before any capture can begin. */
@Composable
private fun PreflightChecklist(
    cameraGranted: Boolean,
    micGranted: Boolean,
    onGranted: (camera: Boolean, mic: Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        onGranted(
            result[Manifest.permission.CAMERA] ?: cameraGranted,
            result[Manifest.permission.RECORD_AUDIO] ?: micGranted,
        )
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Preflight checklist", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Before recording, confirm the essentials. Your recording is captured " +
                "in one continuous take — there is no trimming or editing.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ChecklistItem("Camera access", cameraGranted)
        ChecklistItem("Microphone access", micGranted)
        ChecklistItem("Good lighting and a quiet space", true)
        ChecklistItem("Enough storage for the take", true)

        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                launcher.launch(
                    arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO),
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Grant camera & microphone") }
        OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
    }
}

@Composable
private fun ChecklistItem(label: String, done: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(if (done) "✓" else "○", color = if (done) MaterialTheme.colorScheme.primary else Color.Gray)
        Spacer(Modifier.height(0.dp))
        Text("  $label", style = MaterialTheme.typography.bodyLarge)
    }
}

/** The live guided-recording surface: preview + teleprompter + step controls. */
@Composable
private fun GuidedRecorder(
    controller: GuidedRecordingController,
    onFinalize: (GuidedRecordingController.Capture) -> Unit,
    onCancel: () -> Unit,
) {
    val state by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }

    LaunchedEffect(Unit) {
        controller.bind(lifecycleOwner, previewView, useFrontCamera = true)
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

        Column(
            Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Teleprompter — the current step's line, variables resolved.
            if (state.teleprompter.isNotBlank()) {
                Text(
                    state.teleprompter,
                    style = MaterialTheme.typography.titleLarge,
                    color = Color.White,
                )
            }
            state.currentStep?.let { step ->
                Text(
                    step.instruction,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White.copy(alpha = 0.85f),
                )
            }
            Text(
                "Step ${state.stepIndex + 1}/${state.stepCount}  ·  " +
                    "hold ${state.stepElapsedSeconds}s  ·  total ${state.totalElapsedSeconds}s",
                fontFamily = FontFamily.Monospace,
                color = Color.White,
                style = MaterialTheme.typography.labelLarge,
            )

            when (state.phase) {
                GuidedRecordingController.Phase.IDLE ->
                    Button(onClick = controller::start, modifier = Modifier.fillMaxWidth()) {
                        Text("Start recording")
                    }

                GuidedRecordingController.Phase.RECORDING -> {
                    val isLast = state.stepIndex >= state.stepCount - 1
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (!isLast) {
                            Button(
                                onClick = { controller.advanceStep() },
                                enabled = state.minHoldSatisfied,
                                modifier = Modifier.weight(1f),
                            ) { Text(if (state.minHoldSatisfied) "Next step" else "Hold…") }
                        }
                        Button(
                            onClick = { controller.stopAndFinalize(onFinalize) },
                            enabled = state.minHoldSatisfied,
                            modifier = Modifier.weight(1f),
                        ) { Text("Finish") }
                    }
                }

                GuidedRecordingController.Phase.FINALIZING,
                GuidedRecordingController.Phase.COMPLETED ->
                    CircularProgressIndicator(color = Color.White)

                GuidedRecordingController.Phase.PREPARING ->
                    Text("Preparing camera…", color = Color.White)

                GuidedRecordingController.Phase.ERROR ->
                    OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) {
                        Text(state.error ?: "Camera error")
                    }
            }
        }
    }
}

private fun android.content.Context.hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
