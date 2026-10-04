package com.michealrayberry.console.work

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.michealrayberry.console.integrity.PrivateDnsProbe
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Keeps the integrity heartbeat running.
 *
 *  - A periodic heartbeat every 15 minutes (WorkManager's minimum). Under Doze
 *    the OS may defer it; the server tolerates that (heartbeat loss is
 *    DEGRADED, reviewed only after a long gap).
 *  - An immediate heartbeat whenever the Private DNS state of the default
 *    network changes while the app process is alive, so switching Private DNS
 *    off is reported promptly rather than at the next periodic slot.
 */
@Singleton
class HeartbeatScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val workManager: WorkManager,
) {
    private var lastObserved: String? = null
    private var registered = false

    fun start() {
        val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        workManager.enqueueUniquePeriodicWork(
            PERIODIC_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES)
                .setConstraints(connected)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build(),
        )
        beatNow()
        watchPrivateDns()
    }

    /** One-off heartbeat (sign-in, Private DNS change). Replaces any queued one-off. */
    fun beatNow() {
        workManager.enqueueUniqueWork(
            IMMEDIATE_NAME,
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<HeartbeatWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build(),
        )
    }

    private fun watchPrivateDns() {
        if (registered || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                val state = PrivateDnsProbe.classify(lp.isPrivateDnsActive, lp.privateDnsServerName) +
                    "|" + (lp.privateDnsServerName ?: "")
                if (lastObserved != null && state != lastObserved) beatNow()
                lastObserved = state
            }
        })
        registered = true
    }

    private companion object {
        const val PERIODIC_NAME = "integrity-heartbeat"
        const val IMMEDIATE_NAME = "integrity-heartbeat-now"
    }
}
