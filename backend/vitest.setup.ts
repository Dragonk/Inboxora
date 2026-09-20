// Unit tests exercise the projection logic directly, so they run it inline on
// the test thread instead of spawning worker threads. The worker pool itself is
// covered explicitly in calendarProjectionPool.test.js, which clears this flag.
process.env.CALENDAR_PROJECTION_DISABLED = '1';

// Provider callbacks are derived from APP_URL, and a browser flow with no public origin is reported as
// unconfigured. A configured installation is the default for the suite; a test that needs an unusable
// APP_URL sets its own.
process.env.APP_URL ||= 'https://inboxora.example';
