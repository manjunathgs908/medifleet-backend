/**
 * tests/gstInvoicing.test.js
 * ============================================================
 * GST invoicing Phase 1 — the maths (services/gst.js) and the routes.
 *
 *   - intra-state CGST+SGST (each half the rate) vs inter-state IGST
 *   - the Kalpataru July invoice reproduced exactly (₹64,000 @ 18% =
 *     ₹75,520)
 *   - exempt lines → bill of supply; any taxable line → tax invoice
 *   - discounts, decimal quantities, round-off, reverse charge
 *   - GSTIN check digit + state, SAC/HSN format, amounts in words
 *   - every route is owner-only
 *
 * Database-backed behaviour (numbering, issue, cancel, payments) is checked
 * end to end on an isolated in-memory MongoDB — see the commit message.
 * ============================================================
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const gst = require('../services/gst');

const line = (over = {}) => ({ name: 'Hiring for BLS Eeco Ambulance', code: '999315', unit: 'Month', qtyMilli: 1000, ratePaise: 64_000_00, taxType: 'taxable', gstRate: 18, ...over });

describe('intra-state vs inter-state', () => {
  it('Karnataka party: CGST 9% + SGST 9% — the Kalpataru July invoice exactly', () => {
    const { problems, invoice } = gst.computeInvoice({ lines: [line()], placeOfSupply: '29' });
    expect(problems).toEqual([]);
    expect(invoice.docType).toBe('tax_invoice');
    expect(invoice.supplyType).toBe('intra');
    expect(invoice.totals).toEqual({ taxablePaise: 64_000_00, cgstPaise: 5_760_00, sgstPaise: 5_760_00, igstPaise: 0, taxPaise: 11_520_00, roundOffPaise: 0, grandTotalPaise: 75_520_00 });
    expect(invoice.taxSummary).toEqual([{ gstRate: 18, taxablePaise: 64_000_00, cgstPaise: 5_760_00, sgstPaise: 5_760_00, igstPaise: 0 }]);
  });

  it('another state: IGST at the full rate, no CGST/SGST', () => {
    const { invoice } = gst.computeInvoice({ lines: [line()], placeOfSupply: '24' });
    expect(invoice.supplyType).toBe('inter');
    expect(invoice.totals).toEqual(expect.objectContaining({ cgstPaise: 0, sgstPaise: 0, igstPaise: 11_520_00, grandTotalPaise: 75_520_00 }));
  });

  it('CGST and SGST are each rounded on their own half', () => {
    // ₹10.05 @ 5%: half = 2.5% of 1005p = 25.125p → 25p each, 50p total.
    const { invoice } = gst.computeInvoice({ lines: [line({ ratePaise: 1005, gstRate: 5 })], placeOfSupply: '29', roundOff: false });
    expect(invoice.lines[0]).toEqual(expect.objectContaining({ cgstPaise: 25, sgstPaise: 25, igstPaise: 0, totalPaise: 1055 }));
  });
});

describe('exempt services and bill of supply', () => {
  const trip = { name: 'Patient transport', code: '999315', unit: 'Trip', qtyMilli: 1000, ratePaise: 2_400_00, taxType: 'exempt', gstRate: 18 };

  it('all lines exempt → bill of supply, no tax even if a rate was left on it', () => {
    const { problems, invoice } = gst.computeInvoice({ lines: [trip], placeOfSupply: '29' });
    expect(problems).toEqual([]);
    expect(invoice.docType).toBe('bill_of_supply');
    expect(invoice.totals).toEqual(expect.objectContaining({ taxPaise: 0, grandTotalPaise: 2_400_00 }));
    expect(invoice.lines[0].gstRate).toBe(0);
    expect(invoice.taxSummary).toEqual([]);
  });

  it('nil-rated and non-GST lines are untaxed too', () => {
    for (const taxType of ['nil', 'non_gst']) {
      const { invoice } = gst.computeInvoice({ lines: [{ ...trip, taxType }], placeOfSupply: '29' });
      expect(invoice.docType).toBe('bill_of_supply');
      expect(invoice.totals.taxPaise).toBe(0);
    }
  });

  it('taxable + exempt on one invoice → tax invoice; tax only on the taxable line', () => {
    const { invoice } = gst.computeInvoice({ lines: [line(), trip], placeOfSupply: '29' });
    expect(invoice.docType).toBe('tax_invoice');
    expect(invoice.totals).toEqual(expect.objectContaining({ taxablePaise: 66_400_00, taxPaise: 11_520_00, grandTotalPaise: 77_920_00 }));
  });
});

describe('quantities, discounts, round-off', () => {
  it('decimal quantity (12.5 km × ₹18.40)', () => {
    const { invoice } = gst.computeInvoice({ lines: [line({ qtyMilli: 12_500, ratePaise: 1840, gstRate: 18 })], placeOfSupply: '29', roundOff: false });
    expect(invoice.lines[0].taxablePaise).toBe(23000);
    expect(invoice.lines[0].cgstPaise).toBe(2070);
  });

  it('discount in rupees and in percent come off before tax', () => {
    let { invoice } = gst.computeInvoice({ lines: [line({ discountPaise: 4_000_00 })], placeOfSupply: '29' });
    expect(invoice.lines[0]).toEqual(expect.objectContaining({ discountPaise: 4_000_00, taxablePaise: 60_000_00, cgstPaise: 5_400_00 }));
    ({ invoice } = gst.computeInvoice({ lines: [line({ discountPercent: 10 })], placeOfSupply: '29' }));
    expect(invoice.lines[0]).toEqual(expect.objectContaining({ discountPaise: 6_400_00, taxablePaise: 57_600_00 }));
  });

  it('a discount larger than the line is refused', () => {
    const { problems } = gst.computeInvoice({ lines: [line({ discountPaise: 70_000_00 })], placeOfSupply: '29' });
    expect(problems.join(' ')).toMatch(/discount is more than the line/);
  });

  it('round-off to the rupee, shown as its own figure', () => {
    // ₹999.50 @ 18%: CGST = SGST = 89.955 → 89.96 each (each half rounded),
    // so 1179.42 → 1179.00, round-off −0.42.
    const { invoice } = gst.computeInvoice({ lines: [line({ ratePaise: 99950 })], placeOfSupply: '29' });
    expect(invoice.totals).toEqual(expect.objectContaining({ taxablePaise: 99950, cgstPaise: 8996, sgstPaise: 8996, taxPaise: 17992, roundOffPaise: -42, grandTotalPaise: 117900 }));
    const off = gst.computeInvoice({ lines: [line({ ratePaise: 99950 })], placeOfSupply: '29', roundOff: false });
    expect(off.invoice.totals.grandTotalPaise).toBe(117942);
  });
});

describe('reverse charge', () => {
  it('tax worked out and shown, but not added to what the customer owes', () => {
    const { problems, invoice } = gst.computeInvoice({ lines: [line({ gstRate: 5, reverseCharge: true })], placeOfSupply: '29' });
    expect(problems).toEqual([]);
    expect(invoice.reverseCharge).toBe(true);
    expect(invoice.totals).toEqual(expect.objectContaining({ taxPaise: 3_200_00, grandTotalPaise: 64_000_00 }));
  });

  it('reverse-charge and ordinary taxable lines cannot be mixed', () => {
    const { problems } = gst.computeInvoice({ lines: [line({ reverseCharge: true }), line()], placeOfSupply: '29' });
    expect(problems.join(' ')).toMatch(/cannot be on one invoice/);
  });
});

describe('what stops an invoice', () => {
  it.each([
    [{ lines: [], placeOfSupply: '29' }, /at least one line/],
    [{ lines: [line()], placeOfSupply: '99' }, /place of supply/],
    [{ lines: [line({ gstRate: 7 })], placeOfSupply: '29' }, /GST rate/],
    [{ lines: [line({ taxType: 'zero' })], placeOfSupply: '29' }, /taxable, exempt/],
    [{ lines: [line({ ratePaise: 0 })], placeOfSupply: '29' }, /more than ₹0/],
    [{ lines: [line({ name: '' })], placeOfSupply: '29' }, /name the service/],
  ])('%#', (input, re) => {
    expect(gst.computeInvoice(input).problems.join(' ')).toMatch(re);
  });
});

describe('GSTIN, state, SAC/HSN', () => {
  it('real GSTINs pass, with their state', () => {
    for (const g of ['29CIQPM9958R1ZK', '29AAACN7335C1ZL', '29AAACK8387R1ZF']) {
      expect(gst.gstinProblem(g)).toBeNull();
      expect(gst.stateOfGstin(g)).toBe('29');
    }
    expect(gst.stateName('29')).toBe('Karnataka');
    expect(gst.stateName('24')).toBe('Gujarat');
  });
  it('a wrong check digit, bad shape or state is refused', () => {
    expect(gst.gstinProblem('29AAACN7335C1ZM')).toMatch(/check digit/);
    expect(gst.gstinProblem('29AAACN7335C1')).toMatch(/15 characters/);
    expect(gst.gstinProblem('99AAACN7335C1ZL')).toMatch(/state code/);
    expect(gst.normaliseGstin(' 29aaacn7335c1zl ')).toBe('29AAACN7335C1ZL');
  });
  it('SAC: 6 digits from 99; HSN: 4, 6 or 8 digits', () => {
    expect(gst.codeProblem('999315', 'service')).toBeNull();
    expect(gst.codeProblem('9993', 'service')).toMatch(/6 digits/);
    expect(gst.codeProblem('', 'service')).toMatch(/SAC/);
    expect(gst.codeProblem('3004', 'goods')).toBeNull();
    expect(gst.codeProblem('30049099', 'goods')).toBeNull();
    expect(gst.codeProblem('300', 'goods')).toMatch(/HSN/);
  });
});

describe('numbering and words', () => {
  it('series formats, within 16 characters', () => {
    expect(gst.formatNumber('tax_invoice', '2026-27', 59)).toBe('2026-27/59');
    expect(gst.formatNumber('bill_of_supply', '2026-27', 12345)).toBe('BS/2026-27/12345');
    expect(gst.formatNumber('bill_of_supply', '2026-27', 12345).length).toBeLessThanOrEqual(16);
  });
  it('financial year changes on 1 April, India time', () => {
    expect(gst.financialYear(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27'); // 31 Mar 23:30 IST
    expect(gst.financialYear(new Date('2027-03-31T18:31:00Z'))).toBe('2027-28'); // 1 Apr 00:01 IST
  });
  it('amount in words, Indian system', () => {
    expect(gst.amountInWords(75_520_00)).toBe('Seventy Five Thousand Five Hundred Twenty Rupees only');
    expect(gst.amountInWords(12_34_567_50)).toBe('Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Fifty Paise only');
    expect(gst.amountInWords(2_00_00_000_00)).toBe('Two Crore Rupees only');
    expect(gst.amountInWords(0)).toBe('Zero Rupees only');
  });
  it('typed amounts and quantities', () => {
    expect(gst.parseRupees('64,000')).toBe(64_000_00);
    expect(gst.parseRupees('0', { allowZero: true })).toBe(0);
    expect(gst.parseRupees('0')).toBeNull();
    expect(gst.parseRupees('-5')).toBeNull();
    expect(gst.parseRupees('1.234')).toBeNull();
    expect(gst.parseQty('12.5')).toBe(12_500);
    expect(gst.parseQty('0')).toBeNull();
  });
});

describe('routes: owner only', () => {
  it('every invoicing route is behind login and the owner role', async () => {
    const router = require('../routes/invoicing');
    const routes = router.stack.filter((l) => l.route);
    expect(routes.length).toBe(18);
    for (const l of routes) {
      expect(l.route.stack.length).toBe(3);
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
      const next = jest.fn();
      await l.route.stack[1].handle({ user: { role: 'telecaller' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
    // /invoices/calculate is matched before /invoices/:id.
    const idx = (p, m) => routes.findIndex((l) => l.route.path === p && l.route.methods[m]);
    expect(idx('/invoices/calculate', 'post')).toBeLessThan(idx('/invoices/:id', 'get'));
  });
});
