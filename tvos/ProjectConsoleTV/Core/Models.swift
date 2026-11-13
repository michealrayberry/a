import Foundation

// Wire models for the Project Console API (docs/API.md). Status and timeliness
// strings are SERVER truth and are never derived on the device.

struct Identity: Codable, Equatable, Sendable {
    let id: String
    let displayName: String
    /// Authority source of truth — re-checked by the server on every request.
    let role: String
}

struct LoginResponse: Decodable, Sendable {
    let token: String
    let user: Identity
}

struct TodayResponse: Decodable, Sendable {
    let serverTime: String
    let timeZone: String
    let localDate: String
    let dayNumber: Int
    let dayDeadline: String
    let overallStatus: String
    let day: ProjectDay
    let requirements: [Requirement]
}

struct ProjectDay: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let localDate: String
    let dayNumber: Int
    let overallStatus: String
    let submittedAt: String?
    let deadlineAt: String
    let lockedAt: String?
    let publicStatus: String
}

struct Requirement: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let requirementCode: String
    let name: String
    let evidenceType: String
    /// SQLite stores this as 0/1.
    let mandatory: Int
    let status: String
    let deadlineAt: String
    let grace: String?
    let submittedAt: String?
    let serverReceivedAt: String?
    let verifiedAt: String?
    let timeliness: String?

    var isMandatory: Bool { mandatory == 1 }

    /// States in which the participant still owes evidence.
    var isOutstanding: Bool { status == "NOT_STARTED" || status == "IN_PROGRESS" }
}

struct DayDetailResponse: Decodable, Sendable {
    let day: ProjectDay
    let requirements: [Requirement]
    let audit: [AuditEvent]
}

struct AuditEvent: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let actorRole: String
    let action: String
    let previousState: String?
    let newState: String?
    let reason: String?
    let serverTimestamp: String
}

struct Notice: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let type: String
    let title: String
    let body: String
    let issuedByRole: String
    let issuedAt: String
    let responseRequired: Int
    let responseDueAt: String?
    let acknowledgedAt: String?

    var requiresResponse: Bool { responseRequired == 1 }
    var isAcknowledged: Bool { acknowledgedAt != nil }
}

// MARK: Public (unauthenticated) API

struct PublicStatus: Decodable, Sendable {
    let project: String
    let currentVerifiedWeight: Double?
    let startWeight: Double
    let goalWeight: Double
    let unit: String
    let totalVerifiedChange: Double?
    let currentProjectDay: Int?
    let latestDayStatus: String?
    let lastUpdated: String?
}

struct PublicDay: Decodable, Identifiable, Hashable, Sendable {
    let localDate: String
    let dayNumber: Int
    let overallStatus: String
    let publicPublishedAt: String?
    var id: String { localDate }
}

struct PublicWeight: Decodable, Identifiable, Hashable, Sendable {
    let weight: Double
    let unit: String
    let measuredAt: String
    var id: String { measuredAt }
}
