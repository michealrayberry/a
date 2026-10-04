package com.michealrayberry.console.integrity

import org.junit.Assert.assertEquals
import org.junit.Test

class PrivateDnsProbeTest {
    @Test fun strictHostnameIsReportedAsHostname() =
        assertEquals("hostname", PrivateDnsProbe.classify(true, "abc123.dns.nextdns.io"))

    @Test fun automaticModeIsOpportunistic() =
        assertEquals("opportunistic", PrivateDnsProbe.classify(true, null))

    @Test fun offIsOff() = assertEquals("off", PrivateDnsProbe.classify(false, null))

    @Test fun unobservableIsUnknown() = assertEquals("unknown", PrivateDnsProbe.classify(null, null))

    /** Strict mode that cannot currently resolve still names the configured host. */
    @Test fun strictButFailingStillReportsHostname() =
        assertEquals("hostname", PrivateDnsProbe.classify(false, "abc123.dns.nextdns.io"))
}
