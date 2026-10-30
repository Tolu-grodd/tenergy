package com.tenergy.hub

import org.junit.Assume
import org.junit.Test

/** Does a plug's own timer (data point 9, "countdown_1") switch it by itself? Runs only when TUYA_IP, TUYA_ID, TUYA_KEY and TUYA_TIMER=1 are set. Switches the plug off for the length of the timer. */
class TuyaTimerTest {
    @Test fun theTimerSwitchesAnOffPlugOnByItself() {
        val ip = System.getenv("TUYA_IP"); val id = System.getenv("TUYA_ID"); val key = System.getenv("TUYA_KEY")
        Assume.assumeTrue(ip != null && id != null && key != null && System.getenv("TUYA_TIMER") == "1")
        val secs = (System.getenv("TUYA_TIMER_SECS") ?: "45").toInt()
        val d = TuyaDevice(id!!, key!!, ip!!); d.connect()
        val t0 = System.currentTimeMillis(); fun at() = "%5.1fs".format((System.currentTimeMillis() - t0) / 1000.0)
        val start = d.query(); println("TIMER start: relay=${start["1"]} timer=${start["9"]}")
        d.set(mapOf("1" to false)); Thread.sleep(1500)
        val off = d.query(); println("TIMER ${at()} after switching off: relay=${off["1"]} timer=${off["9"]}")
        d.set(mapOf("9" to secs)); println("TIMER ${at()} timer set to $secs s (nothing else will be sent)")
        var lastRelay: Any? = off["1"]; var switchedAt = -1.0
        while (System.currentTimeMillis() - t0 < (secs * 3 / 2 + 60) * 1000L) {
            Thread.sleep(2500)
            val q = try { d.query() } catch (e: Exception) { println("TIMER ${at()} read failed: ${e.message}"); continue }
            println("TIMER ${at()} relay=${q["1"]} timer=${q["9"]}")
            if (q["1"] != lastRelay) { println("TIMER ${at()} *** relay changed to ${q["1"]} ***"); if (switchedAt < 0) switchedAt = (System.currentTimeMillis() - t0) / 1000.0; lastRelay = q["1"] }
            if (q["1"] == true && switchedAt > 0 && (System.currentTimeMillis() - t0) / 1000.0 > switchedAt + 6) break
        }
        println("TIMER RESULT: relay is now $lastRelay, it changed itself at ${"%.1f".format(switchedAt)} s (timer was $secs s)")
        d.close()
    }

    /** Timer set while off, then the plug is switched ON by hand before the timer ends: does the timer switch it OFF afterwards? */
    @Test fun aManualOnBeforeTheTimerEnds() {
        val ip = System.getenv("TUYA_IP"); val id = System.getenv("TUYA_ID"); val key = System.getenv("TUYA_KEY")
        Assume.assumeTrue(ip != null && id != null && key != null && System.getenv("TUYA_TIMER") == "2")
        val secs = 40
        val d = TuyaDevice(id!!, key!!, ip!!); d.connect()
        val t0 = System.currentTimeMillis(); fun at() = "%5.1fs".format((System.currentTimeMillis() - t0) / 1000.0)
        d.set(mapOf("1" to false)); Thread.sleep(1500); d.set(mapOf("9" to secs)); println("TIMER2 ${at()} off, timer set to $secs s")
        Thread.sleep(8000); d.set(mapOf("1" to true)); println("TIMER2 ${at()} switched ON by hand (timer still running)")
        var relay: Any? = true; var offAt = -1.0
        while (System.currentTimeMillis() - t0 < (secs + 45) * 1000L) {
            Thread.sleep(2500)
            val q = try { d.query() } catch (e: Exception) { continue }
            if (q.containsKey("1")) { if (q["1"] != relay) { println("TIMER2 ${at()} *** relay changed to ${q["1"]} ***"); if (q["1"] == false && offAt < 0) offAt = (System.currentTimeMillis() - t0) / 1000.0; relay = q["1"] } }
            if (q.containsKey("9")) println("TIMER2 ${at()} relay=$relay timer=${q["9"]}")
        }
        println("TIMER2 RESULT: after the timer ended the relay is $relay ${if (offAt > 0) "(it switched OFF at ${"%.1f".format(offAt)} s)" else "(it was never switched off)"}")
        if (relay == false) d.set(mapOf("1" to true))
        d.set(mapOf("9" to 0)); d.close()
    }
}

