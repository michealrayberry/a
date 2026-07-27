package com.michealrayberry.console.ui.today

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.michealrayberry.console.data.local.UploadState
import com.michealrayberry.console.domain.EvidenceType
import com.michealrayberry.console.domain.LocalUpload
import com.michealrayberry.console.domain.Requirement
import com.michealrayberry.console.domain.Timeliness
import com.michealrayberry.console.domain.TodaySnapshot
import com.michealrayberry.console.ui.common.ServerCountdown
import com.michealrayberry.console.ui.theme.CountdownStyle
import com.michealrayberry.console.ui.theme.StatusGrace
import com.michealrayberry.console.ui.theme.StatusLate
import com.michealrayberry.console.ui.theme.StatusMissed
import com.michealrayberry.console.ui.theme.StatusNeutral
import com.michealrayberry.console.ui.theme.StatusTimely
import kotlinx.coroutines.delay

/**
 * Today screen. Renders the day header with a live, server-anchored countdown,
 * a status strip, and one card per requirement showing SERVER status and — kept
 * visually distinct — the device-side local upload state.
 *
 * [captureMode] is used by the Record tab to bias the layout toward starting a
 * capture; the data and cards are identical.
 */
@Composable
fun TodayScreen(
    onRecordRequirement: (String) -> Unit,
    modifier: Modifier = Modifier,
    captureMode: Boolean = false,
    viewModel: TodayViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    when {
        state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        state.snapshot == null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            Text(state.error ?: "No data yet.")
        }
        else -> TodayContent(
            snapshot = state.snapshot!!,
            error = state.error,
            captureMode = captureMode,
            onRecordRequirement = onRecordRequirement,
            modifier = modifier,
        )
    }
}

@Composable
private fun TodayContent(
    snapshot: TodaySnapshot,
    error: String?,
    captureMode: Boolean,
    onRecordRequirement: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Spacer(Modifier.height(8.dp)) }
        item { DayHeader(snapshot) }
        item { StatusStrip(snapshot) }
        if (error != null) {
            item {
                Text(
                    error,
                    style = MaterialTheme.typography.labelLarge,
                    color = StatusLate,
                )
            }
        }
        items(snapshot.requirements, key = { it.id }) { req ->
            RequirementCard(
                requirement = req,
                emphasizeCapture = captureMode,
                onRecord = { onRecordRequirement(req.id) },
            )
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

/** Day header with the hero, server-anchored countdown in tabular monospace. */
@Composable
private fun DayHeader(snapshot: TodaySnapshot) {
    // Tick once per second to recompute remaining time from the monotonic clock.
    var remaining by remember(snapshot.dayDeadline, snapshot.serverTimeAtSync) {
        mutableLongStateOf(
            ServerCountdown.remainingMillis(
                snapshot.dayDeadline,
                snapshot.serverTimeAtSync,
                snapshot.deviceElapsedRealtimeAtSync,
            ),
        )
    }
    LaunchedEffect(snapshot.dayDeadline, snapshot.serverTimeAtSync) {
        while (true) {
            remaining = ServerCountdown.remainingMillis(
                snapshot.dayDeadline,
                snapshot.serverTimeAtSync,
                snapshot.deviceElapsedRealtimeAtSync,
            )
            delay(1000)
        }
    }

    Column {
        Text(
            "Day ${snapshot.dayNumber}",
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            "${snapshot.localDate} · ${snapshot.timeZone}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            ServerCountdown.format(remaining),
            style = CountdownStyle,
            color = if (remaining == 0L) StatusMissed else MaterialTheme.colorScheme.onBackground,
        )
        Text(
            "until today's deadline (server time)",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Compact strip summarizing counts by server status. */
@Composable
private fun StatusStrip(snapshot: TodaySnapshot) {
    val submitted = snapshot.requirements.count {
        it.status in listOf("SUBMITTED", "UNDER_REVIEW", "VERIFIED", "CORRECTION_SUBMITTED")
    }
    val total = snapshot.requirements.size
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Overall: ${snapshot.overallStatus}", style = MaterialTheme.typography.titleMedium)
            Text(
                "$submitted / $total submitted",
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}

@Composable
private fun RequirementCard(
    requirement: Requirement,
    emphasizeCapture: Boolean,
    onRecord: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(requirement.timeliness, requirement.status)
                Spacer(Modifier.size(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(requirement.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        "${requirement.code} · ${requirement.evidenceType}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusBadge(requirement.status)
            }

            // Device-side local upload state, visually SEPARATE from server
            // status so a local recording is never mistaken for a submission.
            requirement.localUpload?.let { UploadRow(it) }

            if (requirement.evidenceType == EvidenceType.VIDEO && !requirement.isServerSubmitted()) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onRecord, modifier = Modifier.fillMaxWidth()) {
                    Text(if (emphasizeCapture) "Start guided recording" else "Record")
                }
            }
        }
    }
}

@Composable
private fun UploadRow(upload: LocalUpload) {
    Spacer(Modifier.height(8.dp))
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Spacer(Modifier.height(8.dp))
    val label = when (upload.state) {
        UploadState.RECORDED_LOCALLY -> "Recorded on device — not yet submitted"
        UploadState.QUEUED -> "Queued for upload"
        UploadState.UPLOADING -> {
            val pct = if (upload.sizeBytes > 0) {
                (upload.bytesUploaded * 100 / upload.sizeBytes)
            } else 0
            "Uploading… $pct%"
        }
        UploadState.UPLOADED -> "Uploaded — registering with server"
        UploadState.SUBMITTED -> "Submitted · server receipt ${upload.serverReceivedAt ?: ""}"
        UploadState.VERIFIED -> "Verified by reviewer"
        UploadState.FAILED -> "Upload failed — will retry"
    }
    Text(
        label,
        style = MaterialTheme.typography.labelLarge,
        color = when (upload.state) {
            UploadState.SUBMITTED, UploadState.VERIFIED -> StatusTimely
            UploadState.FAILED -> StatusMissed
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
}

@Composable
private fun StatusDot(timeliness: Timeliness, status: String) {
    val color = statusColor(timeliness, status)
    Box(
        Modifier
            .size(12.dp)
            .clip(CircleShape)
            .background(color),
    )
}

@Composable
private fun StatusBadge(status: String) {
    Text(
        status,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

private fun statusColor(timeliness: Timeliness, status: String): Color = when {
    status == "VERIFIED" -> StatusTimely
    status == "MISSED" || status == "REJECTED" -> StatusMissed
    timeliness == Timeliness.ON_TIME -> StatusTimely
    timeliness == Timeliness.GRACE -> StatusGrace
    timeliness == Timeliness.LATE -> StatusLate
    timeliness == Timeliness.MISSED -> StatusMissed
    else -> StatusNeutral
}

private fun Requirement.isServerSubmitted(): Boolean =
    status in listOf("SUBMITTED", "UNDER_REVIEW", "VERIFIED", "CORRECTION_SUBMITTED", "LOCKED")
