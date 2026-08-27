-- Real disposable legacy data fixture for upgrade validation.
-- This is intentionally synthetic and contains no credentials or production data.
CREATE TEMP TABLE IF NOT EXISTS legacy_conversation_fixture (
  fixture_key TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  sent_copy BOOLEAN NOT NULL DEFAULT false,
  message_id TEXT,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message_date TIMESTAMPTZ NOT NULL,
  in_reply_to TEXT,
  references_header TEXT,
  legacy_thread_id TEXT
);

INSERT INTO legacy_conversation_fixture (fixture_key, account_key, sent_copy, message_id, subject, sender, recipient, message_date, legacy_thread_id)
SELECT 'test-' || n, CASE WHEN n % 2 = 0 THEN 'account-a' ELSE 'account-b' END, n % 5 = 0,
       '<legacy-test-' || n || '@fixture.test>', CASE WHEN n % 3 = 0 THEN 'Re: Test' ELSE 'Test' END,
       'sender-' || n || '@fixture.test', 'recipient-' || n || '@fixture.test',
       (2014 + (n % 4) * 5 || '-01-01T12:00:00Z')::timestamptz, '<legacy-test-0@fixture.test>'
FROM generate_series(1, 12) AS n
ON CONFLICT DO NOTHING;

-- The runner consumes this fixture through a deterministic table so an upgrade
-- test can assert that no subject-only join is reintroduced.
