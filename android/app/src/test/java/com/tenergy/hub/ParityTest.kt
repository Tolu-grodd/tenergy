package com.tenergy.hub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin reader must give exactly the answers the JavaScript reader gives on every reference photo. */
class ParityTest {
    // Java's image classes are not on the compile path of an Android project's tests, but they are there when the tests run, so they are called by name.
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

    @Test
    fun everyReferencePhotoReadsAsExpected() {
        val refs = manifest(); assertTrue("manifest should list photos", refs.size >= 10)
        var right = 0; val problems = ArrayList<String>()
        for (hypothesis in listOf("cw", "ccw")) {
            right = 0; problems.clear()
            for (r in refs) {
                val raw = load(r.file)
                val img = if (hypothesis == "cw") raw.rotateCW(r.rotate) else raw.rotateCW(360 - r.rotate)
                Segments.resetAutoSearch()
                val t = System.currentTimeMillis(); val read = Segments.readDisplayAuto(img); val ms = System.currentTimeMillis() - t
                val ok = read.value == r.value; if (ok) right++ else problems.add("${r.file}: wanted ${r.value}, got ${read.value} (${read.note})")
                println("[$hypothesis] ${r.file.padEnd(28)} want ${r.value.toString().padEnd(4)} got ${read.value} ${if (ok) "ok" else "WRONG: " + read.note} (${ms}ms)")
            }
            println("[$hypothesis] $right of ${refs.size} right")
            if (right == refs.size) break
        }
        assertEquals("problems: $problems", refs.size, right)
    }
}
