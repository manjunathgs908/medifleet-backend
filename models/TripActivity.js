'use strict';
const mongoose = require('mongoose');
const TripActivitySchema = new mongoose.Schema({
  tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: false },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ambulanceId: { type: String, required: true },
  tripStatus: {
    type: String,
    enum: ['START_12HR_SHIFT','END_12HR_SHIFT','TRIP_STARTED','CLIENT_DROPPED','RETURN_STARTED','CLOSE_DUTY','DIESEL_FILL','FOOD_EXPENSE','VEHICLE_REPAIR','POLICE_FINE'],
    required: true
  },
  location: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
  },
  imageUrl: { type: String },
  ambulanceDetails: {
    dieselAmount: { type: Number, default: 0 },
    dieselLiters: { type: Number, default: 0 },
    foodAmount: { type: Number, default: 0 },
    repairAmount: { type: Number, default: 0 },
    repairDetails: { type: String, default: '' },
    policeFineAmount: { type: Number, default: 0 },
    policeFineReason: { type: String, default: '' }
  },
  createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('TripActivity', TripActivitySchema);