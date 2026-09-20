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
 * Access Matrix (telecaller role removed for now — every route below is
 * owner-only until it comes back; nothing here is currently gated to a
 * telecaller-only allowance):
 * ┌────────────────────────────┬───────┬────────┐
 * │ Resource                   │ owner │ driver │
 * ├────────────────────────────┼───────┼────────┤
 * │ All routes                 │  ✓    │        │
 * │ Book / view all trips      │  ✓    │        │
 * │ View fleet                 │  ✓    │        │
 * │ Own trip list              │  ✓    │   ✓    │
 * │ Own salary info             │  ✓    │   ✓    │
 * │ Financial reports          │  ✓    │        │
 * │ HR & salary management     │  ✓    │        │
 * │ Compliance & documents     │  ✓    │        │
 * └────────────────────────────┴───────┴────────┘
 * ============================================================
 */

'use strict';

const jwt  = require('jsonwebtoken');
const { User } = require('../models');
const Owner = require('../models/Owner');

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

    // 5. One-active-device enforcement — a newer login has since rebound
    //    user.deviceId, making this token's claim stale. Harmless no-op
    //    for tokens/accounts with no deviceId at all (both sides undefined).
    if (decoded.deviceId !== user.deviceId) {
      return res.status(401).json({
        success: false,
        code   : 'DEVICE_MISMATCH',
        message: 'Logged in on another device. Please log in again.',
      });
    }

    // 6. Attach user to request for downstream middleware
    req.user = user;
    // WHICH KIND OF ACTOR THIS IS.
    //
    // `authorize('owner')` passes for two completely different subjects: a
    // CRM admin (a User with role 'owner') and a fleet Owner (an Owner doc
    // whose role is synthesized in protectOwner). The only thing that ever
    // distinguished them was which middleware happened to run, which is
    // invisible from inside a controller. Anything that must treat them
    // differently reads this instead of guessing.
    req.actorType = 'user';
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
 * protectOwner — JWT verification middleware for the new fleet-Owner
 * actor (Phase 1 of the driver-auth redesign, see models/Owner.js).
 * Parallel to protect() but looks the subject up in the Owner
 * collection instead of User. Owner documents have no `role` field of
 * their own, so it's synthesized here as 'owner' — this lets the
 * existing authorize('owner') gate below be reused unchanged for the
 * new owner-facing routes (routes/owners.js, fleets.js, ambulances.js).
 */
const protectOwner = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorised. No token provided.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const owner = await Owner.findById(decoded.id);
    if (!owner) {
      return res.status(401).json({ success: false, message: 'Owner not found. Token may be stale.' });
    }
    if (!owner.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Contact admin.' });
    }

    owner.role = 'owner'; // synthesized for authorize() — not a schema field, not persisted
    req.user = owner;
    req.actorType = 'owner';   // see the note in protect()
    next();

  } catch (err) {
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

  // Any role besides owner/driver (none exist right now — telecaller
  // removed) has no access to salary/driver records.
  return res.status(403).json({ success: false, message: 'Access denied.' });
};


/**
 * requireKycApproved
 * Gates the actual privileged fleet-management actions (create ambulance,
 * register/approve/reject driver, fleet-status, etc.) on the Owner's KYC
 * being approved — mirrors the driver flow's split exactly: login,
 * status-check (getMe), and document upload/re-upload all stay ungated
 * (protectOwner alone) so a pending/rejected owner can still see their own
 * status and resubmit; this middleware only sits in front of the routes
 * that actually use the platform.
 *
 * Usage: router.use(protectOwner, authorize('owner'), requireKycApproved);
 */
const requireKycApproved = (req, res, next) => {
  if (req.user.kycStatus !== 'approved') {
    return res.status(403).json({
      success: false,
      message: 'Your account is pending approval. Please complete KYC and wait for approval.',
      kycStatus: req.user.kycStatus,
    });
  }
  next();
};


/**
 * protectUserOrOwner — accepts EITHER actor on a single route.
 *
 * Deliberately not a change to protect(). Widening protect() itself would
 * make every route already using it reachable by a fleet Owner, which is
 * the opposite of what this exists for. This is opt-in, currently used
 * only by the two trip-read routes an owner legitimately needs.
 *
 * Tries User first, then Owner, mirroring the priority unifiedAuth uses.
 * Sets req.actorType so the controller can scope the answer: a CRM admin
 * sees every trip, a fleet Owner sees only trips on their own ambulances.
 * A controller behind this middleware MUST branch on req.actorType — it
 * is the whole reason the middleware exists.
 */
const protectUserOrOwner = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorised. No token provided.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Session expired. Please log in again.'
      : 'Invalid token. Please log in again.';
    return res.status(401).json({ success: false, message });
  }

  try {
    const user = await User.findById(decoded.id).select('-password -otp -otpExpiry -refreshToken');
    if (user) {
      if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'Account is deactivated. Contact admin.' });
      }
      // Same one-active-device rule protect() enforces — a driver reaching
      // a shared route must not sidestep it by coming through here.
      if (decoded.deviceId !== user.deviceId) {
        return res.status(401).json({
          success: false,
          code   : 'DEVICE_MISMATCH',
          message: 'Logged in on another device. Please log in again.',
        });
      }
      req.user = user;
      req.actorType = 'user';
      return next();
    }

    const owner = await Owner.findById(decoded.id);
    if (owner) {
      if (!owner.isActive) {
        return res.status(403).json({ success: false, message: 'Account is deactivated. Contact admin.' });
      }
      owner.role = 'owner';
      req.user = owner;
      req.actorType = 'owner';
      return next();
    }

    return res.status(401).json({ success: false, message: 'Account not found. Token may be stale.' });
  } catch (err) {
    return next(err);
  }
};


module.exports = {
  protect, protectOwner, protectUserOrOwner, authorize, driverSelfOnly, requireKycApproved,
};
