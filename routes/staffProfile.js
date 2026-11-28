'use strict';
/**
 * routes/staffProfile.js — /api/staff-profile
 * ============================================================
 * Each telecaller's (and the owner's) WhatsApp introduction profile
 * (models/StaffProfile.js). Set ONLY by the person themselves — consent
 * cannot be given on someone's behalf; the owner can see everyone's.
 *
 *   GET    /me          my profile + what it still lacks + caption preview
 *   PUT    /me          { displayName, title, languages[], consent }
 *   PUT    /me/photo    { dataUrl: 'data:image/jpeg|png;base64,…' } ≤ 400 KB
 *   DELETE /me/photo
 *   GET    /:userId/photo   the photo (owner: anyone's; others: their own)
 *   GET    /            owner: every CRM staff member's profile status
 * The photo is served only to signed-in CRM staff (no public URL).
 * ============================================================
 */
const express = require('express');
const mongoose = require('mongoose');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');
const { User } = require('../models');
const StaffProfile = require('../models/StaffProfile');
const intro = require('../services/waIntro');

const router = express.Router();
router.use(protect, authorize(...OPERATIONS));

const CONSENT_TEXT = 'I agree to share my photo and name with customers';
const isObjectId = (v) => mongoose.isValidObjectId(String(v)) && /^[a-f0-9]{24}$/i.test(String(v));

function summary(p, user) {
  const displayName = p?.displayName || '';
  const profile = {
    displayName, title: p?.title || 'sahayaki', languages: p?.languages || [],
    hasPhoto: !!p?.photo?.bytes, photoUpdatedAt: p?.photo?.updatedAt || null,
    consent: { given: !!p?.consent?.given, at: p?.consent?.at || null, text: CONSENT_TEXT },
  };
  const gaps = intro.profileGaps(p);
  return {
    ...profile,
    user: { _id: user._id, name: user.name, role: user.role },
    ready: gaps.length === 0,
    gaps,
    // Exactly what a customer would receive (the image carries this caption).
    preview: {
      caption: intro.introCaption({ displayName: displayName || user.name, title: profile.title, languages: profile.languages.length ? profile.languages : ['kn'] }),
      handoverText: intro.handoverText(displayName || user.name),
    },
  };
}

router.get('/me', async (req, res, next) => {
  try {
    const p = await StaffProfile.findOne({ user: req.user._id }).lean();
    return res.json({ success: true, profile: summary(p, req.user), languages: intro.LANGUAGE_EN, consentText: CONSENT_TEXT });
  } catch (err) { next(err); }
});

router.put('/me', async (req, res, next) => {
  try {
    const b = req.body || {};
    const set = {};
    if (b.displayName !== undefined) {
      const n = String(b.displayName || '').trim().replace(/\s+/g, ' ');
      if (n.length > 40) return res.status(400).json({ success: false, message: 'Keep the display name to 40 characters.' });
      if (/[0-9]{4,}|@|https?:/i.test(n)) return res.status(400).json({ success: false, message: 'Use just your name — no numbers, emails or links.' });
      set.displayName = n;
    }
    if (b.title !== undefined) {
      if (!['sahayaki', 'sahayaka'].includes(b.title)) return res.status(400).json({ success: false, message: 'Pick ಸಹಾಯಕಿ or ಸಹಾಯಕ.' });
      set.title = b.title;
    }
    if (b.languages !== undefined) {
      const langs = [...new Set((Array.isArray(b.languages) ? b.languages : []).map(String))];
      if (langs.some((l) => !StaffProfile.LANGUAGES.includes(l))) return res.status(400).json({ success: false, message: 'Unknown language.' });
      set.languages = StaffProfile.LANGUAGES.filter((l) => langs.includes(l)); // a fixed, readable order
    }
    if (b.consent !== undefined) {
      set['consent.given'] = b.consent === true;
      set['consent.at'] = new Date();
      set['consent.text'] = CONSENT_TEXT;
    }
    const p = await StaffProfile.findOneAndUpdate({ user: req.user._id }, { $set: set, $setOnInsert: { user: req.user._id } }, { new: true, upsert: true, runValidators: true }).lean();
    return res.json({ success: true, profile: summary(p, req.user) });
  } catch (err) { next(err); }
});

router.put('/me/photo', async (req, res, next) => {
  try {
    const m = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
    if (!m) return res.status(400).json({ success: false, message: 'Send a JPEG or PNG photo.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > StaffProfile.PHOTO_MAX_BYTES) return res.status(413).json({ success: false, message: 'That photo is too large — choose a smaller one (under 400 KB).' });
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if ((m[1] === 'image/jpeg' && !isJpeg) || (m[1] === 'image/png' && !isPng)) return res.status(400).json({ success: false, message: 'That file is not a valid photo.' });
    const p = await StaffProfile.findOneAndUpdate(
      { user: req.user._id },
      { $set: { photo: { data: buf, contentType: m[1], bytes: buf.length, updatedAt: new Date() } }, $setOnInsert: { user: req.user._id } },
      { new: true, upsert: true },
    ).lean();
    return res.json({ success: true, profile: summary(p, req.user) });
  } catch (err) { next(err); }
});

router.delete('/me/photo', async (req, res, next) => {
  try {
    const p = await StaffProfile.findOneAndUpdate({ user: req.user._id }, { $unset: { photo: 1 } }, { new: true }).lean();
    return res.json({ success: true, profile: summary(p, req.user) });
  } catch (err) { next(err); }
});

router.get('/:userId/photo', async (req, res, next) => {
  try {
    const id = req.params.userId === 'me' ? String(req.user._id) : req.params.userId;
    if (!isObjectId(id)) return res.status(404).end();
    if (req.user.role !== 'owner' && id !== String(req.user._id)) return res.status(403).json({ success: false, message: 'You can see your own photo only.' });
    const p = await StaffProfile.findOne({ user: id }).select('+photo.data photo.contentType').lean();
    if (!p?.photo?.data) return res.status(404).end();
    res.set({ 'Content-Type': p.photo.contentType, 'Cache-Control': 'private, no-store' });
    return res.send(Buffer.from(p.photo.data.buffer || p.photo.data));
  } catch (err) { next(err); }
});

router.get('/', authorize('owner'), async (req, res, next) => {
  try {
    const users = await User.find({ role: { $in: OPERATIONS } }).select('name role isActive').sort({ name: 1 }).lean();
    const profiles = await StaffProfile.find({ user: { $in: users.map((u) => u._id) } }).lean();
    const by = new Map(profiles.map((p) => [String(p.user), p]));
    return res.json({ success: true, profiles: users.map((u) => ({ ...summary(by.get(String(u._id)), u), isActive: u.isActive !== false })) });
  } catch (err) { next(err); }
});

module.exports = router;
