package com.michealrayberry.console

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.michealrayberry.console.ui.nav.ConsoleNavHost
import com.michealrayberry.console.ui.theme.ProjectConsoleTheme
import dagger.hilt.android.AndroidEntryPoint

/**
 * Single-activity host. Hilt injects the whole graph via [AndroidEntryPoint];
 * all UI is Compose. Authentication gating (showing a sign-in screen when there
 * is no session) would sit above [ConsoleNavHost]; omitted here to keep the
 * skeleton focused on the participant flow.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ProjectConsoleTheme {
                ConsoleNavHost()
            }
        }
    }
}
