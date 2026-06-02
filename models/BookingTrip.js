'use strict';
const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  status      : { type: String },
  completedAt : { type: Date },
  completedBy : { type: String },
  location    : { latitude: Number, longitude: Number },
  notes       : { type: String, default: '' },
  cancelReason: { type: String },
}, { _id: false });

const BookingTripSchema = new mongoose.Schema({
  driver      : { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vehicle     : { type: String },
  tripDate    : { type: Date, default: Date.now },
  currentStage: {
    type: String,
    enum: ['START_TRIP','CANCEL_REQUESTED','CANCEL_APPROVED_BY_ADMIN','REACHED_HOSPITAL','PATIENT_PICKED_BOOKING','START_PICKUP_TRIP','CLIENT_DROPPED','RETURN_STARTED','END_TRIP_CLOSE_DUTY'],
    default: 'START_TRIP'
  },
  isCompleted : { type: Boolean, default: false },
  isCancelled : { type: Boolean, default: false },

  stages: {
    START_TRIP              : { type: stageSchema },
    CANCEL_REQUESTED        : { type: stageSchema },
    CANCEL_APPROVED_BY_ADMIN: { type: stageSchema },
    REACHED_HOSPITAL        : { type: stageSchema },
    PATIENT_PICKED_BOOKING  : { type: stageSchema },
    START_PICKUP_TRIP       : { type: stageSchema },
    CLIENT_DROPPED          : { type: stageSchema },
    RETURN_STARTED          : { type: stageSchema },
    END_TRIP_CLOSE_DUTY     : { type: stageSchema },
  },

  totalDutyHours  : { type: Number },
  totalKm         : { type: Number },
  tripDuration    : { type: Number },
  waitingTime     : { type: Number },
}, { timestamps: true });

module.exports = mongoose.model('BookingTrip', BookingTripSchema);