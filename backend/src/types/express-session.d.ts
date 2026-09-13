// Augments express-session's SessionData with the fields this application
// stores on the session. Centralising them here keeps every route and
// middleware typed instead of relying on per-file casts.
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    username?: string;
    isAdmin?: boolean;
    locked?: boolean;
    pendingUserId?: string;
    pendingTOTPSecret?: string | null;
    pendingTOTPExpiry?: number | null;
    pendingTOTPSetupExpiry?: number | null;
    pendingMFAEnrollment?: any;
    oauthNonce?: string;
    oauthUserId?: string;
    oidcIdToken?: string;
    oidcProviderId?: string;
    oidcPending?: any;
  }
}
