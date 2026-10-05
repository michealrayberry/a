package com.michealrayberry.console.integrity

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.michealrayberry.console.BuildConfig
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.InetAddress
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Phone-side accountability heartbeat (Phase 5 — monitoring integrity).
 *
 * Every ~15 minutes (WorkManager's minimum period; Doze may stretch it) this:
 *   1. asks the Worker for a one-time challenge nonce;
 *   2. resolves `<nonce>.<canary suffix>` through the *system* resolver, i.e.
 *      through whatever Private DNS is actually in effect. The Worker later
 *      looks for that exact name in RAY-PIXEL's NextDNS log — server-side
 *      evidence that this phone's DNS really goes through the AP's profile;
 *   3. reads Android's own view of Private DNS (LinkProperties, API 28+);
 *   4. asks https://test.nextdns.io which NextDNS profile (if any) answered;
 *   5. posts all of it to the Worker.
 *
 * Scope: DNS-path verification only. No browsing history, app usage, location,
 * contacts, messages, camera, or microphone is read or sent.
 *
 * Interpretation is server-side and conservative: a missing heartbeat (phone
 * off, asleep, offline) is DEGRADED, never treated as a confirmed bypass.
 */
@HiltWorker
class IntegrityHeartbeatWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val tokens: HeartbeatTokenStore,
) : CoroutineWorker(context, params) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val token = tokens.token() ?: return@withContext Result.success() // not linked yet
        val base = BuildConfig.WEB_CONTROLS_BASE_URL.trimEnd('/')
        if (base.isBlank()) return@withContext Result.success()

        try {
            // 1. Challenge.
            val challenge = post("$base/api/device/challenge", token, JSONObject())
            val nonce = challenge.optString("nonce").takeIf { it.isNotBlank() && it != "null" }
            val canaryHost = challenge.optString("canaryHost").takeIf { it.isNotBlank() && it != "null" }

            // 2. Canary lookup via the system resolver. NXDOMAIN is expected and
            //    fine — the query is still logged by NextDNS.
            if (canaryHost != null) runCatching { InetAddress.getAllByName(canaryHost) }

            // 3 + 4. Device-reported DNS state.
            val (network, privateDnsActive, privateDnsServer) = privateDnsState()
            val test = runCatching { nextDnsTest() }.getOrNull()

            // 5. Report.
            val body = JSONObject()
                .put("deviceTime", Instant.now().toString())
                .put("network", network)
                .put("privateDnsActive", privateDnsActive ?: JSONObject.NULL)
                .put("privateDnsServer", privateDnsServer ?: JSONObject.NULL)
                .put("nextdnsTest", test ?: JSONObject.NULL)
                .put("canaryNonce", nonce ?: JSONObject.NULL)
                .put("appVersion", BuildConfig.VERSION_NAME)
            val result = post("$base/api/device/heartbeat", token, body)
            tokens.recordResult("Heartbeat delivered ${result.optString("receivedAt")}")
            Result.success()
        } catch (e: UnauthorizedException) {
            // Token revoked by the AP — stop retrying; the AP Portal shows the gap.
            tokens.recordResult("Heartbeat token rejected — ask the AP to re-issue it")
            Result.failure()
        } catch (e: Exception) {
            tokens.recordResult("Heartbeat failed: ${e.message}")
            Result.retry()
        }
    }

    private fun privateDnsState(): Triple<String, Boolean?, String?> {
        val cm = applicationContext.getSystemService(ConnectivityManager::class.java)
        val active = cm.activeNetwork ?: return Triple("NONE", null, null)
        val caps = cm.getNetworkCapabilities(active)
        val network = when {
            caps == null -> "NONE"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
            else -> "OTHER"
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return Triple(network, null, null)
        val lp = cm.getLinkProperties(active) ?: return Triple(network, null, null)
        return Triple(network, lp.isPrivateDnsActive, lp.privateDnsServerName)
    }

    /** test.nextdns.io reports {"status":"ok","profile":"<id>",...} when NextDNS answered. */
    private fun nextDnsTest(): JSONObject {
        val req = Request.Builder().url("https://test.nextdns.io").header("Accept", "application/json").build()
        http.newCall(req).execute().use { res ->
            val json = JSONObject(res.body?.string().orEmpty())
            return JSONObject()
                .put("status", json.optString("status", "unknown"))
                .put("profile", json.optString("profile").takeIf { it.isNotBlank() } ?: JSONObject.NULL)
        }
    }

    private fun post(url: String, token: String, body: JSONObject): JSONObject {
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody(jsonType))
            .build()
        http.newCall(req).execute().use { res ->
            if (res.code == 401) throw UnauthorizedException()
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) error("HTTP ${res.code}")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    private class UnauthorizedException : Exception()

    companion object {
        const val UNIQUE_NAME = "web-controls-heartbeat"
    }
}
