-- Provider device authorization (P04).
--
-- A device flow has provider-side state a browser flow does not: the device code itself, the interval
-- the provider asks to be polled at, and when the last poll actually happened. They live on the flow
-- row so a server restart does not strand a pending authorization (the mailbox device flow keeps its
-- state in process memory, which is exactly the property this provider flow must not inherit).
--
-- Additive: three nullable columns. Existing browser flows keep NULL in all three, and the flow table's
-- `expires_at` is reused for the device code's own expiry, since the provider's `expires_in` is what
-- bounds the flow.
ALTER TABLE oauth_authorization_flows ADD COLUMN IF NOT EXISTS device_code_enc TEXT;
ALTER TABLE oauth_authorization_flows ADD COLUMN IF NOT EXISTS device_interval_seconds INTEGER;
ALTER TABLE oauth_authorization_flows ADD COLUMN IF NOT EXISTS device_last_polled_at TIMESTAMPTZ;
