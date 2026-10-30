package com.tenergy.hub

import android.content.Intent
import android.service.notification.NotificationListenerService

/**
 * Why this exists: some phones (TECNO/HiOS here) discard the boot broadcast for apps that are not on their auto-start list, and there is no such list to switch on. Android itself starts a
 * notification listener at boot, whatever that list says, so this one (it never reads a notification) is the reliable trigger: it opens the Hub's screen, which starts the service.
 */
class BootListener : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        val cfg = Config(this)
        if (!cfg.enabled || HubService.running) return
        HubState.fileDir = getExternalFilesDir(null); HubState.log("started by the system at boot (listener)")
        try { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) } catch (e: Exception) { HubState.log("could not open the screen: ${e.message}") }
    }
}
