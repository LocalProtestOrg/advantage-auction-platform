// Centralized error handler
const errorHandler = (err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.publicMessage || 'Internal server error',
    details: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
};

module.exports = errorHandler;
