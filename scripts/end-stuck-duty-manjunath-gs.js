// scripts/end-stuck-duty-manjunath-gs.js
// One-off, targeted fix for the stuck duty investigated on 2026-07-29.
// Mirrors assignmentController.endDuty's exact logic — same fields, same
// order — just keyed by these specific _ids instead of req.user/req.body,
// since there is no live driver session left to call the real endpoint.
// Confirmed no live trip attached before writing this script; confirmed
// endDuty does not touch User.availability.status, so this doesn't either.
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Assignment = require('../models/Assignment');
const Shift = require('../models/Shift');
const Ambulance = require('../models/Ambulance');

const SHIFT_ID = '6a621173165644d9458ad671';
const ASSIGNMENT_ID = '6a621173165644d9458ad66f';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const shift = await Shift.findOne({ _id: SHIFT_ID, status: { $in: ['active', 'break'] } });
  if (!shift) throw new Error('Shift not found or already ended — aborting.');

  const assignment = await Assignment.findOne({ _id: ASSIGNMENT_ID, active: true });
  if (!assignment) throw new Error('Assignment not found or already ended — aborting.');

  const now = new Date();

  const openBreak = shift.breaks.find(b => !b.endedAt);
  if (openBreak) openBreak.endedAt = now;

  const totalBreakMs = shift.breaks.reduce((sum, b) => {
    const end = b.endedAt || now;
    return sum + Math.max(0, end - b.startedAt);
  }, 0);

  const totalShiftMs = now - shift.shiftStart;
  const workingMs = Math.max(0, totalShiftMs - totalBreakMs);

  shift.status = 'ended';
  shift.shiftEnd = now;
  shift.totalWorkingMinutes = Math.round((workingMs / 60000) * 100) / 100;
  await shift.save();

  assignment.active = false;
  assignment.endTime = now;
  await assignment.save();

  const ambulance = await Ambulance.findById(assignment.ambulance);
  if (ambulance) {
    ambulance.status = 'available';
    ambulance.assignedDriver = null;
    await ambulance.save();
  }

  console.log('Closed shift:', shift._id.toString(), '-> status:', shift.status, 'totalWorkingMinutes:', shift.totalWorkingMinutes);
  console.log('Closed assignment:', assignment._id.toString(), '-> active:', assignment.active);
  console.log('Released ambulance:', ambulance?.registrationNumber, '-> status:', ambulance?.status, 'assignedDriver:', ambulance?.assignedDriver);

  await mongoose.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
