package org.chikatistudio.vittavriksha

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bank alerts caught while the app was closed.
 *
 * A broadcast receiver runs without a WebView, so it cannot classify anything: the rules
 * live in the database and the matching happens in JavaScript. What it can do is write
 * the message down. The app drains the queue when it next opens and classifies the lot,
 * which keeps every decision in one place and means a rule the user edits applies to
 * messages that arrived before the edit.
 *
 * The queue is bounded. A phone that sits unopened for a fortnight should not accumulate
 * an unbounded list of bank alerts in shared preferences.
 */
class AlertQueue(context: Context) {

    private val preferences =
        context.getSharedPreferences("vitta_vriksha_alerts", Context.MODE_PRIVATE)

    companion object {
        private const val KEY = "pending"
        private const val LIMIT = 200
    }

    /** Adds one message. */
    fun add(sender: String, body: String, source: String) {
        if (body.isBlank()) return
        val queued = read()
        queued.put(
            JSONObject()
                .put("sender", sender)
                .put("body", body)
                .put("source", source)
                .put("received_at", System.currentTimeMillis()),
        )

        val trimmed = JSONArray()
        val start = maxOf(0, queued.length() - LIMIT)
        for (i in start until queued.length()) trimmed.put(queued.get(i))
        preferences.edit().putString(KEY, trimmed.toString()).apply()
    }

    /** Returns everything queued and empties it, so nothing is classified twice. */
    fun drain(): String {
        val queued = preferences.getString(KEY, "[]") ?: "[]"
        preferences.edit().remove(KEY).apply()
        return queued
    }

    private fun read(): JSONArray {
        return try {
            JSONArray(preferences.getString(KEY, "[]") ?: "[]")
        } catch (e: Exception) {
            JSONArray()
        }
    }
}
