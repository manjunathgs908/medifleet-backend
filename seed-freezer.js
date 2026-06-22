'use strict';
// One-off seed for the freezer box durations/floors collections.
// Idempotent — safe to re-run, upserts on the natural (city, boxId, durationId/floorId) key.
// Run with: node seed-freezer.js
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const FreezerDuration = require('./models/FreezerDuration');
const FreezerFloor    = require('./models/FreezerFloor');

const CITY = 'Bengaluru';

// Placeholder reference pricing — based on the legacy hardcoded ₹2,000 total
// (₹2,500 base − 20% discount) and ₹2,500 embalming figures previously
// baked into the app. Review/adjust these in MongoDB once real rates are set.
const DURATIONS = [
  { boxId: 'normal_box',      durationId: '24h', label: '24 Hours', basePrice: 1500, discountPercentage: 0,  embalmingCharge: 0,    sortOrder: 1 },
  { boxId: 'normal_box',      durationId: '48h', label: '48 Hours', basePrice: 2500, discountPercentage: 20, embalmingCharge: 2500, sortOrder: 2 },
  { boxId: 'normal_box',      durationId: '72h', label: '72 Hours', basePrice: 3500, discountPercentage: 15, embalmingCharge: 2500, sortOrder: 3 },

  { boxId: 'standard_box',    durationId: '24h', label: '24 Hours', basePrice: 2000, discountPercentage: 0,  embalmingCharge: 0,    sortOrder: 1 },
  { boxId: 'standard_box',    durationId: '48h', label: '48 Hours', basePrice: 3200, discountPercentage: 20, embalmingCharge: 2500, sortOrder: 2 },
  { boxId: 'standard_box',    durationId: '72h', label: '72 Hours', basePrice: 4500, discountPercentage: 15, embalmingCharge: 2500, sortOrder: 3 },

  { boxId: 'vip_digital_box', durationId: '24h', label: '24 Hours', basePrice: 3000, discountPercentage: 0,  embalmingCharge: 0,    sortOrder: 1 },
  { boxId: 'vip_digital_box', durationId: '48h', label: '48 Hours', basePrice: 4800, discountPercentage: 20, embalmingCharge: 2500, sortOrder: 2 },
  { boxId: 'vip_digital_box', durationId: '72h', label: '72 Hours', basePrice: 6500, discountPercentage: 15, embalmingCharge: 2500, sortOrder: 3 },
];

// vip_digital_box deliberately gets ONLY the ground floor doc — the app
// renders a single Ground Floor card whenever that's all the API returns.
const FLOORS = [
  { boxId: 'normal_box',      floorId: 'ground',     label: 'Ground Floor',       helperCharge: 0,   sortOrder: 1 },
  { boxId: 'normal_box',      floorId: 'first',      label: '1st Floor',          helperCharge: 300, sortOrder: 2 },
  { boxId: 'normal_box',      floorId: 'second',     label: '2nd Floor',          helperCharge: 500, sortOrder: 3 },
  { boxId: 'normal_box',      floorId: 'third_plus', label: '3rd Floor & Above',  helperCharge: 800, sortOrder: 4 },

  { boxId: 'standard_box',    floorId: 'ground',     label: 'Ground Floor',       helperCharge: 0,   sortOrder: 1 },
  { boxId: 'standard_box',    floorId: 'first',      label: '1st Floor',          helperCharge: 300, sortOrder: 2 },
  { boxId: 'standard_box',    floorId: 'second',     label: '2nd Floor',          helperCharge: 500, sortOrder: 3 },
  { boxId: 'standard_box',    floorId: 'third_plus', label: '3rd Floor & Above',  helperCharge: 800, sortOrder: 4 },

  { boxId: 'vip_digital_box', floorId: 'ground',     label: 'Ground Floor',       helperCharge: 0,   sortOrder: 1 },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Seeding freezer durations/floors for', CITY);

  for (const d of DURATIONS) {
    await FreezerDuration.updateOne(
      { city: CITY, boxId: d.boxId, durationId: d.durationId },
      { $set: { city: CITY, active: true, ...d } },
      { upsert: true }
    );
  }
  console.log(`Upserted ${DURATIONS.length} duration docs.`);

  for (const f of FLOORS) {
    await FreezerFloor.updateOne(
      { city: CITY, boxId: f.boxId, floorId: f.floorId },
      { $set: { city: CITY, active: true, ...f } },
      { upsert: true }
    );
  }
  console.log(`Upserted ${FLOORS.length} floor docs.`);

  await mongoose.disconnect();
  console.log('Done.');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
