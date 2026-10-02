import { mapConcurrent } from '../utils/mapConcurrent.js';
import { remoteSearchFolders, searchRemoteAccount, waitForRemoteSearch } from './mailSearchRemote.js';
import { searchDate } from './mailSearchRemoteQuery.js';
import { searchFolderCondition, searchFolderAccessCondition, type MailSearchAccess } from './mailSearchAccess.js';
import { parseSearchQuery, escapeSearchLike, type SearchFilter } from './mailSearchQuery.js';
import { query } from './db.js';
import { resolveAccountScope, type UnifiedInboxAccount } from './unifiedInbox.js';
import { toAppError } from '../utils/errors.js';
import { queryInt, queryString } from '../utils/query.js';

/** The account columns the search scope and its provider branch read. */
interface SearchAccount extends UnifiedInboxAccount {
  user_id: string;
  mail_transport?: string | null;
  provider_connection_id?: string | null;
}

/** A provider search that failed, reported next to the local results it did not block. */
interface ProviderSearchError { accountId: string; code?: string; error: string }

// Wraps a positive condition so that when negated it also matches rows where the
// underlying columns are NULL (COALESCE(..., false) treats NULL as "not a match",
// which NOT then flips to a match — the intuitive meaning of exclusion).
function negateCond(sql: string) {
  return `NOT COALESCE((${sql}), false)`;
}

export function resolveSearchFolderScope(filters: SearchFilter[], folderParam = '') {
  let folderScope;
  let folderFuzzy = false; // in:<name> matches loosely; the folder param is exact

  for (const f of filters) {
    if (f.key !== 'in' || f.negate) continue;
    if (f.value === 'all') { folderScope = null; }
    else { folderScope = f.value; folderFuzzy = true; }
  }

  if (folderScope === undefined) {
    folderScope = (folderParam || '').trim() || null;
    folderFuzzy = false;
  }

  return { folderScope, folderFuzzy };
}

export function shouldExcludeTrashFromSearch(folderScope: string | null) {
  return folderScope === null;
}

export function trashFolderExclusionCondition() {
  return `NOT EXISTS (
        SELECT 1
        FROM folders f
        WHERE f.account_id = m.account_id
          AND ((COALESCE(a.mail_transport,'') <> 'gmail_api' AND f.path = m.folder) OR
            (a.mail_transport='gmail_api' AND EXISTS(SELECT 1 FROM message_labels tl WHERE tl.message_id=m.id AND tl.account_id=m.account_id AND tl.folder_path=f.path)))
          AND (f.special_use = '\\Trash'
               OR lower(f.name) LIKE '%trash%'
               OR lower(f.name) LIKE '%deleted%')
      )`;
}

// Postgres refuses to build a tsvector larger than ~1MB of packed lexemes
// (SQLSTATE 54000), so an oversized body would 500 the whole search. Cap the
// text fed to to_tsvector at 600k chars — matching msgvault's maxFTSBodyChars
// (internal/store/dialect_pg.go) — so one huge email can't crash the query.
// Exported because slice 02's search_fts trigger caps the same way.
export const FTS_BODY_CHAR_CAP = 600000;

// Builds the per-term free-text OR-condition: a term matches if it appears in
// the sender, the subject, the stored search_vector, or the length-capped body.
// Extracted so the body cap is a single, testable source of truth.
export function freeTextTermCondition(likeIdx: number, ftsIdx: number, phrase = false) {
  const tsQuery = phrase ? 'phraseto_tsquery' : 'plainto_tsquery';
  return `(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.to_addresses::text ILIKE $${likeIdx}
        OR m.cc_addresses::text ILIKE $${likeIdx}
        OR m.snippet ILIKE $${likeIdx}
        OR m.body_text ILIKE $${likeIdx}
        OR regexp_replace(LEFT(coalesce(m.body_html,''), ${FTS_BODY_CHAR_CAP}), '<[^>]*>', ' ', 'g') ILIKE $${likeIdx}
        OR m.search_vector @@ ${tsQuery}('english', $${ftsIdx})
        OR to_tsvector('english', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ ${tsQuery}('english', $${ftsIdx})
      )`;
}

export async function searchMail(userId: string, input: Record<string, unknown>, access?: MailSearchAccess) {
  const q = queryString(input.q) ?? '';
  const accountId = queryString(input.accountId);
  const limit = queryInt(input.limit, 50);
  const offset = queryInt(input.offset, 0);
  const trimmed = q.trim();
  if (!trimmed) return ({ messages: [] });
  if (trimmed.length > 500) throw Object.assign(new Error('Search query too long'), { statusCode: 400 });

  const accountsResult = await query<SearchAccount>(
    'SELECT id, user_id, include_in_unified_inbox, mail_transport, provider_connection_id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  const accounts = accountsResult.rows.filter(account => !access?.accounts || access.accounts.includes(account.id));
  const { accountIds: targetIds } = resolveAccountScope(access?.allAccounts ? accounts.map(account => ({ ...account, include_in_unified_inbox: true })) : accounts, accountId);
  if (!targetIds.length) return ({ messages: [] });

  const providerErrors: ProviderSearchError[] = [];
  const remoteIds: string[] = [];
  let partial = false;
  let retryablePartial = false;
  const cap = Math.max(1, Math.min(limit, 200));
  const { filters, terms } = parseSearchQuery(trimmed);

  const conditions: string[] = [];
  const params: unknown[] = [targetIds];
  let p = 2;
  const textConditions: string[] = [];

  // Folder scope. `in:` in the query wins; otherwise the client-supplied `folder`
  // param (the folder the user is currently viewing) applies. `undefined` means
  // no in: operator was given, so we fall back to the param below.
  //   folderScope === null   → search all folders
  //   folderScope === string → restrict to that folder

  // ── Operator filters ──────────────────────────────────────────────────────

  for (const f of filters) {
    // Positive in: selects scope. Negative in: excludes only the named folder.
    if (f.key === 'in') {
      if (f.negate && f.value !== 'all') {
        params.push(escapeSearchLike(f.value), `%/${escapeSearchLike(f.value)}`);
        conditions.push(negateCond(searchFolderCondition(p, true, p + 1)));
        p += 2;
      }
      continue;
    }

    let cond = null;

    if (f.key === 'from') {
      params.push(`%${escapeSearchLike(f.value)}%`);
      cond = `(m.from_email ILIKE $${p} OR m.from_name ILIKE $${p})`;
      p++;
    } else if (f.key === 'subject') {
      params.push(`%${escapeSearchLike(f.value)}%`);
      cond = `m.subject ILIKE $${p++}`;
    } else if (f.key === 'to') {
      // to: searches the to/cc address JSON — cast to text covers name and email
      params.push(`%${escapeSearchLike(f.value)}%`);
      cond = `(m.to_addresses::text ILIKE $${p} OR m.cc_addresses::text ILIKE $${p})`;
      p++;
    } else if (f.key === 'has') {
      if (f.value === 'attachment' || f.value === 'attachments') cond = `m.has_attachments = true`;
    } else if (f.key === 'is') {
      if (f.value === 'unread')  cond = `m.is_read = false`;
      else if (f.value === 'read')    cond = `m.is_read = true`;
      else if (f.value === 'starred') cond = `m.is_starred = true`;
    } else if (f.key === 'after') {
      const d = searchDate(f.value);
      if (!Number.isNaN(d.getTime())) { params.push(d.toISOString()); cond = `m.date >= $${p++}`; }
    } else if (f.key === 'before') {
      const d = searchDate(f.value);
      if (!Number.isNaN(d.getTime())) { params.push(d.toISOString()); cond = `m.date < $${p++}`; }
    }

    if (cond) conditions.push(f.negate ? negateCond(cond) : cond);
  }

  // ── Free-text terms ───────────────────────────────────────────────────────
  // Each term must match at least one of: from, subject (ILIKE — good for names
  // and partial words), or body content (FTS — good for large text with stemming).
  // AND between all terms: every word must appear somewhere in the email.
  // A negated term (-word) must appear nowhere.

  for (const term of terms) {
    if (!term.value) continue;
    params.push(`%${escapeSearchLike(term.value)}%`); // ILIKE pattern
    const likeIdx = p++;

    params.push(term.value); // raw term for plainto_tsquery
    const ftsIdx = p++;

    const cond = freeTextTermCondition(likeIdx, ftsIdx, /\s/.test(term.value));
    textConditions.push(term.negate ? `(${negateCond(cond)} AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL))` : cond);
  }

  // Require at least one real search condition before applying folder scope, so a
  // bare `in:inbox` (or a lone folder param) never dumps an entire folder.
  if (!conditions.length && !textConditions.length) return ({ messages: [], query: q });

  // Resolve folder scope: in: operator wins; otherwise use the param.
  const { folderScope, folderFuzzy } = resolveSearchFolderScope(filters, queryString(input.folder) ?? '');
  if (folderScope) {
    if (folderFuzzy) {
      // in:<name> — case-insensitive match on a folder named exactly that, or a
      // nested folder whose path ends in it (in:sent → "Sent" or "Personal/Sent").
      // A multi-word leaf like "[Gmail]/Sent Mail" needs the quoted form in:"sent mail".
      params.push(escapeSearchLike(folderScope));
      params.push(`%/${escapeSearchLike(folderScope)}`);
      conditions.push(searchFolderCondition(p, true, p + 1));
      p += 2;
    } else {
      params.push(folderScope);
      conditions.push(searchFolderCondition(p++));
    }
  } else if (shouldExcludeTrashFromSearch(folderScope)) {
    // Deleting moves mail into Trash, where it remains searchable by explicit
    // folder queries like in:trash. Keep ordinary all-folder searches from
    // resurfacing freshly-deleted messages after the optimistic UI guard expires.
    conditions.push(trashFolderExclusionCondition());
  }

  if (access?.folders !== undefined && access.folders !== null) {
    params.push(JSON.stringify(access.folders));
    conditions.push(searchFolderAccessCondition(p++));
  }
  if (textConditions.length) {
    // A provider confirms the whole parsed text expression. Its metadata-only
    // hits must not fail again just because their body is not cached locally.
    params.push(remoteIds);
    conditions.push(`((${textConditions.join(' AND ')}) OR m.id=ANY($${p++}::uuid[]))`);
  }
  const off = Math.max(0, offset);
  params.push(cap + 1);
  params.push(off);

  const runLocalSearch = () => query(`
      SELECT
        m.id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.account_id = ANY($1)
        AND m.is_deleted = false
        AND ${conditions.join('\n        AND ')}
      ORDER BY m.date DESC NULLS LAST, m.id DESC
      LIMIT $${p} OFFSET $${p + 1}
    `, params);

  try {
    // A full cached page cannot prove coverage: newer server matches or a
    // different account may be entirely absent from the local sync window.
    const remoteDeadline = Date.now() + 8000;
    await mapConcurrent(accounts.filter(account => targetIds.includes(account.id)), 3, async account => {
      try {
        const folders = await remoteSearchFolders(account.id, folderScope, folderFuzzy, access?.folders);
        const result = await waitForRemoteSearch(() => searchRemoteAccount(account, { query: trimmed, folders, maxResults: Math.min(1000, Math.max(200, off + cap + 1)) }), remoteDeadline);
        remoteIds.push(...result.rowIds);
        partial ||= result.truncated;
        retryablePartial ||= result.retryable === true;
        if (result.errors?.length) providerErrors.push({ accountId: account.id, code: 'SEARCH_INCOMPLETE', error: result.errors.join(' ') });
      } catch (caught) {
        const error = toAppError(caught); partial = true;
        retryablePartial ||= error.name === 'TimeoutError' || error.name === 'AbortError' || (error as typeof error & { retryable?: boolean }).retryable === true;
        providerErrors.push({ accountId: account.id, code: error.code || 'PROVIDER_SEARCH_FAILED',
          error: 'The mail server could not complete this search. Locally synchronized matches are shown; check the account connection and retry.' });
        console.warn(`Provider search failed for account ${account.id}: ${error.code || 'unavailable'}`);
      }
    });
    const result = await runLocalSearch();
    return ({
      messages: result.rows.slice(0, cap),
      nextOffset: result.rows.length > cap ? off + cap : null,
      partial,
      retryablePartial,
      coverage: partial ? 'partial' : 'provider_and_local',
      query: q,
      ...(providerErrors.length ? { providerErrors } : {}),
    });
  } catch (err) {
    console.error('Search error:', err);
    throw err;
  }
}
