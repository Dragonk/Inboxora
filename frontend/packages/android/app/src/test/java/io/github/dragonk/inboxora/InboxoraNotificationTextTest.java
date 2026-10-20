package io.github.dragonk.inboxora;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

public class InboxoraNotificationTextTest {
    private static final String FALLBACK_TITLE = "Nowa wiadomość";
    private static final String FALLBACK_BODY = "Masz nową wiadomość.";
    private static final String FALLBACK_COUNT = "Nowe wiadomości: {{count}}";

    @Test
    public void buildsSenderSubjectAndPreviewFromTheNativeEndpointShape() throws Exception {
        JSONObject message = new JSONObject()
            .put("title", "Ada Lovelace")
            .put("body", "Quarterly report")
            .put("snippet", "The numbers for Q3 are attached.");
        assertEquals("Ada Lovelace", InboxoraNotificationText.title(message, FALLBACK_TITLE));
        assertEquals("Quarterly report\nThe numbers for Q3 are attached.",
            InboxoraNotificationText.body(message, 1, FALLBACK_BODY, FALLBACK_COUNT));
    }

    @Test
    public void buildsFromTheLegacyCookieListShape() throws Exception {
        JSONObject message = new JSONObject()
            .put("from_name", "")
            .put("from_email", "bob@example.com")
            .put("subject", "Hello")
            .put("snippet", "Long time no see.");
        assertEquals("bob@example.com", InboxoraNotificationText.title(message, FALLBACK_TITLE));
        assertEquals("Hello\nLong time no see.",
            InboxoraNotificationText.body(message, 1, FALLBACK_BODY, FALLBACK_COUNT));
    }

    @Test
    public void buildsFromTheLiveWebSocketShape() throws Exception {
        JSONObject message = new JSONObject()
            .put("fromName", "Cynthia")
            .put("subject", "Lunch tomorrow?")
            .put("snippet", "The usual place at noon.");
        assertEquals("Cynthia", InboxoraNotificationText.title(message, FALLBACK_TITLE));
        assertEquals("Lunch tomorrow?\nThe usual place at noon.",
            InboxoraNotificationText.body(message, 1, FALLBACK_BODY, FALLBACK_COUNT));
    }

    @Test
    public void showsTheSubjectAloneWhenThereIsNoSnippetAndViceVersa() throws Exception {
        JSONObject subjectOnly = new JSONObject().put("subject", "Subject only");
        assertEquals("Subject only",
            InboxoraNotificationText.body(subjectOnly, 1, FALLBACK_BODY, FALLBACK_COUNT));
        JSONObject snippetOnly = new JSONObject().put("snippet", "Snippet only");
        assertEquals("Snippet only",
            InboxoraNotificationText.body(snippetOnly, 1, FALLBACK_BODY, FALLBACK_COUNT));
    }

    @Test
    public void usesTheLocalizedFallbacksWhenTheMessageCarriesNoText() throws Exception {
        JSONObject empty = new JSONObject();
        assertEquals(FALLBACK_TITLE, InboxoraNotificationText.title(empty, FALLBACK_TITLE));
        assertEquals(FALLBACK_BODY,
            InboxoraNotificationText.body(empty, 1, FALLBACK_BODY, FALLBACK_COUNT));
        assertEquals("Nowe wiadomości: 3",
            InboxoraNotificationText.body(empty, 3, FALLBACK_BODY, FALLBACK_COUNT));
    }

    @Test
    public void survivesAMissingMessageObject() throws Exception {
        assertEquals(FALLBACK_TITLE, InboxoraNotificationText.title(null, FALLBACK_TITLE));
        assertEquals(FALLBACK_BODY,
            InboxoraNotificationText.body(null, 1, FALLBACK_BODY, FALLBACK_COUNT));
        assertEquals("Nowe wiadomości: 2",
            InboxoraNotificationText.body(null, 2, FALLBACK_BODY, FALLBACK_COUNT));
    }
}
