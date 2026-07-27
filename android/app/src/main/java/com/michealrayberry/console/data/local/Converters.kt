package com.michealrayberry.console.data.local

import androidx.room.TypeConverter

/** Room type converters for enums stored as their stable string name. */
class Converters {
    @TypeConverter
    fun uploadStateToString(state: UploadState): String = state.name

    @TypeConverter
    fun stringToUploadState(value: String): UploadState =
        runCatching { UploadState.valueOf(value) }.getOrDefault(UploadState.FAILED)
}
