// App-specific fields attached to the Express Request by auth middleware
// (DAV credentials, push device). Declared here so routes stay typed.
import 'express-serve-static-core';

declare global {
  namespace Express {
    interface Request {
    caldavCredentialId?: string;
    caldavUserId?: string;
    cardavCredentialId?: string;
    cardavUserId?: string;
    davCredentialId?: string;
    davUserId?: string;
    pushDevice?: {
      id: string;
      userId: string;
      deviceId: string;
      transport: string;
      [key: string]: unknown;
    };
    }
  }
}

export {};