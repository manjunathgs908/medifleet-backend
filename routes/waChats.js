'use strict';
/**
 * routes/waChats.js — /api/whatsapp-chats
 * ============================================================
 * Team inbox on the one SaveLife WhatsApp number (services/waIntro.js).
 * A chat is addressed by its opaque customerRef — never a number.
 *
 *   GET   /:ref            the chat's assignee, introduction and window
 *   PATCH /:ref/assign     { userId | null, rev }
 *                            owner: assign / reassign to any active CRM
 *                                   staff member, or unassign
 *                            telecaller: "Assign to me" on an UNASSIGNED
 *                                   chat only (claim); nothing else
 *                          Guarded by rev like leads: a change from an
 *                          out-of-date view gets 409 with the current state.
 *   POST  /:ref/intro      the assignee's one introduction card (24 h window)
 *   POST  /:ref/handover   the new assignee's handover message (24 h window)
 * Owner + telecallers (OPERATIONS). Manual assignment + claim only — no
 * automatic routing.
 * ============================================================
 */
const express = require('express');
const mongoose = require('mongoose');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');
const { User } = require('../models');
const WhatsAppConversation = require('../models/WhatsAppConversation');
const StaffProfile = require('../models/StaffProfile');
const { phoneFromRef, maskPhone, customerRef } = require('../utils/customerPhone');
const { normalisePhone } = require('../utils/phone');
const intro = require('../services/waIntro');

const router = express.Router();
router.use(protect, authorize(...OPERATIONS));

const isObjectId = (v) => mongoose.isValidObjectId(String(v)) && /^[a-f0-9]{24}$/i.test(String(v));
const revFilter = (rev) => (rev === 0 ? { $or: [{ rev: 0 }, { rev: { $exists: false } }] } : { rev });

function phoneOf(req) {
  const ten = normalisePhone(phoneFromRef(String(req.params.ref || '')) || '');
  return ten.length === 10 ? ten : null;
}

// The chat as `user` sees it — no number, ever.
async function chatState(phone10, user) {
  const [conv, profile, win] = await Promise.all([
    WhatsAppConversation.findOne({ phone: phone10 }).lean(),
    StaffProfile.findOne({ user: user._id }).lean(),
    intro.windowOf(phone10),
  ]);
  const actions = intro.actionsFor(conv, user, profile, win);
  return {
    customerRef: customerRef(phone10),
    phoneMasked: maskPhone(phone10),
    assignee: conv?.assignedTo ? { _id: conv.assignedTo, name: conv.assignedToName } : null,
    assignedAt: conv?.assignedAt || null,
    rev: conv?.rev || 0,
    intro: conv?.intro?.at ? { sent: true, at: conv.intro.at, byName: conv.intro.byName } : { sent: false },
    window: win,
    actions,
    canAssign: user.role === 'owner',
    canClaim: !conv?.assignedTo,
  };
}

router.get('/:ref', async (req, res, next) => {
  try {
    const phone10 = phoneOf(req);
    if (!phone10) return res.status(404).json({ success: false, message: 'Chat not found.' });
    return res.json({ success: true, chat: await chatState(phone10, req.user) });
  } catch (err) { next(err); }
});

router.patch('/:ref/assign', async (req, res, next) => {
  try {
    const phone10 = phoneOf(req);
    if (!phone10) return res.status(404).json({ success: false, message: 'Chat not found.' });
    const rev = Number(req.body?.rev);
    if (!Number.isInteger(rev) || rev < 0) return res.status(400).json({ success: false, message: 'Reload WhatsApp Chats and try again.' });
    const { userId } = req.body || {};
    const isOwner = req.user.role === 'owner';

    const conflict = async () => res.status(409).json({
      success: false,
      message: 'Someone changed this chat\'s assignment just now — check it, then try again.',
      chat: await chatState(phone10, req.user),
    });
    const conv = await WhatsAppConversation.findOne({ phone: phone10 }).lean();
    if ((conv?.rev || 0) !== rev) return conflict();

    let set; let unset = {}; let event;
    if (userId === null || userId === '') {
      if (!isOwner) return res.status(403).json({ success: false, message: 'Only the owner can unassign a chat.' });
      if (!conv?.assignedTo) return res.status(400).json({ success: false, message: 'This chat is not assigned to anyone.' });
      set = {};
      unset = { assignedTo: 1, assignedToName: 1, assignedAt: 1, handoverFrom: 1 };
      event = { type: 'unassigned', from: conv.assignedToName };
    } else {
      if (!isObjectId(userId)) return res.status(400).json({ success: false, message: 'Pick a staff member.' });
      if (!isOwner) {
        // A telecaller may only claim an unassigned chat for themselves.
        if (String(userId) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Only the owner can assign a chat to someone else.' });
        if (conv?.assignedTo) return res.status(409).json({ success: false, message: `${conv.assignedToName || 'Someone'} already has this chat.`, chat: await chatState(phone10, req.user) });
      }
      const to = await User.findOne({ _id: String(userId), role: { $in: OPERATIONS }, isActive: true }).select('name').lean();
      if (!to) return res.status(400).json({ success: false, message: 'That person cannot take chats (not an active CRM staff member).' });
      if (String(conv?.assignedTo || '') === String(to._id)) return res.status(400).json({ success: false, message: `Already assigned to ${to.name}.` });
      const now = new Date();
      set = { assignedTo: to._id, assignedToName: to.name, assignedAt: now };
      // From one person to another: the new one may send a handover message.
      if (conv?.assignedTo) set.handoverFrom = { user: conv.assignedTo, name: conv.assignedToName, at: now };
      else unset = { handoverFrom: 1 };
      event = { type: isOwner ? 'assigned' : 'claimed', from: conv?.assignedToName, to: to.name };
    }

    try {
      const updated = await WhatsAppConversation.findOneAndUpdate(
        { phone: phone10, ...revFilter(rev) },
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
          $inc: { rev: 1 },
          $push: { history: { ...event, at: new Date(), by: req.user._id, byName: req.user.name } },
        },
        { new: true, upsert: !conv, setDefaultsOnInsert: true },
      );
      if (!updated) return conflict();
    } catch (err) {
      if (err?.code === 11000) return conflict(); // two first claims at once: one wins
      throw err;
    }
    return res.json({ success: true, chat: await chatState(phone10, req.user) });
  } catch (err) { next(err); }
});

const action = (fn) => async (req, res, next) => {
  try {
    const phone10 = phoneOf(req);
    if (!phone10) return res.status(404).json({ success: false, message: 'Chat not found.' });
    const r = await fn(phone10, req.user);
    const chat = await chatState(phone10, req.user);
    if (!r.ok) return res.status(r.status).json({ success: false, code: r.code, message: r.message, chat });
    return res.json({ success: true, chat });
  } catch (err) { next(err); }
};
router.post('/:ref/intro', action((p, u) => intro.sendIntro(p, u)));
router.post('/:ref/handover', action((p, u) => intro.sendHandover(p, u)));

module.exports = router;
module.exports._internals = { chatState };
