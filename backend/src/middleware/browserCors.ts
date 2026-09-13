import cors from 'cors';

function isDavPath(path) {
  return path === '/carddav' || path.startsWith('/carddav/')
    || path === '/caldav' || path.startsWith('/caldav/');
}

export function createBrowserCors(options) {
  const browserCors = cors(options);

  return (req, res, next) => {
    if (isDavPath(req.path)) return next();
    return browserCors(req, res, next);
  };
}
