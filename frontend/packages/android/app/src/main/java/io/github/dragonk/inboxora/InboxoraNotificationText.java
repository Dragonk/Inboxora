package io.github.dragonk.inboxora;

import org.json.JSONObject;

/**
 * Builds the visible text of a new-mail notification - Gmail-style: the sender
 * in the title, the subject plus a short body preview in the text, with the
 * caller-supplied localized fallbacks used only when the message carries none
 * of the corresponding fields.
 *
 * <p>Three message shapes reach the native side and all must work: the native
 * notification endpoints ({@code title}/{@code body}/{@code snippet}), the live
 * WebSocket rows ({@code fromName}/{@code fromEmail}/{@code subject}/{@code
 * snippet}) and the legacy session-cookie list rows ({@code from_name}/{@code
 * from_email}/{@code subject}/{@code snippet}).
 */
final class InboxoraNotificationText {
    private InboxoraNotificationText() {}

    /** First non-empty value among the given keys, or an empty string. */
    static String first(JSONObject message, String... keys) {
        for (String key : keys) {
            if (message == null) break;
            // An explicit JSON null is not a value: optString would coerce it into
            // the literal string "null" and put it in the notification text.
            if (message.isNull(key)) continue;
            String value = message.optString(key, "");
            if (value != null && !value.isEmpty()) return value;
        }
        return "";
    }

    /** Notification title: the sender, or the localized fallback. */
    static String title(JSONObject message, String fallbackTitle) {
        String title = first(message, "title", "from_name", "fromName", "from_email", "fromEmail");
        return title.isEmpty() ? fallbackTitle : title;
    }

    /**
     * Notification text: the subject and the body preview, on separate lines
     * when both exist (either alone when only one does). With neither, a
     * multi-message reconciliation delta uses the localized count template and
     * a single message falls back to the localized generic line - never a
     * hardcoded English one.
     */
    static String body(JSONObject message, int delta, String fallbackBody, String fallbackCount) {
        String subject = first(message, "subject", "body");
        String snippet = first(message, "snippet");
        if (!subject.isEmpty() && !snippet.isEmpty()) return subject + "\n" + snippet;
        if (!subject.isEmpty()) return subject;
        if (!snippet.isEmpty()) return snippet;
        if (delta > 1) return fallbackCount.replace("{{count}}", String.valueOf(delta));
        return fallbackBody;
    }
}
