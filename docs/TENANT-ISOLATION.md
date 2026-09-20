# Tenant isolation audit

Phase 3. Every route reachable by a fleet **Owner** session (`protectOwner`)
and every **driver** route, with the predicate that scopes it.

## The thing to understand first

`authorize('owner')` passes for **two different subjects**:

| Middleware | Subject | `req.user` is | `req.actorType` |
|---|---|---|---|
| `protect` | CRM admin | a `User` with `role: 'owner'` | `'user'` |
| `protectOwner` | fleet partner | an `Owner` doc, role synthesized | `'owner'` |
| `protectUserOrOwner` | either | whichever matched | set accordingly |

They are told apart only by **which middleware ran**, which a controller
cannot see — so `req.actorType` exists to make it readable. Anything that
must treat the two differently reads that, never `role`.

A consequence worth stating plainly, because it is load-bearing and
accidental: **`protect` resolves the subject with `User.findById`**, and a
fleet Owner's `_id` lives in the `owners` collection. So an Owner token on
any `protect` route gets `401 User not found. Token may be stale.` Every
CRM-only route is therefore closed to partners by construction, not by a
role check. `tests/tenantIsolation.test.js` pins this, because it would be
silently undone by anyone "fixing" `protect` to look in both collections.

## Owner routes (`protectOwner`)

All of these additionally carry `authorize('owner')` and, except where
noted, `requireKycApproved`.

| Route | Handler | Scoped by |
|---|---|---|
| `POST /api/ambulances` | `createAmbulance` | `resolveFleet(req.user._id)`; `owner: req.user._id` on create |
| `GET /api/ambulances` | `getAmbulances` | `owner: req.user._id` |
| `GET /api/ambulances/:id` | `getAmbulanceById` | `owner: req.user._id` |
| `PUT /api/ambulances/:id` | `updateAmbulance` | `owner: req.user._id` |
| `DELETE /api/ambulances/:id` | `deleteAmbulance` | `owner: req.user._id` |
| `PUT /api/ambulances/:id/document` | `updateDocument` | `owner: req.user._id` |
| `POST /api/ambulances/:id/photos` | `addPhoto` | `owner: req.user._id` |
| `PUT /api/ambulances/:id/default-driver` | `setDefaultDriver` | ambulance **and** driver both `owner: req.user._id` |
| `DELETE /api/ambulances/:id/default-driver` | `clearDefaultDriver` | `owner: req.user._id` |
| `POST /api/fleets` | `createFleet` | `owner: req.user._id` |
| `GET /api/fleets` | `getFleets` | `owner: req.user._id` |
| `GET /api/fleets/:id` | `getFleetById` | `owner: req.user._id` |
| `PUT /api/fleets/:id` | `updateFleet` | `owner: req.user._id` |
| `DELETE /api/fleets/:id` | `deleteFleet` | `owner: req.user._id` |
| `GET /api/assignments/fleet-status` | `getFleetShiftStatus` | `owner: ownerId` on the ambulance query |
| `PUT /api/assignments/:driverId/force-end-duty` | `forceEndDuty` | `owner: req.user._id` on the driver |
| `GET /api/driver-auth` | `listDrivers` | `owner: req.user._id` |
| `POST /api/driver-auth/register` | `createDriverAccount` | writes `owner: req.user._id` |
| `PUT /api/driver-auth/:id/approve` | `approveDriver` | `owner: req.user._id` |
| `PUT /api/driver-auth/:id/reject` | `rejectDriver` | `owner: req.user._id` |
| `PUT /api/driver-auth/:id/unbind-device` | `unbindDevice` | `owner: req.user._id` |
| `PUT /api/driver-auth/:id/shift-hours` | `setDriverShiftHours` | `owner: req.user._id` |
| `GET /api/owners/me` | `getMe` | self (`req.user`) — no KYC gate, deliberately |
| `POST /api/owners/kyc/upload` | `uploadKycDocument` | self — no KYC gate, deliberately |
| `POST /api/owners/act-as-driver` | `actAsDriver` | self, by the owner's own phone |
| `GET /api/trips` | `getTrips` | `ambulance ∈ {owner's ambulances}` |
| `GET /api/trips/:id` | `getTripById` | ambulance must be the owner's, else 404 |

`/owners/me` and `/kyc/upload` sit outside `requireKycApproved` on purpose:
an owner must always be able to log in, read their own rejection reason and
re-upload documents, whatever their approval state.

## Driver routes (`protect` + `authorize('driver')`)

Scoped by `req.user._id` (self) or `req.user.owner` (their fleet).

| Route | Handler | Scoped by |
|---|---|---|
| `GET /api/assignments/available-ambulances` | `getAvailableAmbulances` | `owner: req.user.owner`; 403 when unlinked |
| `POST /api/assignments/start-duty` | `startDuty` | `owner: req.user.owner` inside the atomic claim |
| `POST /api/assignments/break` `resume` `end-duty` | — | `driver: req.user._id` |
| `GET /api/assignments/my-active` `my-history` `my-shifts` | — | `driver: req.user._id` |
| `PUT /api/driver-auth/documents` | `uploadDriverDocument` | self |
| `PUT /api/driver-auth/location` | `updateLocation` | self |
| `POST /api/driver-auth/change-pin` | `changePin` | self |
| `POST /api/advances` `GET /api/advances/my` | — | `driver: req.user._id`; platform drivers only |
| `POST /api/booking-trips` `PUT /:id/stage` `GET /my` | — | `driver: req.user._id` |
| `GET/POST /api/trips/:id/messages` | — | trip's own driver |
| `GET /api/trips` `GET /api/trips/:id` | — | `driver: req.user._id` |

A driver with no `owner` link sees **nothing** rather than the whole
platform — the old permissive fallback was a cross-tenant leak.

## CRM-admin only (`protect` + `authorize('owner')`)

Unreachable by an Owner token for the structural reason above. Global by
design; **none of these is partition-aware**, which is why partner payroll
and partner SOS do not exist yet.

`GET /api/trips/live` · `/api/salary/*` · `/api/sos` · `/api/trip-activity`
· `GET /api/advances` (+approve/reject) · `/api/billing/*` · `/api/finance/*`
· `/api/vehicles/*` · `/api/geofence-events` · `GET /api/auth/users` ·
`PUT /api/auth/users/:id` · `PUT /api/auth/users/:id/owner` ·
`GET /api/ambulances/admin` · `GET /api/owners` (+approve/reject/platform-owner)

## Known gaps, deliberately not closed here

1. **`Vehicle` has no `owner` field at all**, so `/api/vehicles/*` cannot be
   made multi-tenant. It must be retired before partner #2 carries real
   volume. It still backs live dispatch (`assignTripToVehicle`).
2. **Salary, SOS and trip-activity are platform-wide.** Fine while only
   SaveLife's own drivers have payroll; a partner-facing version of any of
   them needs its own scoping pass.
3. **Driver phone is globally unique.** One human cannot drive for two
   partners. The 409 no longer says why, so nothing leaks.
