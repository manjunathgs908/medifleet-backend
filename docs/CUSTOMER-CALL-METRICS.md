# Customer call metrics

What every call number on the customer overview and the Call Logs views means.

- **Code:**
  - `services/callStats.js`: the canonical call, built with MongoDB aggregation.
  - `services/customerOverview.js`: the overview, plus the same merge in JavaScript for its call list.
  - `controllers/callHistoryController.js`: the "All call events" and "By customer" views.
- **Tests:**
  - On a real MongoDB: `tests/canonicalCalls.mongo.test.js`, `tests/performance.mongo.test.js`, `tests/callStats.mongo.test.js` and `tests/callHistory.mongo.test.js`.
  - Mocked: `tests/customerOverview.test.js` and `tests/callHistoryRoutes.test.js`.

## What is counted

| Term | Definition |
|---|---|
| **Call record** | One `CallLog` document. "All call events" lists call records. A call's legs (agent, customer, in-app and ring-phone legs), its transfers and its recordings are all stored on one record. |
| **Call** (logical call) | All the records **reliably linked** to one call. That means records with the same Plivo CallUUID (`providerCallId`), for example a hang-up webhook that was delivered twice and logged the same call twice. A record with no CallUUID is a call on its own. Records are never linked by number, name or time. Every count below is a count of calls. |
| Excluded | Test rings (`context: test_ring`). |
| **Not a call** | Outcomes typed by staff: WhatsApp Chats "Booked / Follow up / No answer" (`WhatsAppCallLog`), callback task resolutions and lead notes. They describe a call and appear on the timeline, but they are never counted as another call. |

## The canonical call: one rule for every view

Each call is first rebuilt from all its linked records, before any filter applies:

| Field | Rule |
|---|---|
| **Time** | The earliest record's `startedAt` (or `createdAt` if missing). This decides the call's day and period. |
| **Number** | The number on the earliest record that has one. |
| **Staff** | Everyone who handled any of its records: the agent who placed or answered it (`agentUser`), plus anyone who took it as a transfer (`transfers.answeredBy`). |
| **Kind** | Driver if any record is a masked trip call. Otherwise incoming (inbound) or outgoing (outbound), taken from the earliest record. |
| **Outcome** | The strongest outcome any record shows (see "Duplicates of one call"). |
| **Staff name shown** | The agent on a connected record, otherwise the latest named record. |

The filters then include or exclude **whole calls** by these values:

- the period or custom dates, by the call's time;
- staff, matched against anyone who handled the call;
- direction, by the call's kind;
- outcome, by the call's outcome;
- customer and search, by the call's number.

**No filter can change a call's outcome, time or number.**

These all use this rule, and for the same scope and period they agree to the call:
- the Customer Overview (counts, call list, "Last attempt", "Last spoke");
- "By customer";
- the totals of "All call events";
- the **Telecaller performance** panel (`GET /api/calls/performance`).

### Which records "All call events" lists

It lists a call's records that fall inside the chosen dates and are on the searched number, for every call that is included.

**Example:** a call has a "missed" record at 23:59:58 on the 18th and a "completed" record at 00:00:03 on the 19th.

- It is **one answered call on the 18th**.
- Choosing the 18th lists the 23:59:58 record, marked "Record of a call Plivo reported 2 times — counted once, as Answered".
- Choosing the 19th shows neither the call nor that record: the call started on the 18th.
- Choosing 18th–19th lists both records, counted as one call.

## Period

By the call's time, in **India time (IST, UTC+05:30)**:

| Period | From |
|---|---|
| Today | 00:00 IST today |
| 7 days | 00:00 IST six days ago (today and the 6 days before) |
| 30 days | 00:00 IST 29 days ago (today and the 29 days before) |
| All time | No lower bound: **every** call on record, with no row cap |

Custom dates in Call Logs (`from` and `to`, as `YYYY-MM-DD`) are whole India days, both inclusive. A call starting exactly at 00:00:00.000 IST belongs to that day.

## Evidence for "answered" and "connected" (unchanged)

"Answered" (incoming) and "connected" (outgoing, or driver ↔ customer) mean status **`completed`**. The calling code writes `completed` only from Plivo's own report that the call connected:

- **Incoming:** Plivo's Dial result says staff picked up, in the app or on a ring phone, while the caller was on the line. A transfer started by staff during the live call also sets it.
- **Outgoing:** the **customer's** leg answered.
- **Masked trip call:** the other party's leg answered, and the connected call has ended.

These are **not** evidence of a connection, and the tests check each one:

- `agent_answered`, which means our agent or the driver picked up their own leg;
- the app's "answered" claim, which records who answered and when;
- talk time;
- a recording URL.

## Incoming (customer called us)

| Outcome | Rule |
|---|---|
| Answered | `completed` |
| Missed | `missed`, `no_agents` or `not_routed` |
| Status unconfirmed | Still marked `ringing` / `initiated` / `agent_answered`, but the hang-up arrived or the call is older than any call can last (`utils/callLiveness`). It is neither answered nor missed. |
| In progress | Anything else |

## Outgoing (we called the customer)

| Measure | Rule |
|---|---|
| Attempts | Every outgoing call |
| Connected | `completed`: the customer's leg answered |
| Callback attempts / connected | The outgoing calls that were callback attempts (`context: call_back`, or linked to a callback task). A subset of Attempts. |

## Driver ↔ customer

Masked trip calls are counted separately, as driver calls. They are not staff work and are not included in the incoming or outgoing figures, and never count as "answered" or "connected".

## Last attempt / last spoke

- **Last attempt:** the newest staff call (by the call's time) in either direction, with its canonical outcome.
- **Last spoke:** the newest staff call that was answered or connected.
- Both are canonical calls over **all** the customer's calls. A newer replayed "missed" record never turns the last attempt into "Missed".

## Telecaller performance (`GET /api/calls/performance`)

Same canonical calls. The response fields are unchanged; `team.driverCalls` and `basis` are added.

**Team totals:** `incoming`, `answered`, `missed`, `unconfirmed` and `inProgress` count each **call once**, by its canonical outcome.
- A call belongs to the period if its **time** (its earliest record) is inside it.
- A replayed record is never a second call.
- A replayed "missed" record of an answered call is never a missed call.
- Masked driver ↔ customer calls are not staff work. They are counted in `team.driverCalls`, not in `incoming`. On `main` they were included in `incoming`.

**Staff credit:** the same rules as `main`, applied once per call.

| Measure | Who gets it |
|---|---|
| answered | The agent on the call's connected record(s), **and** each person who took it as a transfer (transfer outcome `answered` or `rang_back`). |
| answeredUnattributed | An answered call where no connected record names an agent. |
| avgAnswerSec | That person's `answeredAt` minus the call's start (its earliest record), counted only if between 0 and 600 seconds. |
| placed / connected | The outgoing calls a person is named on (any record), once each. Connected means the customer's leg answered. |

**Transfer attribution:** one call may involve several staff. Each of them is credited **once** for it, however many records or transfers name them, so the people's "answered" figures can add up to more than the team's. The team counts the call **once**.

A transfer ring nobody picked up credits nobody. An agent answering their own leg, the app's "answered" claim, talk time or a recording never makes a call answered or connected.

**How it relates to the Call Logs staff filter:**
- The staff filter selects calls a person **handled**: their name is on any record, or they took a transfer.
- Performance "answered" credits the people who **answered**.
- For a person who only answers their own calls, the two match. Tests check that they agree per person: answered, placed, connected.

## Duplicates of one call (the canonical outcome)

| | Strongest first |
|---|---|
| **Incoming** | answered (`completed`) > missed > status unconfirmed > in progress |
| **Outgoing / driver** | connected (`completed`) > not connected |

**Why this order:**
- `completed` is written only from Plivo's report that the call connected, so a "missed" record of the same call is a late or replayed report.
- "Unconfirmed" beats "in progress" because a record with a hang-up time proves the call ended.
- The order in which the records arrived does not matter.

"All call events" lists records and says so. Its totals give both numbers ("N call records · M calls"). Each record that is one of several for the same call is marked "Record of a call Plivo reported 2 times — counted once, as Answered" (`sameCall` in the API).

**The outcome filter selects whole calls:** Answered lists every record of each answered call, including its replayed "missed" record. Missed never lists a record of an answered call. The outcome filters split the calls with no overlap: answered + missed + unconfirmed + in progress = incoming calls.

## Bookings, enquiries, tasks

These are kept as separate statuses and never mixed with call outcomes: call outcome (per call), enquiry status (lead), callback task status and booking status (trip).

- **Booking now** is an active trip: booked, ambulance assigned, or on the way.
- A trip that was confirmed and later cancelled shows as **Last booking: Cancelled**, and both events stay on the timeline.

## People and numbers

Everything is grouped by the call's **number**. Records are never merged by name. A number with more than one patient name is flagged **Shared number**, and each trip keeps its own patient name.

## Privacy

- Numbers are masked (`••••••1234`) for everyone except the CRM owner, including numbers typed inside notes, enquiry messages and cancellation reasons.
- Payments (the list, their timeline entries and amounts) are returned to the owner only.
- Links and paging cursors use an opaque customer reference, never the number.
- Access is the same as on `main`: the owner and telecallers see every call and every customer's history.
- The only restriction is the one `main` already has. The owner can use the **staff filter** for anyone, but a telecaller may pick only themselves. On `main`, `GET /api/calls/logs?agent=` answers 403 "You can filter by your own calls only."; `/history` and `/customers` return the same 403 with the same wording.

## Search

- **Digits** (3 or more): matched against the end of the call's number.
- **A name** (2 or more letters): matched against **every** enquiry (`Lead.patientName`) and booking (`Trip.patientName`), case-insensitive, anywhere in the name.
  - The matching numbers are collected with no row limit.
  - The first page reports `search: { by: 'name', numbers: N, complete: true }`, shown as "name matched N customer numbers (every enquiry and booking searched)".
  - If a name matches more than 20,000 different numbers, the request is **refused** with a message asking for more of the name. It is never cut short silently.

## How the database finds a filtered set of calls

1. **Candidate records:** those inside the dates and on the searched number(s). Any call whose time is in range has its earliest record in range, so every such call has at least one candidate record.
2. **Their CallUUIDs:** one indexed `distinct`.
3. **Every record of those calls:** candidates without a CallUUID, plus every record carrying one of those CallUUIDs (indexed `$in`), wherever they fall.
4. **Group, then filter:** records are grouped per call, the canonical fields are computed, and the filters are applied.

With no date or number filter, or more than 50,000 candidate CallUUIDs, every record is read and grouped. The filters on the canonical call still decide, so the result is the same.

## MongoDB version

**Minimum: MongoDB 4.2, run as a replica set.** Atlas clusters are replica sets.

- **4.2:** the installed MongoDB Node driver's minimum (mongodb 6.20, under mongoose 8.24). The pipelines here need 4.0 or later.
- **Replica set:** booking from a lead uses a transaction (`services/leadBooking.js`).

`node scripts/check-mongo-compat.js` checks a server **read-only**:

- It reads the version and replica-set status, and the feature-compatibility version if the user may read it.
- It sends every aggregation these views use, behind a first `$match` that can match no document, so the server validates every stage but reads no data.
- It opens a transaction, runs one empty read inside it, and aborts it.
- It loads no Mongoose model, so it creates no index or collection, and it writes nothing.

It has only been run against MongoDB 7.0, locally. It has not been run against an older server.

## Indexes

Two additive, non-unique indexes are prepared, but not built:

- `calllogs { startedAt: -1, _id: -1 }`
- `trips { leadId: 1 }`, partial on trips that have a `leadId`

They are created by `scripts/create-call-history-indexes.js`, which only reports unless run with `--apply`. It is run by a person, never by the app. The indexes are deliberately **not** declared in the schemas, because Mongoose `autoIndex` would then build them on production at the first start of the new backend. The app is correct without them, only slower.

What can go wrong when building them:

- **Duplicates are not a blocker:** neither index is unique.
- **A build can still fail or be aborted:**
  - **permissions:** the user needs the `createIndex` action;
  - **disk space:** about 5 MB per 200,000 calls, measured locally;
  - **interruption:** a primary step-down or failover, a restart, or `killOp`;
  - **an index with the same name but a different key or options.** The script reports this before building and skips it.
- A failed build leaves no partial index; rerun it later.
- Reads and writes continue during a build, at the cost of extra CPU and I/O.

## Measured speed (local, synthetic)

Measured on 200,000 calls (about 2% replayed), on a local MongoDB 7.0 under Windows:

| View | Without the date index | With it |
|---|---|---|
| All call events, 30 days (page 1 + totals) | ~2.2 s | ~0.9 s |
| All call events, 30 days, Missed | ~1.0 s | ~0.6 s |
| By customer, 30 days | ~1.0 s | ~0.6 s |
| One customer, all time | ~20 ms | ~20 ms |
| All call events or By customer, **all time** | ~6–7 s | ~6–7 s |

The all-time views group every call, and an index cannot avoid that. Production speed depends on its call volume, which has not been measured.

The CRM therefore opens "All call events" and "By customer" on **Last 30 days**. All time stays one choice away.
- The page always shows the selected period in India dates, for example "Period: Last 30 days · 23 Oct 2026 – 21 Nov 2026".
- While loading it says so, and warns that All time can take several seconds.
- An error shows a Retry button, and the previous filter's totals are not left on screen.
- A reply for an older filter never overwrites a newer one.
- Totals are never truncated.

## Known limits

- **Records listed after a date filter:** a record of an included call that falls outside the chosen dates is not listed. For example, the 00:00:03 record above is not listed under the 18th. The call is still counted once, and its marker shows how many records it has.
- **Linking is by CallUUID only:** two records of one call without a common CallUUID are treated as two calls.
- **Timeline length:** the customer overview timeline shows the newest 300 entries, and says when there are more.
- **Name search cost:** a name search reads every enquiry and booking name, because a case-insensitive match anywhere in the name can't use an index. It took about 50 ms for 30,000 enquiries and 20,000 bookings locally, and runs again for each page of results.
