// App-specific fields attached to the Express Request by auth middleware
// (DAV credentials, push device). Declared here so routes stay typed.
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    caldavCredentialId?: any;
    caldavUserId?: string;
    cardavCredentialId?: any;
    cardavUserId?: string;
    davCredentialId?: any;
    davUserId?: string;
    pushDevice?: any;
  }
}
