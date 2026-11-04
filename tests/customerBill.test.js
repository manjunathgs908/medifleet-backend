/**
 * tests/customerBill.test.js
 * ============================================================
 * The customer's bill on WhatsApp (services/customerBill.js,
 * billingController customer-bill endpoints):
 *
 *   - a completed trip's bill is queued for the owner (pending_review);
 *     sent at once only with BILL_AUTO_SEND=true and no warnings
 *   - warnings (drop-wait review, no distance, no total, >25% from the
 *     estimate, billed elsewhere) always hold it for a person
 *   - Send happens once: a sent bill, or one being sent, is never sent again
 *   - the trip_bill template gets 91 + 10 digits and the bill as stored;
 *     the link is the tracking token; numbers are listed masked
 *   - no valid mobile, or WhatsApp refusing, is recorded — never thrown
 *
 * Models and Meta's API are mocked — no database, no messages sent.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['populate', 'select', 'sort', 'lean', 'limit', 'session']) q[m] = () => q;
  return q;
};

jest.mock('../models', () => ({
  Bill: { updateOne: jest.fn(), findById: jest.fn(), find: jest.fn() },
  Trip: { findById: jest.fn() },
  User: {}, Vehicle: {}, HospitalInvoice: {}, Hospital: {}, Notification: {},
}));
jest.mock('../models/Ambulance', () => ({}));
jest.mock('../models/Payment', () => ({ aggregate: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../services/whatsappService', () => ({ sendTemplate: jest.fn(), sendText: jest.fn() }));

const { Bill, Trip } = require('../models');
const whatsapp = require('../services/whatsappService');
const { waPhone } = require('../services/whatsappNotifications');
const customerBill = require('../services/customerBill');
const billingCtrl = require('../controllers/billingController');

const BILL_ID = '64c000000000000000000001';
const TRIP_ID = '64c0000000000000000000t1';
const owner = { _id: '64a0000000000000000000a1', role: 'owner', name: 'Owner' };

const trip = (over = {}) => ({
  _id: TRIP_ID, tripNumber: 'TRP-1', patientName: 'Ravi', patientPhone: '9986844442',
  trackingToken: 'tok123', estimatedFare: 2700, dropWaitNeedsReview: false, ...over,
});
const bill = (over = {}) => ({
  _id: BILL_ID, billNumber: 'BILL-20261103-001', trip: TRIP_ID,
  baseFare: 2400, additionalCharges: 0, gstAmount: 120, waitCharge: 150, grandTotal: 2670,
  distanceKm: 18, paidAmount: 0, paymentStatus: 'pending', ...over,
});

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const run = async (handler, req) => {
  const res = mockRes(); const next = jest.fn();
  await handler({ body: {}, query: {}, params: {}, ...req }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
};

const updates = () => Bill.updateOne.mock.calls.map(([filter, update]) => ({ filter, update }));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.BILL_AUTO_SEND;
  Bill.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  whatsapp.sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.1' }] });
  Trip.findById.mockReturnValue(chain(trip()));
});

// ─────────────────────────────────────────────────────────────
describe('customer number for WhatsApp: 91 + 10 digits', () => {
  it.each([
    ['9986844442', '919986844442'],
    ['919986844442', '919986844442'],
    ['+91 99868 44442', '919986844442'],
    ['09986844442', '919986844442'],
  ])('%s → %s', (raw, out) => expect(waPhone(raw)).toBe(out));

  it.each(['N/A', '', null, '12345', '1234567890'])('%s → not sendable', (raw) => expect(waPhone(raw)).toBeNull());
});

describe('warnings that hold a bill for review', () => {
  it('a clean bill has none', () => expect(customerBill.warningsFor(trip(), bill())).toEqual([]));
  it('drop wait flagged for review', () => expect(customerBill.warningsFor(trip({ dropWaitNeedsReview: true }), bill())).toEqual(['drop_wait_review']));
  it('no distance', () => expect(customerBill.warningsFor(trip(), bill({ distanceKm: 0 }))).toContain('no_distance'));
  it('no total', () => expect(customerBill.warningsFor(trip(), bill({ grandTotal: 0 }))).toContain('no_total'));
  it('more than 25% from the booking estimate, either way', () => {
    expect(customerBill.warningsFor(trip({ estimatedFare: 2000 }), bill({ grandTotal: 2600 }))).toEqual(['far_from_estimate']);
    expect(customerBill.warningsFor(trip({ estimatedFare: 2000 }), bill({ grandTotal: 1400 }))).toEqual(['far_from_estimate']);
    expect(customerBill.warningsFor(trip({ estimatedFare: 2000 }), bill({ grandTotal: 2500 }))).toEqual([]);
    expect(customerBill.ESTIMATE_DRIFT).toBe(0.25);
  });
  it('billed to a hospital, insurance or a hospital invoice', () => {
    expect(customerBill.warningsFor(trip(), bill({ paymentMode: 'hospital_credit' }))).toEqual(['billed_elsewhere']);
    expect(customerBill.warningsFor(trip(), bill({ paymentMode: 'insurance' }))).toEqual(['billed_elsewhere']);
    expect(customerBill.warningsFor(trip(), bill({ invoiceId: 'inv1' }))).toEqual(['billed_elsewhere']);
  });
});

describe('queueBill — right after a trip completes', () => {
  it('default: queued for the owner, nothing sent', async () => {
    const r = await customerBill.queueBill(trip(), bill());
    expect(r).toEqual(expect.objectContaining({ queued: true, state: 'pending_review' }));
    const [u] = updates();
    // Once per bill.
    expect(u.filter).toEqual({ _id: BILL_ID, customerBill: { $exists: false } });
    expect(u.update.$set.customerBill).toEqual(expect.objectContaining({ state: 'pending_review' }));
    expect(u.update.$set.customerBill.warnings).toBeUndefined();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('no valid mobile: queued as no_phone', async () => {
    await customerBill.queueBill(trip({ patientPhone: 'N/A' }), bill());
    expect(updates()[0].update.$set.customerBill.state).toBe('no_phone');
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('warnings are recorded with it', async () => {
    await customerBill.queueBill(trip({ dropWaitNeedsReview: true }), bill());
    expect(updates()[0].update.$set.customerBill.warnings).toEqual(['drop_wait_review']);
  });

  it('BILL_AUTO_SEND=true and no warnings: sent at once', async () => {
    process.env.BILL_AUTO_SEND = 'true';
    Bill.findById.mockReturnValue(chain({ ...bill(), customerBill: { state: 'pending_review' } }));
    const r = await customerBill.queueBill(trip(), bill());
    expect(r).toEqual({ ok: true, code: 'sent' });
    expect(whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
    const sent = updates().find((u) => u.update.$set?.['customerBill.state'] === 'sent');
    expect(sent.update.$set['customerBill.auto']).toBe(true);
  });

  it('BILL_AUTO_SEND=true but warnings: held for the owner', async () => {
    process.env.BILL_AUTO_SEND = 'true';
    const r = await customerBill.queueBill(trip({ estimatedFare: 1000 }), bill());
    expect(r).toEqual(expect.objectContaining({ queued: true, warnings: ['far_from_estimate'] }));
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('auto-send is off unless exactly "true"', async () => {
    process.env.BILL_AUTO_SEND = 'yes';
    await customerBill.queueBill(trip(), bill());
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('already queued (a retried completion): nothing again', async () => {
    Bill.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    process.env.BILL_AUTO_SEND = 'true';
    expect(await customerBill.queueBill(trip(), bill())).toEqual({ queued: false });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('sendBill — the owner taps Send', () => {
  const queued = (cb = {}, over = {}) => Bill.findById.mockReturnValue(chain({ ...bill(over), customerBill: { state: 'pending_review', ...cb } }));

  it('sends trip_bill to 91+10 digits with the bill as stored, the tracking link, and who sent it', async () => {
    queued({}, { paidAmount: 500, paymentStatus: 'partial' });
    const r = await customerBill.sendBill(BILL_ID, { user: owner });
    expect(r).toEqual({ ok: true, code: 'sent' });
    const [to, name, lang, components] = whatsapp.sendTemplate.mock.calls[0];
    expect(to).toBe('919986844442');
    expect(name).toBe('trip_bill');
    expect(lang).toBe('en');
    expect(components[0].parameters.map((p) => p.text)).toEqual([
      'BILL-20261103-001',
      'TRP-1',
      'Fare ₹2,400 · Waiting ₹150 · Extras ₹0 · GST ₹120',
      '₹2,670',
      '₹500',
      '₹2,170',
      'https://www.savelife.health/track/tok123',
    ]);
    // Meta refuses a parameter with a newline.
    expect(components[0].parameters.every((p) => !/\n/.test(p.text))).toBe(true);
    const u = updates();
    expect(u[0].filter.$or[0]).toEqual({ 'customerBill.state': { $in: ['pending_review', 'failed', 'no_phone'] } });
    const done = u.find((x) => x.update.$set?.['customerBill.state'] === 'sent');
    expect(done.filter['customerBill.state']).toBe('sending');
    expect(done.update.$set).toEqual(expect.objectContaining({ 'customerBill.by': owner._id, 'customerBill.byName': 'Owner', 'customerBill.messageId': 'wamid.1', 'customerBill.auto': false }));
  });

  it('a sent bill is never sent again', async () => {
    queued({ state: 'sent', sentAt: new Date() });
    expect((await customerBill.sendBill(BILL_ID, { user: owner })).code).toBe('already_sent');
    expect(Bill.updateOne).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('two taps at once: the second finds it claimed', async () => {
    queued();
    Bill.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    expect((await customerBill.sendBill(BILL_ID, { user: owner })).code).toBe('in_progress');
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('warnings: refused until the owner acknowledges them; then sent', async () => {
    queued({ warnings: ['far_from_estimate'] });
    expect(await customerBill.sendBill(BILL_ID, { user: owner })).toEqual({ ok: false, code: 'warnings', warnings: ['far_from_estimate'] });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect((await customerBill.sendBill(BILL_ID, { user: owner, acknowledgeWarnings: true })).code).toBe('sent');
  });

  it('never auto-sends a bill with warnings, even acknowledged', async () => {
    queued({ warnings: ['no_distance'] });
    expect((await customerBill.sendBill(BILL_ID, { auto: true, acknowledgeWarnings: true })).code).toBe('warnings');
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('a dismissed bill is not sent', async () => {
    queued({ state: 'dismissed' });
    expect((await customerBill.sendBill(BILL_ID, { user: owner })).code).toBe('dismissed');
  });

  it('WhatsApp refuses (template not approved): failed with the reason; can be retried', async () => {
    queued();
    whatsapp.sendTemplate.mockResolvedValue(null);
    const r = await customerBill.sendBill(BILL_ID, { user: owner });
    expect(r.code).toBe('failed');
    expect(r.error).toMatch(/trip_bill template approved/);
    const f = updates().find((x) => x.update.$set?.['customerBill.state'] === 'failed');
    expect(f.update.$set['customerBill.error']).toMatch(/trip_bill/);
    // 'failed' is sendable again.
    queued({ state: 'failed' });
    whatsapp.sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.2' }] });
    expect((await customerBill.sendBill(BILL_ID, { user: owner })).code).toBe('sent');
  });

  it('the trip has no valid mobile: no_phone, nothing sent', async () => {
    queued();
    Trip.findById.mockReturnValue(chain(trip({ patientPhone: 'N/A' })));
    expect((await customerBill.sendBill(BILL_ID, { user: owner })).code).toBe('no_phone');
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('an error mid-send is recorded as failed, never thrown', async () => {
    queued();
    whatsapp.sendTemplate.mockRejectedValue(new Error('socket hang up'));
    await expect(customerBill.sendBill(BILL_ID, { user: owner })).resolves.toEqual(expect.objectContaining({ ok: false, code: 'failed' }));
  });
});

describe('CRM endpoints', () => {
  it('Send: maps outcomes to clear answers; acknowledgeWarnings must be exactly true', async () => {
    Bill.findById.mockReturnValue(chain({ ...bill(), customerBill: { state: 'pending_review', warnings: ['no_distance'] } }));
    let res = await run(billingCtrl.sendCustomerBill, { user: owner, params: { id: BILL_ID }, body: { acknowledgeWarnings: 'true' } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'warnings', warnings: ['no_distance'] }));
    res = await run(billingCtrl.sendCustomerBill, { user: owner, params: { id: BILL_ID }, body: { acknowledgeWarnings: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('sent');
  });

  it('Send on a sent bill: 409 already_sent', async () => {
    Bill.findById.mockReturnValue(chain({ ...bill(), customerBill: { state: 'sent' } }));
    const res = await run(billingCtrl.sendCustomerBill, { user: owner, params: { id: BILL_ID } });
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('already_sent');
  });

  it('Don\'t send: only while it is still unsent', async () => {
    let res = await run(billingCtrl.dismissCustomerBill, { user: owner, params: { id: BILL_ID } });
    expect(res.statusCode).toBe(200);
    expect(updates()[0].filter).toEqual({ _id: BILL_ID, 'customerBill.state': { $in: ['pending_review', 'failed', 'no_phone'] } });
    Bill.updateOne.mockResolvedValue({ modifiedCount: 0 });
    res = await run(billingCtrl.dismissCustomerBill, { user: owner, params: { id: BILL_ID } });
    expect(res.statusCode).toBe(409);
  });

  it('the list masks the customer\'s number and says whether auto-send is on', async () => {
    Bill.find.mockReturnValue(chain([{ ...bill(), trip: trip(), customerBill: { state: 'pending_review', warnings: ['no_distance'] } }]));
    const res = await run(billingCtrl.getCustomerBills, { user: owner, query: {} });
    expect(Bill.find.mock.calls[0][0]).toEqual({ 'customerBill.state': { $in: ['pending_review', 'failed', 'no_phone', 'sending'] } });
    expect(res.body.autoSend).toBe(false);
    expect(res.body.bills[0]).toEqual(expect.objectContaining({ phoneMasked: '••••••4442', state: 'pending_review', warnings: ['no_distance'], balancePaise: 267000 }));
    expect(JSON.stringify(res.body)).not.toContain('9986844442');
    expect(JSON.stringify(res.body)).not.toContain('tok123');
  });

  it('unknown view: 400', async () => {
    const res = await run(billingCtrl.getCustomerBills, { user: owner, query: { view: 'everything' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('routes: owner only', () => {
  const router = require('../routes/billing');
  const layers = router.stack.filter((l) => /customer-bills/.test(l.route?.path || ''));

  it('three routes, each behind login and the owner role', async () => {
    expect(layers.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`)).toEqual([
      'get /customer-bills', 'post /customer-bills/:id/send', 'post /customer-bills/:id/dismiss',
    ]);
    for (const l of layers) {
      expect(l.route.stack).toHaveLength(3);
      // authorize('owner') turns a telecaller away.
      const res = mockRes(); const next = jest.fn();
      await l.route.stack[1].handle({ user: { role: 'telecaller' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });
});
