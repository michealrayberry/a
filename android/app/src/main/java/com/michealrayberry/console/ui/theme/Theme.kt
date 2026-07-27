package com.michealrayberry.console.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = OnAccent,
    background = Ink,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceHigh,
    onSurfaceVariant = TextSecondary,
    outline = Line,
    outlineVariant = Line,
    error = StatusMissed,
)

private val LightColors = lightColorScheme(
    primary = AccentPressed,
    onPrimary = OnAccent,
    background = Paper,
    onBackground = TextPrimaryLight,
    surface = PaperSurface,
    onSurface = TextPrimaryLight,
    surfaceVariant = Paper,
    onSurfaceVariant = TextSecondaryLight,
    outline = LineLight,
    outlineVariant = LineLight,
    error = StatusMissed,
)

/**
 * Material 3 theme for the whole app.
 *
 * Dynamic color is deliberately NOT used: this is a compliance instrument and
 * its neutral, restrained appearance must be stable and identical across
 * devices rather than adopting the user's wallpaper palette.
 */
@Composable
fun ProjectConsoleTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColors else LightColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = AppTypography,
        content = content,
    )
}
