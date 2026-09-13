import { query } from './db.js';

export const CONVERSATION_LIST_VIEW = 'conversation_list_view_enabled';
export const CONVERSATION_READER_VIEW = 'conversation_reader_view_enabled';

export async function ensureConversationFeatureDefaults(userId) {
  await query(`
    UPDATE users
       SET preferences = COALESCE(preferences, '{}'::jsonb)
         || CASE WHEN preferences ? $2 THEN '{}'::jsonb
                 ELSE jsonb_build_object($2, false) END
         || CASE WHEN preferences ? $3 THEN '{}'::jsonb
                 ELSE jsonb_build_object($3, false) END
     WHERE id = $1
  `, [userId, CONVERSATION_LIST_VIEW, CONVERSATION_READER_VIEW]);
}

export function conversationViewEnabled(preferences, key) {
  return preferences?.[key] === true;
}
