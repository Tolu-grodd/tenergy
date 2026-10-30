package com.tenergy.hub

import org.json.JSONObject
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A direct conversation with one Tuya plug over the home Wi-Fi, protocol 3.5 (AES-GCM, session key negotiated on connect). No cloud, no quota.
 * Same wire format as the tuyapi library the Termux agent used: a 3-step handshake, then DP_QUERY_NEW (0x10) to read and CONTROL_NEW (0x0d) to switch.
 */
class TuyaDevice(val id: String, key: String, val ip: String, private val port: Int = 6668) {
    private val localKey = key.toByteArray(Charsets.UTF_8)
    private var sock: Socket? = null
    private var inp: DataInputStream? = null
    private var out: OutputStream? = null
    private var sessionKey: ByteArray? = null
    private var seq = 0
    private val rnd = SecureRandom()

    companion object {
        private fun gcm(key: ByteArray, iv: ByteArray, aad: ByteArray?, data: ByteArray, enc: Boolean): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(if (enc) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            if (aad != null) c.updateAAD(aad)
            return c.doFinal(data)
        }
        private fun hmac(key: ByteArray, data: ByteArray): ByteArray { val m = Mac.getInstance("HmacSHA256"); m.init(SecretKeySpec(key, "HmacSHA256")); return m.doFinal(data) }
        const val CMD_NEG_START = 3; const val CMD_NEG_RES = 4; const val CMD_NEG_FINISH = 5; const val CMD_CONTROL_NEW = 13; const val CMD_QUERY_NEW = 16; const val CMD_STATUS = 8
    }

    class Packet(val cmd: Int, val seq: Int, val plain: ByteArray)

    private fun frame(cmd: Int, seqN: Int, payload: ByteArray, key: ByteArray): ByteArray {
        val h = ByteBuffer.allocate(18); h.putInt(0x00006699); h.putShort(0); h.putInt(seqN); h.putInt(cmd); h.putInt(payload.size + 28)
        val hb = h.array(); val iv = ByteArray(12).also { rnd.nextBytes(it) }
        val body = gcm(key, iv, hb.copyOfRange(4, 18), payload, true) // ciphertext + 16-byte tag
        return hb + iv + body + byteArrayOf(0, 0, 0x99.toByte(), 0x66)
    }

    private fun readPacket(key: ByteArray): Packet {
        val hb = ByteArray(18); inp!!.readFully(hb)
        val bb = ByteBuffer.wrap(hb)
        if (bb.getInt(0) != 0x00006699) throw IllegalStateException("not a protocol 3.5 packet")
        val len = bb.getInt(14); if (len < 28 || len > 65_536) throw IllegalStateException("odd packet length $len")
        val rest = ByteArray(len + 4); inp!!.readFully(rest)
        val iv = rest.copyOfRange(0, 12); val ctTag = rest.copyOfRange(12, len)
        val plain = gcm(key, iv, hb.copyOfRange(4, 18), ctTag, false)
        return Packet(bb.getInt(10), bb.getInt(6), if (plain.size >= 4) plain.copyOfRange(4, plain.size) else plain) // the first 4 bytes are the device's return code
    }

    private fun send(cmd: Int, payload: ByteArray, key: ByteArray) { out!!.write(frame(cmd, seq, payload, key)); out!!.flush() }

    /** Open the connection and agree a session key. Throws if the plug is not there, does not answer, or does not accept our key. */
    fun connect(timeoutMs: Int = 6000) {
        close()
        val s = Socket(); s.connect(InetSocketAddress(ip, port), timeoutMs); s.soTimeout = timeoutMs; s.tcpNoDelay = true
        sock = s; inp = DataInputStream(s.getInputStream()); out = s.getOutputStream()
        val local = ByteArray(16).also { rnd.nextBytes(it) }
        seq = 1; send(CMD_NEG_START, local, localKey)
        val res = readPacket(localKey)
        if (res.cmd != CMD_NEG_RES || res.plain.size < 48) throw IllegalStateException("handshake: unexpected answer (command ${res.cmd})")
        val remote = res.plain.copyOfRange(0, 16)
        if (!hmac(localKey, local).contentEquals(res.plain.copyOfRange(16, 48))) throw IllegalStateException("handshake: wrong key")
        seq = res.seq; send(CMD_NEG_FINISH, hmac(localKey, remote), localKey)
        val xored = ByteArray(16) { (local[it].toInt() xor remote[it].toInt()).toByte() }
        sessionKey = gcm(localKey, local.copyOfRange(0, 12), null, xored, true).copyOfRange(0, 16)
    }

    private fun nowSec() = (System.currentTimeMillis() / 1000).toString()

    /** Ask the plug for all its data points. Returns them as a map ("1" to true, "19" to 53, ...). */
    fun query(): Map<String, Any> {
        val sk = sessionKey ?: throw IllegalStateException("not connected")
        val p = JSONObject().put("gwId", id).put("devId", id).put("t", nowSec()).put("dps", JSONObject()).put("uid", id)
        seq++; send(CMD_QUERY_NEW, p.toString().toByteArray(), sk)
        for (i in 0 until 6) {
            val r = readPacket(sk)
            if (r.cmd == CMD_QUERY_NEW || r.cmd == CMD_STATUS) { val m = parseDps(r.plain); if (m != null) return m }
        }
        throw IllegalStateException("no answer to the query")
    }

    /** Switch data points (for the plugs: {"1": true}). Returns once the command is sent. */
    fun set(dps: Map<String, Any>) {
        val sk = sessionKey ?: throw IllegalStateException("not connected")
        val d = JSONObject(); for ((k, v) in dps) d.put(k, v)
        val data = JSONObject().put("ctype", 0).put("devId", id).put("gwId", id).put("uid", "").put("dps", d)
        val payload = JSONObject().put("data", data).put("protocol", 5).put("t", nowSec().toLong())
        val head = ByteArray(15); "3.5".toByteArray().copyInto(head)
        seq += 2; send(CMD_CONTROL_NEW, head + payload.toString().toByteArray(), sk)
    }

    private fun parseDps(plain: ByteArray): Map<String, Any>? {
        var b = plain; if (b.size > 15 && b[0] == '3'.code.toByte() && b[1] == '.'.code.toByte()) b = b.copyOfRange(15, b.size)
        val text = String(b, Charsets.UTF_8).trim(); if (!text.startsWith("{")) return null
        val j = try { JSONObject(text) } catch (_: Exception) { return null }
        val d = j.optJSONObject("dps") ?: j.optJSONObject("data")?.optJSONObject("dps") ?: return null
        val m = HashMap<String, Any>(); for (k in d.keys()) m[k] = d.get(k); return m
    }

    fun close() { try { sock?.close() } catch (_: Exception) {}; sock = null; sessionKey = null }
}

/** Finding plugs on the home network: which addresses answer on Tuya's local port, then which of them take a given key. */
object Lan {
    fun subnets(): List<String> {
        val out = LinkedHashSet<String>()
        try { for (n in NetworkInterface.getNetworkInterfaces()) for (a in n.inetAddresses) { val s = a.hostAddress ?: continue; if (!a.isLoopbackAddress && Regex("^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)").containsMatchIn(s) && !s.contains(":")) out.add(s.substringBeforeLast(".")) } } catch (_: Exception) {}
        return out.toList()
    }

    /** Every host on the phone's own subnets with port 6668 open. */
    fun openHosts(): List<String> {
        val pool = Executors.newFixedThreadPool(48)
        try {
            val jobs = ArrayList<java.util.concurrent.Future<String?>>()
            for (sn in subnets()) for (i in 1..254) { val ip = "$sn.$i"; jobs.add(pool.submit(Callable { try { Socket().use { it.connect(InetSocketAddress(ip, 6668), 700) }; ip } catch (_: Exception) { null } })) }
            return jobs.mapNotNull { try { it.get(15, TimeUnit.SECONDS) } catch (_: Exception) { null } }
        } finally { pool.shutdownNow() }
    }

    /** The address of the plug that takes this key, searched among `candidates` (skipping addresses other plugs already use). */
    fun find(id: String, key: String, candidates: List<String>, taken: Set<String>): String? {
        for (ip in candidates) {
            if (ip in taken) continue
            val d = TuyaDevice(id, key, ip)
            try { d.connect(3000); d.query(); return ip } catch (_: Exception) {} finally { d.close() }
        }
        return null
    }
}
