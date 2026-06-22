'use strict';
const mongoose = require('mongoose');

const FreezerDurationSchema = new mongoose.Schema({
  city              : { type: String, required: true, trim: true },
  boxId             : { type: String, required: true, enum: ['normal_box', 'standard_box', 'vip_digital_box'] },
  durationId        : { type: String, required: true },
  label             : { type: String, required: true },
  basePrice         : { type: Number, required: true },
  discountPercentage: { type: Number, default: 0 },
  embalmingCharge   : { type: Number, default: 0 },
  sortOrder         : { type: Number, default: 0 },
  active            : { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('FreezerDuration', FreezerDurationSchema, 'durations');
