package com.tenergy.hub

import org.junit.Assume
import org.junit.Test

/** Talks to a real plug, only when TUYA_IP, TUYA_ID and TUYA_KEY are set in the environment (it never switches anything). */
class TuyaLiveTest {
    @Test fun readsARealPlug() {
        val ip = System.getenv("TUYA_IP"); val id = System.getenv("TUYA_ID"); val key = System.getenv("TUYA_KEY")
        Assume.assumeTrue(ip != null && id != null && key != null)
        val d = TuyaDevice(id!!, key!!, ip!!)
        d.connect()
        val dps = d.query()
        println("TUYA DPS: " + dps.entries.joinToString { it.key + "=" + it.value })
        assert(dps.isNotEmpty())
        d.close()
    }

    /** Sends the plug the state it already has (never changes anything), and checks the plug takes the command and still answers. */
    @Test fun acceptsASwitchCommandWithoutChangingIt() {
        val ip = System.getenv("TUYA_IP"); val id = System.getenv("TUYA_ID"); val key = System.getenv("TUYA_KEY")
        Assume.assumeTrue(ip != null && id != null && key != null && System.getenv("TUYA_SET") == "1")
        val d = TuyaDevice(id!!, key!!, ip!!)
        d.connect()
        val now = d.query()["1"] as Boolean
        d.set(mapOf("1" to now))
        Thread.sleep(1500)
        val after = d.query()["1"] as Boolean
        println("TUYA SET: before=$now after=$after")
        assert(now == after)
        d.close()
    }
}
