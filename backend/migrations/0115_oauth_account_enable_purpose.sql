-- Allow the `account_enable` authorization purpose to be stored on an OAuth flow.
--
-- `account_enable` is the purpose the account card sends to authorize everything one mailbox needs (mail,
-- calendar and contacts) in a single consent. It is already a first-class member of the TypeScript
-- `AuthorizationPurpose` union, it has its own scope sets and a finalizer branch, but two things never
-- accepted it end to end:
--
--   * the OAuth start routes kept a narrower purpose allow-list, so an explicitly sent `account_enable` was
--     silently rewritten to `new_account` (fixed in the route layer); and
--   * this table's CHECK, created by 0103, rejected the value, so even a route that accepted it could not
--     persist the flow.
--
-- Widening an existing CHECK is additive: no column, row or index is touched, and every value that was
-- valid before is still valid. Apply after 0114. Safe on any state (the DROP is guarded).

ALTER TABLE oauth_authorization_flows
  DROP CONSTRAINT IF EXISTS oauth_authorization_flows_purpose_check;

ALTER TABLE oauth_authorization_flows
  ADD CONSTRAINT oauth_authorization_flows_purpose_check
  CHECK (purpose IN ('new_account', 'mail_migration', 'calendar_enable', 'contacts_enable', 'account_enable'));
