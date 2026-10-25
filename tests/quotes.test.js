/**
 * tests/quotes.test.js
 * ============================================================
 * "Quote & Confirm" booking links (controllers/quoteController.js).
 *
 * Pins the things that matter on a public, ambulance-booking endpoint:
 *   - the public page only ever reaches the one quote its token names, and
 *     never sees the full phone, the creator or anything else internal
 *   - pricing and booking go through tripController's shared quoteTrip /
 *     createBookedTrip, never a second formula
 *   - confirm is claimed atomically, so a double tap books one trip, and a
 *     failed booking releases the claim so the customer can retry
 *   - the booked trip's phone is the number the link was SENT to, whatever
 *     the page posts
 *
 * Models and services are mocked — no database, no network.
 * ============================================================
 */
'use strict';

jest.mock('../models/Quote', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findById: jest.fn(),
  findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../models', () => ({ Trip: { findById: jest.fn() } }));
jest.mock('../controllers/tripController', () => ({
  quoteTrip: jest.fn(), createBookedTrip: jest.fn(),
}));
jest.mock('../utils/fareCalculator', () => ({ findPricingDoc: jest.fn() }));
jest.mock('../services/whatsappNotifications', () => ({ notifyQuoteLink: jest.fn() }));
jest.mock('../services/trackingNotifications', () => ({
  resolveTrackingUrl: jest.fn(async () => 'https://www.savelife.health/track/TRACKTOKEN'),
}));

const Quote = require('../models/Quote');
const { Trip } = require('../models');
const { quoteTrip, createBookedTrip } = require('../controllers/tripController');
const fareCalculator = require('../utils/fareCalculator');
const whatsappNotifications = require('../services/whatsappNotifications');
const ctrl = require('../controllers/quoteController');

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars, base64url
const future = () => new Date(Date.now() + 60 * 60 * 1000);
const past   = () => new Date(Date.now() - 60 * 1000);

const PICKUP = { address: 'MG Road, Bengaluru', lat: 12.975, lng: 77.606 };
const DROP   = { address: 'Manipal Hospital, Old Airport Rd', lat: 12.958, lng: 77.649 };

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json   = jest.fn(() => res);
  return res;
}

function quoteDoc(over = {}) {
  return {
    _id: 'q1', token: TOKEN, phone: '9986844442', status: 'sent',
    sentAt: new Date(), expiresAt: future(), createdBy: 'staff1',
    save: jest.fn(async function () { return this; }),
    ...over,
  };
}

const run = async (handler, req) => {
  const res = mockRes();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
};

beforeEach(() => jest.resetAllMocks());

// ─────────────────────────────────────────────────────────────
describe('createQuote (CRM)', () => {
  it('requires a valid 10-digit mobile', async () => {
    const res = await run(ctrl.createQuote, { body: { phone: '12345' }, user: { _id: 'staff1' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Quote.create).not.toHaveBeenCalled();
  });

  it('normalises the phone, stores only usable places, and sends the link', async () => {
    const doc = quoteDoc();
    Quote.create.mockResolvedValue(doc);
    whatsappNotifications.notifyQuoteLink.mockResolvedValue({ messages: [{ id: 'wamid.1' }] });

    const res = await run(ctrl.createQuote, {
      body: { phone: '+91 99868 44442', pickup: PICKUP, drop: { address: 'typed only, no coords' } },
      user: { _id: 'staff1' },
    });

    const created = Quote.create.mock.calls[0][0];
    expect(created.phone).toBe('9986844442');
    expect(created.pickup).toEqual(PICKUP);
    expect(created.drop).toBeUndefined();
    expect(whatsappNotifications.notifyQuoteLink)
      .toHaveBeenCalledWith('9986844442', `https://crm.savelife.health/q/${TOKEN}`);
    expect(doc.whatsappSent).toBe(true);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].quote.url).toBe(`https://crm.savelife.health/q/${TOKEN}`);
  });

  it('keeps the quote when WhatsApp fails, recording why', async () => {
    const doc = quoteDoc();
    Quote.create.mockResolvedValue(doc);
    whatsappNotifications.notifyQuoteLink.mockResolvedValue({ skipped: true, reason: 'template not approved' });

    const res = await run(ctrl.createQuote, { body: { phone: '9986844442' }, user: { _id: 'staff1' } });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(doc.whatsappSent).toBe(false);
    expect(doc.whatsappError).toBe('template not approved');
  });

  it('refuses a service with no active pricing', async () => {
    fareCalculator.findPricingDoc.mockResolvedValue(null);
    const res = await run(ctrl.createQuote, { body: { phone: '9986844442', selectedType: 'bls' }, user: {} });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Quote.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('getPublicQuote', () => {
  it('404s a malformed token without touching the database', async () => {
    const res = await run(ctrl.getPublicQuote, { params: { token: '{"$ne":null}' } });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(Quote.findOne).not.toHaveBeenCalled();
  });

  it('marks a sent quote viewed on first open, conditionally', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc());
    Quote.findOneAndUpdate.mockResolvedValue(quoteDoc({ status: 'viewed', viewedAt: new Date() }));

    await run(ctrl.getPublicQuote, { params: { token: TOKEN } });

    const [filter, update] = Quote.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'q1', status: 'sent' });
    expect(update.$set.status).toBe('viewed');
  });

  it('exposes only customer-facing fields, with the phone masked', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed', pickup: PICKUP }));

    const res = await run(ctrl.getPublicQuote, { params: { token: TOKEN } });
    const body = res.json.mock.calls[0][0].quote;

    expect(body.phoneMasked).toBe('••••••4442');
    expect(JSON.stringify(body)).not.toContain('9986844442');
    expect(body).not.toHaveProperty('createdBy');
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('_id');
    expect(body.pickup).toEqual(PICKUP);
  });
});

// ─────────────────────────────────────────────────────────────
describe('estimatePublicQuote', () => {
  it('prices through the shared quoteTrip, one way', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    quoteTrip.mockResolvedValue({ distanceKm: 6.2, oneWayKm: 6.2, durationSec: 1200, fare: { grandTotal: 1450, baseFare: 1450 } });

    const res = await run(ctrl.estimatePublicQuote, {
      params: { token: TOKEN },
      body: { pickup: PICKUP, drop: DROP, selectedType: 'bls', acEnabled: true },
    });

    expect(quoteTrip).toHaveBeenCalledWith(expect.objectContaining({
      pickupLat: PICKUP.lat, dropLng: DROP.lng, selectedType: 'bls', tripType: 'one_way', acEnabled: true,
    }));
    expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({
      success: true, distanceKm: 6.2, durationSec: 1200, fare: { grandTotal: 1450 },
    }));
  });

  it('never passes a regex-looking service id to pricing', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    quoteTrip.mockResolvedValue({ distanceKm: 5, durationSec: 600, fare: null });

    await run(ctrl.estimatePublicQuote, {
      params: { token: TOKEN },
      body: { pickup: PICKUP, drop: DROP, selectedType: '.*' },
    });

    expect(quoteTrip.mock.calls[0][0].selectedType).toBeUndefined();
  });

  it('refuses an expired link', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ expiresAt: past() }));
    const res = await run(ctrl.estimatePublicQuote, { params: { token: TOKEN }, body: { pickup: PICKUP, drop: DROP } });
    expect(res.status).toHaveBeenCalledWith(410);
    expect(quoteTrip).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('confirmPublicQuote', () => {
  const body = { patientName: 'Ravi', pickup: PICKUP, drop: DROP, selectedType: 'bls', acEnabled: false, patientPhone: '9000000000' };

  beforeEach(() => {
    quoteTrip.mockResolvedValue({ distanceKm: 6.2, oneWayKm: 6.2, durationSec: 1200, fare: { grandTotal: 1450 } });
    createBookedTrip.mockResolvedValue({ _id: 't1', tripNumber: 'TRP-1' });
  });

  it('claims the quote, books through createBookedTrip with the SENT phone, and confirms', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    Quote.findOneAndUpdate
      .mockResolvedValueOnce(quoteDoc({ status: 'confirming' }))
      .mockResolvedValueOnce(quoteDoc({ status: 'confirmed', trip: 't1' }));

    const res = await run(ctrl.confirmPublicQuote, { params: { token: TOKEN }, body });

    const [claimFilter, claimUpdate] = Quote.findOneAndUpdate.mock.calls[0];
    expect(claimFilter.status).toEqual({ $in: ['sent', 'viewed'] });
    expect(claimUpdate.$set.status).toBe('confirming');

    const [tripBody, opts] = createBookedTrip.mock.calls[0];
    expect(tripBody.patientPhone).toBe('9986844442');
    expect(tripBody.patientName).toBe('Ravi');
    expect(tripBody.effectiveDist).toBe(6.2);
    expect(opts).toEqual({ bookedBy: 'staff1', bookingSource: 'crm' });

    expect(Quote.findOneAndUpdate.mock.calls[1][1].$set).toEqual(expect.objectContaining({ status: 'confirmed', trip: 't1' }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].quote).toEqual(expect.objectContaining({ status: 'confirmed', tripNumber: 'TRP-1' }));
  });

  it('books nothing when another confirm already holds the claim', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    Quote.findOneAndUpdate.mockResolvedValueOnce(null);
    Quote.findById.mockResolvedValue(quoteDoc({ status: 'confirming' }));

    const res = await run(ctrl.confirmPublicQuote, { params: { token: TOKEN }, body });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(createBookedTrip).not.toHaveBeenCalled();
  });

  it('answers a repeat confirm with the existing booking, not a second trip', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'confirmed', trip: 't1' }));
    Trip.findById.mockReturnValue({ select: () => ({ lean: async () => ({ tripNumber: 'TRP-1' }) }) });

    const res = await run(ctrl.confirmPublicQuote, { params: { token: TOKEN }, body });

    expect(createBookedTrip).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].quote.tripNumber).toBe('TRP-1');
  });

  it('releases the claim when booking fails, so the customer can retry', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    Quote.findOneAndUpdate.mockResolvedValueOnce(quoteDoc({ status: 'confirming' }));
    const fareErr = Object.assign(new Error('No active pricing'), { isFareError: true });
    createBookedTrip.mockRejectedValue(fareErr);

    const res = await run(ctrl.confirmPublicQuote, { params: { token: TOKEN }, body });

    expect(res.status).toHaveBeenCalledWith(400);
    const [filter, update] = Quote.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'q1', status: 'confirming' });
    expect(update.$set.status).toBe('viewed');
  });

  it('refuses a route that cannot be priced instead of booking at 0 km', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    Quote.findOneAndUpdate.mockResolvedValueOnce(quoteDoc({ status: 'confirming' }));
    quoteTrip.mockResolvedValue(null);

    const res = await run(ctrl.confirmPublicQuote, { params: { token: TOKEN }, body });

    expect(res.status).toHaveBeenCalledWith(422);
    expect(createBookedTrip).not.toHaveBeenCalled();
    expect(Quote.updateOne).toHaveBeenCalled();
  });

  it('requires a patient name, pickup, drop and service', async () => {
    Quote.findOne.mockResolvedValue(quoteDoc({ status: 'viewed' }));
    const res = await run(ctrl.confirmPublicQuote, { params: { token: TOKEN }, body: { ...body, drop: null } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Quote.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
