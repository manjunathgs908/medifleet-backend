'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const sosAlertSchema = new Schema(
  {
    driver: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    trip  : { type: Schema.Types.ObjectId, ref: 'Trip' }, // optional — a driver may hit SOS with no active trip

    lat: Number,
    lng: Number,

    resolved  : { type: Boolean, default: false },
    resolvedAt: Date,
    notes     : { type: String, trim: true },
  },
  { timestamps: true } // gives createdAt/updatedAt, same convention as Assignment.js
);

module.exports = mongoose.model('SosAlert', sosAlertSchema);
