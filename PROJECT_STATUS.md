# Driver-Auth Redesign — Project Status

**Scope:** `medifleet-backend` (Express/MongoDB API) + `medifleet-app` (Expo driver app)
**Phases completed:** 1–6 (this document is the Phase 6 wrap-up deliverable)
**Status as of:** 2026-07-11

---

## 1. What's built, phase by phase

### Phase 1 — Owner + Fleet + Ambulance management (backend, additive)
- New models: `Owner` (OTP-registered fleet owner, KYC status/documents), `Fleet`, `Ambulance` (documents: rc/insurance/fitness/permit/pollution, `status` enum available/assigned/maintenance).
- New controllers/routes: `POST /api/owners/send-otp`, `/verify-otp`, `GET /me`, `POST /kyc/upload`; full CRUD on `/api/fleets`, `/api/ambulances` (+ per-ambulance document upload).
- New middleware: `protectOwner` (JWT → `Owner` collection, synthesizes `role:'owner'` so the existing `authorize('owner')` gate works unchanged).
- **Existing `User`/`Trip`/`BookingTrip` models and routes were not touched.**

### Phase 2 — Employee ID + PIN driver login (backend, additive)
- Extended `User` with optional fields: `employeeId` (unique, sparse), `pin` (bcrypt, own pre-save hook), `pinChangeRequired`, `approvalStatus`, `deviceId`, `driverDocuments`, `assignedAmbulanceId` (ref the new `Ambulance` model).
- New `authController` functions: `loginWithPin` (device-binding on first login, blocks on `approvalStatus`/device mismatch), `changePin`, `createDriverAccount`, `approveDriver`, `rejectDriver`, `unbindDevice`.
- New routes mounted at `/api/driver-auth/*`.
- **Existing `/api/auth/login` (phone+password) and OTP flow were not touched** — confirmed working side-by-side throughout every phase's regression pass.

### Phase 3 — Assignment + Shift management (backend, additive)
- New models: `Assignment` (driver↔ambulance duty link), `Shift` (active/break/ended, `breaks[]`, `totalWorkingMinutes`).
- New `assignmentController`: `startDuty` (enforces one-driver-one-ambulance and one-active-assignment-per-ambulance), `breakDuty`, `resumeDuty`, `endDuty` (computes working minutes, releases the ambulance), `getMyActiveShift`, `getAssignmentHistory`, `getFleetShiftStatus` (owner dashboard).
- New routes mounted at `/api/assignments/*`.

### Phase 4 — Driver app: PIN login UI (frontend, additive)
- `LoginScreen`: Password/PIN tab toggle (PIN default), boxed 6-digit `PinInput` component, device ID via `expo-application`.
- New screens: `ChangePinScreen` (forced first-login PIN change, no back button), `PermissionsScreen` (camera + location gate, skips itself once both are granted).
- `AuthContext` extended with `loginWithPin`/`completePinChange`, alongside the untouched existing `login`/`logout`.
- **Required a new native dependency (`expo-application`) → needed a new `eas build`, not just an OTA update.**

### Phase 5 — Driver app: Ola/Uber-style trip flow (frontend, additive)
- New screens: `TripAssignedScreen` (modal alert on new dispatch), `NavigateScreen` (static pickup address — no map library in this project, flagged rather than guessed), `TripSummaryScreen` (post-completion summary from `tripsApi.complete()`'s real response fields).
- `DriverDashboard` converted from a hand-rolled `showBookingTrip` conditional-render into a real nested `Stack.Navigator` (`DriverDashboard`, `TripAssigned`, `Navigate`, `BookingTrip`, `TripSummary`); added a 9-second polling effect for new dispatches.
- `BookingTripScreen`'s only change: `{ onBack }` prop → `{ navigation }`, i.e. `navigation.goBack()` — its entire internal stage-tracking logic is untouched.
- **Purely JS/navigation — no new native dependency, no `eas build` needed, `eas update` would have sufficed.**

### Phase 6 — Decline endpoint, migration, final regression (this phase)
- **Backend:** `PUT /api/trips/:id/decline` (`protect`, `authorize('driver')`) — only the currently-assigned driver, only on a `'dispatched'` trip; returns the trip to `'booked'` (unassigned), clears `vehicle`/`driver`, releases the vehicle. Additive alongside the untouched owner/telecaller-only `/cancel`.
- **Frontend:** `TripAssignedScreen`'s Reject button now calls this endpoint instead of just dismissing locally; the `TODO(backend)` comment is resolved and removed.
- **Migration:** `scripts/migrate-driver-to-pin.js` — idempotent, phone-number-driven, gives an existing phone+password driver an `employeeId`/PIN identity without touching their password. Run once for `8884092777`:
  - `employeeId: DRV-001`
  - `approvalStatus: approved`
  - **temp PIN: `135790`** (they'll be forced to change it on first PIN login — `pinChangeRequired:true`)
  - Their existing password is untouched — confirmed both `/api/auth/login` (phone+password) and `/api/driver-auth/login` (employeeId+PIN) work for this same account.

---

## 2. Known gaps (deliberate — not silently skipped)

| Gap | Why it exists | What's needed to close it |
|---|---|---|
| **No real map in `NavigateScreen`** | `react-native-maps` was never a dependency of `medifleet-app` (checked, confirmed absent in Phase 5). Adding a native map library is explicitly out of scope for an additive/OTA-safe phase. | `npx expo install react-native-maps`, wire up pickup/live-location markers, **and a new `eas build`** (native module). |
| **No push notifications for trip assignment** | Explicitly deferred — Phase 5 only implements client-side polling (`GET /api/trips/live` every 9s while on `DriverDashboard`). | Add `expo-notifications` (native module → new build), a device-token registration endpoint, and a server-side push trigger in `assignTripToVehicle()`. |
| **`Trip`/`Vehicle` dispatch system is separate from the Phase 1 `Ambulance`/`Assignment` system** | Pre-existing architecture: `createTrip`/`assignVehicle` auto-assign against the *legacy* `Vehicle` model, not the new `Ambulance` model built in Phases 1–3. Confirmed directly while testing the Phase 6 decline endpoint — had to create a legacy `Vehicle` doc to get a real dispatched `Trip`. | A real unification would mean migrating `Trip.vehicle`/dispatch logic to reference `Ambulance` instead of `Vehicle` — a bigger, riskier change explicitly out of scope for every phase so far. |
| **`BookingTrip` has no link back to `Trip._id`** | Pre-existing: `BookingTripScreen`'s stage tracker (`START_TRIP`→`END_TRIP_CLOSE_DUTY`) operates on its own `BookingTrip` document with no `trip` reference field. This is *why* Phase 5's "Reached Pickup" returns to `DriverDashboard` instead of routing into `BookingTripScreen` — going that way would silently orphan the `Trip` at `en_route` forever. | Add a `trip: ObjectId ref 'Trip'` field to `BookingTrip` and thread it through, or retire one of the two systems. |
| **Decline has no reason field / no notification to owner/telecaller** | Kept minimal per the Phase 6 spec (status-and-release only). | Optional: accept a `reason` in the request body (mirroring `cancelTrip`), and/or create a `Notification` doc so the telecaller dashboard shows "declined, needs reassignment." |

---

## 3. What to test on a real phone next

This has only been verified via `curl` against the real DB and Babel/`node --check` syntax passes — **no on-device test has been run.** Before trusting this in the field:

- [ ] **Fresh install / OTA update** — confirm `expo-application`'s native module actually resolves at runtime (Phase 4 needed a real build, not just JS — verify the currently-installed build on the test device already includes it, or do a new build first).
- [ ] **PIN login end-to-end** — log in as `DRV-001` / PIN `135790` on a real device; confirm the forced `ChangePinScreen` appears and can't be bypassed; set a new PIN; confirm it persists after killing and reopening the app.
- [ ] **Device binding** — log in from a second physical device with the same `employeeId` and confirm the "device not registered" message and Contact-Owner hint appear correctly.
- [ ] **Permissions screen** — fresh install, deny camera or location once (not "don't ask again") and confirm the retry path works; deny permanently and confirm "Open Settings" actually opens the OS settings screen and that returning to the app re-detects the grant.
- [ ] **Trip assignment polling** — with a real dispatched trip (create one via `POST /api/trips` with a real `vehicleId`, see the Known Gaps table above for why it needs a `Vehicle`, not an `Ambulance`), confirm `TripAssignedScreen` pops up within ~9s on the device without a manual refresh.
- [ ] **Accept → Navigate → Reached Pickup → Client Dropped → Trip Summary** — the full loop on a real device, confirming the trip actually reaches `'completed'` and a real Bill/Income record is created server-side.
- [ ] **Reject/decline** — confirm the trip actually disappears from *this* driver's view and re-enters the pool (verify server-side via `/api/trips` as an owner/telecaller, or a DB check) rather than just visually dismissing.
- [ ] **Old-style login still works** — confirm the existing phone+password screen (Password Login tab) still logs in fine for any driver who hasn't been migrated yet.
- [ ] **Background/kill-and-resume** — kill the app mid-shift (after `start-duty`) and confirm reopening it doesn't lose track of the active assignment (`GET /api/assignments/my-active` on resume) — this isn't wired into any screen yet and is worth deciding whether it needs to be.
- [ ] **Selfie/expense camera flows** (pre-existing, unrelated to this redesign but exercised by the same Permissions gate) — confirm they still work now that permission-granting has been centralized into `PermissionsScreen` ahead of `DriverDashboard`.

---

## 4. Everything NOT touched across all 6 phases (confirmed via diff each phase)

- `models/index.js`'s `Trip`, `BookingTrip`, `TripActivity` schemas (only `User` gained new optional fields).
- `authController.loginPassword`, `sendOtp`, `verifyOtp`, `refresh`, `logout`, `getMe`, `updatePassword`, `register`.
- `PUT /api/trips/:id/cancel` (still owner/telecaller-only).
- `BookingTripScreen.js`'s internal stage logic (only its navigation prop changed).
- `DriverDashboard.js`'s trip-completion call itself (`tripsApi.complete(tripId, {})` — only what happens *after* success changed).
- `medifleet-app`'s `LoginScreen`/`ChangePinScreen`/`PermissionsScreen`/`AuthContext`/`client.js` core exports from Phase 4 (Phase 5 and 6 only added to them, never edited their existing lines — except Phase 6's one-line `tripsApi.decline` addition and `TripAssignedScreen`'s `handleReject` body, exactly as this phase's brief asked for).
