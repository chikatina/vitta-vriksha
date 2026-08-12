package org.chikatistudio.vittavriksha

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Raises the notification when a scheduled reminder comes due.
 *
 * The alarm carries its own text, set when it was scheduled, so nothing has to be looked
 * up here. That matters: this runs with the app closed and the database is a file the
 * WebView holds in memory, not something a receiver can read.
 */
class ReminderReceiver : BroadcastReceiver() {

    companion object {
        const val EXTRA_ID = "reminder_id"
        const val EXTRA_TITLE = "reminder_title"
        const val EXTRA_BODY = "reminder_body"
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null || intent == null) return
        val title = intent.getStringExtra(EXTRA_TITLE) ?: return
        if (title.isBlank()) return

        ReminderNotificationManager(context).showReminder(
            intent.getStringExtra(EXTRA_ID) ?: title,
            title,
            intent.getStringExtra(EXTRA_BODY) ?: "",
        )
    }
}
