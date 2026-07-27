package com.michealrayberry.console.data.remote.dto

import com.squareup.moshi.JsonClass

/** POST /auth/login request body. */
@JsonClass(generateAdapter = true)
data class LoginRequest(
    val email: String,
    val password: String,
)

/** POST /auth/login response. */
@JsonClass(generateAdapter = true)
data class LoginResponse(
    val token: String,
    val user: UserDto,
)

/**
 * Authenticated user as reported by the server.
 *
 * IMPORTANT: [role] and all authority come from the backend. The client never
 * infers role from the email address or any local heuristic.
 */
@JsonClass(generateAdapter = true)
data class UserDto(
    val id: String,
    val displayName: String,
    val role: String,
)
