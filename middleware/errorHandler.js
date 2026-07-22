/**
 * middleware/errorHandler.js
 * ─────────────────────────────────────────────────────────────
 * Centralised Express error handler.
 * Must be registered LAST in the middleware stack in server.js.
 *
 * Catches:
 *   - Mongoose CastError (invalid ObjectId)
 *   - Mongoose ValidationError
 *   - Mongoose duplicate key (code 11000)
 *   - JWT errors (handled upstream in auth.js, but caught here too)
 *   - Generic unhandled errors
 */

'use strict';

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message    = err.message    || 'Internal Server Error';

  // ── Body too large (base64 photo/document uploads) ────────
  if (err.type === 'entity.too.large') {
    statusCode = 413;
    message    = 'File is too large. Please use a smaller photo or document.';
  }

  // ── Mongoose: Invalid ObjectId ────────────────────────────
  if (err.name === 'CastError') {
    statusCode = 400;
    message    = `Invalid ID format: ${err.value}`;
  }

  // ── Mongoose: Validation errors ───────────────────────────
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message    = Object.values(err.errors).map(e => e.message).join('. ');
  }

  // ── Mongoose: Duplicate key ───────────────────────────────
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message    = `Duplicate value for field: ${field}. Please use a different value.`;
  }

  // ── JWT errors ─────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message    = 'Invalid authentication token.';
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message    = 'Authentication token has expired. Please log in again.';
  }

  // ── Log stack in development ──────────────────────────────
  if (process.env.NODE_ENV === 'development') {
    console.error(`[ERROR] ${err.stack}`);
  } else {
    console.error(`[ERROR] ${statusCode} — ${message}`);
  }

  return res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// Helper to create consistent API errors throughout controllers
class ApiError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}

module.exports = errorHandler;
module.exports.ApiError = ApiError;
