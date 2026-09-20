# Retiring the legacy `Vehicle` path — audit

Phase 6, step 6. Every read and write of `Vehicle`, with a verdict for each.

Production state this is judged against (today's backup):
`vehicles = 0`, `loans = 0`, `servicelogs = 0`, `expenses = 0`, `trips = 130`.

---

## The finding that stops the work

**Auto-assign is already dead in production, and switching it to Ambulance
turns it back on.**

`createTrip` (tripController.js:372-381) calls `autoAssign(trip)` when no
`vehicleId` is supplied. `autoAssign` (L394) is:

```js
const available = await Vehicle.find({ status: 'available' })
if (!available.length) return null;
```

With `vehicles = 0` that returns `null` on every call, so **no trip has
been auto-assigned for as long as the collection has been empty**. Every
dispatch today is a human choosing a unit on the CRM board.

Pointing `autoAssign` at on-duty Ambulances — which is the correct fix and
what step 7 asks for — does not restore old behaviour. It *starts* a
behaviour production has not had: a trip booked from the website, the
customer app or WhatsApp would immediately pick the nearest on-duty
ambulance, set the driver to `on_trip`, and fire the driver push, the
full-screen call intent, the WhatsApp "driver assigned" message and the
customer's tracking-link SMS — with no dispatcher in the loop.

That is a live change to a patient-critical path and an operational change
for drivers, not a refactor. **Stopping here for a decision, per the rule
about risky findings.** Steps 7 and 8 are not implemented.

What the decision needs to cover:

1. Should auto-assign be on at all, or should dispatch stay manual with
   `autoAssign` deleted rather than ported?
2. If on: for every booking source, or only some? A WhatsApp lead and a
   999-style emergency call are not the same urgency.
3. If on: nearest-first by GPS, as the Vehicle version did? Ambulance has
   no `gps` field of its own — the driver's `User.availability.lat/lng` is
   the live position, so the sort has to be rewritten, not copied.

Everything else below is safe and mechanical.

---

## Trip dispatch

| Site | What it does | Verdict |
|---|---|---|
| `autoAssign` (L394) | `Vehicle.find({status:'available'})`, sorts by `vehicle.gps` | **Move to Ambulance** — but see the finding above. Needs a new distance source (`User.availability`). |
| `createTrip` (L372-381) | auto-assign, or `Vehicle.findById(vehicleId)` | **Move to Ambulance.** Drop the `vehicleId` branch. |
| `assignVehicle` (L507) | manual assign; accepts `ambulanceId` **or** `vehicleId` | **Keep the ambulance branch, remove the vehicle branch.** The vehicle branch cannot match anything. |
| `assignTripToVehicle` (L482) | sets `trip.vehicle`, flips `Vehicle.status` | **Remove.** `assignTripToAmbulance` already does the real work. |
| `getLiveBoard` (L1630) | merges `Vehicle.find({status:'available'})` into `availableVehicles` | **Remove the vehicle half.** The CRM already filters to `source === 'ambulance'` (Phase 5). |

## Trip lifecycle — writes against `trip.vehicle`

`completeTrip` (L1160), `assignVehicle`'s release (L525), reassign (L1270),
cancel (L1308), and L1357 all call
`Vehicle.findByIdAndUpdate(trip.vehicle, { status: 'available' })`.

**Remove.** Every one is already a no-op: `trip.vehicle` is null on new
trips, and on the 130 historical trips it points at a `Vehicle` document
that no longer exists, so `findByIdAndUpdate` matches nothing and returns
`null` without throwing. Nothing branches on the result.

## Historical rendering — the 130 trips

| Site | Verdict |
|---|---|
| `Trip.vehicle` field (models/index.js:604) | **Keep, read-only.** It is how those 130 trips remember which unit ran them. |
| `trackedVehicleInfo` (L1753) | **Keep as-is.** Already prefers `trip.ambulance` and falls back to `trip.vehicle`; that fallback is exactly the historical path. |
| `getTrips` / `getTripById` populate `'vehicle'` | **Keep.** Populating a dangling ref yields `null`, which the renderer already handles. |
| `billingController` L76 populates `trip.vehicle` | **Keep.** Same dangling-ref-yields-null behaviour, on historical bills. |

## Vehicle CRUD and the things hanging off it

| Site | Rows in prod | Verdict |
|---|---|---|
| `routes/vehicles.js` + `vehicleController` CRUD | 0 vehicles | **Unmount and delete.** Its last CRM caller went in Phase 4. |
| `assignDriver` (vehicleController:119) | — | **Delete.** The orphaned owner-assign endpoint; superseded by `Ambulance.defaultDriver`. |
| `complianceDashboard` (vehicleController:208) | 0 | **Delete.** Ambulance has its own `documents` block with the same doc types. |
| Service logs (`addServiceLog`, `getServiceLogs`) | `servicelogs = 0` | **Delete.** `ServiceLog.vehicle` is `required: true`, so nothing can be written against an Ambulance without a schema change, and there is no history to preserve. |
| `Loan` model + finance loan routes | `loans = 0` | **Delete the Vehicle coupling.** `Loan.vehicle` is `required: true` and there are no rows. If vehicle finance is wanted later it should be modelled against Ambulance from scratch. |
| `Expense.vehicle`, `Income.vehicle` (optional refs) | `expenses = 0` | **Keep the field, drop nothing.** Optional and unpopulated; leaving them costs nothing and avoids a migration. |
| `Notification.vehicle` | optional | **Keep.** Same reasoning. |
| `jobs/scheduler.js` compliance cron (L57, L112) | 0 | **Move to Ambulance or delete.** It currently iterates an empty collection and sends nothing. Ambulance documents have expiry dates, so the alert has a real target if it is wanted. |
| `models/index.js` `Vehicle` model | — | **Keep the model.** `Trip.vehicle`, `Expense.vehicle`, `Income.vehicle` and `Notification.vehicle` all declare `ref: 'Vehicle'`, and mongoose needs the model registered for `.populate()` on those paths not to throw — including on the 130 historical trips. Keeping the schema with no routes is the cheap, safe end state. |

## Not touched

`pricingController.getPricingByVehicle` is named for vehicle *type*
(`Pricing.serviceType`), not the `Vehicle` model. Unrelated.

`salaryController` L455's `vehicleOk` is a shift-checklist boolean. Also
unrelated — and part of the unrouted attendance handlers noted in Phase 4.
