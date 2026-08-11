-- Per-message plugin annotations (v3.0 plugin platform).
--
-- Plugins sometimes need to cache a small piece of derived data ON a message (GTD caches a
-- one-line AI "gist" for waiting heads). A dedicated GTD column (messages.gtd_gist) was both a
-- core↔plugin leak and GTD-specific. Replace it with a generic, plugin-namespaced JSONB column:
-- `plugin_annotations = { "<pluginId>": { ... } }`. It lives on the message row, so it is cleaned
-- automatically when the message is deleted (unlike plugin_data, which only cascades on user
-- delete) — the correct lifecycle for a per-message cache.
--
-- Accessed only through the getMessageAnnotations / setMessageAnnotation capabilities; no plugin
-- reads or writes this column directly.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS plugin_annotations JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Carry existing GTD gists across into the namespaced shape.
UPDATE messages
   SET plugin_annotations = jsonb_build_object('gtd', jsonb_build_object('gist', gtd_gist))
 WHERE gtd_gist IS NOT NULL
   AND (plugin_annotations -> 'gtd' -> 'gist') IS NULL;

ALTER TABLE messages DROP COLUMN IF EXISTS gtd_gist;
