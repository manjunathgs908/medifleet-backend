'use strict';
/**
 * services/aiCaller/styleExamples.js
 * ============================================================
 * AI TELECALLER — the real SaveLife calls (models/CallStyleExample) that go
 * into the assistant's instructions as style examples
 * (prompt.styleBlock). At most AI_STYLE_EXAMPLES_MAX (default 3) active
 * examples, each cut to MAX_CHARS_PER_EXAMPLE, phone numbers always masked.
 * Never blocks a call: if they cannot be loaded, the call starts without.
 * ============================================================
 */
const CallStyleExample = require('../../models/CallStyleExample');
const { maskNumbersInText } = require('../../utils/maskNumbersInText');

const MAX_CHARS_PER_EXAMPLE = 1500;

const maxExamples = () => {
  const n = Number(process.env.AI_STYLE_EXAMPLES_MAX);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 3;
};

// One example, ready for the prompt: masked, cut to size at a turn boundary.
function forPrompt(ex) {
  const transcript = [];
  let chars = 0;
  for (const t of ex.transcript || []) {
    const text = maskNumbersInText(String(t.text || '').replace(/\s+/g, ' ').trim(), { always: true });
    if (!text) continue;
    if (chars + text.length > MAX_CHARS_PER_EXAMPLE) break;
    transcript.push({ role: t.role, text });
    chars += text.length;
  }
  return { title: ex.title || '', transcript };
}

async function loadForPrompt() {
  const max = maxExamples();
  if (!max) return [];
  try {
    const rows = await CallStyleExample.find({ active: true }).sort({ order: 1, updatedAt: -1 }).limit(max).lean();
    return rows.map(forPrompt).filter((ex) => ex.transcript.length);
  } catch (err) {
    console.error('[aiCaller] style examples not loaded:', err.message);
    return [];
  }
}

module.exports = { loadForPrompt, forPrompt, maxExamples, MAX_CHARS_PER_EXAMPLE };
