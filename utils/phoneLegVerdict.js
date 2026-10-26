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

  // Seconds from our phone Dial to Plivo's result: a busy within a few
  // seconds of ringing was refused automatically, not by a person.
  const dialAt = overlap?.dialAt ? new Date(overlap.dialAt).getTime() : NaN;
  const doneAt = phoneLeg.receivedAt ? new Date(phoneLeg.receivedAt).getTime() : NaN;
  const afterSec = Number.isFinite(dialAt) && Number.isFinite(doneAt) && doneAt >= dialAt ? Math.round((doneAt - dialAt) / 1000) : null;

  const out = (code, text, advice) => ({ code, rang, cause, overlapping: ours, afterSec, text, ...(advice ? { advice } : {}) });

  if (status === 'completed') return out('answered', 'The phone rang and was answered.');
  if (busy && rang === true) {
    if (afterSec != null && afterSec <= 6) {
      return out('rang_then_auto_busy',
        `The network reported ringing, then ${cause || 'busy'} only ${afterSec}s after dialling — too fast for a person. The phone or carrier refused it automatically.`,
        'On that phone, check: spam/unknown-caller blocking (phone settings, Truecaller, Airtel/Jio spam filter) and whether 080 6559 1088 is blocked; "reject calls" or a call-blocking app; DND mode set to reject; dual-SIM with the other SIM busy; call forwarding (dial ##002#). Save +91 80655 91088 as a contact named SaveLife.');
    }
    return out('rang_then_busy', `The phone rang${afterSec != null ? ` for about ${afterSec}s` : ''}, then the call was declined (${cause || 'busy'}) — rejected on the handset, or it took another call.`,
      'If nobody pressed reject: check spam/unknown-caller blocking and call-blocking apps on that phone, and whether 080 6559 1088 is blocked.');
  }
  if (busy && rang === false) {
    if (ours) {
      return out('busy_overlap', `Busy before ringing (${cause || 'busy'}) — ${ours} other call leg(s) of ours were already on this number when it was dialled.`);
    }
    // Calls from before the overlap check existed: can't rule our own legs out.
    if (!overlap) {
      return out('busy_no_ring_unchecked', `Busy before it ever rang (${cause || 'busy'}). This call predates the overlap check, so an overlapping leg of ours can't be ruled out.`);
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
