package com.tenergy.hub

import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone gets knocked: the reader must still find and read the display when the picture is turned by a quarter turn or tilted well beyond what it was built for. */
class KnockedPhoneTest {
    private fun load(name: String): Img {
        val bi = Class.forName("javax.imageio.ImageIO").getMethod("read", java.io.InputStream::class.java).invoke(null, javaClass.getResourceAsStream("/ref/$name")!!)!!
        val c = bi.javaClass; val w = c.getMethod("getWidth").invoke(bi) as Int; val h = c.getMethod("getHeight").invoke(bi) as Int
        val px = IntArray(w * h); c.getMethod("getRGB", Int::class.java, Int::class.java, Int::class.java, Int::class.java, IntArray::class.java, Int::class.java, Int::class.java).invoke(bi, 0, 0, w, h, px, 0, w)
        return Img(w, h, px)
    }

    private data class Ref(val file: String, val rotate: Int, val value: Int)
    private fun manifest(): List<Ref> {
        val text = javaClass.getResourceAsStream("/ref/manifest.json")!!.bufferedReader().readText()
        return Regex("\"file\":\\s*\"([^\"]+)\",\\s*\"rotate\":\\s*(\\d+),\\s*\"value\":\\s*(\\d+)").findAll(text).map { Ref(it.groupValues[1], it.groupValues[2].toInt(), it.groupValues[3].toInt()) }.toList()
    }

    @Test fun readsAKnockedPhone() {
        val refs = manifest().filter { it.value in listOf(87, 97, 74) }.distinctBy { it.value }
        val cases = listOf("straight" to (0 to 0), "quarter 90" to (90 to 0), "half turn" to (180 to 0), "tilt 12" to (0 to 12), "tilt -22" to (0 to -22), "quarter + tilt 15" to (90 to 15))
        val sb = StringBuilder(); var total = 0; var right = 0
        for ((name, qa) in cases) {
            var ok = 0
            for (r in refs) {
                var img = load(r.file).rotateCW((360 - r.rotate) % 360)
                if (qa.first != 0) img = img.rotateCW(qa.first); if (qa.second != 0) img = img.tilt(qa.second.toDouble())
                Segments.resetAutoSearch()
                val t0 = System.currentTimeMillis(); val read = Segments.readDisplayAuto(img, System.currentTimeMillis() + 10 * 60_000); val ms = System.currentTimeMillis() - t0
                println("   ${name.padEnd(18)} ${r.file.padEnd(22)} -> ${read.value} (${ms} ms, ${img.w}x${img.h})")
                total++; if (read.value == r.value) { ok++; right++ } else println("   ${if (read.value != null) "WRONG" else "miss "}: $name ${r.file} wanted ${r.value} got ${read.value} (${read.note})")
            }
            sb.append("${name.padEnd(18)} $ok of ${refs.size}\n")
        }
        println("KNOCKED PHONE\n$sb  total $right of $total")
        assertTrue("at least 80% of knocked pictures should read ($right of $total)", right >= total * 0.8)
    }
}
