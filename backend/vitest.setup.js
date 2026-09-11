// Unit tests exercise the projection logic directly, so they run it inline on
// the test thread instead of spawning worker threads. The worker pool itself is
// covered explicitly in calendarProjectionPool.test.js, which clears this flag.
process.env.CALENDAR_PROJECTION_DISABLED = '1';
