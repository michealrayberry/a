package com.michealrayberry.console.data.remote

import com.michealrayberry.console.data.remote.dto.AckResponse
import com.michealrayberry.console.data.remote.dto.EvidenceRequest
import com.michealrayberry.console.data.remote.dto.EvidenceResponse
import com.michealrayberry.console.data.remote.dto.ExternalLinkRequest
import com.michealrayberry.console.data.remote.dto.ExternalLinkResponse
import com.michealrayberry.console.data.remote.dto.LoginRequest
import com.michealrayberry.console.data.remote.dto.LoginResponse
import com.michealrayberry.console.data.remote.dto.NoticeDto
import com.michealrayberry.console.data.remote.dto.TodayResponse
import com.michealrayberry.console.data.remote.dto.WeightRequest
import com.michealrayberry.console.data.remote.dto.WeightResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * Retrofit description of the backend REST surface. Endpoints mirror the
 * Node/TypeScript API exactly; no client-invented endpoints exist here.
 *
 * All participant routes require a Bearer JWT — added transparently by
 * [AuthInterceptor], so no @Header token parameter is needed at call sites.
 */
interface ApiService {

    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @GET("participant/today")
    suspend fun today(): TodayResponse

    /** Register an evidence record. Response carries the trusted receipt time. */
    @POST("participant/evidence")
    suspend fun submitEvidence(@Body body: EvidenceRequest): EvidenceResponse

    @POST("participant/weights")
    suspend fun submitWeight(@Body body: WeightRequest): WeightResponse

    @POST("participant/external-links")
    suspend fun submitExternalLink(@Body body: ExternalLinkRequest): ExternalLinkResponse

    @GET("participant/notices")
    suspend fun notices(): List<NoticeDto>

    @POST("participant/notices/{id}/acknowledge")
    suspend fun acknowledgeNotice(@Path("id") id: String): AckResponse

    @POST("participant/violations/{id}/acknowledge")
    suspend fun acknowledgeViolation(@Path("id") id: String): AckResponse
}
