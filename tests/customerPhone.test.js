/**
 * tests/customerPhone.test.js
 * ============================================================
 * Customer numbers never leave the backend.
 *
 *   - utils/customerPhone.js: masks, and opaque refs that round-trip the
 *     stored digits exactly and reject anything forged or altered
 *   - every model the CRM, driver app or fleet-owner app receives drops
 *     the customer's number from its JSON — checked against the real
 *     schemas, with no database, so a future field rename cannot quietly
 *     undo it
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { maskPhone, customerRef, phoneFromRef, isCustomerRef } = require('../utils/customerPhone');
const { Trip, Lead, Bill } = require('../models');
const WhatsAppLead    = require('../models/WhatsAppLead');
const WhatsAppCallLog = require('../models/WhatsAppCallLog');
const CallLog         = require('../models/CallLog');

const NUMBER = '9986844442';
const leaks = (value) => /9986844442/.test(JSON.stringify(value));

describe('customer refs', () => {
  it('round-trips a 10-digit number', () => {
    const ref = customerRef(NUMBER);
    expect(isCustomerRef(ref)).toBe(true);
    expect(ref).not.toContain(NUMBER);
    expect(phoneFromRef(ref)).toBe(NUMBER);
  });

  it('round-trips WhatsApp\'s stored format exactly, country code and all', () => {
    expect(phoneFromRef(customerRef('919986844442'))).toBe('919986844442');
  });

  it('is stable, so the CRM can key rows on it', () => {
    expect(customerRef(NUMBER)).toBe(customerRef(NUMBER));
    expect(customerRef(NUMBER)).not.toBe(customerRef('9986844443'));
  });

  it('rejects a ref that was altered or made up', () => {
    const ref = customerRef(NUMBER);
    const flipped = ref.slice(0, -2) + (ref.endsWith('A') ? 'B' : 'A') + ref.slice(-1);
    expect(phoneFromRef(flipped)).toBeNull();
    expect(phoneFromRef('c_' + Buffer.alloc(26).toString('base64url'))).toBeNull();
    expect(phoneFromRef(NUMBER)).toBeNull();
    expect(phoneFromRef(undefined)).toBeNull();
  });

  it('masks to the last four digits', () => {
    expect(maskPhone('+91 99868 44442')).toBe('••••••4442');
    expect(maskPhone('')).toBeNull();
  });
});

describe('no response carries a customer number', () => {
  it('Trip, including when populated inside another document', () => {
    const trip = new Trip({ patientName: 'A', patientPhone: NUMBER });
    const bill = new Bill({});
    bill.trip = trip;

    const out = JSON.parse(JSON.stringify({ trip, bill, list: [trip] }));
    expect(leaks(out)).toBe(false);
    expect(out.trip.patientPhoneMasked).toBe('••••••4442');
    expect(out.bill.trip.patientPhoneMasked).toBe('••••••4442');
    // The backend itself can still read it, to send WhatsApp and to dial.
    expect(trip.patientPhone).toBe(NUMBER);
  });

  it('Lead', () => {
    const out = JSON.parse(JSON.stringify(new Lead({ phone: NUMBER })));
    expect(leaks(out)).toBe(false);
    expect(out.phoneMasked).toBe('••••••4442');
  });

  it('WhatsAppLead, with a ref to call or open it by', () => {
    const out = JSON.parse(JSON.stringify(new WhatsAppLead({ phone: '919986844442', service: 'BLS' })));
    expect(leaks(out)).toBe(false);
    expect(phoneFromRef(out.customerRef)).toBe('919986844442');
  });

  it('WhatsAppCallLog', () => {
    const out = JSON.parse(JSON.stringify(new WhatsAppCallLog({ phone: '919986844442', outcome: 'booked' })));
    expect(leaks(out)).toBe(false);
  });

  it('CallLog — neither the customer\'s nor the agent\'s number', () => {
    const log = new CallLog({
      provider: 'plivo', direction: 'outbound', context: 'trip',
      customerPhone: NUMBER, agentPhone: '9123456789',
    });
    const out = JSON.parse(JSON.stringify(log));
    expect(leaks(out)).toBe(false);
    expect(JSON.stringify(out)).not.toContain('9123456789');
    expect(out.customerMasked).toBe('••••••4442');
  });
});
