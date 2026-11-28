'use strict';
/**
 * models/StaffProfile.js
 * ============================================================
 * How a telecaller (or the owner) introduces themselves to customers on
 * WhatsApp: a professional photo, the name to show, the languages they
 * speak — usable ONLY while they have consented to share photo and name
 * with customers. Set by the person themselves (routes/staffProfile.js);
 * the owner can see it but cannot consent on their behalf.
 *
 * Kept apart from User on purpose: User is loaded on every authenticated
 * request, and a photo does not belong there. The photo is stored here
 * (a small JPEG/PNG, resized in the browser) and is never published at a
 * public URL: to send it, the server uploads it to WhatsApp's own media
 * store and sends that media id (services/waIntro.js).
 * ============================================================
 */
const mongoose = require('mongoose');

const LANGUAGES = ['kn', 'hi', 'en', 'ta', 'te', 'ml', 'mr'];
const PHOTO_MAX_BYTES = 400 * 1024;

const StaffProfileSchema = new mongoose.Schema({
  user       : { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  displayName: { type: String, trim: true, maxlength: 40 },
  // How the caption introduces them: ಸಹಾಯಕಿ (as in the agreed text) or ಸಹಾಯಕ.
  title      : { type: String, enum: ['sahayaki', 'sahayaka'], default: 'sahayaki' },
  languages  : { type: [{ type: String, enum: LANGUAGES }], default: [] },
  photo      : {
    data       : { type: Buffer, select: false },
    contentType: { type: String, enum: ['image/jpeg', 'image/png'] },
    bytes      : Number,
    updatedAt  : Date,
  },
  consent    : {
    given : { type: Boolean, default: false },
    at    : Date, // when last given or withdrawn
    text  : String, // the exact words agreed to
  },
}, { timestamps: true });

StaffProfileSchema.statics.LANGUAGES = LANGUAGES;
StaffProfileSchema.statics.PHOTO_MAX_BYTES = PHOTO_MAX_BYTES;

module.exports = mongoose.model('StaffProfile', StaffProfileSchema);
