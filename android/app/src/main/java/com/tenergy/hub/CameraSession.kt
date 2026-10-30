package com.tenergy.hub

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * One check of the tank with full control of the camera and the light: open it once, switch the torch on, let exposure settle, trigger autofocus and WAIT until the lens
 * says it is locked, then hand over full-size pictures one at a time until the caller has seen enough, then close (which puts the torch out). No preview is shown, which is
 * what an always-on camera app needs: nothing on screen to crash.
 */
class CameraSession(ctx: Context, private val cameraId: String, private val log: (String) -> Unit) {
    private val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    /** Exposure compensation in the camera's own steps (negative = darker). The caller may change it between frames: a bright display glows into its neighbouring digits, and a darker picture separates them. */
    @Volatile var ev = 0
    @Volatile var evMin = 0
    @Volatile var evMax = 0
    @Volatile private var evApplied = 0

    class Summary(val openMs: Long, val afResult: String, val afMs: Long, val frames: Int, val totalMs: Long)

    /** onFrame gets each picture (JPEG bytes) and its number; return true to ask for another. Must run off the main thread. */
    fun run(torch: Boolean, warmupMs: Long, afTimeoutMs: Long, gapMs: Long, onFrame: (ByteArray, Int) -> Boolean): Summary {
        val t0 = System.currentTimeMillis()
        val chars = mgr.getCameraCharacteristics(cameraId)
        val evRange = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE); evMin = evRange?.lower ?: 0; evMax = evRange?.upper ?: 0
        val sizes = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!.getOutputSizes(ImageFormat.JPEG)
        // about 5 megapixels: plenty for reading digits and far lighter to decode than the sensor's full size
        val jpegSize = sizes.filter { it.width >= 2400 && Math.abs(it.width * 3 - it.height * 4) < 8 }.minByOrNull { it.width * it.height } ?: sizes.maxByOrNull { it.width * it.height }!!
        val thread = HandlerThread("cam").also { it.start() }
        val h = Handler(thread.looper)
        val yuv = ImageReader.newInstance(640, 480, ImageFormat.YUV_420_888, 2)
        yuv.setOnImageAvailableListener({ r -> r.acquireLatestImage()?.close() }, h)
        val jpeg = ImageReader.newInstance(jpegSize.width, jpegSize.height, ImageFormat.JPEG, 2)
        val shot = AtomicReference<ByteArray?>(null); var gotShot = CountDownLatch(1)
        jpeg.setOnImageAvailableListener({ r ->
            r.acquireNextImage()?.use { img -> val b = img.planes[0].buffer; val bytes = ByteArray(b.remaining()); b.get(bytes); shot.set(bytes) }
            gotShot.countDown()
        }, h)
        var dev: CameraDevice? = null; var session: CameraCaptureSession? = null
        var openMs = 0L; var afResult = "not run"; var afMs = 0L; var frames = 0
        try {
            val opened = CountDownLatch(1); var openErr = ""
            mgr.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) { dev = d; opened.countDown() }
                override fun onDisconnected(d: CameraDevice) { openErr = "disconnected"; d.close(); opened.countDown() }
                override fun onError(d: CameraDevice, e: Int) { openErr = "error $e"; d.close(); opened.countDown() }
            }, h)
            if (!opened.await(8, TimeUnit.SECONDS) || dev == null) throw IllegalStateException("camera did not open ($openErr)")
            openMs = System.currentTimeMillis() - t0
            val d = dev!!
            val ready = CountDownLatch(1)
            d.createCaptureSession(listOf(yuv.surface, jpeg.surface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) { session = s; ready.countDown() }
                override fun onConfigureFailed(s: CameraCaptureSession) { ready.countDown() }
            }, h)
            if (!ready.await(8, TimeUnit.SECONDS) || session == null) throw IllegalStateException("capture session failed")
            val s = session!!

            fun CaptureRequest.Builder.common(): CaptureRequest.Builder {
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, ev.coerceIn(evMin, evMax))
                set(CaptureRequest.FLASH_MODE, if (torch) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
                return this
            }
            val afBox = AtomicInteger(-1)
            val cb = object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) { afBox.set(result.get(CaptureResult.CONTROL_AF_STATE) ?: -1) }
            }
            fun startRepeating() { s.setRepeatingRequest(d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(yuv.surface); common() }.build(), cb, h) }
            evApplied = ev; startRepeating()
            Thread.sleep(warmupMs)
            s.capture(d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(yuv.surface); common(); set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START) }.build(), cb, h)
            val afStart = System.currentTimeMillis()
            while (System.currentTimeMillis() - afStart < afTimeoutMs) {
                val st = afBox.get(); if (st == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED || st == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED) break
                Thread.sleep(30)
            }
            afMs = System.currentTimeMillis() - afStart
            afResult = when (afBox.get()) { CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED -> "locked"; CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED -> "no lock"; else -> "still scanning" }

            while (true) {
                gotShot = CountDownLatch(1); shot.set(null)
                s.capture(d.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                    addTarget(jpeg.surface); common(); set(CaptureRequest.JPEG_QUALITY, 95.toByte()); set(CaptureRequest.JPEG_ORIENTATION, 0)
                }.build(), cb, h)
                if (!gotShot.await(8, TimeUnit.SECONDS)) throw IllegalStateException("no picture within 8 s")
                val bytes = shot.get() ?: throw IllegalStateException("empty picture")
                frames++
                if (!onFrame(bytes, frames)) break
                if (ev != evApplied) { evApplied = ev; startRepeating(); Thread.sleep(700) } // the new exposure needs a few frames to settle
                Thread.sleep(gapMs)
            }
        } finally {
            try { session?.close() } catch (_: Exception) {}
            try { dev?.close() } catch (_: Exception) {}
            try { mgr.setTorchMode(cameraId, false) } catch (_: Exception) {} // never leave the light on, whatever happened
            yuv.close(); jpeg.close(); thread.quitSafely()
        }
        return Summary(openMs, afResult, afMs, frames, System.currentTimeMillis() - t0)
    }
}
