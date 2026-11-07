'use strict';
/**
 * controllers/aiStyleController.js
 * ============================================================
 * AI TELECALLER — the real SaveLife calls it copies the talking style of
 * (models/CallStyleExample, services/aiCaller/styleExamples.js). Owner only.
 *
 *   GET    /api/ai-caller/style-examples       all examples
 *   POST   /api/ai-caller/style-examples       { callLogId } copies that call's
 *                                              transcript, or { transcript }
 *   PUT    /api/ai-caller/style-examples/:id   title / active / order / notes / transcript
 *   DELETE /api/ai-caller/style-examples/:id
 *   GET    /api/ai-caller/style-candidates     recent captured calls with a
 *                                              transcript (live call capture)
 *   GET    /api/ai-caller/prompt-preview       the instructions a call made
 *                                              now would get
 * ============================================================
 */
const mongoose = require('mongoose');
const CallStyleExample = require('../models/CallStyleExample');
const CallLog = require('../models/CallLog');
const prompt = require('../services/aiCaller/prompt');
const styleExamples = require('../services/aiCaller/styleExamples');

const MAX_TURNS = 60;
const CANDIDATE_DAYS = 60;
const isId = (v) => mongoose.isValidObjectId(String(v));
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// A transcript from the CRM: turns of { role: operator|customer, text }.
function cleanTranscript(raw) {
  if (!Array.isArray(raw)) return null;
  const turns = raw.slice(0, MAX_TURNS)
    .map((t) => ({ role: t?.role, text: clean(t?.text, 1000) }))
    .filter((t) => ['operator', 'customer'].includes(t.role) && t.text);
  return turns.length ? turns : null;
}

exports.list = async (req, res, next) => {
  try {
    const examples = await CallStyleExample.find({}).sort({ order: 1, updatedAt: -1 }).lean();
    return res.json({ success: true, examples, maxInPrompt: styleExamples.maxExamples() });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    let transcript;
    let source;
    if (req.body?.callLogId) {
      if (!isId(req.body.callLogId)) return res.status(400).json({ success: false, message: 'Invalid call id.' });
      const log = await CallLog.findById(req.body.callLogId).select('transcript');
      if (!log) return res.status(404).json({ success: false, message: 'Call not found.' });
      transcript = cleanTranscript((log.transcript || []).map((t) => ({ role: t.role, text: t.text })));
      source = { callLog: log._id };
    } else {
      transcript = cleanTranscript(req.body?.transcript);
    }
    if (!transcript) return res.status(400).json({ success: false, message: 'A transcript with at least one operator or customer line is needed.' });
    const example = await CallStyleExample.create({
      title   : clean(req.body?.title, 120),
      language: clean(req.body?.language, 20),
      notes   : clean(req.body?.notes, 500),
      transcript,
      ...(source ? { source } : {}),
      createdBy: req.user?._id,
    });
    return res.status(201).json({ success: true, example });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
    const $set = {};
    if ('title' in req.body) $set.title = clean(req.body.title, 120);
    if ('language' in req.body) $set.language = clean(req.body.language, 20);
    if ('notes' in req.body) $set.notes = clean(req.body.notes, 500);
    if ('active' in req.body) $set.active = req.body.active === true;
    if ('order' in req.body && Number.isFinite(Number(req.body.order))) $set.order = Number(req.body.order);
    if ('transcript' in req.body) {
      const t = cleanTranscript(req.body.transcript);
      if (!t) return res.status(400).json({ success: false, message: 'A transcript with at least one operator or customer line is needed.' });
      $set.transcript = t;
    }
    const example = await CallStyleExample.findByIdAndUpdate(req.params.id, { $set }, { new: true });
    if (!example) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, example });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
    const r = await CallStyleExample.deleteOne({ _id: req.params.id });
    if (!r?.deletedCount) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true });
  } catch (err) { next(err); }
};

exports.candidates = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - CANDIDATE_DAYS * 24 * 60 * 60 * 1000);
    const [logs, used] = await Promise.all([
      CallLog.find({ 'transcript.0': { $exists: true }, createdAt: { $gte: since } })
        .select('transcript summary agentName createdAt talkSec')
        .sort({ createdAt: -1 }).limit(30),
      CallStyleExample.find({ 'source.callLog': { $exists: true } }).select('source.callLog').lean(),
    ]);
    const usedIds = new Set(used.map((e) => String(e.source.callLog)));
    const calls = logs.map((l) => {
      const j = l.toJSON();
      return {
        _id: j._id, createdAt: j.createdAt, agentName: j.agentName, talkSec: j.talkSec,
        summary: j.summary || '', turns: (j.transcript || []).length,
        transcript: j.transcript || [], used: usedIds.has(String(j._id)),
      };
    });
    return res.json({ success: true, calls });
  } catch (err) { next(err); }
};

exports.promptPreview = async (req, res, next) => {
  try {
    const examples = await styleExamples.loadForPrompt();
    return res.json({ success: true, instructions: prompt.buildInstructions({ now: new Date(), examples }), styleExamples: examples.length });
  } catch (err) { next(err); }
};
