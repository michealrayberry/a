package com.michealrayberry.console.di

import android.content.Context
import androidx.room.Room
import com.michealrayberry.console.data.local.ConsoleDatabase
import com.michealrayberry.console.data.local.dao.PendingEvidenceDao
import com.michealrayberry.console.data.local.dao.RequirementCacheDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** Provides the Room database and its DAOs. */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): ConsoleDatabase =
        Room.databaseBuilder(context, ConsoleDatabase::class.java, ConsoleDatabase.NAME)
            // No destructive fallback: this DB can hold un-uploaded evidence.
            // Real migrations are required for every schema change.
            .build()

    @Provides
    fun providePendingEvidenceDao(db: ConsoleDatabase): PendingEvidenceDao = db.pendingEvidenceDao()

    @Provides
    fun provideRequirementCacheDao(db: ConsoleDatabase): RequirementCacheDao = db.requirementCacheDao()
}
