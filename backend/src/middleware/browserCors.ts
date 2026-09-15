import cors from 'cors';
import type { CorsOptions } from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

function isDavPath(path: string) {
  return path === '/carddav' || path.startsWith('/carddav/')
    || path === '/caldav' || path.startsWith('/caldav/');
}

export function createBrowserCors(options: CorsOptions): RequestHandler {
  const browserCors = cors(options);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isDavPath(req.path)) return next();
    return browserCors(req, res, next);
  };
}
