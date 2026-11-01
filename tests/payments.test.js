/**
 * tests/payments.test.js
 * ============================================================
 * Payment collection — the rules that need no database:
 *   - amounts typed by a person become exact paise, or are refused
 *   - a bill's total / received / outstanding / state, and when it needs
 *     reconciling instead of more payments
 *   - receipt financial year and the India calendar month at their edges
 *   - the record-payment endpoint refuses bad input before touching data
 *   - the old free-form PUT /bills/:id/payment writes nothing
 * Transactions, concurrency, advances through trip completion, Razorpay
 * idempotency, rollback and cross-page totals need a real MongoDB and were
 * checked against an isolated in-memory replica set.
 * ============================================================
 */
'use strict';

const { parseAmount, toPaise, formatRupees } = require('../utils/money');
const { balanceOf, financialYear, istMonth } = require('../services/payments');

describe('amounts', () => {
  it.each([
    ['1500', 150000], ['1500.5', 150050], ['1,500.50', 150050], ['0.01', 1], [1500, 150000], [' 99.9 ', 9990],
  ])('%j -> %d paise', (input, paise) => expect(parseAmount(input)).toBe(paise));

  it.each(['0', '-5', '12.345', 'abc', '', '1e3', '₹100', null, undefined, { $gt: 0 }, '10000000.01'])('%j is refused', (input) => {
    expect(parseAmount(input)).toBe(null);
  });

  it('stored rupee figures convert without float drift', () => {
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(1234.565)).toBe(123457);
    expect(toPaise(undefined)).toBe(null);
  });

  it('formats Indian style', () => {
    expect(formatRupees(12345650)).toBe('₹1,23,456.50');
    expect(formatRupees(100000)).toBe('₹1,000');
  });
});

describe('bill balance', () => {
  const bill = (o) => ({ grandTotal: 2100, paidAmount: 0, paymentStatus: 'pending', ...o });
  it('unpaid / part-paid / paid', () => {
    expect(balanceOf(bill(), 0)).toMatchObject({ totalPaise: 210000, paidPaise: 0, outstandingPaise: 210000, state: 'unpaid', reconcile: [] });
    expect(balanceOf(bill({ paidAmount: 800, paymentStatus: 'partial' }), 80000)).toMatchObject({ outstandingPaise: 130000, state: 'part_paid', notItemisedPaise: 0, reconcile: [] });
    expect(balanceOf(bill({ paidAmount: 2100, paymentStatus: 'paid' }), 210000)).toMatchObject({ outstandingPaise: 0, state: 'paid', reconcile: [] });
  });

  it('an older paid bill with no receipts is paid, "not itemised", not a reconciliation case', () => {
    expect(balanceOf(bill({ paidAmount: 2100, paymentStatus: 'paid' }), 0)).toMatchObject({ state: 'paid', notItemisedPaise: 210000, reconcile: [] });
  });

  it.each([
    ['marked paid but short', { paidAmount: 1000, paymentStatus: 'paid' }, 0, 'marked_paid_short'],
    ['more received than billed', { paidAmount: 2500, paymentStatus: 'paid' }, 250000, 'overpaid'],
    ['status behind the amount', { paidAmount: 2100, paymentStatus: 'partial' }, 210000, 'status_behind'],
    ['money but still "pending"', { paidAmount: 100, paymentStatus: 'pending' }, 10000, 'status_behind'],
    ['receipts above paid amount', { paidAmount: 100, paymentStatus: 'partial' }, 50000, 'receipts_exceed_paid'],
    ['no total', { grandTotal: undefined }, 0, 'no_total'],
  ])('needs reconciling: %s', (_, o, receipts, reason) => {
    expect(balanceOf(bill(o), receipts).reconcile).toContain(reason);
  });

  it('a waived bill owes nothing', () => {
    expect(balanceOf(bill({ paymentStatus: 'waived' }), 0)).toMatchObject({ state: 'waived', outstandingPaise: 0 });
  });

  it('a bill on a hospital invoice is marked so, and is not collectible from the customer', () => {
    expect(balanceOf(bill({ invoiceId: 'inv1' }), 0)).toMatchObject({ onHospitalInvoice: true, outstandingPaise: 210000, collectiblePaise: 0 });
    // Traced from the invoice's own bill list (invoiceId may be missing).
    expect(balanceOf(bill(), 0, { onInvoice: true })).toMatchObject({ onHospitalInvoice: true, collectiblePaise: 0, reconcile: [] });
    expect(balanceOf(bill(), 0).collectiblePaise).toBe(210000);
  });

  it('paid by the customer AND on a hospital invoice needs reconciling', () => {
    expect(balanceOf(bill({ paidAmount: 500, paymentStatus: 'partial' }), 50000, { onInvoice: true }).reconcile).toContain('paid_and_invoiced');
  });
});

describe('India-time boundaries', () => {
  it('financial year turns at 1 April 00:00 India time', () => {
    expect(financialYear(new Date('2027-03-31T18:29:59Z'))).toBe('2026-27'); // 31 Mar 23:59:59 IST
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('2027-28'); // 1 Apr 00:00 IST
    expect(financialYear(new Date('2026-11-01T10:00:00Z'))).toBe('2026-27');
  });

  it('a month is the India calendar month', () => {
    const { start, end } = istMonth(new Date('2026-10-31T19:00:00Z')); // 1 Nov 00:30 IST
    expect(start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });
});

describe('POST /api/billing/payments input', () => {
  jest.resetModules();
  const mockRecord = jest.fn();
  jest.doMock('../services/payments', () => ({ ...jest.requireActual('../services/payments'), recordPayment: mockRecord }));
  const ctrl = require('../controllers/billingController');
  const run = async (body) => {
    const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; };
    await ctrl.recordPayment({ body, user: { _id: 'u1', name: 'Owner' } }, res, (e) => { throw e; });
    return res;
  };
  const ok = { tripId: '64b000000000000000000001', amount: '500', method: 'cash', receivedAt: '2026-11-01T09:30', requestId: 'abcd-1234-efgh' };

  it.each([
    ['bad trip', { tripId: 'x' }], ['no amount', { amount: '' }], ['card', { method: 'card' }], ['online', { method: 'online' }],
    ['cash with reference', { reference: 'ABC12345' }], ['bank without UTR', { method: 'bank_transfer' }],
    ['bad reference', { method: 'upi', reference: '<script>' }], ['no received time', { receivedAt: '' }],
    ['received time in the future', { receivedAt: new Date(Date.now() + 3600e3).toISOString() }],
    ['long note', { note: 'x'.repeat(301) }], ['no form key', { requestId: undefined }], ['form key object', { requestId: { $ne: 1 } }],
  ])('%s -> 400, nothing recorded', async (_, change) => {
    const res = await run({ ...ok, ...change });
    expect(res.statusCode).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a valid cash payment goes through as paise, India time', async () => {
    mockRecord.mockResolvedValueOnce({ payment: { amountPaise: 50000, receiptNumber: 'RCT/2026-27/000001' }, created: true });
    const res = await run(ok);
    expect(res.statusCode).toBe(201);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ amountPaise: 50000, method: 'cash', receivedAt: new Date('2026-11-01T04:00:00Z') });
  });

  it('the old PUT /bills/:id/payment writes nothing', () => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    ctrl.legacyRecordPayment({ params: { id: 'b1' }, body: { amount: 100 } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
  });
});

describe('customer-facing issuer (bills and receipts)', () => {
  const { CUSTOMER_ISSUER, gstinCheckDigitValid } = require('../utils/customerIssuer');
  const { BUSINESS } = require('../services/seoFacts');

  it('business name, GSTIN, registered address and configured contacts', () => {
    expect(CUSTOMER_ISSUER).toEqual({
      name: 'SaveLife Health Services', gstin: '29CIQPM9958R1ZK', address: BUSINESS.address,
      phone: BUSINESS.callNumber, email: BUSINESS.email, website: BUSINESS.website,
    });
  });

  it('no personal name or proprietor / legal-entity line', () => {
    expect(JSON.stringify(CUSTOMER_ISSUER)).not.toMatch(/propriet|legal|manjunath/i);
  });

  it('the GSTIN check digit is valid and its state (29, Karnataka) matches the address', () => {
    expect(gstinCheckDigitValid(CUSTOMER_ISSUER.gstin)).toBe(true);
    expect(gstinCheckDigitValid('29CIQPM9958R1ZJ')).toBe(false);
    expect(CUSTOMER_ISSUER.address).toMatch(/Karnataka/);
  });

  it('the internal legal identity is unchanged', () => {
    expect(BUSINESS.legalName).toBe('SaveLife Health Services (Proprietorship)');
  });
});

describe('receipt reversal rules', () => {
  const { reversalBlock } = require('../services/payments');
  const Payment = require('../models/Payment');
  const staff = { kind: 'payment', verification: 'staff_recorded', method: 'cash', amountPaise: 50000 };
  const okBal = { onHospitalInvoice: false, state: 'paid', notItemisedPaise: 0, reconcile: [], paidPaise: 100000 };

  it('a staff-recorded cash / UPI / bank receipt (or advance) can be reversed', () => {
    for (const method of ['cash', 'upi', 'bank_transfer']) expect(reversalBlock({ ...staff, method }, { bal: okBal })).toBe(null);
    expect(reversalBlock({ ...staff, kind: 'advance' })).toBe(null);
    expect(reversalBlock(staff, { bal: { ...okBal, reconcile: ['overpaid'] } })).toBe(null); // e.g. an advance above the final bill
  });

  it.each([
    ['a Razorpay-verified receipt', { ...staff, verification: 'provider_verified', method: 'online' }, {}, /Razorpay/],
    ['a reversal', { ...staff, kind: 'reversal', amountPaise: -50000 }, {}, /can't itself be reversed/],
    ['one already reversed', staff, { reversedBy: { receiptNumber: 'REV/2026-27/000001' } }, /Already reversed \(REV/],
    ['a bill on a hospital invoice', staff, { bal: { ...okBal, onHospitalInvoice: true } }, /hospital invoice/],
    ['a bill with older un-itemised payments', staff, { bal: { ...okBal, notItemisedPaise: 10000 } }, /ambiguous/],
    ['a bill needing reconciliation', staff, { bal: { ...okBal, reconcile: ['marked_paid_short'] } }, /reconciling/],
    ['a waived bill', staff, { bal: { ...okBal, state: 'waived' } }, /waived/],
    ['a bill showing less received than the receipt', staff, { bal: { ...okBal, paidPaise: 1000 } }, /reconciling/],
  ])('refused: %s', (_, p, opts, why) => {
    expect(reversalBlock(p, opts)).toMatch(why);
  });

  it('amounts: positive receipts, negative reversals, whole paise, never zero', () => {
    const v = (o) => new Payment({ receiptNumber: 'x', trip: '64b000000000000000000001', method: 'cash', verification: 'staff_recorded', receivedAt: new Date(), ...o }).validateSync()?.errors?.amountPaise;
    expect(v({ kind: 'payment', amountPaise: 100 })).toBeUndefined();
    expect(v({ kind: 'reversal', amountPaise: -100 })).toBeUndefined();
    expect(v({ kind: 'payment', amountPaise: -100 })).toBeDefined();
    expect(v({ kind: 'reversal', amountPaise: 100 })).toBeDefined();
    expect(v({ kind: 'payment', amountPaise: 0 })).toBeDefined();
    expect(v({ kind: 'payment', amountPaise: 1.5 })).toBeDefined();
  });
});

describe('POST /api/billing/payments/:id/reverse input', () => {
  jest.resetModules();
  const mockReverse = jest.fn();
  jest.doMock('../services/payments', () => ({ ...jest.requireActual('../services/payments'), reversePayment: mockReverse }));
  const ctrl = require('../controllers/billingController');
  const run = async (params, body) => {
    const res = { statusCode: 200 }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; };
    await ctrl.reversePayment({ params, body, user: { _id: 'o1', name: 'Owner', role: 'owner' } }, res, (e) => { throw e; });
    return res;
  };
  it.each([
    ['bad id', { id: 'x' }, { reason: 'Entered twice by mistake', requestId: 'abcd-1234' }, 404],
    ['no form key', { id: '64b000000000000000000001' }, { reason: 'Entered twice by mistake' }, 400],
    ['form key object', { id: '64b000000000000000000001' }, { reason: 'Entered twice by mistake', requestId: { $ne: 1 } }, 400],
  ])('%s -> %d, nothing reversed', async (_, params, body, code) => {
    expect((await run(params, body)).statusCode).toBe(code);
    expect(mockReverse).not.toHaveBeenCalled();
  });
  it('the response says no money was refunded', async () => {
    mockReverse.mockResolvedValueOnce({ reversal: { receiptNumber: 'REV/2026-27/000001' }, created: true });
    const res = await run({ id: '64b000000000000000000001' }, { reason: 'Entered twice by mistake', requestId: 'abcd-1234' });
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toMatch(/no money was refunded/);
  });
});

describe('reference reuse slot (refSeq)', () => {
  const Payment = require('../models/Payment');
  const doc = (refSeq) => new Payment({ receiptNumber: 'x', trip: '64b000000000000000000001', kind: 'payment', amountPaise: 1, method: 'upi', reference: 'R1', receivedAt: new Date(), verification: 'staff_recorded', ...(refSeq === 'absent' ? {} : { refSeq }) });
  it('first use stores no refSeq (no default)', () => {
    expect(doc('absent').toObject().refSeq).toBeUndefined();
  });
  it.each([0, -1, 1.5])('refSeq %p is rejected — "absent" is the only first-use slot', (v) => {
    expect(doc(v).validateSync()?.errors?.refSeq).toBeDefined();
  });
  it.each([1, 2, 30])('refSeq %p is accepted', (v) => {
    expect(doc(v).validateSync()?.errors?.refSeq).toBeUndefined();
  });
});
