import { bearerTokenFromHeader, authenticatePushDevice } from '../services/pushDevices.js';

// Native background requests carry a revocable, user-scoped device token instead
// of a WebView session cookie. It authenticates ONLY the native notification
// mount (/api/push/native/*), so it cannot reach accounts, send, admin or any
// other part of the API. The token is verified by prefix + bcrypt; the resolved
// user id is the only identity the route handlers may trust.
export async function requireDeviceAuth(req, res, next) {
  try {
    const token = bearerTokenFromHeader(req.get('Authorization'));
    const device = token ? await authenticatePushDevice(token) : null;
    if (!device) return res.status(401).json({ error: 'Not authenticated' });
    req.pushDevice = device;
    next();
  } catch (err) {
    next(err);
  }
}
