'use strict';
// GST invoicing (Phase 1) — owner only, like the rest of billing.
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/invoicingController');
const { protect, authorize } = require('../middleware/auth');

const owner = [protect, authorize('owner')];

router.get ('/settings',        ...owner, ctrl.getSettings);
router.put ('/settings',        ...owner, ctrl.updateSettings);
// Where a series starts this year (e.g. after Vyapar's last number) —
// only before it has used a number.
router.put ('/settings/series', ...owner, ctrl.setSeriesStart);

router.get ('/parties',         ...owner, ctrl.listParties);
router.post('/parties',         ...owner, ctrl.createParty);
router.put ('/parties/:id',     ...owner, ctrl.updateParty);

router.get ('/items',           ...owner, ctrl.listItems);
router.post('/items',           ...owner, ctrl.createItem);
router.put ('/items/:id',       ...owner, ctrl.updateItem);

// Preview: the GST worked out for what is on screen; saves nothing.
router.post('/invoices/calculate', ...owner, ctrl.calculate);
router.get ('/invoices',        ...owner, ctrl.listInvoices);
router.post('/invoices',        ...owner, ctrl.createInvoice);
router.get ('/invoices/:id',    ...owner, ctrl.getInvoice);
router.put ('/invoices/:id',    ...owner, ctrl.updateInvoice);      // drafts only
router.delete('/invoices/:id',  ...owner, ctrl.deleteDraft);        // drafts only
router.post('/invoices/:id/issue',    ...owner, ctrl.issueInvoice);
router.post('/invoices/:id/cancel',   ...owner, ctrl.cancelInvoice);
router.post('/invoices/:id/payments', ...owner, ctrl.recordPayment);

module.exports = router;
