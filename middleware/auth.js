/**
 * middleware/auth.js
 * ============================================================
 * Two middleware functions exported from this file:
 *
 *  1. protect(req, res, next)
 *     — Verifies the Bearer JWT on every protected route.
 *     — Attaches the decoded user object to req.user.
 *
 *  2. authorize(...roles)
 *     — Role-Based Access Control (RBAC) gate.
 *     — Must come AFTER protect() in the middleware chain.
 *     — Usage:  router.get('/report', protect, authorize('owner'), handler)
 *
 * Access Matrix:
 * ┌────────────────────────────┬───────┬────────────┬────────┐
 * │ Resource                   │ owner │ telecaller │ driver │
 * ├────────────────────────────┼───────┼────────────┼────────┤
 * │ All routes                 │  ✓    │            │        │
 * │ Book / view all trips      │  ✓    │     ✓      │        │
 * │ View fleet                 │  ✓    │     ✓      │        │
 * │ Own trip list              │  ✓    │            │   ✓    │
 * │ Own salary info            │  ✓    │            │   ✓    │
 * │ Financial reports          │  ✓    │            │        │
 * │ HR & salary management     │  ✓    │            │        │
 * │ Compliance & documents     │  ✓    │            │        │
 * └────────────────────────────┴───────┴────────────┴────────┘
 * ============================================================
 */

'use strict';

const jwt  = require('jsonwebtoken');
const { User } = require('../models');

/**
 * protect — JWT verification middleware
 * Extracts the token from Authorization: Bearer <token>
 * and attaches the live user document to req.user.
 */
const protect = async (req, res, next) => {
  let token;

  // 1. Extract token from Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // 2. Reject if no token
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorised. No token provided.',
    });
  }

  try {
    // 3. Verify token signature
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 4. Fetch user from DB (ensures user still exists and is active)
    const user = await User.findById(decoded.id).select('-password -otp -otpExpiry -refreshToken');

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found. Token may be stale.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Contact admin.' });
    }

    // 5. Attach user to request for downstream middleware
    req.user = user;
    next();

  } catch (err) {
    // Distinguish between expired and invalid tokens for better UX
    const message = err.name === 'TokenExpiredError'
      ? 'Session expired. Please log in again.'
      : 'Invalid token. Please log in again.';

    return res.status(401).json({ success: false, message });
  }
};


/**
 * authorize(...roles)
 * Returns a middleware that rejects the request if req.user.role
 * is not in the allowed roles list.
 *
 * Example:
 *   router.delete('/vehicles/:id', protect, authorize('owner'), deleteVehicle);
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message : `Access denied. This action requires one of: [${roles.join(', ')}]. Your role: ${req.user.role}.`,
      });
    }
    next();
  };
};


/**
 * driverSelfOnly
 * Special guard used on driver-specific endpoints.
 * Allows owner to access any driver's data (by :driverId param),
 * but constrains a driver to only see their own data.
 *
 * Usage: router.get('/salary/:driverId', protect, driverSelfOnly, getSalary);
 */
const driverSelfOnly = (req, res, next) => {
  const { role, _id } = req.user;

  if (role === 'owner') return next(); // Owner can see anyone

  if (role === 'driver') {
    const requestedId = req.params.driverId || req.params.id;
    if (_id.toString() !== requestedId) {
      return res.status(403).json({
        success: false,
        message: 'Drivers can only access their own records.',
      });
    }
    return next();
  }

  // Telecallers have no access to salary/driver records
  return res.status(403).json({ success: false, message: 'Access denied.' });
};


module.exports = { protect, authorize, driverSelfOnly };
