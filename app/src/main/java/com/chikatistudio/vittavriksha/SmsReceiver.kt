package com.chikatistudio.vittavriksha

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Catches a bank alert and writes it down.
 *
 * It does not classify it. The rules that decide what a message means are rows in the
 * database and the matching happens in JavaScript, neither of which a broadcast receiver
 * can reach. Queuing the text and letting the app deal with it when it next opens keeps
 * that decision in one place, and means a rule edited today applies to a message that
 * arrived yesterday.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null || intent?.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val queue = AlertQueue(context)
        if (!queue.isSmsTrackingEnabled()) return
        var queued = 0

        for (message in Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return) {
            val sender = message.displayOriginatingAddress ?: ""
            if (isPersonalSender(sender)) continue
            val body = message.messageBody ?: continue
            if (!looksFinancial(body)) continue
            queue.add(sender, body, "sms")
            queued += 1
        }

        if (queued > 0) ReminderNotificationManager(context).showAlertsWaiting(queued)
    }

    companion object {
        private val MARKERS = listOf(
            "debited", "credited", "spent", "sent rs", "received", "withdrawn", "payment",
        )

        /** An amount: a currency token with a number after it. */
        private val AMOUNT = Regex("""(?:rs\.?|inr|₹)\s*\.?\s*\d""", RegexOption.IGNORE_CASE)

        private val PERSONAL_SENDER_REGEX = Regex("""^\+?(?:91)?[6-9]\d{9}$""")
        private val ALL_NUMERIC_LONG_REGEX = Regex("""^\+?\d{10,13}$""")

        /** Checks if a sender address is a personal individual phone number rather than a DLT business header. */
        fun isPersonalSender(sender: String?): Boolean {
            if (sender.isNullOrBlank()) return false
            val clean = sender.trim().replace(Regex("""[\s-]"""), "")
            return PERSONAL_SENDER_REGEX.matches(clean) || ALL_NUMERIC_LONG_REGEX.matches(clean)
        }

        /**
         * A first pass, so an ordinary message from a friend is never written down at
         * all. The real classification happens later, in JavaScript, against the user's
         * own rules. This only decides what is worth keeping.
         *
         * It has to stay coarse. A list of verbs is a second classifier, and it disagreed
         * with the real one: "deposited" was missing, so every salary credit was dropped
         * before it ever reached the app, along with bill payments, tolls and refunds.
         * That was 13 percent of everything the classifier could have filed, and it
         * failed silently, because a message that is never read cannot be reported as
         * unmatched. An amount is the one thing every bank alert has and an ordinary
         * conversation almost never does, so that is the whole test.
         */
        fun looksFinancial(body: String): Boolean {
            if (AMOUNT.containsMatchIn(body)) return true
            val text = body.lowercase()
            return MARKERS.any { text.contains(it) }
        }
    }
}
