package com.michealrayberry.console.ui.nav

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.michealrayberry.console.ui.history.HistoryScreen
import com.michealrayberry.console.ui.notices.NoticesScreen
import com.michealrayberry.console.ui.project.ProjectScreen
import com.michealrayberry.console.ui.record.RecordScreen
import com.michealrayberry.console.ui.record.RecordingReviewScreen
import com.michealrayberry.console.ui.today.TodayScreen

/**
 * App shell: a bottom navigation bar over a [NavHost] with the five top-level
 * destinations plus the record-session and review routes. Unidirectional: each
 * screen owns a ViewModel and reads immutable state; navigation events flow up
 * as callbacks.
 */
@Composable
fun ConsoleNavHost() {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination

    Scaffold(
        bottomBar = {
            NavigationBar {
                TopDestination.entries.forEach { dest ->
                    val selected = currentRoute?.hierarchy?.any { it.route == dest.route } == true
                    NavigationBarItem(
                        selected = selected,
                        onClick = {
                            navController.navigate(dest.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(dest.icon, contentDescription = null) },
                        label = { Text(stringResource(dest.labelRes)) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = TopDestination.TODAY.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(TopDestination.TODAY.route) {
                TodayScreen(
                    onRecordRequirement = { reqId ->
                        navController.navigate(Routes.recordSession(reqId))
                    },
                )
            }
            composable(TopDestination.RECORD.route) {
                // The Record tab lists what can be captured today and routes into
                // a guided session; the tab itself is a launcher.
                TodayScreen(
                    captureMode = true,
                    onRecordRequirement = { reqId ->
                        navController.navigate(Routes.recordSession(reqId))
                    },
                )
            }
            composable(TopDestination.HISTORY.route) { HistoryScreen() }
            composable(TopDestination.NOTICES.route) { NoticesScreen() }
            composable(TopDestination.PROJECT.route) { ProjectScreen() }

            composable(
                route = Routes.RECORD_SESSION,
                arguments = listOf(navArgument("requirementId") { type = NavType.StringType }),
            ) {
                RecordScreen(
                    onCaptured = { pendingId ->
                        navController.navigate(Routes.review(pendingId)) {
                            popUpTo(TopDestination.TODAY.route)
                        }
                    },
                    onCancel = { navController.popBackStack() },
                )
            }

            composable(
                route = Routes.REVIEW,
                arguments = listOf(navArgument("pendingId") { type = NavType.StringType }),
            ) {
                RecordingReviewScreen(
                    onAccepted = {
                        navController.popBackStack(TopDestination.TODAY.route, inclusive = false)
                    },
                    onReRecord = { navController.popBackStack() },
                )
            }
        }
    }
}
