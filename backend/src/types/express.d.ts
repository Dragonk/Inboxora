// App-specific fields attached to the Express Request by auth middleware
// (DAV credentials, push device). Declared here so routes stay typed.
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
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
      [key: string]: unknown;
    };
  }
}
