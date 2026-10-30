package com.tenergy.hub

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The phone's copy of the fridge rules must answer exactly like the Worker's auto.js on 400 generated situations. */
class AutoParityTest {
    @Test fun sameAnswersAsTheWorker() {
        val arr = JSONArray(javaClass.getResourceAsStream("/ref/autoplan-cases.json")!!.bufferedReader().readText())
        var planned = 0
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val f = c.optJSONObject("fr")
            val fr = if (f == null) null else Fridge(if (f.isNull("on")) null else f.getBoolean("on"), if (f.isNull("online")) null else f.getBoolean("online"))
            val pct = if (c.isNull("pct")) null else c.getInt("pct"); val grid = if (c.isNull("gridOn")) null else c.getBoolean("gridOn")
            val tank = if (c.isNull("tankW")) null else c.getDouble("tankW")
            val p = Auto.plan(AutoCfg.from(c.getJSONObject("cfg")), c.getLong("now"), c.getString("today"), fr, tank, c.getDouble("limit"), pct, grid, c.getBoolean("emOff"), c.getBoolean("weak"), c.getLong("anchor"), c.getBoolean("dayThrottle"), if (c.has("anchorAt")) c.getLong("anchorAt") else c.getLong("anchor"))
            val e = c.opt("exp")
            if (e == null || e == JSONObject.NULL) { assertEquals("case $i should have no plan", null, p); continue }
            e as JSONObject; planned++
            assertEquals("case $i action", if (e.isNull("action")) null else e.getString("action"), p!!.action)
            assertEquals("case $i reason", e.getString("reason"), p.reason)
            assertEquals("case $i urgent", e.getBoolean("urgent"), p.urgent)
            assertEquals("case $i src", e.getString("src"), p.src)
            assertEquals("case $i restMin", e.optInt("restMin", 0), p.restMin)
        }
        println("AUTO PARITY: $planned planned cases of ${arr.length()} agree")
    }
}
