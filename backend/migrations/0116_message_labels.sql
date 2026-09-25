-- MAIL-02, first step: record which labels a provider message belongs to.
--
-- A message has one `folder`, which is the one place it is presented in. A Gmail message can carry several labels
-- at once, and today only the primary one is kept — the rest are visible only as `messages.provider_labels`, an
-- array that no view can be built on. This table is the durable membership the audit asks for: one row per
-- (message, label), written by the synchronisation, so a later change can present a message in every label it
-- carries without re-reading the provider.
--
-- Nothing reads it yet, which is deliberate: the reads (folder listings, counts, search) change together with the
-- model, and writing the membership first is what makes that change verifiable. The migration is additive: it
-- creates a table, rewrites nothing, and an application version that does not know it leaves it empty.
CREATE TABLE IF NOT EXISTS message_labels (
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL,
  -- The provider's own label id (Gmail's `Label_1`, `INBOX`, …), which is what the provider reports.
  label_id     TEXT NOT NULL,
  -- The local folder path that label projects into, when this account models one.
  folder_path  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, label_id)
);

-- A message is looked up by its labels (which messages carry this one), and the account scopes every query.
CREATE INDEX IF NOT EXISTS message_labels_account_label_idx ON message_labels (account_id, label_id);
-- The same membership with the folder path, for the views that follow a label's projected folder.
CREATE INDEX IF NOT EXISTS message_labels_folder_idx ON message_labels (account_id, folder_path);
