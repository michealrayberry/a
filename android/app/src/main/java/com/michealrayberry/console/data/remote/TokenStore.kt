package com.michealrayberry.console.data.remote

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
 * Persists the session JWT and the server-reported identity.
 *
 * Storage is [EncryptedSharedPreferences] backed by the Android Keystore. The
 * token is a *session credential only* — it is NOT a secret baked into the app.
 * There are no API keys, signing keys, or shared secrets in the client. Role
 * and authority are read from what the server returned at login and are never
 * derived locally.
 *
 * Kept deliberately small and synchronous (backed by SharedPreferences) so
 * [AuthInterceptor] can read the token on OkHttp's network thread without
 * suspending. An in-memory [StateFlow] mirror lets the UI react to sign-in /
 * sign-out.
 */
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "console_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val _session = MutableStateFlow(readSession())
    val session: StateFlow<Session?> = _session.asStateFlow()

    /** Blocking read used by the network interceptor. */
    fun currentToken(): String? = prefs.getString(KEY_TOKEN, null)

    fun save(token: String, userId: String, displayName: String, role: String) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_USER_ID, userId)
            .putString(KEY_DISPLAY_NAME, displayName)
            .putString(KEY_ROLE, role)
            .apply()
        _session.value = readSession()
    }

    fun clear() {
        prefs.edit().clear().apply()
        _session.value = null
    }

    private fun readSession(): Session? {
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        return Session(
            token = token,
            userId = prefs.getString(KEY_USER_ID, "") ?: "",
            displayName = prefs.getString(KEY_DISPLAY_NAME, "") ?: "",
            role = prefs.getString(KEY_ROLE, "") ?: "",
        )
    }

    data class Session(
        val token: String,
        val userId: String,
        val displayName: String,
        /** Server-provided role. Authority source of truth. */
        val role: String,
    )

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_USER_ID = "user_id"
        const val KEY_DISPLAY_NAME = "display_name"
        const val KEY_ROLE = "role"
    }
}
