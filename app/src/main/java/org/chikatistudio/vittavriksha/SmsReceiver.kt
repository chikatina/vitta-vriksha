package org.chikatistudio.vittavriksha

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
        var queued = 0

        for (message in Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return) {
            val body = message.messageBody ?: continue
            if (!looksFinancial(body)) continue
            queue.add(message.displayOriginatingAddress ?: "", body, "sms")
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
