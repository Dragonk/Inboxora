-- Native push without ntfy: the app's own always-on WebSocket ("live") replaces
-- UnifiedPush, so no distributor endpoint exists on the server side. Rows still
-- registered as unifiedpush move to the live transport; the app re-registers on
-- its next start anyway (registration rotates the device token) and a stale
-- distributor URL must never keep receiving events. FCM and Web Push unchanged.

ALTER TABLE push_devices DROP CONSTRAINT IF EXISTS push_devices_transport_check;

UPDATE push_devices SET transport = 'live', endpoint = '' WHERE transport = 'unifiedpush';

ALTER TABLE push_devices
  ADD CONSTRAINT push_devices_transport_check CHECK (transport IN ('live', 'fcm', 'webpush'));
