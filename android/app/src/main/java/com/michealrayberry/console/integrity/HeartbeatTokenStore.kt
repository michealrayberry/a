package com.michealrayberry.console.integrity

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Holds the per-device heartbeat token the Accountability Partner issued in the
 * AP Portal (Devices → Issue heartbeat token). It authorizes exactly two calls
 * on the AP-owned Web Controls Worker — `/api/device/challenge` and
 * `/api/device/heartbeat` — and nothing else: it cannot read DNS activity or
 * change any NextDNS setting. Stored encrypted with the Android Keystore.
 */
@Singleton
class HeartbeatTokenStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "web_controls_heartbeat",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val _linked = MutableStateFlow(token() != null)
    val linked: StateFlow<Boolean> = _linked.asStateFlow()

    fun token(): String? = prefs.getString(KEY_TOKEN, null)

    fun save(token: String) {
        require(token.startsWith("mrbd_")) { "Not a Web Controls heartbeat token" }
        prefs.edit().putString(KEY_TOKEN, token.trim()).apply()
        _linked.value = true
    }

    fun clear() {
        prefs.edit().remove(KEY_TOKEN).apply()
        _linked.value = false
    }

    fun lastResult(): String? = prefs.getString(KEY_LAST_RESULT, null)

    fun recordResult(summary: String) {
        prefs.edit().putString(KEY_LAST_RESULT, summary).apply()
    }

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_LAST_RESULT = "last_result"
    }
}
