# Moshi / Retrofit DTOs are referenced reflectively by generated adapters.
# Keep DTO classes and their members so JSON (de)serialization survives R8.
-keep class com.michealrayberry.console.data.remote.dto.** { *; }

# Moshi generated adapters.
-keep class **JsonAdapter { *; }
-keepnames @com.squareup.moshi.JsonClass class *

# Retrofit keeps generic signatures for suspend functions.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
