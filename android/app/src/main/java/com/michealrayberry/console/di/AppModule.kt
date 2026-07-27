package com.michealrayberry.console.di

import android.content.Context
import androidx.work.WorkManager
import com.michealrayberry.console.work.ChunkedUploadTransport
import com.michealrayberry.console.work.EvidenceUploadTransport
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** App-level singletons and interface bindings. */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideWorkManager(@ApplicationContext context: Context): WorkManager =
        WorkManager.getInstance(context)
}

/** Interface -> implementation bindings. */
@Module
@InstallIn(SingletonComponent::class)
abstract class BindingsModule {

    /** Swap this binding to plug in a real resumable storage transport. */
    @Binds
    @Singleton
    abstract fun bindUploadTransport(impl: ChunkedUploadTransport): EvidenceUploadTransport
}
