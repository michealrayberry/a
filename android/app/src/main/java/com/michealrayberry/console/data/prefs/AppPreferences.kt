package com.michealrayberry.console.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

// Non-sensitive UI/behavior preferences only. Anything security-relevant (the
// session token) lives in EncryptedSharedPreferences via TokenStore, not here.
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "console_prefs")

/**
 * User preferences backed by Jetpack DataStore.
 *
 * Deliberately holds only display/behavior toggles: teleprompter visibility,
 * front/back lens, and a hint of the last synced date for cold-start UX. No
 * authority, timeliness, or secret data is stored here.
 */
@Singleton
class AppPreferences @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val store = context.dataStore

    val teleprompterEnabled: Flow<Boolean> =
        store.data.map { it[KEY_TELEPROMPTER] ?: true }

    val useFrontCamera: Flow<Boolean> =
        store.data.map { it[KEY_FRONT_CAMERA] ?: true }

    val lastSyncedLocalDate: Flow<String?> =
        store.data.map { it[KEY_LAST_SYNCED_DATE] }

    suspend fun setTeleprompterEnabled(enabled: Boolean) {
        store.edit { it[KEY_TELEPROMPTER] = enabled }
    }

    suspend fun setUseFrontCamera(front: Boolean) {
        store.edit { it[KEY_FRONT_CAMERA] = front }
    }

    suspend fun setLastSyncedLocalDate(date: String) {
        store.edit { it[KEY_LAST_SYNCED_DATE] = date }
    }

    private companion object {
        val KEY_TELEPROMPTER = booleanPreferencesKey("teleprompter_enabled")
        val KEY_FRONT_CAMERA = booleanPreferencesKey("use_front_camera")
        val KEY_LAST_SYNCED_DATE = stringPreferencesKey("last_synced_date")
    }
}
