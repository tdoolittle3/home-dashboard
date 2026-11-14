package com.thomas.ladybird

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/** The one logcat tag everything here logs under: adb logcat -s Ladybird */
const val TAG = "Ladybird"

/**
 * Everything provisioning can set. All of it arrives as intent extras on
 * MainActivity (see CONTRACT.md) - there is no on-TV settings UI on purpose.
 */
data class Config(
    val dashboardUrl: String?,
    val room: String?,
    val ntfyUrl: String?,
    val ntfyTopics: String?,
    val ntfyToken: String?,
) {
    /** The page both the activity and the dream show. Null until dashboard_url is provisioned. */
    val tvUrl: String?
        get() {
            val base = dashboardUrl?.trimEnd('/') ?: return null
            val roomName = room?.takeIf { it.isNotBlank() }
            return if (roomName == null) "$base/tv" else "$base/tv?room=${Uri.encode(roomName)}"
        }
}

/**
 * SharedPreferences-backed config. An extra that is present overwrites the
 * stored value; a missing extra keeps what was there - so re-provisioning can
 * change one knob without restating the rest.
 */
object ConfigStore {
    private const val PREFS = "ladybird"
    private val KEYS = listOf("dashboard_url", "room", "ntfy_url", "ntfy_topics", "ntfy_token")
    private const val LAST_ID = "ntfy_last_id"

    fun absorb(context: Context, intent: Intent?): Config {
        if (intent != null) {
            val edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            var changed = false
            for (key in KEYS) {
                val value = intent.getStringExtra(key) ?: continue
                edit.putString(key, value)
                changed = true
            }
            if (changed) edit.apply()
        }
        return load(context)
    }

    fun load(context: Context): Config {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val config = Config(
            dashboardUrl = prefs.getString("dashboard_url", null),
            room = prefs.getString("room", null),
            ntfyUrl = prefs.getString("ntfy_url", null),
            ntfyTopics = prefs.getString("ntfy_topics", null),
            ntfyToken = prefs.getString("ntfy_token", null),
        )
        Log.i(
            TAG,
            "config: dashboard_url=${config.dashboardUrl} room=${config.room} " +
                "ntfy_url=${config.ntfyUrl} ntfy_topics=${config.ntfyTopics} " +
                "ntfy_token=${if (config.ntfyToken.isNullOrBlank()) "unset" else "<redacted>"}",
        )
        return config
    }

    /** Newest ntfy message id seen, so a reconnect's since= misses nothing. */
    fun lastId(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LAST_ID, null)

    fun setLastId(context: Context, id: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(LAST_ID, id).apply()
    }
}
