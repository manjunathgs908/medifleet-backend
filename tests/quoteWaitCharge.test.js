/**
 * tests/quoteWaitCharge.test.js
 * ============================================================
 * tripController.quoteWaitCharge — the waiting charge for a PLANNED wait
 * (the AI telecaller's round-trip quote). It must give exactly what
 * completeTrip would bill for that much waiting: the same Pricing fields
 * (return-drop two-tier for a round trip, drop wait for one way), the same
 * computeSegmentAmount, no new rates, no cap (none exists yet).
 *
 * Real tripController and models/index.js computeSegmentAmount; only the
 * Pricing lookup is stubbed with a document shaped like the collection's.
 * ============================================================
 */
'use strict';

// Side-effect modules tripController loads (as in the other trip tests).
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));
jest.mock('../utils/smsService', () => ({ sendOtp: jest.fn(), sendAlert: jest.fn(), sendSms: jest.fn() }));
jest.mock('../utils/cloudinary', () => ({ uploadToCloudinary: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({ notifyDriverAssigned: jest.fn() }));
jest.mock('../services/trackingNotifications', () => ({ notifyTrackingLink: jest.fn() }));
jest.mock('../utils/fareCalculator', () => ({
  ...jest.requireActual('../utils/fareCalculator'),
  findPricingDoc: jest.fn(),
}));

const fareCalculator = require('../utils/fareCalculator');
const { computeSegmentAmount } = require('../models');
const { quoteWaitCharge } = require('../controllers/tripController');

// Rates as they would sit in the Pricing collection (deliberately not the
// schema defaults, so a hardcoded value would show).
const PRICING = {
  serviceType: 'bls',
  returnDropFreeWaitMinutes : 15,
  returnDropWaitTier1PerMin : 4,
  returnDropWaitTier1Minutes: 90,
  returnDropWaitTier2PerMin : 9,
  dropFreeWaitMinutes: 12,
  dropWaitPerMin     : 7,
};

beforeEach(() => fareCalculator.findPricingDoc.mockReset().mockResolvedValue(PRICING));

describe('quoteWaitCharge', () => {
  test('round trip: free minutes, then tier 1, then tier 2 — from Pricing', async () => {
    const q = await quoteWaitCharge({ selectedType: 'bls', tripType: 'round_trip', waitMinutes: 180 });
    // 180 - 15 free = 165 billable: 90 x 4 + 75 x 9 = 360 + 675
    expect(q).toEqual({ waitMinutes: 180, freeMinutes: 15, billableMinutes: 165, amount: 1035, ratePerMin: 4, tier1Minutes: 90, tier2RatePerMin: 9 });
    expect(fareCalculator.findPricingDoc).toHaveBeenCalledWith('bls');
  });

  test('exactly what completeTrip bills for the same wait (same segment shape, same function)', async () => {
    for (const minutes of [0, 10, 15, 16, 60, 105, 106, 240]) {
      const q = await quoteWaitCharge({ selectedType: 'bls', tripType: 'round_trip', waitMinutes: minutes });
      const billed = computeSegmentAmount({
        ratePerMin: PRICING.returnDropWaitTier1PerMin,
        freeSeconds: PRICING.returnDropFreeWaitMinutes * 60,
        tier1CapMinutes: PRICING.returnDropWaitTier1Minutes,
        tier2RatePerMin: PRICING.returnDropWaitTier2PerMin,
      }, minutes * 60000);
      expect(q.amount).toBe(billed.amount);
    }
  });

  test('within the free minutes: nothing to pay', async () => {
    expect((await quoteWaitCharge({ selectedType: 'bls', tripType: 'round_trip', waitMinutes: 15 })).amount).toBe(0);
    expect((await quoteWaitCharge({ selectedType: 'bls', tripType: 'round_trip', waitMinutes: 0 })).amount).toBe(0);
  });

  test('one way: drop wait rate', async () => {
    const q = await quoteWaitCharge({ selectedType: 'bls', tripType: 'one_way', waitMinutes: 60 });
    expect(q).toMatchObject({ freeMinutes: 12, billableMinutes: 48, amount: 336, ratePerMin: 7, tier1Minutes: null, tier2RatePerMin: null });
  });

  test('a service with no Pricing: null, never a guessed price', async () => {
    fareCalculator.findPricingDoc.mockResolvedValueOnce(null);
    expect(await quoteWaitCharge({ selectedType: 'nope', tripType: 'round_trip', waitMinutes: 60 })).toBeNull();
  });

  test('a Pricing doc without wait fields charges 0, as completeTrip does', async () => {
    fareCalculator.findPricingDoc.mockResolvedValueOnce({ serviceType: 'bls' });
    expect((await quoteWaitCharge({ selectedType: 'bls', tripType: 'round_trip', waitMinutes: 300 })).amount).toBe(0);
  });
});
