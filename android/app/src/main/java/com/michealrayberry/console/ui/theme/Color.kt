package com.michealrayberry.console.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Restrained palette (product blueprint: "explicitly NOT a playful fitness
 * look"). Near-black / white / neutral gray with a single restrained accent.
 *
 * Semantic status colors are muted and used sparingly — they signal server
 * state (timely / late / missed / deficient), never decoration.
 */

// Neutrals — the app is predominantly these.
val Ink = Color(0xFF0B0B0C)        // near-black background
val Surface = Color(0xFF141416)    // card surface (dark)
val SurfaceHigh = Color(0xFF1E1E21)
val Line = Color(0xFF2A2A2E)       // hairline dividers/outlines
val TextPrimary = Color(0xFFF3F3F4)
val TextSecondary = Color(0xFFA7A7AD)
val TextDisabled = Color(0xFF6C6C72)

// Light-scheme neutrals.
val Paper = Color(0xFFFAFAFA)
val PaperSurface = Color(0xFFFFFFFF)
val LineLight = Color(0xFFE2E2E4)
val TextPrimaryLight = Color(0xFF17181A)
val TextSecondaryLight = Color(0xFF55565B)

// Single restrained accent — a desaturated steel blue. Used for primary
// actions and the "recording live" affordance only.
val Accent = Color(0xFF4C7DA6)
val AccentPressed = Color(0xFF3C6488)
val OnAccent = Color(0xFFFFFFFF)

// Muted status colors (state signal, not brand).
val StatusTimely = Color(0xFF3E8E5A)   // VERIFIED / on-time
val StatusGrace = Color(0xFFB08A2E)    // in grace window
val StatusLate = Color(0xFFC77B3A)     // LATE
val StatusMissed = Color(0xFFB0503F)   // MISSED / REJECTED
val StatusNeutral = Color(0xFF6C6C72)  // NOT_STARTED / pending
