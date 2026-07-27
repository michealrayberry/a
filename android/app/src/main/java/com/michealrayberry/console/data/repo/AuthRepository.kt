package com.michealrayberry.console.data.repo

import com.michealrayberry.console.data.remote.ApiService
import com.michealrayberry.console.data.remote.TokenStore
import com.michealrayberry.console.data.remote.dto.LoginRequest
import com.michealrayberry.console.domain.Identity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Owns authentication. On successful login it persists the JWT and the
 * server-reported identity via [TokenStore].
 *
 * The [Identity.role] returned here is whatever the backend says — the app
 * exposes it for display/branching but performs no local authority checks based
 * on the account's email or any hardcoded rule.
 */
@Singleton
class AuthRepository @Inject constructor(
    private val api: ApiService,
    private val tokenStore: TokenStore,
) {
    /** Emits the current identity, or null when signed out. */
    val identity: Flow<Identity?> = tokenStore.session.map { session ->
        session?.let { Identity(it.userId, it.displayName, it.role) }
    }

    fun isSignedIn(): Boolean = tokenStore.currentToken() != null

    suspend fun login(email: String, password: String): Result<Identity> = runCatching {
        val response = api.login(LoginRequest(email = email, password = password))
        tokenStore.save(
            token = response.token,
            userId = response.user.id,
            displayName = response.user.displayName,
            role = response.user.role,
        )
        Identity(response.user.id, response.user.displayName, response.user.role)
    }

    fun signOut() = tokenStore.clear()
}
