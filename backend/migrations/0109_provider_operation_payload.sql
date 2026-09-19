-- P07b: keep the adapter parameters of a scheduled provider mutation.
--
-- `provider_operations` already records the intent, the claim, the lease, the
-- generation and the outcome, and `next_attempt_at` lets a retryable mutation be
-- scheduled for later. What it did not keep is *what to retry*: the row carried
-- `expected_versions` (optimistic concurrency) but nothing that a worker could hand
-- back to an adapter. Without it a `pending` row is unreadable, which is why the
-- pending pool had no drainer.
--
-- The payload is the adapter's own JSON, bounded by the mutation layer, and never
-- carries credentials — an adapter reaches those through its own services.
--
-- Expand-only: the column is nullable and no existing row is rewritten. Apply in
-- order, after 0108, before rolling out the application.

ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS payload JSONB;
