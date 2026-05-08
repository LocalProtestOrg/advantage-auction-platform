// Request logger — logs API calls with method, path, status, duration.
// Skips static asset requests (.js, .css, .html, images) to keep logs clean.
const STATIC_EXT = /\.(js|css|html|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map)$/i;

const logger = (req, res, next) => {
  if (!req.path.startsWith('/api') && STATIC_EXT.test(req.path)) return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms  = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN ' : 'INFO ';
    console.log(`[${new Date().toISOString()}] ${lvl} [http] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
};

module.exports = logger;
