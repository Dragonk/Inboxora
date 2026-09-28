-- Apply after 0150 and before deploying the accounts API that selects these columns.
-- Preferences belong to the account, including all its aliases; transports do not use them.
CREATE FUNCTION account_default_recipients_bounded(addresses TEXT[])
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT addresses IS NOT NULL
    AND cardinality(addresses) <= 50
    AND (cardinality(addresses) = 0 OR (array_ndims(addresses) = 1 AND array_lower(addresses, 1) = 1))
    AND NOT EXISTS (
      SELECT 1 FROM unnest(addresses) AS address
      WHERE address IS NULL OR char_length(address) NOT BETWEEN 3 AND 254
        OR address ~ '[[:cntrl:]]'
    );
$$;

ALTER TABLE email_accounts
  ADD COLUMN default_cc TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN default_bcc TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT email_accounts_default_cc_bounded CHECK (account_default_recipients_bounded(default_cc)),
  ADD CONSTRAINT email_accounts_default_bcc_bounded CHECK (account_default_recipients_bounded(default_bcc));
