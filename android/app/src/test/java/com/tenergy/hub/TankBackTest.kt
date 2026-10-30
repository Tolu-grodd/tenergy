package com.tenergy.hub

import org.junit.Assert.assertEquals
import org.junit.Test

/** The phone's comeback-timer length after a tank cut must equal the Worker's `tankBackSecs` (values produced by the Worker's own function). */
class TankBackTest {
    private fun check(h: Int, m: Int, expected: Int) {
        // the phone works from the clock in UTC milliseconds; Lagos is one hour ahead
        val now = java.time.OffsetDateTime.of(2026, 10, 22, h, m, 0, 0, java.time.ZoneOffset.ofHours(1)).toInstant().toEpochMilli()
        assertEquals("cut at %02d:%02d".format(h, m), expected, Auto.tankBackSecs("09:00", 90, now))
    }
    @Test fun sameAsTheWorker() {
        check(3, 33, 18167)
        check(8, 45, 5000)
        check(9, 0, 5000)
        check(9, 15, 5000)
        check(13, 0, 5000)
        check(14, 59, 5000)
        check(15, 0, 60000)
        check(19, 0, 46667)
        check(23, 50, 30556)
    }
}
