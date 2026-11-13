import Foundation
import UIKit
import Observation

/// Compliance-gated TV.
///
/// The gate decides, from SERVER requirement status, whether today's mandatory
/// evidence is in. tvOS does not let an app block other apps, so the actual
/// lock comes from Single App Mode on a supervised Apple TV (see
/// tvos/PARENTAL_CONTROLS.md):
///
/// - `manual`: the AP starts or ends Single App Mode from Apple Configurator.
///   The app only shows LOCKED or CLEARED, so the AP knows when to release.
/// - `autonomous`: the app asks tvOS to enter Single App Mode while locked and to
///   exit once cleared. This needs a supervised device with this bundle ID in
///   the restrictions profile's `autonomousSingleAppModePermittedAppIDs`. Apple
///   doesn't confirm tvOS support, so the app reports whether the request worked.
/// - `off`: no gate UI.
///
/// The mode is NOT editable in the app. It comes from the managed app
/// configuration, or else the build's Info.plist, so it can't be switched off
/// from the couch.
enum GateMode: String, Sendable {
    case off, manual, autonomous

    static var configured: GateMode {
        let managed = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed")
        let raw = (managed?["ComplianceGateMode"] as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "ComplianceGateMode") as? String)
            ?? "manual"
        return GateMode(rawValue: raw.lowercased()) ?? .manual
    }

    /// Project-zone wall time ("HH:mm") the daily lock window starts. "00:00" = all day.
    static var lockFrom: String {
        let managed = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed")
        return (managed?["ComplianceGateLockFrom"] as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "ComplianceGateLockFrom") as? String)
            ?? "00:00"
    }
}

enum GateVerdict: Equatable, Sendable {
    /// Every mandatory requirement for today has evidence in (or is excused).
    case cleared
    /// Today's lock window hasn't started yet.
    case notYetLocking(startsAt: Date)
    /// Locked. `owed` still needs submission; `failed` was missed or found
    /// deficient. Missing a deadline never unlocks the TV.
    case locked(owed: [String], failed: [String])

    var isLocked: Bool { if case .locked = self { true } else { false } }
}

enum ComplianceGate {
    /// Statuses that mean evidence is in, or the item no longer applies.
    private static let satisfied: Set<String> = [
        "SUBMITTED", "UNDER_REVIEW", "LATE", "VERIFIED", "LOCKED", "EXCUSED", "NOT_APPLICABLE",
    ]
    /// Statuses that keep the gate shut for the rest of the day.
    private static let failed: Set<String> = [
        "MISSED", "DEFICIENT", "VIOLATION_PENDING", "VIOLATION_ASSESSED",
    ]

    static func evaluate(
        requirements: [Requirement],
        localDate: String,
        zone: String,
        now: Date,
        lockFrom: String = GateMode.lockFrom
    ) -> GateVerdict {
        let mandatory = requirements.filter(\.isMandatory)
        let failedNames = mandatory.filter { failed.contains($0.status) }.map(\.name)
        let owedNames = mandatory.filter { !satisfied.contains($0.status) && !failed.contains($0.status) }.map(\.name)

        // A failed item locks the TV regardless of the lock window.
        if !failedNames.isEmpty { return .locked(owed: owedNames, failed: failedNames) }
        if owedNames.isEmpty { return .cleared }
        if let start = windowStart(localDate: localDate, wallTime: lockFrom, zone: zone), now < start {
            return .notYetLocking(startsAt: start)
        }
        return .locked(owed: owedNames, failed: [])
    }

    static func windowStart(localDate: String, wallTime: String, zone: String) -> Date? {
        let d = localDate.split(separator: "-").compactMap { Int($0) }
        let t = wallTime.split(separator: ":").compactMap { Int($0) }
        guard d.count == 3, t.count == 2, let tz = TimeZone(identifier: zone) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        return cal.date(from: DateComponents(year: d[0], month: d[1], day: d[2], hour: t[0], minute: t[1]))
    }
}

/// Owns the gate's live state and, in autonomous mode, drives Single App Mode.
@MainActor
@Observable
final class GateController {
    let mode = GateMode.configured
    private(set) var verdict: GateVerdict?
    private(set) var lastEvaluated: Date?
    /// Result of the most recent Single App Mode request (autonomous mode only).
    private(set) var autonomousStatus: String?

    var singleAppModeActive: Bool { UIAccessibility.isGuidedAccessEnabled }

    func update(with today: TodayResponse, serverNow: Date) async {
        guard mode != .off else { return }
        let v = ComplianceGate.evaluate(
            requirements: today.requirements, localDate: today.localDate, zone: today.timeZone, now: serverNow)
        verdict = v
        lastEvaluated = serverNow
        guard mode == .autonomous else { return }

        // Only change the lock on fresh server data. If the server can't be
        // reached, this isn't called and the TV stays as it is.
        let wantLocked = v.isLocked
        guard wantLocked != singleAppModeActive else {
            autonomousStatus = wantLocked ? "Single App Mode active" : "Unlocked"
            return
        }
        let ok = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            UIAccessibility.requestGuidedAccessSession(enabled: wantLocked) { cont.resume(returning: $0) }
        }
        autonomousStatus = ok
            ? (wantLocked ? "Locked: Single App Mode started" : "Cleared: Single App Mode ended")
            : "tvOS refused the Single App Mode request. The device isn't supervised, or this app isn't permitted for autonomous mode. Use manual mode."
    }
}
