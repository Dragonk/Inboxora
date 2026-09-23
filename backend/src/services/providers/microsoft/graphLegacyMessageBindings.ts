/** Minimal query surface shared by a transaction client and the application's pool helper. */
interface QueryExecutor {
  query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/**
 * A legacy IMAP physical row deliberately never receives a Graph provider id.  The
 * separate binding keeps the old local UUID usable without collapsing a second
 * provider copy or claiming that an RFC Message-ID is a Graph identity.
 */
export interface GraphMessageBinding {
  canonicalMessageId: string;
  providerMessageId: string;
}

export type GraphIdentityResolution =
  | { kind: 'resolved'; providerMessageId: string; canonicalMessageId: string }
  | { kind: 'account_connection_missing' }
  | { kind: 'identity_missing' }
  | { kind: 'binding_ambiguous' };

/** Resolve direct native identity or one verified legacy alias for this account+connection. */
export async function resolveGraphMessageIdentity(
  client: QueryExecutor,
  input: { messageId: string; accountId: string; connectionId: string | null | undefined; directProviderMessageId: string | null | undefined },
): Promise<GraphIdentityResolution> {
  if (!input.connectionId) return { kind: 'account_connection_missing' };
  if (input.directProviderMessageId?.trim()) {
    return { kind: 'resolved', providerMessageId: input.directProviderMessageId, canonicalMessageId: input.messageId };
  }
  const binding = await client.query<{ canonical_message_id: string; provider_message_id: string }>(
    `SELECT b.canonical_message_id, canonical.provider_message_id
       FROM graph_legacy_message_bindings b
       JOIN messages canonical ON canonical.id = b.canonical_message_id
      WHERE b.legacy_message_id = $1 AND b.account_id = $2 AND b.connection_id = $3
        AND b.status = 'bound' AND canonical.account_id = $2
        AND NULLIF(BTRIM(canonical.provider_message_id), '') IS NOT NULL
      LIMIT 2`,
    [input.messageId, input.accountId, input.connectionId],
  );
  if (binding.rows.length !== 1) return { kind: binding.rows.length > 1 ? 'binding_ambiguous' : 'identity_missing' };
  const row = binding.rows[0]!;
  return { kind: 'resolved', providerMessageId: row.provider_message_id, canonicalMessageId: row.canonical_message_id };
}

/**
 * Bind only an unambiguous legacy counterpart observed during a native Graph page.
 * An RFC Message-ID alone is intentionally insufficient: sender and timestamp must
 * agree, and multiple physical legacy rows remain a visible review case.
 */
export async function bindVerifiedLegacyGraphMessage(
  client: QueryExecutor,
  input: {
    accountId: string;
    connectionId: string;
    canonicalMessageId: string;
    providerMessageId: string;
    rfcMessageId: string | null;
    fromEmail: string | null;
    date: string | Date | null;
  },
): Promise<'bound' | 'none' | 'ambiguous'> {
  const rfcMessageId = input.rfcMessageId?.trim();
  if (!rfcMessageId) return 'none';
  const candidates = await client.query<{ id: string }>(
    `SELECT m.id
       FROM messages m
      WHERE m.account_id = $1
        AND NULLIF(BTRIM(m.provider_message_id), '') IS NULL
        AND NULLIF(BTRIM(m.message_id), '') = $2
        AND m.from_email IS NOT DISTINCT FROM $3
        AND m.date IS NOT DISTINCT FROM $4::timestamptz
        AND m.id <> $5
      ORDER BY m.id
      LIMIT 2`,
    [input.accountId, rfcMessageId, input.fromEmail, input.date, input.canonicalMessageId],
  );
  if (candidates.rows.length === 0) return 'none';
  if (candidates.rows.length !== 1) return 'ambiguous';
  const legacyMessageId = candidates.rows[0]!.id;
  await client.query(
    `INSERT INTO graph_legacy_message_bindings
       (legacy_message_id, canonical_message_id, account_id, connection_id, status, evidence)
     VALUES ($1, $2, $3, $4, 'bound', jsonb_build_object('kind', 'rfc_message_id_sender_date'))
     ON CONFLICT (legacy_message_id) DO UPDATE
       SET canonical_message_id = EXCLUDED.canonical_message_id,
           connection_id = EXCLUDED.connection_id,
           status = 'bound', evidence = EXCLUDED.evidence, updated_at = NOW()
       WHERE graph_legacy_message_bindings.account_id = EXCLUDED.account_id`,
    [legacyMessageId, input.canonicalMessageId, input.accountId, input.connectionId],
  );
  return 'bound';
}
