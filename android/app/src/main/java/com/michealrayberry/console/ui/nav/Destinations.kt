package com.michealrayberry.console.ui.nav

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.ui.graphics.vector.ImageVector
import com.michealrayberry.console.R

/** The five bottom-navigation destinations. */
enum class TopDestination(
    val route: String,
    val labelRes: Int,
    val icon: ImageVector,
) {
    TODAY("today", R.string.nav_today, Icons.Outlined.CalendarToday),
    RECORD("record", R.string.nav_record, Icons.Outlined.Videocam),
    HISTORY("history", R.string.nav_history, Icons.Outlined.History),
    NOTICES("notices", R.string.nav_notices, Icons.Outlined.Notifications),
    PROJECT("project", R.string.nav_project, Icons.Outlined.FolderOpen),
}

/** Non-tab routes reachable via navigation. */
object Routes {
    /** Guided recording for a specific requirement instance. */
    const val RECORD_SESSION = "record/{requirementId}"

    fun recordSession(requirementId: String) = "record/$requirementId"

    /** Review captured take (accept / re-record). */
    const val REVIEW = "review/{pendingId}"

    fun review(pendingId: String) = "review/$pendingId"
}
