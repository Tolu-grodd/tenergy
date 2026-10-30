package com.tenergy.hub

import org.json.JSONArray
import org.json.JSONObject

/**
 * The fridge and tank rules on the phone, as a safety net. While the Worker answers, nothing here switches anything: the phone only keeps a fresh copy of the Worker's settings.
 * If the Worker cannot be reached for the set number of minutes (home internet down, Cloudflare down), the phone applies the same rules itself, switching the plugs directly over
 * the home Wi-Fi from its own battery reading, grid light and plug readings. The moment the Worker answers again, the phone stops and reports what it did.
 */
class Failover(private val cfg: Config, private val home: HomeLink, private val log: (String) -> Unit) {
    private val startedAt = System.currentTimeMillis()
    @Volatile private var running = false
    @Volatile var active = false
    private var planAt = 0L
    private var plan: JSONObject? = try { JSONObject(cfg.plan) } catch (_: Exception) { null }
    // what the phone has decided on its own during an outage
    private var tankTimerSet = false; private var emOff = false; private var anchor = 0L; private var anchorAt = 0L; private var fridgeOnPrev: Boolean? = null; private var fridgeSince: Long? = null; private var weak = false; private var day = false; private var cutAt: Long? = null; private var lastT = 0L; private var seenGrid: Boolean? = null
    private val events = JSONArray()
    val recent = java.util.concurrent.CopyOnWriteArrayList<String>() // the last things the phone did on its own, for the Automation screen
    /** The saved rules as label and value pairs, for the Automation screen. */
    fun planFields(): List<Pair<String, String>>? {
        val p = plan ?: return null; val c = p.optJSONObject("cfg") ?: return null; val n = c.optJSONObject("night") ?: return null
        val mode = p.optString("mode").replaceFirstChar { it.uppercase() } + (if (p.optBoolean("weak")) " · weak night" else "") + (if (p.optBoolean("dayThrottle")) " · day throttle" else "")
        return listOf("Mode" to mode, "Fridge stops at" to "${c.optInt("emergency")}%", "Tank output cut at" to "${c.optInt("cutAt")}%", "Tank output back on at" to "${c.optInt("restoreAt")}%",
            "Night" to "${n.optString("from")} to ${n.optString("to")}", "Night rhythm" to "${n.optInt("onMin")} min on, ${n.optInt("offMin")} off", "Saved" to "${(System.currentTimeMillis() - p.optLong("at")) / 60000} min ago")
    }

    fun planText(): String {
        val p = plan ?: return "No saved rules yet"; val c = p.optJSONObject("cfg"); val n = c?.optJSONObject("night"); val nl = "\n"
        return "mode " + p.optString("mode") + (if (p.optBoolean("weak")) ", weak night" else "") + (if (p.optBoolean("dayThrottle")) ", day throttle" else "") + nl +
            "fridge stops at " + c?.optInt("emergency") + "%, tank cut at " + c?.optInt("cutAt") + "%, back on at " + c?.optInt("restoreAt") + "%" + nl +
            "night " + n?.optString("from") + " to " + n?.optString("to") + ", " + n?.optInt("onMin") + " min on, " + n?.optInt("offMin") + " off" + nl +
            "saved " + ((System.currentTimeMillis() - p.optLong("at")) / 60000) + " min ago"
    }

    fun start() {
        running = true
        Thread({
            while (running) {
                try { step() } catch (e: InterruptedException) { break } catch (e: Exception) { log("failover: ${e.message}") }
                try { Thread.sleep(30_000) } catch (e: InterruptedException) { break }
            }
        }, "hub-failover").also { it.isDaemon = true }.start()
    }

    fun stop() { running = false }

    private fun reachable(): Boolean = System.currentTimeMillis() - Math.max(home.lastReportAt, startedAt) < cfg.failoverMin * 60_000L

    private fun step() {
        val now = System.currentTimeMillis()
        if (reachable()) {
            if (active) end()
            if (now - planAt > 5 * 60_000L && home.lastReportAt > 0) refreshPlan()
            return
        }
        val p = plan ?: run { if (!active) log("the Worker cannot be reached, and there is no saved plan to follow"); return }
        if (!active) { active = true; log("the Worker has not answered for ${cfg.failoverMin} min: the phone is running the fridge rules itself"); loadState(p) }
        tick(p, now)
    }

    private fun refreshPlan() {
        try { val t = Net.get(cfg, "/api/hub/plan"); val j = JSONObject(t); if (j.has("cfg")) { if (plan == null) log("saved the Worker's rules, ready to run them if it cannot be reached"); plan = j; cfg.plan = t; planAt = System.currentTimeMillis() } }
        catch (e: Exception) { planAt = System.currentTimeMillis() - 4 * 60_000L } // not now: try again in a minute
    }

    private fun loadState(p: JSONObject) { emOff = p.optBoolean("emOff"); anchor = p.optLong("anchor", 0); anchorAt = p.optLong("anchorAt", anchor); fridgeOnPrev = if (p.has("fridgeOn") && !p.isNull("fridgeOn")) p.optBoolean("fridgeOn") else null; fridgeSince = if (p.has("fridgeSince") && !p.isNull("fridgeSince")) p.optLong("fridgeSince") else null; weak = p.optBoolean("weak"); day = p.optBoolean("dayThrottle"); cutAt = null; lastT = 0; seenGrid = null }

    private fun note(text: String, fridgeOn: Boolean? = null) {
        log("failover: $text"); recent.add(0, java.text.SimpleDateFormat("HH:mm", java.util.Locale.US).format(java.util.Date()) + " " + text); while (recent.size > 8) recent.removeAt(recent.size - 1)
        if (events.length() < 50) events.put(JSONObject().put("at", System.currentTimeMillis()).put("text", "The phone, on its own: $text").apply { if (fridgeOn != null) put("fridgeOn", fridgeOn) })
    }

    private fun end() {
        active = false; log("the Worker answers again: the phone hands the rules back")
        if (events.length() > 0) { try { Net.post(cfg, "/api/hub/failover", JSONObject().put("events", events).toString()); } catch (e: Exception) { log("failover report not sent: ${e.message}"); return } }
        while (events.length() > 0) events.remove(0)
    }

    private fun tick(p: JSONObject, now: Long) {
        if (now - lastT < 60_000L) return
        val c = AutoCfg.from(p.getJSONObject("cfg")); val today = Auto.todayAt(now)
        val fridgeId = p.optString("fridgeId"); val tankId = p.optString("tankId")
        val frR = if (fridgeId.isNotEmpty()) home.plugs.reading(fridgeId) else null
        val tankR = if (tankId.isNotEmpty()) home.plugs.reading(tankId) else null
        val battOk = HubState.lastPct != null && HubState.lastReadAt > 0 && (now - HubState.lastReadAt) / 60000.0 <= c.staleMin
        val pct = if (battOk) HubState.lastPct else null
        val gridOn: Boolean? = if (HubState.gridAt > 0 && now - HubState.gridAt < 20 * 60_000L) HubState.gridOn else null
        val frOn = frR?.first; if (frOn != null && frOn != fridgeOnPrev) { fridgeOnPrev = frOn; fridgeSince = now } // when the fridge last changed state
        // the grid has just gone off: the rhythm continues from where the fridge really is (see Auto.phaseAnchor), not always with a rest
        if (gridOn != null && seenGrid != null && gridOn != seenGrid && !gridOn) { val sp = Auto.rhythmNow(c, weak, day, now, today); anchor = if (sp != null) Auto.phaseAnchor(sp, frOn, fridgeSince, now) else now; anchorAt = now }
        if (gridOn != null) seenGrid = gridOn
        if (weak && pct != null && pct >= c.weakEndAt) { weak = false; val sp = Auto.rhythmNow(c, false, day, now, today); anchor = if (sp != null) Auto.phaseAnchor(sp, frR?.first, fridgeSince, now) else now; anchorAt = now; note("Weak night ended at $pct%") }
        if (day && Auto.windowAt(c.nightFrom, c.nightTo, now, today) != null) { day = false; note("Day throttle ended: the night plan has started") }
        emOff = if (gridOn == true) false else if (pct != null) pct <= c.emergency || (emOff && pct <= c.emergency + 4) else emOff
        val fr = if (frR == null) null else Fridge(frR.first, true)
        val togAt = Math.max(if (weak) p.optLong("weakSince", 0) else 0L, if (day) p.optLong("daySince", 0) else 0L)
        var pl = Auto.plan(c, now, today, fr, tankR?.second, p.optDouble("limit", 500.0), pct, gridOn, emOff, weak, if (togAt > Math.max(anchorAt, anchor)) togAt else anchor, day, Math.max(Math.max(anchorAt, anchor), togAt))
        val hold = p.optJSONObject("hold")
        if (hold != null && pl != null && !pl.urgent && fr?.on != null && (hold.isNull("until") || now < hold.optLong("until"))) {
            val want = hold.getBoolean("on"); pl = Plan(if (want == fr.on) null else if (want) "on" else "off", "Held ${if (want) "on" else "off"} by you", false, "hold", 0)
        }
        lastT = now
        if (pl?.action != null && fridgeId.isNotEmpty()) {
            val want = pl.action == "on"
            if (home.plugs.switch(fridgeId, want)) note("fridge ${if (want) "on" else "off"}: ${pl.reason}", want) else log("failover: the fridge plug did not take the command")
        }
        // the very last resort, as on the Worker: cut the tank output before the tank runs empty, and bring it back once the battery has recovered and there is no grid
        if (tankId.isNotEmpty() && tankR != null) {
            if (c.cutOn && gridOn == false && pct != null && pct <= c.cutAt && tankR.first == true) { if (home.plugs.switch(tankId, false)) {
                    cutAt = now
                    // the plug's own timer brings the output back with no Wi-Fi, exactly as when the Worker does the cut
                    val cc = p.getJSONObject("cfg"); val back = Auto.tankBackSecs(cc.optString("cutBackAt", "09:00"), cc.optInt("cutBackDayMin", 90), now)
                    val timerOk = home.plugs.setCountdown(tankId, back); tankTimerSet = timerOk
                    note("battery at $pct%: the tank output was switched off so the tank does not run empty" + if (timerOk) "; its own timer brings it back in ${back / 60} min" else "; the timer could not be set")
                } }
            else if (cutAt != null && tankR.first == false && gridOn == false && pct != null && pct >= c.restoreAt) { if (home.plugs.switch(tankId, true)) { cutAt = null; if (tankTimerSet) { home.plugs.setCountdown(tankId, 0); tankTimerSet = false }; note("battery at $pct%: the tank output was switched back on") } }
        }
    }
}
