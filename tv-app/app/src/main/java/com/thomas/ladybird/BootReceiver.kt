package com.thomas.ladybird

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Alerts must survive a power cut: boot brings the ntfy stream up without anyone opening the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Log.i(TAG, "boot completed - starting NtfyService")
        NtfyService.start(context)
    }
}
