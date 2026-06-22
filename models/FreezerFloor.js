'use strict';
const mongoose = require('mongoose');

const FreezerFloorSchema = new mongoose.Schema({
  city        : { type: String, required: true, trim: true },
  boxId       : { type: String, required: true, enum: ['normal_box', 'standard_box', 'vip_digital_box'] },
  floorId     : { type: String, required: true },
  label       : { type: String, required: true },
  charge      : { type: Number, default: 0 },
  isFree      : { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
  active      : { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('FreezerFloor', FreezerFloorSchema, 'floors');
