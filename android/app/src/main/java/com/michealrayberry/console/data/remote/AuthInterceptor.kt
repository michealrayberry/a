package com.michealrayberry.console.data.remote

import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Attaches the Bearer JWT to every request except the unauthenticated login
 * call. The token is a per-session credential read from [TokenStore]; nothing
 * secret is compiled into the app.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val tokenStore: TokenStore,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()

        // Never decorate the login request.
        if (request.url.encodedPath.endsWith("/auth/login")) {
            return chain.proceed(request)
        }

        val token = tokenStore.currentToken()
        val decorated = if (token.isNullOrBlank()) {
            request
        } else {
            request.newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        }
        return chain.proceed(decorated)
    }
}
