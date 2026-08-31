import { authLimiterConfig } from './authLimiter.js';
import { logAuthEvent } from './authEvents.js';
import { authenticateDavCredential } from './davCredentials.js';
import { consume as rlConsume } from './rateLimiter.js';

export function createDavAuthMiddleware({ realm, eventType }) {
  return async function davAuth(req, res, next) {
    const authorization = req.headers.authorization || '';
    const reject = async (username = null) => {
      const { limited } = await rlConsume(`auth:${req.ip}`, authLimiterConfig.maxRequests, authLimiterConfig.windowMs);
      logAuthEvent(eventType, { username, ip: req.ip, success: false });
      res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
      return res.status(limited ? 429 : 401).end();
    };

    if (!authorization.startsWith('Basic ')) return reject();
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return reject();

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    try {
      const credential = await authenticateDavCredential(username, password);
      if (!credential) return reject(username || null);
      req.davUserId = credential.userId;
      req.davCredentialId = credential.credentialId;
      next();
    } catch (error) {
      console.error('DAV authentication error:', error);
      res.status(500).end();
    }
  };
}
