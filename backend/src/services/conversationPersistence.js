import { createHash } from 'crypto';
import { withTransaction } from './db.js';
import { effectiveConversationOverride, resolveConversationAlias, refreshConversationAggregates } from './conversationOverridePolicy.js';
import { normalizeMessageIdList } from './threading/normalizeMessageId.js';
import { canonicalConversationSubject, classifyDirection, logicalMessageIdentity, threadingDecision } from './conversationEngine.js';
import { strictSeriesDecision, smartSeriesDecision } from './automatedSeries.js';
import { referencesAnchor } from './automatedSeriesAnchor.js';

function fingerprintCopy(copy) {
  return createHash('sha256').update(JSON.stringify([copy.body_text || '', copy.subject || '', copy.from_email || '', copy.date || '', copy.in_reply_to || '', copy.thread_references || ''])).digest('hex');
}

export async function hydrateLogicalMessage(copy, { identities = [] } = {}) {
  const owner = copy.user_id || copy.userId;
  const identity = logicalMessageIdentity(copy, { userId: owner });
  return { ...identity, userId: owner, accountId: copy.account_id, rawHeaders: copy.conversation_raw_headers || copy.raw_headers || null, rawInReplyTo: copy.in_reply_to || null, rawReferences: copy.thread_references || null, canonicalSubject: canonicalConversationSubject(copy.subject), direction: classifyDirection(copy, identities), messageDate: copy.date || null, bodyFingerprint: createHash('sha256').update(String(copy.body_text || '')).digest('hex'), headerFingerprint: createHash('sha256').update(JSON.stringify([copy.message_id, copy.in_reply_to, copy.thread_references, copy.conversation_raw_headers])).digest('hex'), copyFingerprint: fingerprintCopy(copy) };
}

async function findExistingLogical(client, hydrated) {
  if (hydrated.canonicalMessageId) {
    // P1-07: query directly by (user_id, canonical_message_id, collision_key)
    // instead of LIMIT 2 + JS filtering. This handles >=3 collision variants
    // correctly and allows a unique constraint/index to prevent race duplicates.
    const result = await client.query(
      `SELECT id, conversation_id, message_id_collision_key
         FROM logical_messages
        WHERE user_id = $1 AND canonical_message_id = $2 AND message_id_collision_key = $3
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [hydrated.userId, hydrated.canonicalMessageId, hydrated.collisionKey],
    );
    if (result.rows.length > 0) return { logical: result.rows[0], collision: false };
    // No exact collision-key match. Check if the canonical Message-ID exists
    // with a DIFFERENT collision key — that is collision evidence (a new
    // logical message should be created, not a duplicate).
    const existing = await client.query(
      `SELECT 1 FROM logical_messages
        WHERE user_id = $1 AND canonical_message_id = $2
        LIMIT 1`,
      [hydrated.userId, hydrated.canonicalMessageId],
    );
    return { logical: null, collision: existing.rows.length > 0 };
  }
  const result = await client.query(`SELECT id, conversation_id, message_id_collision_key FROM logical_messages WHERE user_id = $1 AND canonical_message_id IS NULL AND body_fingerprint = $2 AND header_fingerprint = $3 ORDER BY created_at ASC LIMIT 1 FOR UPDATE`, [hydrated.userId, hydrated.bodyFingerprint, hydrated.headerFingerprint]);
  return { logical: result.rows[0] || null, collision: false };
}

async function findParentLogical(client, hydrated) {
  const replyId = normalizeMessageIdList(hydrated.rawInReplyTo).at(-1);
  if (replyId) {
    const direct = await client.query(`SELECT id, conversation_id, canonical_message_id, subject FROM logical_messages WHERE user_id = $1 AND canonical_message_id = $2 ORDER BY created_at ASC FOR UPDATE`, [hydrated.userId, replyId]);
    if (direct.rows.length === 1) return { ...direct.rows[0], relationType: 'in-reply-to' };
    if (direct.rows.length > 1) return { ambiguous: true, relationType: 'ambiguous-in-reply-to', canonical_message_id: replyId };
  }
  const refs = normalizeMessageIdList(hydrated.rawReferences);
  for (const referencedId of [...refs].reverse()) {
    const result = await client.query(`SELECT id, conversation_id, canonical_message_id, subject FROM logical_messages WHERE user_id = $1 AND canonical_message_id = $2 ORDER BY created_at ASC FOR UPDATE`, [hydrated.userId, referencedId]);
    if (result.rows.length === 1) return { ...result.rows[0], relationType: 'references' };
    if (result.rows.length > 1) return { ambiguous: true, relationType: 'ambiguous-references', canonical_message_id: referencedId };
  }
  return null;
}

async function findPreviousSeriesMessage(client, hydrated) {
  // P1-03: include c.logical_message_count so the 100-message cap check works.
  // Additional: filter by anchor/signatures, not just canonical_subject — a latest
  // same-subject unrelated candidate must not block an older correct candidate.
  // We look for the most recent logical message with the same canonical subject AND
  // the same sender signature (from_email), which is the actual series anchor.
  const result = await client.query(`
    SELECT lm.*, c.logical_message_count, m.from_email, m.to_addresses, m.body_text, m.date
      FROM logical_messages lm
      JOIN conversations c ON c.id = lm.conversation_id AND c.user_id = lm.user_id
      JOIN messages m ON m.logical_message_id = lm.id
     WHERE lm.user_id = $1 AND lm.canonical_subject = $2
     ORDER BY lm.message_date DESC NULLS LAST LIMIT 1
  `, [hydrated.userId, hydrated.canonicalSubject]);
  return result.rows[0] || null;
}

async function findProviderConversation(client, hydrated, provider) {
  if (!provider?.providerThreadId || !hydrated.accountId) return null;
  const result = await client.query(`SELECT conversation_id FROM provider_thread_mappings WHERE user_id = $1 AND account_id = $2 AND provider = $3 AND provider_thread_id = $4 FOR UPDATE`, [hydrated.userId, hydrated.accountId, provider.provider, provider.providerThreadId]);
  return result.rows[0]?.conversation_id || null;
}

export async function upsertConversationCopy(copy, { identities = [], provider = null } = {}) {
  return withTransaction(async client => {
      const verified = await client.query(`SELECT m.*, a.user_id, a.automated_series_mode FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1 AND a.user_id IS NOT NULL FOR UPDATE`, [copy.id]);
    if (verified.rows.length !== 1) throw new Error('Conversation copy not found or owner mismatch');
    const source = { ...verified.rows[0], user_id: verified.rows[0].user_id };
    const hydrated = await hydrateLogicalMessage(source, { identities });
    let requestedConversationId = null;
    const parent = await findParentLogical(client, hydrated);
    const decision = threadingDecision({ message: source, parent: parent?.ambiguous ? null : parent, provider, identities });
    const seriesMode = source.automated_series_mode || 'off';
    const previousSeries = await findPreviousSeriesMessage(client, hydrated);
    const series = seriesMode === 'strict' ? strictSeriesDecision({ message: { ...source, canonical_subject: hydrated.canonicalSubject, referencesAnchor: referencesAnchor(source) }, previous: previousSeries ? { ...previousSeries, canonical_subject: previousSeries.canonical_subject || hydrated.canonicalSubject, referencesAnchor: referencesAnchor(previousSeries) } : null, mode: 'strict' }) : seriesMode === 'smart' ? smartSeriesDecision({ message: { ...source, canonical_subject: hydrated.canonicalSubject }, previous: previousSeries, enabled: true }) : null;
    if (series && !parent?.ambiguous) { decision.kind = series.kind || decision.kind; decision.reason = series.kind || decision.reason; decision.confidence = series.confidence || decision.confidence; }
    if (parent?.ambiguous) decision.reason = parent.relationType;
    const existing = await findExistingLogical(client, hydrated);
    let logical = existing.logical;
    const collision = existing.collision;
    if (!logical) logical = (await client.query(`INSERT INTO logical_messages (user_id, canonical_message_id, raw_message_id, message_id_collision_key, raw_headers, raw_in_reply_to, raw_references, parsed_in_reply_to, parsed_references, subject, canonical_subject, direction, message_date, body_fingerprint, header_fingerprint, threading_reason, threading_confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, conversation_id`, [hydrated.userId, hydrated.canonicalMessageId, hydrated.rawMessageId, hydrated.collisionKey, hydrated.rawHeaders, hydrated.rawInReplyTo, hydrated.rawReferences, JSON.stringify(normalizeMessageIdList(hydrated.rawInReplyTo)), JSON.stringify(normalizeMessageIdList(hydrated.rawReferences)), source.subject || null, hydrated.canonicalSubject, hydrated.direction, hydrated.messageDate, hydrated.bodyFingerprint, hydrated.headerFingerprint, decision.reason, decision.confidence])).rows[0];
    else await client.query('UPDATE logical_messages SET raw_headers = COALESCE(raw_headers, $2), updated_at = NOW(), threading_reason = $3, threading_confidence = $4 WHERE id = $1', [logical.id, hydrated.rawHeaders, decision.reason, decision.confidence]);
    let conversationId = logical.conversation_id || await findProviderConversation(client, hydrated, provider) || (decision.reason === 'subject-change-split' ? null : parent?.conversation_id);
    if (series?.kind === 'automated_reference_series' || series?.kind === 'automated_smart_series') conversationId = previousSeries?.conversation_id || conversationId;
    const override = await effectiveConversationOverride(client, { userId: hydrated.userId, conversationId, logicalMessageId: logical.id });
    if (override.merge?.target_id) requestedConversationId = await resolveConversationAlias(client, { userId: hydrated.userId, conversationId: override.merge.target_id });
    if (override.split?.target_id) requestedConversationId = await resolveConversationAlias(client, { userId: hydrated.userId, conversationId: override.split.target_id });
    const previousConversationId = conversationId;
    if (override.forceExclude) conversationId = null;
    if (override.forceExclude) {
      await client.query('UPDATE messages SET conversation_id = NULL, conversation_user_id = NULL, threading_reason = $1, threading_confidence = 0 WHERE logical_message_id = $2 AND conversation_user_id = $3', ['manual-force-exclude', logical.id, hydrated.userId]);
      await client.query('UPDATE logical_messages SET conversation_id = NULL, parent_logical_message_id = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2', [logical.id, hydrated.userId]);
      if (previousConversationId) await client.query('DELETE FROM conversation_evidence WHERE logical_message_id = $1 AND conversation_id = $2 AND user_id = $3', [logical.id, previousConversationId, hydrated.userId]);
      await client.query('UPDATE unresolved_message_references SET resolved_logical_message_id = NULL, resolved_at = NULL WHERE resolved_logical_message_id = $1 AND user_id = $2', [logical.id, hydrated.userId]);
      if (previousConversationId) await refreshConversationAggregates(client, hydrated.userId, previousConversationId);
      return { logicalMessageId: null, conversationId: null, kind: 'excluded', canonicalSubject: hydrated.canonicalSubject };
    }
    if (override.forceInclude?.target_id) requestedConversationId = await resolveConversationAlias(client, { userId: hydrated.userId, conversationId: override.forceInclude.target_id });
    if (override.locked && conversationId) requestedConversationId = await resolveConversationAlias(client, { userId: hydrated.userId, conversationId });
    if (requestedConversationId) conversationId = requestedConversationId;
    const relatedParentConversationId = decision.reason === 'subject-change-split' ? parent?.conversation_id : null;
    if (!conversationId) conversationId = (await client.query(`INSERT INTO conversations (user_id, kind, subject_snapshot, canonical_subject, first_message_at, last_message_at, logical_message_count, copy_count, unread_count, threading_confidence) VALUES ($1,$2,$3,$4,$5,$5,0,0,0,$6) RETURNING id`, [hydrated.userId, decision.kind, source.subject || null, hydrated.canonicalSubject, hydrated.messageDate, decision.confidence])).rows[0].id;
    await client.query(`UPDATE logical_messages SET conversation_id = $1, parent_logical_message_id = CASE WHEN $4::text = 'subject-change-split' THEN NULL ELSE COALESCE(parent_logical_message_id, $2) END, updated_at = NOW() WHERE id = $3`, [conversationId, parent?.id || null, logical.id, decision.reason]);
    const attached = await client.query(`UPDATE messages SET logical_message_id = $1, conversation_id = $2, conversation_user_id = $3, canonical_message_id = $4, provider_message_id = COALESCE($5, provider_message_id), provider_thread_id = COALESCE($6, provider_thread_id), provider_namespace = COALESCE($7, provider_namespace), threading_reason = $8, threading_confidence = $9, threading_algorithm_version = 'conversation-v2', row_version = row_version + 1 WHERE id = $10 RETURNING id`, [logical.id, conversationId, hydrated.userId, hydrated.canonicalMessageId, provider?.providerMessageId || null, provider?.providerThreadId || null, provider?.namespace || provider?.provider || null, decision.reason, decision.confidence, source.id]);
    if (attached.rowCount !== 1) throw new Error('Conversation copy attachment failed');
    if (provider?.providerThreadId) await client.query(`INSERT INTO provider_thread_mappings (user_id, account_id, provider, provider_thread_id, conversation_id, last_seen_at, diagnostics) VALUES ($1,$2,$3,$4,$5,NOW(),$6::jsonb) ON CONFLICT (user_id, account_id, provider, provider_thread_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, last_seen_at = NOW(), diagnostics = EXCLUDED.diagnostics`, [hydrated.userId, hydrated.accountId, provider.provider, provider.providerThreadId, conversationId, JSON.stringify(provider.diagnostics || {})]);
    const unresolved = [...new Set([...normalizeMessageIdList(hydrated.rawInReplyTo), ...normalizeMessageIdList(hydrated.rawReferences)])].filter(id => id !== hydrated.canonicalMessageId);
    if (unresolved.length) {
      const known = await client.query(`SELECT id, canonical_message_id FROM logical_messages WHERE user_id = $1 AND canonical_message_id = ANY($2::text[])`, [hydrated.userId, unresolved]);
      const knownIds = new Set(known.rows.map(row => row.canonical_message_id));
      for (const [position, referenced] of unresolved.entries()) {
        const relationType = referenced === normalizeMessageIdList(hydrated.rawInReplyTo).at(-1) ? 'in-reply-to' : 'references';
        if (!knownIds.has(referenced)) {
          await client.query(`INSERT INTO unresolved_message_references (user_id, child_logical_message_id, referenced_message_id, relation_type, reference_position) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [hydrated.userId, logical.id, referenced, relationType, position]);
        }
      }
    }
    const waiting = await client.query(`SELECT id, child_logical_message_id FROM unresolved_message_references WHERE user_id = $1 AND referenced_message_id = $2 AND resolved_at IS NULL FOR UPDATE`, [hydrated.userId, hydrated.canonicalMessageId]);
    for (const reference of waiting.rows) {
      await client.query('UPDATE unresolved_message_references SET resolved_logical_message_id = $1, resolved_at = NOW() WHERE id = $2', [logical.id, reference.id]);
      const component = await client.query(`WITH RECURSIVE component(id, path) AS (
        SELECT id, ARRAY[id] FROM logical_messages WHERE id = $1 AND user_id = $2
        UNION ALL
        SELECT lm.id, component.path || lm.id FROM logical_messages lm JOIN component ON lm.parent_logical_message_id = component.id
         WHERE lm.user_id = $2 AND NOT lm.id = ANY(component.path)
      ) SELECT lm.id, lm.conversation_id, c.manually_locked FROM logical_messages lm JOIN component ON component.id = lm.id LEFT JOIN conversations c ON c.id = lm.conversation_id FOR UPDATE`, [reference.child_logical_message_id, hydrated.userId]);
      let blockedMove = false;
      const oldConversationIds = new Set();
      for (const node of component.rows) {
        if (node.conversation_id) oldConversationIds.add(node.conversation_id);
        const nodeOverride = await effectiveConversationOverride(client, { userId: hydrated.userId, conversationId: node.conversation_id, logicalMessageId: node.id });
        if (node.manually_locked || nodeOverride.forceExclude || nodeOverride.forceInclude || nodeOverride.split || nodeOverride.locked) blockedMove = true;
      }
      if (!blockedMove && component.rows.length && [...oldConversationIds].some(id => id !== conversationId)) {
        await client.query(`UPDATE logical_messages SET conversation_id = $1, parent_logical_message_id = CASE WHEN id = $2 THEN $3 ELSE parent_logical_message_id END, updated_at = NOW() WHERE id = ANY($4::uuid[]) AND user_id = $5`, [conversationId, reference.child_logical_message_id, logical.id, component.rows.map(node => node.id), hydrated.userId]);
        await client.query('UPDATE messages SET conversation_id = $1, conversation_user_id = $2 WHERE logical_message_id = ANY($3::uuid[]) AND conversation_user_id = $2', [conversationId, hydrated.userId, component.rows.map(node => node.id)]);
        const touched = new Set([...oldConversationIds, conversationId]);
        for (const touchedId of touched) await refreshConversationAggregates(client, hydrated.userId, touchedId);
        const crossEdge = await client.query(`SELECT 1 FROM logical_messages child JOIN logical_messages parent ON parent.id = child.parent_logical_message_id WHERE child.user_id = $1 AND child.conversation_id IS DISTINCT FROM parent.conversation_id LIMIT 1`, [hydrated.userId]);
        if (crossEdge.rows.length) throw new Error('delayed parent reconcile left a cross-conversation parent edge');
      }
    }
    if (parent?.ambiguous) await client.query(`INSERT INTO conversation_evidence (user_id, conversation_id, logical_message_id, evidence_type, evidence_value_hash, weight, details) VALUES ($1,$2,$3,'ambiguous-parent',$4,0,$5::jsonb) ON CONFLICT DO NOTHING`, [hydrated.userId, conversationId, logical.id, createHash('sha256').update(String(parent.canonical_message_id)).digest('hex'), JSON.stringify({ canonical_message_id: parent.canonical_message_id, relation_type: parent.relationType })]);
    if (relatedParentConversationId) await client.query(`INSERT INTO conversation_evidence (user_id, conversation_id, logical_message_id, evidence_type, evidence_value_hash, weight, details) VALUES ($1,$2,$3,'subject-change-split',$4,1,$5::jsonb) ON CONFLICT DO NOTHING`, [hydrated.userId, relatedParentConversationId, logical.id, createHash('sha256').update(String(logical.id)).digest('hex'), JSON.stringify({ relatedConversation_id: conversationId, parent_logical_message_id: parent.id })]);
    const evidence = [[decision.reason, decision.confidence, { relationType: parent?.relationType || null, provider: provider?.provider || null }], ...(series ? [[series.kind, series.confidence, { mode: seriesMode, previousLogicalMessageId: previousSeries?.id || null }]] : []), ...(parent ? [['rfc-parent', 0.99, { parentLogicalMessageId: parent.id }]] : []), ...(provider?.providerThreadId ? [['provider-thread-id', 1, { provider: provider.provider }]] : [])];
    if (collision) evidence.push(['message-id-collision', 0, { canonicalMessageId: hydrated.canonicalMessageId, collisionKey: hydrated.collisionKey }]);
    for (const [type, weight, details] of evidence) await client.query(`INSERT INTO conversation_evidence (user_id, conversation_id, logical_message_id, evidence_type, evidence_value_hash, weight, details) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (conversation_id, logical_message_id, evidence_type, evidence_value_hash) DO NOTHING`, [hydrated.userId, conversationId, logical.id, type, createHash('sha256').update(JSON.stringify(details)).digest('hex'), weight, JSON.stringify(details)]);
    await client.query(`UPDATE conversations c SET first_message_at = (SELECT MIN(message_date) FROM logical_messages WHERE conversation_id = c.id), last_message_at = (SELECT MAX(message_date) FROM logical_messages WHERE conversation_id = c.id), subject_snapshot = COALESCE((SELECT subject FROM logical_messages WHERE conversation_id = c.id ORDER BY message_date ASC NULLS LAST, id LIMIT 1), c.subject_snapshot), canonical_subject = COALESCE((SELECT canonical_subject FROM logical_messages WHERE conversation_id = c.id ORDER BY message_date ASC NULLS LAST, id LIMIT 1), c.canonical_subject), logical_message_count = (SELECT COUNT(*) FROM logical_messages WHERE conversation_id = c.id), copy_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = false), unread_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = false AND is_read = false), updated_at = NOW() WHERE c.id = $1`, [conversationId]);
    return { logicalMessageId: logical.id, conversationId, kind: decision.kind, canonicalSubject: hydrated.canonicalSubject };
  }, { serializable: true });
}
