'use strict';

// ============================================================
// utils/phoneLegVerdict.js
// ============================================================
// Plain-words reading of Plivo's report on an incoming call's phone <Dial>
// (CallLog.phoneLeg) together with the overlap check made when it was
// dialled (CallLog.overlap) — so the CRM can say "it never rang: the
// carrier or handset said busy" instead of a bare USER_BUSY.
//
// DialRingStatus is Plivo's "did the far end ever ring" flag. Busy with no
// ring and nothing else of ours on that number means the refusal came from
// the network or the handset itself: call forwarding ("forward when busy"
// left on from the old night forwarding), DND/call barring, or the phone
// already on a call.
// ============================================================

const BUSY_CAUSES = ['USER_BUSY', 'CALL_REJECTED', 'busy'];

function phoneLegVerdict(phoneLeg, overlap) {
  if (!phoneLeg) return null;
  const status = String(phoneLeg.DialStatus || '').toLowerCase();
  const ring   = String(phoneLeg.DialRingStatus ?? '').toLowerCase();
  const rang   = ring === 'true' ? true : ring === 'false' ? false : null;
  const cause  = phoneLeg.DialHangupCause || phoneLeg.DialBLegHangupCause || null;
  const busy   = status === 'busy' || BUSY_CAUSES.includes(cause);
  const ours   = (overlap?.ourCalls?.length || 0) + (overlap?.liveLegs?.length || 0);

  const out = (code, text, advice) => ({ code, rang, cause, overlapping: ours, text, ...(advice ? { advice } : {}) });

  if (status === 'completed') return out('answered', 'The phone rang and was answered.');
  if (busy && rang === true) {
    return out('rang_then_busy', `The phone rang, then the call was declined (${cause || 'busy'}) — rejected on the handset, or it took another call.`);
  }
  if (busy && rang === false) {
    if (ours) {
      return out('busy_overlap', `Busy before ringing (${cause || 'busy'}) — ${ours} other call leg(s) of ours were already on this number when it was dialled.`);
    }
    return out('busy_no_ring',
      `Busy before it ever rang (${cause || 'busy'}), and no other call of ours was on this number — the busy came from the carrier or the handset, not from SaveLife or Plivo.`,
      'Check call forwarding on that SIM (left on from the old night forwarding? dial ##002# from it to cancel all forwarding), DND or call barring, and whether the phone was on another call. Or set your ring number to the telecaller\'s actual idle phone.');
  }
  if (rang === true) return out('rang_no_answer', `The phone rang but nobody answered (${cause || status || 'no answer'}).`);
  if (rang === false) return out('not_reached', `The phone never rang (${cause || status || 'unknown'}).`);
  return out('unknown', `Plivo reported ${status || 'no status'}${cause ? ` (${cause})` : ''}.`);
}

module.exports = { phoneLegVerdict };
