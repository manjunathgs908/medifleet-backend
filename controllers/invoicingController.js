'use strict';
// ============================================================
// controllers/invoicingController.js — GST invoicing, Phase 1 (owner only).
//
// Parties, the service catalog, sale invoices and bills of supply, FY
// numbering, the data for the printable GST invoice, and money received
// against an invoice. All GST maths is services/gst.js; every figure is
// computed here on the server from the lines — the CRM only previews it.
//
// Invoices: draft (editable, no number) → issued (number given, party
// frozen, nothing editable) → cancelled (number kept, shown as cancelled).
// ============================================================
const mongoose = require('mongoose');
const { Party, CatalogItem, SalesInvoice, DocumentCounter, BillingSettings } = require('../models/Invoicing');
const gst = require('../services/gst');
const { CUSTOMER_ISSUER } = require('../utils/customerIssuer');

const IST_MS = 5.5 * 60 * 60 * 1000;
const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const bad = (res, message, extra = {}) => res.status(400).json({ success: false, message, ...extra });
const text = (v, max = 500) => (v == null ? undefined : String(v).trim().slice(0, max) || undefined);

// 'YYYY-MM-DD' (an Indian calendar day) ↔ the Date of its IST midnight.
function istDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST_MS);
  const back = new Date(d.getTime() + IST_MS);
  return back.getUTCDate() === +m[3] && back.getUTCMonth() === +m[2] - 1 ? d : null;
}
const istToday = (now = new Date()) => {
  const d = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_MS);
};
const fmtDay = (d) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);

// Printed on every tax invoice and bill of supply unless the owner saves
// their own in Settings, or the invoice carries its own. Worded for clients
// who signed an agreement and for those who accepted a quotation.
const DEFAULT_TERMS = [
  '1. This invoice is raised based on the rates accepted in the agreement or quotation.',
  '2. The above invoice details are true and correct, and the service has been duly provided.',
  '3. Signature & seal are not required on this computer-generated invoice.',
  '4. Payment is due within the agreed credit period from the invoice date.',
  '5. E. & O.E. (Errors and Omissions Excepted).',
].join('\n');
exports.DEFAULT_TERMS = DEFAULT_TERMS;

const paymentState = (inv) => {
  const total = inv.totals?.grandTotalPaise || 0;
  const got = inv.receivedPaise || 0;
  return got <= 0 ? 'unpaid' : got >= total ? 'paid' : 'partial';
};

// ════════════════════════════════════════════════════════════
// Parties
// ════════════════════════════════════════════════════════════
function partyFromBody(body, { partial = false } = {}) {
  const out = {};
  const problems = [];
  if (!partial || 'name' in body) {
    out.name = text(body.name, 200);
    if (!out.name) problems.push('Enter the party name.');
  }
  if (!partial || 'kind' in body) {
    out.kind = body.kind;
    if (!gst.PARTY_KINDS.includes(out.kind)) problems.push('Choose registered business, unregistered business or consumer.');
  }
  if ('gstin' in body || (!partial && out.kind === 'registered')) {
    const g = gst.normaliseGstin(body.gstin);
    out.gstin = g || undefined;
  }
  const kind = out.kind ?? body.kindNow;
  if (kind === 'registered') {
    const g = out.gstin ?? body.gstinNow;
    const p = g ? gst.gstinProblem(g) : 'A registered business needs its GSTIN.';
    if (p) problems.push(p);
    else out.stateCode = gst.stateOfGstin(g);
  } else if (out.gstin) {
    problems.push('Only a registered business has a GSTIN — choose "registered business" or clear the GSTIN.');
  }
  if (kind !== 'registered' && (!partial || 'stateCode' in body)) {
    out.stateCode = String(body.stateCode || '').padStart(2, '0');
    if (!gst.isStateCode(out.stateCode)) problems.push('Choose the party\'s state.');
  }
  if ('address' in body) {
    const a = body.address || {};
    out.address = { line1: text(a.line1, 200), line2: text(a.line2, 200), city: text(a.city, 100), pincode: text(a.pincode, 10) };
    if (out.address.pincode && !/^\d{6}$/.test(out.address.pincode)) problems.push('A PIN code is 6 digits.');
  }
  if ('phone' in body) out.phone = text(body.phone, 20);
  if ('email' in body) out.email = text(body.email, 120);
  if ('notes' in body) out.notes = text(body.notes, 1000);
  if ('creditDays' in body) {
    const n = Number(body.creditDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) problems.push('Credit days must be 0–365.');
    else out.creditDays = n;
  }
  if ('openingBalance' in body) {
    const p = body.openingBalance === '' || body.openingBalance == null ? 0 : gst.parseRupees(body.openingBalance, { allowZero: true });
    if (p == null) problems.push('Opening balance must be an amount in rupees, e.g. 75520.');
    else out.openingBalancePaise = p;
    if (p > 0) {
      const asOf = istDay(body.openingBalanceAsOf);
      if (!asOf) problems.push('Give the date of the opening balance (the cutover date).');
      else out.openingBalanceAsOf = asOf;
    }
  }
  if ('active' in body) out.active = !!body.active;
  return { out, problems };
}

// What each party owes: opening balance + issued invoices − money received.
async function balances(partyIds) {
  const match = { status: 'issued', ...(partyIds ? { party: { $in: partyIds } } : {}) };
  const rows = await SalesInvoice.aggregate([
    { $match: match },
    { $group: { _id: '$party', billed: { $sum: '$totals.grandTotalPaise' }, received: { $sum: '$receivedPaise' }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

exports.listParties = async (req, res, next) => {
  try {
    const filter = req.query.all === '1' ? {} : { active: true };
    const parties = await Party.find(filter).sort({ name: 1 }).lean();
    const bal = await balances(parties.map((p) => p._id));
    return res.json({
      success: true,
      parties: parties.map((p) => {
        const b = bal.get(String(p._id)) || { billed: 0, received: 0, count: 0 };
        return { ...p, stateName: gst.stateName(p.stateCode), billedPaise: b.billed, receivedPaise: b.received, invoiceCount: b.count, balancePaise: (p.openingBalancePaise || 0) + b.billed - b.received };
      }),
    });
  } catch (err) { next(err); }
};

exports.createParty = async (req, res, next) => {
  try {
    const { out, problems } = partyFromBody(req.body || {});
    if (problems.length) return bad(res, problems[0], { problems });
    const party = await Party.create({ ...out, createdBy: req.user._id });
    return res.status(201).json({ success: true, party });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ success: false, message: 'A party with this GSTIN already exists.' });
    next(err);
  }
};

exports.updateParty = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Party not found.' });
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ success: false, message: 'Party not found.' });
    const { out, problems } = partyFromBody({ ...req.body, kindNow: party.kind, gstinNow: party.gstin }, { partial: true });
    if (problems.length) return bad(res, problems[0], { problems });
    if (out.kind && out.kind !== 'registered') out.gstin = undefined;
    party.set(out);
    if (party.kind !== 'registered') party.gstin = undefined;
    await party.save();
    // Issued invoices keep the party as it was when they were issued.
    return res.json({ success: true, party });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ success: false, message: 'A party with this GSTIN already exists.' });
    next(err);
  }
};

// ════════════════════════════════════════════════════════════
// Catalog
// ════════════════════════════════════════════════════════════
function itemFromBody(body, { partial = false, current = {} } = {}) {
  const out = {};
  const problems = [];
  const has = (k) => !partial || k in body;
  if (has('name')) { out.name = text(body.name, 200); if (!out.name) problems.push('Enter the item name.'); }
  if (has('kind')) { out.kind = body.kind || 'service'; if (!['service', 'goods'].includes(out.kind)) problems.push('Choose service or goods.'); }
  const kind = out.kind ?? current.kind ?? 'service';
  if (has('code') || 'kind' in body) {
    out.code = text(body.code ?? current.code, 8);
    const p = gst.codeProblem(out.code, kind);
    if (p) problems.push(p);
  }
  if (has('unit')) out.unit = text(body.unit, 20) || 'Nos';
  if (has('rate')) {
    const p = body.rate === '' || body.rate == null ? 0 : gst.parseRupees(body.rate, { allowZero: true });
    if (p == null) problems.push('Rate must be an amount in rupees.');
    else out.ratePaise = p;
  }
  if (has('taxType')) { out.taxType = body.taxType; if (!gst.TAX_TYPES.includes(out.taxType)) problems.push('Choose taxable, exempt, nil-rated or non-GST.'); }
  const taxType = out.taxType ?? current.taxType;
  if (has('gstRate') || 'taxType' in body) {
    const r = Number(body.gstRate ?? current.gstRate);
    if (taxType === 'taxable') {
      if (!gst.GST_RATES.includes(r) || r === 0) problems.push('Choose the GST rate for a taxable item.');
      else out.gstRate = r;
    } else out.gstRate = 0;
  }
  if (has('reverseCharge')) out.reverseCharge = !!body.reverseCharge && taxType === 'taxable';
  if ('description' in body) out.description = text(body.description, 500);
  if ('active' in body) out.active = !!body.active;
  return { out, problems };
}

exports.listItems = async (req, res, next) => {
  try {
    const items = await CatalogItem.find(req.query.all === '1' ? {} : { active: true }).sort({ name: 1 }).lean();
    return res.json({ success: true, items, rates: gst.GST_RATES.filter((r) => r > 0) });
  } catch (err) { next(err); }
};
exports.createItem = async (req, res, next) => {
  try {
    const { out, problems } = itemFromBody(req.body || {});
    if (problems.length) return bad(res, problems[0], { problems });
    const item = await CatalogItem.create(out);
    return res.status(201).json({ success: true, item });
  } catch (err) { next(err); }
};
exports.updateItem = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Item not found.' });
    const item = await CatalogItem.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });
    const { out, problems } = itemFromBody(req.body || {}, { partial: true, current: item.toObject() });
    if (problems.length) return bad(res, problems[0], { problems });
    item.set(out);
    await item.save();
    // Invoices already made keep the code and rate they were made with.
    return res.json({ success: true, item });
  } catch (err) { next(err); }
};

// ════════════════════════════════════════════════════════════
// Invoices
// ════════════════════════════════════════════════════════════

// The lines as sent → the stored line inputs, filled from the catalog item
// where the line names one and leaves a field out.
async function linesFromBody(raw) {
  const problems = [];
  if (!Array.isArray(raw)) return { lines: [], problems: ['Add at least one line.'] };
  if (raw.length > 100) return { lines: [], problems: ['At most 100 lines on one invoice.'] };
  const ids = raw.map((l) => l?.item).filter((id) => isObjectId(String(id || '')));
  const items = new Map((await CatalogItem.find({ _id: { $in: ids } }).lean()).map((i) => [String(i._id), i]));
  const lines = raw.map((l, i) => {
    const it = l?.item ? items.get(String(l.item)) : null;
    if (l?.item && !it) problems.push(`Line ${i + 1}: that catalog item no longer exists.`);
    const pick = (k, fallback) => (l?.[k] !== undefined && l?.[k] !== '' ? l[k] : fallback);
    const qtyMilli = gst.parseQty(pick('qty', '1'));
    if (qtyMilli == null) problems.push(`Line ${i + 1}: quantity must be a number above 0 (up to 3 decimals).`);
    const rateIn = pick('rate', it ? String(it.ratePaise / 100) : undefined);
    const ratePaise = rateIn == null ? null : gst.parseRupees(rateIn, { allowZero: true });
    if (ratePaise == null) problems.push(`Line ${i + 1}: enter the rate in rupees.`);
    const line = {
      item: it?._id,
      name: text(pick('name', it?.name), 200),
      description: text(l?.description, 500),
      code: text(pick('code', it?.code), 8),
      kind: pick('kind', it?.kind || 'service'),
      unit: text(pick('unit', it?.unit || 'Nos'), 20),
      qtyMilli: qtyMilli ?? 0,
      ratePaise: ratePaise ?? 0,
      taxType: pick('taxType', it?.taxType),
      gstRate: Number(pick('gstRate', it?.gstRate ?? 0)),
      reverseCharge: !!pick('reverseCharge', it?.reverseCharge || false),
    };
    if (l?.discountPercent !== undefined && l?.discountPercent !== '') {
      const d = Number(l.discountPercent);
      if (!Number.isFinite(d)) problems.push(`Line ${i + 1}: discount % must be a number.`);
      else line.discountPercent = d;
    } else if (l?.discount !== undefined && l?.discount !== '') {
      const d = gst.parseRupees(l.discount, { allowZero: true });
      if (d == null) problems.push(`Line ${i + 1}: discount must be an amount in rupees.`);
      else line.discountPaise = d;
    }
    if (line.taxType !== 'taxable') line.gstRate = 0;
    return line;
  });
  return { lines, problems };
}

// Everything a draft says, computed. `problems` lists what stops it being
// issued; a draft may be saved with problems.
async function draftFromBody(body, { party: knownParty } = {}) {
  const problems = [];
  let party = knownParty || null;
  if (!party) {
    if (isObjectId(String(body.party || ''))) party = await Party.findById(body.party).lean();
    if (!party) return { fatal: 'Choose the party.' };
  }
  const date = body.date ? istDay(body.date) : istToday();
  if (!date) return { fatal: 'The invoice date must be a date (YYYY-MM-DD).' };
  const placeOfSupply = String(body.placeOfSupply || party.stateCode || '').padStart(2, '0');
  const { lines, problems: lp } = await linesFromBody(body.lines);
  problems.push(...lp);
  const roundOff = body.roundOff !== false;
  const { problems: cp, invoice } = gst.computeInvoice({ lines, placeOfSupply, roundOff });
  problems.push(...cp);
  const paymentMode = body.paymentMode === 'cash' ? 'cash' : 'credit';
  // The site this invoice is for — optional; a site name is needed if any
  // of it is given.
  const sl = body.serviceLocation || {};
  const serviceLocation = { siteName: text(sl.siteName, 150), address: text(sl.address, 400), attention: text(sl.attention, 120) };
  const hasSite = Object.values(serviceLocation).some(Boolean);
  if (hasSite && !serviceLocation.siteName) problems.push('Service location: give the site name.');
  return {
    party, problems,
    doc: {
      party: party._id, date, placeOfSupply, roundOff, paymentMode,
      docType: invoice.docType, supplyType: invoice.supplyType, reverseCharge: invoice.reverseCharge,
      lines: invoice.lines, totals: invoice.totals, taxSummary: invoice.taxSummary,
      serviceLocation: hasSite ? serviceLocation : undefined,
      description: text(body.description, 300), terms: text(body.terms, 2000), notes: text(body.notes, 1000),
      transport: body.transport ? {
        driverName: text(body.transport.driverName, 100), vehicleNumber: text(body.transport.vehicleNumber, 20),
        pickup: text(body.transport.pickup, 200), drop: text(body.transport.drop, 200),
      } : undefined,
    },
  };
}

// What stops an invoice being issued, beyond the maths.
// `numbered`: the issued invoice being edited — its number is kept, so its
// date must stay in its financial year and between its neighbours'.
async function issueProblems(inv, party, now = new Date(), { numbered = null } = {}) {
  const problems = [];
  if (!party) return ['The party no longer exists.'];
  if (party.kind === 'registered') {
    const p = party.gstin ? gst.gstinProblem(party.gstin) : 'This party is registered but has no GSTIN.';
    if (p) problems.push(`Party: ${p}`);
  }
  inv.lines.forEach((l, i) => {
    const p = gst.codeProblem(l.code, l.kind);
    if (p) problems.push(`Line ${i + 1}: ${p}`);
  });
  if (inv.date > now) problems.push('The invoice date cannot be in the future.');
  const fy = gst.financialYear(inv.date);
  const numberedSeries = { docType: inv.docType, fy, status: { $in: ['issued', 'cancelled'] } };
  if (numbered) {
    if (fy !== numbered.fy) problems.push(`${numbered.number} belongs to ${numbered.fy}; its date must stay in that financial year.`);
    const prev = await SalesInvoice.findOne({ ...numberedSeries, seq: { $lt: numbered.seq } }).sort({ seq: -1 }).select('number date').lean();
    const next = await SalesInvoice.findOne({ ...numberedSeries, seq: { $gt: numbered.seq } }).sort({ seq: 1 }).select('number date').lean();
    if (prev && inv.date < prev.date) problems.push(`The date is before ${prev.number} (${fmtDay(prev.date)}). Invoices must be dated in number order.`);
    if (next && inv.date > next.date) problems.push(`The date is after ${next.number} (${fmtDay(next.date)}). Invoices must be dated in number order.`);
    return problems;
  }
  // Numbers run in date order: no invoice dated before the last one issued
  // in its series this year.
  const last = await SalesInvoice.findOne(numberedSeries).sort({ seq: -1 }).select('number date').lean();
  if (last && inv.date < last.date) problems.push(`The date is before ${last.number} (${fmtDay(last.date)}). Invoices must be dated in number order.`);
  return problems;
}

// Whether an edit changes what is owed or the GST: the party, place of
// supply, round-off or any line figure. Text-only fields (description,
// driver, vehicle, site, terms, notes) and the date do not count.
const FINANCIAL_LINE_KEYS = ['item', 'name', 'code', 'kind', 'unit', 'qtyMilli', 'ratePaise', 'discountPercent', 'discountPaise', 'taxType', 'gstRate', 'reverseCharge', 'taxablePaise', 'taxPaise', 'totalPaise'];
function financialChange(before, after) {
  const lineSig = (lines) => JSON.stringify((lines || []).map((l) => FINANCIAL_LINE_KEYS.map((k) => (l[k] == null ? null : String(l[k])))));
  const changed = [];
  if (String(before.party) !== String(after.party)) changed.push('party');
  if (String(before.placeOfSupply) !== String(after.placeOfSupply)) changed.push('place of supply');
  if ((before.roundOff !== false) !== (after.roundOff !== false)) changed.push('round-off');
  if (lineSig(before.lines) !== lineSig(after.lines)) changed.push('line items');
  if ((before.totals?.grandTotalPaise ?? null) !== (after.totals?.grandTotalPaise ?? null) && !changed.length) changed.push('total');
  return changed;
}

exports.calculate = async (req, res, next) => {
  try {
    const d = await draftFromBody(req.body || {});
    if (d.fatal) return bad(res, d.fatal);
    return res.json({ success: true, invoice: { ...d.doc, placeOfSupplyName: gst.stateName(d.doc.placeOfSupply) }, problems: d.problems, amountInWords: gst.amountInWords(Math.max(0, d.doc.totals.grandTotalPaise)) });
  } catch (err) { next(err); }
};

exports.createInvoice = async (req, res, next) => {
  try {
    const d = await draftFromBody(req.body || {});
    if (d.fatal) return bad(res, d.fatal);
    const inv = await SalesInvoice.create({ ...d.doc, status: 'draft', createdBy: req.user._id });
    return res.status(201).json({ success: true, invoice: inv, problems: d.problems });
  } catch (err) { next(err); }
};

exports.updateInvoice = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const cur = await SalesInvoice.findById(req.params.id).lean();
    if (!cur) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    if (cur.status === 'cancelled') return res.status(409).json({ success: false, message: 'A cancelled invoice cannot be edited.' });
    const d = await draftFromBody({ party: cur.party, ...req.body });
    if (d.fatal) return bad(res, d.fatal);
    const rev = Number(req.body?.rev);

    if (cur.status === 'draft') {
      const r = await SalesInvoice.updateOne({ _id: cur._id, status: 'draft', rev }, { $set: d.doc, $inc: { rev: 1 } });
      if (!r.modifiedCount) return res.status(409).json({ success: false, reason: 'stale', message: 'This draft was changed or issued elsewhere. Reload it.' });
      const invoice = await SalesInvoice.findById(cur._id).lean();
      return res.json({ success: true, invoice, problems: d.problems });
    }

    // An issued invoice: everything is recomputed, its number never changes,
    // and it must still be a valid invoice of the same kind.
    if (rev !== cur.rev) return res.status(409).json({ success: false, reason: 'stale', message: 'This invoice changed since you opened it. Reload it, then edit.' });
    if (d.doc.docType !== cur.docType) {
      return bad(res, `This edit would turn ${cur.docType === 'tax_invoice' ? 'the tax invoice into a bill of supply' : 'the bill of supply into a tax invoice'}, which has its own number series. Cancel ${cur.number} and issue a new one instead.`, { reason: 'doc_type_change' });
    }
    const problems = [...d.problems, ...(await issueProblems(d.doc, d.party, new Date(), { numbered: cur }))];
    if (problems.length) return bad(res, problems[0], { reason: 'not_valid', problems });

    const changed = financialChange(cur, d.doc);
    const received = cur.receivedPaise || 0;
    if (received > 0 && changed.length) {
      if (d.doc.totals.grandTotalPaise < received) {
        return bad(res, `₹${(received / 100).toLocaleString('en-IN')} has been received against ${cur.number}; the new total cannot be less than that.`, { reason: 'below_received' });
      }
      if (req.body?.confirmFinancialChange !== true) {
        return res.status(409).json({
          success: false, reason: 'financial_change_needs_confirm', changed,
          message: `Money has been received against ${cur.number}. This edit changes its ${changed.join(', ')}. Save anyway?`,
        });
      }
    }

    // Money already received is never changed by an edit (a cash sale keeps
    // what was recorded at issue); Record money received adds to it.
    const { doc } = d;
    const now = new Date();
    const r = await SalesInvoice.updateOne(
      { _id: cur._id, status: 'issued', rev: cur.rev, number: cur.number },
      {
        $set: {
          ...doc,
          partySnapshot: {
            name: d.party.name, kind: d.party.kind, gstin: d.party.gstin, stateCode: d.party.stateCode,
            stateName: gst.stateName(d.party.stateCode), address: d.party.address, phone: d.party.phone,
          },
        },
        $inc: { rev: 1 },
        $push: { edits: { at: now, by: req.user._id, byName: req.user.name, financial: changed.length > 0, changed, totalBeforePaise: cur.totals?.grandTotalPaise, totalAfterPaise: doc.totals.grandTotalPaise } },
      },
    );
    if (!r.modifiedCount) return res.status(409).json({ success: false, reason: 'stale', message: 'This invoice was changed elsewhere. Reload it.' });
    console.info(`[invoicing] edited ${cur.number} by=${req.user._id} changed=${changed.join('|') || 'text only'} total=${cur.totals?.grandTotalPaise}→${doc.totals.grandTotalPaise}p`);
    const invoice = await SalesInvoice.findById(cur._id).lean();
    return res.json({ success: true, invoice, message: `Saved ${cur.number}.` });
  } catch (err) { next(err); }
};

exports.deleteDraft = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const r = await SalesInvoice.deleteOne({ _id: req.params.id, status: 'draft' });
    if (!r.deletedCount) return res.status(409).json({ success: false, message: 'Only a draft can be deleted. An issued invoice is cancelled instead.' });
    return res.json({ success: true });
  } catch (err) { next(err); }
};

// The counter for a series starts where the settings say (e.g. after the
// last Vyapar number), created outside the transaction like receipts'.
async function ensureCounter(key) {
  const exists = await DocumentCounter.exists({ _id: key });
  if (exists) return;
  const settings = await BillingSettings.findById('default').lean();
  const start = Number(settings?.seriesStart?.[key] ?? settings?.seriesStart?.get?.(key) ?? 1);
  await DocumentCounter.updateOne({ _id: key }, { $setOnInsert: { seq: Math.max(1, start) - 1 } }, { upsert: true })
    .catch((e) => { if (e?.code !== 11000) throw e; });
}

exports.issueInvoice = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const cur = await SalesInvoice.findById(req.params.id).lean();
    if (!cur) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    if (cur.status !== 'draft') return res.status(409).json({ success: false, message: `This invoice is already ${cur.status}${cur.number ? ` (${cur.number})` : ''}.` });
    if (Number(req.body?.rev) !== cur.rev) return res.status(409).json({ success: false, reason: 'stale', message: 'This draft changed since you opened it. Check it again, then issue.' });

    // Recomputed from the stored lines and the party as it is now — the
    // draft's saved figures are never trusted on their own.
    const party = await Party.findById(cur.party).lean();
    const d = await draftFromBody({
      ...cur,
      date: fmtDay(cur.date),
      lines: cur.lines.map((l) => ({ ...l, qty: String(l.qtyMilli / 1000), rate: String(l.ratePaise / 100), discount: l.discountPercent == null && l.discountPaise != null ? String(l.discountPaise / 100) : undefined })),
    }, { party });
    if (d.fatal) return bad(res, d.fatal);
    const problems = [...d.problems, ...(await issueProblems(d.doc, party))];
    if (problems.length) return bad(res, problems[0], { reason: 'not_ready', problems });

    const { doc } = d;
    const fy = gst.financialYear(doc.date);
    const key = `${doc.docType}:${fy}`;
    await ensureCounter(key);

    const now = new Date();
    const session = await mongoose.startSession();
    let issued;
    try {
      await session.withTransaction(async () => {
        const c = await DocumentCounter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, session });
        const number = gst.formatNumber(doc.docType, fy, c.seq);
        const cash = doc.paymentMode === 'cash';
        const r = await SalesInvoice.updateOne({ _id: cur._id, status: 'draft', rev: cur.rev }, {
          $set: {
            ...doc, status: 'issued', fy, seq: c.seq, number, issuedBy: req.user._id, issuedAt: now,
            partySnapshot: {
              name: party.name, kind: party.kind, gstin: party.gstin, stateCode: party.stateCode,
              stateName: gst.stateName(party.stateCode), address: party.address, phone: party.phone,
            },
            // A cash sale is paid when it is made.
            ...(cash ? {
              receivedPaise: doc.totals.grandTotalPaise,
              payments: [{ amountPaise: doc.totals.grandTotalPaise, receivedOn: doc.date, mode: 'cash', note: 'Cash sale', by: req.user._id, byName: req.user.name, recordedAt: now }],
            } : {}),
          },
          $inc: { rev: 1 },
        }, { session });
        // Issued or changed meanwhile: abort, so the number is not used up.
        if (!r.modifiedCount) throw Object.assign(new Error('stale'), { stale: true });
        issued = number;
      });
    } catch (err) {
      if (err?.stale) return res.status(409).json({ success: false, reason: 'stale', message: 'This draft was issued or changed elsewhere. Reload it.' });
      throw err;
    } finally {
      await session.endSession();
    }
    console.info(`[invoicing] issued ${issued} (${doc.docType}) party=${party._id} total=${doc.totals.grandTotalPaise}p by=${req.user._id}`);
    const invoice = await SalesInvoice.findById(cur._id).lean();
    return res.json({ success: true, invoice, message: `Issued ${issued}.` });
  } catch (err) { next(err); }
};

exports.cancelInvoice = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const reason = text(req.body?.reason, 300);
    if (!reason || reason.length < 5) return bad(res, 'Give the reason for cancelling (at least 5 characters).');
    const r = await SalesInvoice.updateOne(
      { _id: req.params.id, status: 'issued', receivedPaise: { $lte: 0 } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: req.user._id, cancelReason: reason }, $inc: { rev: 1 } },
    );
    if (!r.modifiedCount) {
      const cur = await SalesInvoice.findById(req.params.id).select('status receivedPaise').lean();
      if (!cur) return res.status(404).json({ success: false, message: 'Invoice not found.' });
      if (cur.status === 'issued' && cur.receivedPaise > 0) return res.status(409).json({ success: false, message: 'Money has been received against this invoice, so it cannot be cancelled here. (Credit notes come in a later phase.)' });
      return res.status(409).json({ success: false, message: `Only an issued invoice can be cancelled (this one is ${cur.status}).` });
    }
    return res.json({ success: true, message: 'Cancelled. Its number stays used and shows as cancelled.' });
  } catch (err) { next(err); }
};

// Money received against one issued invoice (Phase 1; payment-in across
// several invoices, with TDS, is Phase 2). Never more than is still owed.
const PAY_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'];
exports.recordPayment = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const amountPaise = gst.parseRupees(req.body?.amount);
    if (!amountPaise) return bad(res, 'Enter the amount received in rupees.');
    const receivedOn = istDay(req.body?.receivedOn) || null;
    if (!receivedOn) return bad(res, 'Give the date the money was received.');
    if (receivedOn > new Date()) return bad(res, 'The received date cannot be in the future.');
    const mode = req.body?.mode;
    if (!PAY_MODES.includes(mode)) return bad(res, 'Choose how it was received.');
    const r = await SalesInvoice.updateOne(
      { _id: req.params.id, status: 'issued', $expr: { $lte: [{ $add: ['$receivedPaise', amountPaise] }, '$totals.grandTotalPaise'] } },
      {
        $push: { payments: { amountPaise, receivedOn, mode, reference: text(req.body?.reference, 100), note: text(req.body?.note, 300), by: req.user._id, byName: req.user.name, recordedAt: new Date() } },
        $inc: { receivedPaise: amountPaise, rev: 1 },
      },
    );
    if (!r.modifiedCount) {
      const cur = await SalesInvoice.findById(req.params.id).select('status receivedPaise totals').lean();
      if (!cur) return res.status(404).json({ success: false, message: 'Invoice not found.' });
      if (cur.status !== 'issued') return res.status(409).json({ success: false, message: 'Money can be recorded only against an issued invoice.' });
      const due = cur.totals.grandTotalPaise - cur.receivedPaise;
      return res.status(409).json({ success: false, message: `That is more than the balance due (₹${(due / 100).toLocaleString('en-IN')}).` });
    }
    const invoice = await SalesInvoice.findById(req.params.id).lean();
    return res.json({ success: true, invoice, paymentState: paymentState(invoice) });
  } catch (err) { next(err); }
};

exports.listInvoices = async (req, res, next) => {
  try {
    const filter = {};
    if (['draft', 'issued', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
    if (isObjectId(String(req.query.party || ''))) filter.party = req.query.party;
    const from = istDay(req.query.from); const to = istDay(req.query.to);
    if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    let list = await SalesInvoice.find(filter).sort({ date: -1, seq: -1, createdAt: -1 }).limit(500)
      .select('status docType number date party partySnapshot serviceLocation totals receivedPaise paymentMode description createdAt')
      .populate('party', 'name').lean();
    list = list.map((i) => ({ ...i, partyName: i.partySnapshot?.name || i.party?.name, paymentState: i.status === 'issued' ? paymentState(i) : null, balancePaise: i.status === 'issued' ? i.totals.grandTotalPaise - (i.receivedPaise || 0) : null }));
    if (['unpaid', 'partial', 'paid'].includes(req.query.payment)) list = list.filter((i) => i.paymentState === req.query.payment);
    return res.json({ success: true, invoices: list });
  } catch (err) { next(err); }
};

exports.getInvoice = async (req, res, next) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const inv = await SalesInvoice.findById(req.params.id).populate('party').lean();
    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    const settings = await BillingSettings.findById('default').lean();
    // A draft shows the party as it is now; an issued invoice as it was.
    const party = inv.status === 'draft' ? { ...inv.party, stateName: gst.stateName(inv.party?.stateCode) } : inv.partySnapshot;
    let problems = [];
    if (inv.status === 'draft') {
      const { problems: cp } = gst.computeInvoice({ lines: inv.lines, placeOfSupply: inv.placeOfSupply, roundOff: inv.roundOff });
      problems = [...cp, ...(await issueProblems(inv, inv.party))];
    }
    return res.json({
      success: true,
      invoice: { ...inv, party: inv.party?._id, paymentState: inv.status === 'issued' ? paymentState(inv) : null, balancePaise: inv.totals.grandTotalPaise - (inv.receivedPaise || 0) },
      problems,
      print: {
        title: inv.docType === 'bill_of_supply' ? 'Bill of Supply' : 'Tax Invoice',
        issuer: { ...CUSTOMER_ISSUER, stateCode: gst.SUPPLIER_STATE, stateName: gst.stateName(gst.SUPPLIER_STATE) },
        party,
        placeOfSupplyName: gst.stateName(inv.placeOfSupply),
        amountInWords: gst.amountInWords(Math.max(0, inv.totals.grandTotalPaise)),
        bank: settings?.bank, upiId: settings?.upiId, signatory: settings?.signatory || CUSTOMER_ISSUER.name,
        // This invoice's own terms, else the owner's (Settings), else the standard ones.
        terms: inv.terms || settings?.terms || DEFAULT_TERMS,
      },
    });
  } catch (err) { next(err); }
};

// ════════════════════════════════════════════════════════════
// Settings
// ════════════════════════════════════════════════════════════
exports.getSettings = async (req, res, next) => {
  try {
    const settings = (await BillingSettings.findById('default').lean()) || { _id: 'default' };
    const fy = gst.financialYear(new Date());
    const series = await Promise.all(gst.DOC_TYPES.map(async (docType) => {
      const key = `${docType}:${fy}`;
      const c = await DocumentCounter.findById(key).lean();
      const start = settings.seriesStart?.[key];
      const next = c ? c.seq + 1 : Number(start || 1);
      return { docType, fy, key, started: !!c, next, nextNumber: gst.formatNumber(docType, fy, next) };
    }));
    // Terms as printed: the owner's when saved, else the standard ones.
    return res.json({ success: true, settings: { ...settings, terms: settings.terms || DEFAULT_TERMS }, defaultTerms: DEFAULT_TERMS, series, states: Object.entries(gst.STATES).map(([code, name]) => ({ code: String(code).padStart(2, '0'), name })), supplierState: gst.SUPPLIER_STATE, issuer: CUSTOMER_ISSUER });
  } catch (err) { next(err); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const b = req.body || {};
    const set = { updatedBy: req.user._id };
    if (b.bank) {
      const ifsc = text(b.bank.ifsc, 11)?.toUpperCase();
      if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return bad(res, 'An IFSC is 11 characters, e.g. HDFC0004251.');
      set.bank = { name: text(b.bank.name, 100), accountNo: text(b.bank.accountNo, 30), ifsc, holder: text(b.bank.holder, 100) };
    }
    if ('upiId' in b) {
      const u = text(b.upiId, 60);
      if (u && !/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(u)) return bad(res, 'A UPI ID looks like name@bank.');
      set.upiId = u;
    }
    // Blank terms = back to the standard terms (DEFAULT_TERMS).
    const unset = {};
    if ('terms' in b) { const tm = text(b.terms, 2000); if (tm) set.terms = tm; else unset.terms = ''; }
    if ('signatory' in b) set.signatory = text(b.signatory, 100);
    await BillingSettings.updateOne({ _id: 'default' }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
    return res.json({ success: true });
  } catch (err) { next(err); }
};

// Where a series starts this year — e.g. the number after Vyapar's last.
// Only before the series has used a number, so no number is ever reused.
exports.setSeriesStart = async (req, res, next) => {
  try {
    const { docType, fy } = req.body || {};
    const start = Number(req.body?.next);
    if (!gst.DOC_TYPES.includes(docType)) return bad(res, 'Unknown series.');
    if (!/^\d{4}-\d{2}$/.test(String(fy || ''))) return bad(res, 'Financial year looks like 2026-27.');
    if (!Number.isInteger(start) || start < 1 || start > 99999) return bad(res, 'The next number must be a whole number from 1.');
    const key = `${docType}:${fy}`;
    if (await DocumentCounter.exists({ _id: key })) {
      return res.status(409).json({ success: false, message: `${gst.formatNumber(docType, fy, 1).replace(/1$/, '…')} has already started numbering in the CRM; its next number can no longer be changed.` });
    }
    await BillingSettings.updateOne({ _id: 'default' }, { $set: { [`seriesStart.${key}`]: start, updatedBy: req.user._id } }, { upsert: true });
    return res.json({ success: true, nextNumber: gst.formatNumber(docType, fy, start) });
  } catch (err) { next(err); }
};

// ════════════════════════════════════════════════════════════
// Continue the tax-invoice series from a number (Settings, owner only)
// ════════════════════════════════════════════════════════════
// For when the CRM started numbering at 1 but Vyapar had already used the
// first numbers of the year: the CRM's own numbers below the one entered
// duplicate Vyapar's, so those test invoices are deleted (never sent or
// filed) and the series continues from the number entered.
//
// Safety (as in the one-off fix script): refused if ANY tax invoice in the
// CRM has money received — so nothing with a payment is ever touched and
// it cannot run once real invoices are being paid; refused if any number at
// or above the one entered has been used (it would be reused or out of
// order); the owner types DELETE; the checks run again inside the one
// transaction that deletes and moves the counter. Bills of supply and
// drafts are never touched.
const RESTART_WORD = 'DELETE';
const isPaid = (i) => (i.receivedPaise || 0) > 0 || (i.payments || []).length > 0;

// allTax: every tax invoice in the CRM (any year, any status);
// numbered: this year's numbered ones; counterSeq: the last number used.
function restartPlan({ allTax, numbered, counterSeq, next, fy }) {
  const problems = [];
  if (!Number.isInteger(next) || next < 1 || next > 99999) problems.push('The next number must be a whole number from 1.');
  const paid = allTax.filter(isPaid);
  if (paid.length) problems.push(`Money has been received against ${paid.map((i) => i.number || 'a draft').join(', ')}. Nothing is changed while any tax invoice has a payment.`);
  const atOrAbove = numbered.filter((i) => i.seq >= next);
  if (atOrAbove.length) problems.push(`${atOrAbove.map((i) => i.number).join(', ')} already use${atOrAbove.length === 1 ? 's' : ''} a number at or above ${next}.`);
  if (counterSeq != null && counterSeq >= next && !atOrAbove.length) problems.push(`Numbers up to ${gst.formatNumber('tax_invoice', fy, counterSeq)} have already been given out; continuing from ${next} would reuse one.`);
  const toDelete = numbered.filter((i) => i.seq < next);
  if (!problems.length && !toDelete.length && counterSeq === next - 1) problems.push(`The series already continues from ${gst.formatNumber('tax_invoice', fy, next)}.`);
  return { problems, toDelete };
}

async function loadRestartState(fy, session = null) {
  const opts = session ? { session } : {};
  const [allTax, counter] = await Promise.all([
    SalesInvoice.find({ docType: 'tax_invoice' }, 'number status seq fy receivedPaise payments partySnapshot totals date', opts).lean(),
    DocumentCounter.findById(`tax_invoice:${fy}`, null, opts).lean(),
  ]);
  const numbered = allTax.filter((i) => i.fy === fy && i.number).sort((a, b) => a.seq - b.seq);
  return { allTax, numbered, counterSeq: counter ? counter.seq : null };
}

const restartView = (i) => ({
  number: i.number, status: i.status, date: i.date, party: i.partySnapshot?.name,
  totalPaise: i.totals?.grandTotalPaise || 0, receivedPaise: i.receivedPaise || 0,
});

// GET /settings/series/restart?next=58 — what it would do; changes nothing.
exports.previewRestartTaxSeries = async (req, res, next) => {
  try {
    const fy = gst.financialYear(new Date());
    const state = await loadRestartState(fy);
    const n = req.query.next != null && req.query.next !== '' ? Number(req.query.next) : null;
    const plan = n == null ? null : restartPlan({ ...state, next: n, fy });
    return res.json({
      success: true, fy, confirmWord: RESTART_WORD,
      counterSeq: state.counterSeq,
      nextNumber: gst.formatNumber('tax_invoice', fy, (state.counterSeq ?? 0) + 1),
      invoices: state.numbered.map(restartView),
      paid: state.allTax.filter(isPaid).map((i) => i.number || 'draft'),
      ...(plan ? { plan: { next: n, nextNumber: gst.formatNumber('tax_invoice', fy, n), willDelete: plan.toDelete.map(restartView), problems: plan.problems } } : {}),
    });
  } catch (err) { next(err); }
};

// POST /settings/series/restart { next, confirm: 'DELETE' }
exports.restartTaxSeries = async (req, res, next) => {
  try {
    const fy = gst.financialYear(new Date());
    const n = Number(req.body?.next);
    if (String(req.body?.confirm || '').trim() !== RESTART_WORD) return bad(res, `Type ${RESTART_WORD} to confirm.`, { reason: 'not_confirmed' });
    const key = `tax_invoice:${fy}`;
    let result;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const state = await loadRestartState(fy, session);
        const plan = restartPlan({ ...state, next: n, fy });
        if (plan.problems.length) throw Object.assign(new Error(plan.problems[0]), { refused: plan.problems });
        const ids = plan.toDelete.map((i) => i._id);
        if (ids.length) {
          const del = await SalesInvoice.deleteMany({ _id: { $in: ids }, docType: 'tax_invoice', fy, receivedPaise: { $not: { $gt: 0 } }, 'payments.0': { $exists: false } }, { session });
          if (del.deletedCount !== ids.length) throw Object.assign(new Error('An invoice changed meanwhile. Nothing was changed; try again.'), { refused: ['changed'] });
        }
        await DocumentCounter.updateOne({ _id: key }, { $set: { seq: n - 1 } }, { upsert: true, session });
        const deleted = plan.toDelete.map((i) => i.number);
        await BillingSettings.updateOne({ _id: 'default' }, {
          $push: { seriesRestarts: { at: new Date(), by: req.user._id, byName: req.user.name, fy, next: n, deleted, counterBefore: state.counterSeq } },
        }, { upsert: true, session });
        result = { deleted, counterBefore: state.counterSeq };
      });
    } catch (err) {
      if (err?.refused) return res.status(409).json({ success: false, reason: 'refused', message: err.message, problems: err.refused });
      throw err;
    } finally {
      await session.endSession();
    }
    const nextNumber = gst.formatNumber('tax_invoice', fy, n);
    console.warn(`[invoicing] tax-invoice series ${fy} continued from ${nextNumber} by=${req.user._id}; deleted unpaid CRM invoices: ${result.deleted.join(', ') || 'none'}; counter ${result.counterBefore ?? '-'}→${n - 1}`);
    return res.json({ success: true, deleted: result.deleted, nextNumber, message: `Done. ${result.deleted.length ? `Deleted ${result.deleted.join(', ')}. ` : ''}The next tax invoice will be ${nextNumber}.` });
  } catch (err) { next(err); }
};

exports._internals = { istDay, fmtDay, paymentState, draftFromBody, issueProblems, financialChange, restartPlan };
