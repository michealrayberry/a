package com.michealrayberry.console.work

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.michealrayberry.console.BuildConfig
import com.michealrayberry.console.data.prefs.AppPreferences
import com.michealrayberry.console.data.remote.ApiService
import com.michealrayberry.console.data.remote.TokenStore
import com.michealrayberry.console.data.remote.dto.HeartbeatRequest
import com.michealrayberry.console.integrity.PrivateDnsProbe
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.time.Instant

/**
 * Monitoring-integrity heartbeat (Phase 5).
 *
 * Reports — never changes — the phone's Private DNS mode/hostname, the active
 * network type, and whether the Recording Assistant has the permissions it
 * needs. The server decides what the report means (CONFIRMED / DISABLED /
 * MISCONFIGURED) and stamps the trusted receipt time.
 *
 * Not signed in → nothing to report; the work succeeds quietly. Network
 * failures retry with backoff; a missed heartbeat surfaces server-side as
 * PHONE HEARTBEAT LOST (DEGRADED), never as an accusation.
 */
@HiltWorker
class HeartbeatWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val api: ApiService,
    private val tokens: TokenStore,
    private val prefs: AppPreferences,
    private val probe: PrivateDnsProbe,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (tokens.currentToken() == null) return Result.success()
        val dns = probe.snapshot()
        return try {
            api.heartbeat(
                HeartbeatRequest(
                    deviceId = prefs.installId(),
                    privateDnsMode = dns.mode,
                    privateDnsHost = dns.host,
                    network = dns.network,
                    recordingReady = hasPermission(Manifest.permission.CAMERA) &&
                        hasPermission(Manifest.permission.RECORD_AUDIO),
                    appVersion = BuildConfig.VERSION_NAME,
                    clientTime = Instant.now().toString(),
                ),
            )
            Result.success()
        } catch (e: retrofit2.HttpException) {
            // 401/403: session ended — stop retrying until the user signs in again.
            if (e.code() == 401 || e.code() == 403) Result.success() else Result.retry()
        } catch (e: java.io.IOException) {
            Result.retry()
        }
    }

    private fun hasPermission(p: String) =
        ContextCompat.checkSelfPermission(applicationContext, p) == PackageManager.PERMISSION_GRANTED
}
