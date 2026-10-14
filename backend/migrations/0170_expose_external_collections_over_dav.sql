-- Migration 0170: Expose external calendars and address books (including Google,
-- Microsoft, CalDAV, and CardDAV) over CalDAV and CardDAV by default.
-- Existing external collections created with dav_mode = 'off' are updated to
-- 'read_write', matching local collections. Read-only safety on the DAV channel
-- for external provider collections without direct DAV write-through is enforced
-- by the capability resolution layer.

UPDATE calendars
   SET dav_mode = 'read_write',
       updated_at = NOW()
 WHERE dav_mode = 'off'
   AND source IN ('google', 'microsoft', 'caldav', 'ical_url');

UPDATE address_books
   SET dav_mode = 'read_write',
       updated_at = NOW()
 WHERE dav_mode = 'off'
   AND source IN ('google', 'microsoft', 'carddav');

UPDATE integration_collections
   SET dav_mode = 'read_write',
       updated_at = NOW()
 WHERE dav_mode = 'off'
   AND kind IN ('calendar', 'address_book');
