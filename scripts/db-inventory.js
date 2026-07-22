/**
 * scripts/db-inventory.js
 * READ-ONLY. Full inventory of everything relevant to a fresh-start
 * cleanup: Owners, driver Users, Ambulances, Fleets, Assignments,
 * Shifts, Trips, BookingTrips. No writes.
 * Usage: node scripts/db-inventory.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { User, Trip } = require('../models');
const Owner = require('../models/Owner');
const Fleet = require('../models/Fleet');
const Ambulance = require('../models/Ambulance');
const Assignment = require('../models/Assignment');
const Shift = require('../models/Shift');
const BookingTrip = require('../models/BookingTrip');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const owners = await Owner.find({}).select('name phone createdAt').lean();
  console.log('\n=== OWNERS ===');
  console.log(JSON.stringify(owners, null, 2));

  const drivers = await User.find({ role: 'driver' }).select('name phone employeeId owner approvalStatus deviceId isOwnerSelf createdAt').lean();
  console.log('\n=== DRIVER USERS ===');
  console.log(JSON.stringify(drivers, null, 2));

  const ambulances = await Ambulance.find({}).select('registrationNumber owner fleet status isActive serviceType createdAt').lean();
  console.log('\n=== AMBULANCES ===');
  console.log(JSON.stringify(ambulances, null, 2));

  const fleets = await Fleet.find({}).select('name owner isActive createdAt').lean();
  console.log('\n=== FLEETS ===');
  console.log(JSON.stringify(fleets, null, 2));

  const assignments = await Assignment.find({}).select('driver ambulance active createdAt').lean();
  console.log('\n=== ASSIGNMENTS ===');
  console.log(JSON.stringify(assignments, null, 2));

  const shifts = await Shift.find({}).select('driver ambulance status createdAt').lean();
  console.log('\n=== SHIFTS ===');
  console.log(JSON.stringify(shifts, null, 2));

  const trips = await Trip.find({}).select('status patientName patientPhone pickupAddress createdAt bookedBy').lean();
  console.log('\n=== TRIPS (Trip model) ===');
  console.log(JSON.stringify(trips, null, 2));

  const bookingTrips = await BookingTrip.find({}).select('status createdAt').lean();
  console.log('\n=== BOOKING TRIPS (BookingTrip model) ===');
  console.log(JSON.stringify(bookingTrips, null, 2));

  console.log('\n=== COUNTS ===');
  console.log({
    owners: owners.length,
    drivers: drivers.length,
    ambulances: ambulances.length,
    fleets: fleets.length,
    assignments: assignments.length,
    shifts: shifts.length,
    trips: trips.length,
    bookingTrips: bookingTrips.length,
  });

  await mongoose.disconnect();
})();
