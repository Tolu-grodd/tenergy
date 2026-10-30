package com.tenergy.hub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the hub after the phone restarts, or after the app is updated, if it was switched on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (!Config(ctx).enabled) return
        HubState.fileDir = ctx.getExternalFilesDir(null); HubState.log("started by ${intent.action}")
        // Android 12 and later does not let a camera service start from the background, so the app's own screen is opened (allowed with the "display over other apps" permission); it starts the service.
        try { ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) } catch (e: Exception) { HubState.log("could not open the screen: ${e.message}") }
        try { HubService.start(ctx) } catch (e: Exception) { HubState.log("could not start the service directly: ${e.message}") }
    }
}
