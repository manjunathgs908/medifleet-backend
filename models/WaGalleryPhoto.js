'use strict';
/**
 * models/WaGalleryPhoto.js
 * ============================================================
 * The photo for one preset ambulance type in the WhatsApp Chats "Send
 * ambulance photo" gallery (services/waGallery.js holds the fixed list of
 * types and their labels). One document per type, set by the owner. The
 * photo is never published: to send it the server uploads it to WhatsApp's
 * own media store and sends that media id.
 * ============================================================
 */
const mongoose = require('mongoose');

const WaGalleryPhotoSchema = new mongoose.Schema({
  key          : { type: String, required: true, unique: true },
  photo        : {
    data       : { type: Buffer, select: false },
    contentType: { type: String, enum: ['image/jpeg', 'image/png'] },
    bytes      : Number,
    updatedAt  : Date,
  },
  updatedBy    : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedByName: String,
}, { timestamps: true });

module.exports = mongoose.model('WaGalleryPhoto', WaGalleryPhotoSchema);
