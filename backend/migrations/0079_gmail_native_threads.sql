-- The native list, expansion and bulk actions share the generated thread_key.
-- Gmail's server thread identity also groups automated mail without RFC reply links.
UPDATE messages SET thread_id = 'gmail:' || provider_thread_id
WHERE provider_namespace LIKE 'gmail:%' AND provider_thread_id IS NOT NULL
  AND thread_id IS DISTINCT FROM ('gmail:' || provider_thread_id);
