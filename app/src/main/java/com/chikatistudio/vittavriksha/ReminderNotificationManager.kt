package com.chikatistudio.vittavriksha

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The notifications the app raises: a reminder that came due, and a bank alert that
 * arrived while the app was closed.
 *
 * Neither carries an amount or a merchant in its text. A notification is visible on a
 * locked screen and over somebody's shoulder, so it says that there is something to look
 * at rather than what it is.
 */
class ReminderNotificationManager(private val context: Context) {

    companion object {
        private const val CHANNEL_ID = "vitta_vriksha_reminders"
        private const val CHANNEL_NAME = "Reminders and alerts"
        private const val ALERT_NOTIFICATION_ID = 2001
    }

    init {
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Instalments, renewals, statement refreshes and detected transactions"
            setShowBadge(true)
        }
        manager().createNotificationChannel(channel)
    }

    private fun manager() =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun openAppIntent(reminderId: String? = null): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (reminderId != null) {
                putExtra(ReminderReceiver.EXTRA_ID, reminderId)
            }
        }
        return PendingIntent.getActivity(
            context,
            reminderId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** A reminder that has come due. */
    fun showReminder(id: String, title: String, body: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openAppIntent(id))
            .setAutoCancel(true)
            .build()

        manager().notify(id.hashCode(), notification)
    }

    /**
     * A bank alert was caught and queued.
     *
     * One notification however many are waiting, replaced each time, because a run of
     * them says nothing more than the first one did.
     */
    fun showAlertsWaiting(count: Int) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(
                if (count == 1) "A transaction to review" else "$count transactions to review",
            )
            .setContentText("Tap to quickly classify, accept or discard.")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openAppIntent("pending-alerts"))
            .setAutoCancel(true)
            .build()

        manager().notify(ALERT_NOTIFICATION_ID, notification)
    }
}
