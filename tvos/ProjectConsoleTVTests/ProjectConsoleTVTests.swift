import XCTest
@testable import ProjectConsoleTV

final class ServerClockTests: XCTestCase {
    private let anchor = Date(timeIntervalSince1970: 1_800_000_000)

    func testNowAdvancesByMonotonicDeltaOnly() {
        let clock = ServerClock(serverTime: anchor, monotonicNow: 1_000_000_000)
        // 90 s of monotonic time later.
        let now = clock.now(monotonicNow: 91_000_000_000)
        XCTAssertEqual(now.timeIntervalSince(anchor), 90, accuracy: 0.001)
    }

    func testRemainingIsNeverNegative() {
        let clock = ServerClock(serverTime: anchor, monotonicNow: 0)
        let deadline = anchor.addingTimeInterval(10)
        XCTAssertEqual(clock.remaining(until: deadline, monotonicNow: 4_000_000_000), 6, accuracy: 0.001)
        XCTAssertEqual(clock.remaining(until: deadline, monotonicNow: 60_000_000_000), 0)
    }

    func testFormat() {
        XCTAssertEqual(ServerClock.format(0), "00:00:00")
        XCTAssertEqual(ServerClock.format(3_725.9), "01:02:05")
        XCTAssertEqual(ServerClock.format(36 * 3600), "36:00:00")
    }
}

final class ISODateTests: XCTestCase {
    func testParsesLuxonOffsetWithFraction() {
        let d = ISODate.parse("2026-11-13T22:00:59.999-05:00")
        XCTAssertNotNil(d)
        XCTAssertEqual(d, ISODate.parse("2026-11-14T03:00:59.999Z"))
    }

    func testParsesWithoutFraction() {
        XCTAssertNotNil(ISODate.parse("2026-11-14T03:00:59Z"))
    }

    func testDisplaysInProjectZoneNotDeviceZone() {
        // 03:00 UTC on Nov 14 is 10:00 PM ET on Nov 13 (EST, UTC-5).
        let s = ISODate.time("2026-11-14T03:00:00.000Z", zone: "America/New_York")
        XCTAssertTrue(s.contains("10:00"), s)
        XCTAssertTrue(s.contains("EST"), s)
    }

    func testNilAndGarbage() {
        XCTAssertNil(ISODate.parse(nil))
        XCTAssertNil(ISODate.parse("not a date"))
        XCTAssertEqual(ISODate.display(nil, zone: "America/New_York"), "—")
    }
}

final class DecodingTests: XCTestCase {
    func testTodayDecodesServerShape() throws {
        let json = """
        {
          "serverTime": "2026-11-13T18:00:00.000-05:00",
          "timeZone": "America/New_York",
          "localDate": "2026-11-13",
          "dayNumber": 117,
          "dayDeadline": "2026-11-14T04:59:59.999Z",
          "overallStatus": "OPEN",
          "day": { "id": "d1", "projectId": "p1", "localDate": "2026-11-13", "dayNumber": 117,
                   "configurationId": "c1", "overallStatus": "OPEN", "submissionVersion": 0,
                   "submittedAt": null, "deadlineAt": "2026-11-14T04:59:59.999Z", "lockedAt": null,
                   "lockedBy": null, "publicStatus": "PRIVATE", "publicPublishedAt": null },
          "requirements": [
            { "id": "r1", "projectDayId": "d1", "requirementCode": "DAILY_VIDEO", "name": "Daily inspection video",
              "evidenceType": "VIDEO", "mandatory": 1, "status": "NOT_STARTED",
              "deadlineAt": "2026-11-14T03:00:59.999Z", "grace": null, "submittedAt": null,
              "serverReceivedAt": null, "verifiedAt": null, "verifiedBy": null, "timeliness": null,
              "publicStatus": "PRIVATE" }
          ],
          "recordingTemplate": { "ignored": true }
        }
        """
        let today = try JSONDecoder().decode(TodayResponse.self, from: Data(json.utf8))
        XCTAssertEqual(today.dayNumber, 117)
        XCTAssertEqual(today.requirements.count, 1)
        XCTAssertTrue(today.requirements[0].isMandatory)
        XCTAssertTrue(today.requirements[0].isOutstanding)
    }

    func testNoticeFlags() throws {
        let json = """
        [{ "id": "n1", "projectId": "p1", "projectDayId": null, "type": "MISSED_DEADLINE",
           "title": "Missed: Weight entry", "body": "…", "issuedByRole": "SYSTEM", "issuedBy": null,
           "issuedAt": "2026-11-13T05:00:00.000Z", "responseRequired": 1, "responseDueAt": null,
           "acknowledgedAt": null, "publicStatus": "PRIVATE" }]
        """
        let notices = try JSONDecoder().decode([Notice].self, from: Data(json.utf8))
        XCTAssertTrue(notices[0].requiresResponse)
        XCTAssertFalse(notices[0].isAcknowledged)
    }
}

final class StatusStyleTests: XCTestCase {
    func testEveryStatusHasTextAndIcon() {
        for raw in ["VERIFIED", "LATE", "MISSED", "DEFICIENT", "NOT_STARTED", "UNDER_REVIEW", "EXCUSED", "SOMETHING_NEW", ""] {
            let s = StatusStyle(raw)
            XCTAssertFalse(s.label.isEmpty, raw)
            XCTAssertFalse(s.symbol.isEmpty, raw)
        }
        XCTAssertEqual(StatusStyle("UNDER_REVIEW").label, "Under Review")
    }
}

final class ComplianceGateTests: XCTestCase {
    private func req(_ name: String, _ status: String, mandatory: Bool = true) -> Requirement {
        Requirement(id: name, requirementCode: name, name: name, evidenceType: "VIDEO", mandatory: mandatory ? 1 : 0,
                    status: status, deadlineAt: "2026-11-14T03:00:59.999Z", grace: nil, submittedAt: nil,
                    serverReceivedAt: nil, verifiedAt: nil, timeliness: nil)
    }
    private let zone = "America/New_York"
    private let noonET = ISODate.parse("2026-11-13T17:00:00Z")!   // 12:00 PM EST

    func testLockedWhileMandatoryOwed() {
        let v = ComplianceGate.evaluate(requirements: [req("Video", "NOT_STARTED"), req("Weight", "SUBMITTED")],
                                        localDate: "2026-11-13", zone: zone, now: noonET, lockFrom: "00:00")
        XCTAssertEqual(v, .locked(owed: ["Video"], failed: []))
    }

    func testClearedOnSubmissionNotVerification() {
        let v = ComplianceGate.evaluate(requirements: [req("Video", "UNDER_REVIEW"), req("Weight", "SUBMITTED"),
                                                       req("Photo", "NOT_STARTED", mandatory: false)],
                                        localDate: "2026-11-13", zone: zone, now: noonET, lockFrom: "00:00")
        XCTAssertEqual(v, .cleared)
    }

    func testMissingADeadlineNeverUnlocks() {
        let v = ComplianceGate.evaluate(requirements: [req("Video", "MISSED"), req("Weight", "VERIFIED")],
                                        localDate: "2026-11-13", zone: zone, now: noonET, lockFrom: "18:00")
        XCTAssertEqual(v, .locked(owed: [], failed: ["Video"]))
    }

    func testLockWindowNotStarted() {
        let v = ComplianceGate.evaluate(requirements: [req("Video", "NOT_STARTED")],
                                        localDate: "2026-11-13", zone: zone, now: noonET, lockFrom: "18:00")
        XCTAssertEqual(v, .notYetLocking(startsAt: ISODate.parse("2026-11-13T23:00:00Z")!))  // 6 PM EST
    }

    func testLockWindowStarted() {
        let sevenPM = ISODate.parse("2026-11-14T00:00:00Z")!
        let v = ComplianceGate.evaluate(requirements: [req("Video", "IN_PROGRESS")],
                                        localDate: "2026-11-13", zone: zone, now: sevenPM, lockFrom: "18:00")
        XCTAssertTrue(v.isLocked)
    }
}
