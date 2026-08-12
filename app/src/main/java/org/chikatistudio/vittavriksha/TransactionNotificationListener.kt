package org.chikatistudio.vittavriksha

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Catches a bank or payment app's own notification, for the accounts that no longer send
 * a text message.
 *
 * Same arrangement as the message receiver: the text is queued and the app classifies it
 * when it next opens. Nothing is read except notifications that look financial, and
 * nothing is kept except those.
 */
class TransactionNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(notification: StatusBarNotification?) {
        super.onNotificationPosted(notification)
        val packageName = notification?.packageName ?: return
        if (packageName == applicationContext.packageName) return

        val extras = notification.notification?.extras ?: return
        val title = extras.getCharSequence("android.title")?.toString() ?: ""
        val text = extras.getCharSequence("android.text")?.toString() ?: ""
        val combined = "$title $text".trim()

        if (!SmsReceiver.looksFinancial(combined)) return

        AlertQueue(this).add(packageName, combined, "notification")
        ReminderNotificationManager(this).showAlertsWaiting(1)
    }
}
