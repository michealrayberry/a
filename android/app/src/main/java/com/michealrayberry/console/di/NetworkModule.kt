package com.michealrayberry.console.di

import com.michealrayberry.console.BuildConfig
import com.michealrayberry.console.data.remote.ApiService
import com.michealrayberry.console.data.remote.AuthInterceptor
import com.squareup.moshi.Moshi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

/**
 * Networking graph. The base URL comes from [BuildConfig.API_BASE_URL], which is
 * a build-time value (see app/build.gradle.kts) — no host or secret is
 * hardcoded in source. The only credential ever attached is the per-session
 * Bearer token, injected by [AuthInterceptor].
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    // DTO adapters are generated at compile time by moshi-kotlin-codegen
    // (@JsonClass(generateAdapter = true)); no reflection adapter is needed.
    @Provides
    @Singleton
    fun provideMoshi(): Moshi = Moshi.Builder().build()

    @Provides
    @Singleton
    fun provideOkHttp(authInterceptor: AuthInterceptor): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }
        return OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .addInterceptor(logging)
            // Generous read timeout: evidence registration can follow a large
            // upload. Uploads themselves run in the WorkManager foreground job.
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient, moshi: Moshi): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .client(client)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()

    @Provides
    @Singleton
    fun provideApiService(retrofit: Retrofit): ApiService = retrofit.create(ApiService::class.java)
}
