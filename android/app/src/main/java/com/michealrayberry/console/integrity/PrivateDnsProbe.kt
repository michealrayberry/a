package com.michealrayberry.console.integrity

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import android.os.Build
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads the phone's Private DNS state from the active network's
 * [LinkProperties] (public API, API 28+). Read-only observation: this app never
 * changes Private DNS, never manages the device, and needs no special
 * permission beyond ACCESS_NETWORK_STATE.
 *
 * The server — not this class — decides whether the hostname is the RAY-PIXEL
 * NextDNS profile.
 */
@Singleton
class PrivateDnsProbe @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    data class Snapshot(
        /** "off" | "opportunistic" | "hostname" | "unknown" (server contract). */
        val mode: String,
        val host: String?,
        /** "WIFI" | "CELLULAR" | "OTHER" | "NONE" (server contract). */
        val network: String,
    )

    fun snapshot(): Snapshot {
        val cm = context.getSystemService(ConnectivityManager::class.java)
            ?: return Snapshot(MODE_UNKNOWN, null, NETWORK_NONE)
        val active = cm.activeNetwork ?: return Snapshot(MODE_UNKNOWN, null, NETWORK_NONE)
        val caps = cm.getNetworkCapabilities(active)
        val network = when {
            caps == null -> NETWORK_NONE
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NETWORK_WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NETWORK_CELLULAR
            else -> NETWORK_OTHER
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return Snapshot(MODE_UNKNOWN, null, network)
        val lp: LinkProperties = cm.getLinkProperties(active) ?: return Snapshot(MODE_UNKNOWN, null, network)
        return Snapshot(classify(lp.isPrivateDnsActive, lp.privateDnsServerName), lp.privateDnsServerName, network)
    }

    companion object {
        const val MODE_OFF = "off"
        const val MODE_OPPORTUNISTIC = "opportunistic"
        const val MODE_HOSTNAME = "hostname"
        const val MODE_UNKNOWN = "unknown"
        const val NETWORK_WIFI = "WIFI"
        const val NETWORK_CELLULAR = "CELLULAR"
        const val NETWORK_OTHER = "OTHER"
        const val NETWORK_NONE = "NONE"

        /**
         * Android semantics: strict mode ("Private DNS provider hostname") sets a
         * server name; "Automatic" is active without a name; "Off" is inactive.
         */
        fun classify(privateDnsActive: Boolean?, serverName: String?): String = when {
            privateDnsActive == null -> MODE_UNKNOWN
            !serverName.isNullOrBlank() -> MODE_HOSTNAME
            privateDnsActive -> MODE_OPPORTUNISTIC
            else -> MODE_OFF
        }
    }
}
