package com.michealrayberry.console

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application entry point.
 *
 * - [HiltAndroidApp] bootstraps dependency injection for the whole process.
 * - Implements [Configuration.Provider] so WorkManager is initialized *on
 *   demand* with a Hilt-aware [HiltWorkerFactory]. This is what lets
 *   [com.michealrayberry.console.work.ResumableUploadWorker] receive injected
 *   dependencies (repository, API, hashing) and, crucially, lets queued
 *   uploads resume after process death — the manifest disables WorkManager's
 *   default initializer so this configuration wins.
 */
@HiltAndroidApp
class ProjectConsoleApp : Application(), Configuration.Provider {

    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .build()
}
