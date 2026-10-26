'use strict';

// ============================================================
// utils/phoneViewer.js — who is looking at customer numbers.
// ============================================================
// Customer numbers go out masked ("••••••4442") to everyone, except to a
// signed-in CRM OWNER, who also gets the full number. That is decided once
// per request, when middleware/auth.js verifies a CRM User login
// (protect / protectUserOrOwner), and read by the models' toJSON transforms
// and the few hand-built responses through fullPhone().
//
// Safe by default: anything that never set a viewer — public routes,
// webhooks, a fleet partner (Owner) login, a driver, a telecaller — sees
// masked only. A telecaller can still call back, dispatch and so on: those
// actions take an id or customerRef and the server looks the number up.
// ============================================================

const { AsyncLocalStorage } = require('async_hooks');
const { normalisePhone } = require('./phone');

const storage = new AsyncLocalStorage();

// Runs the rest of the request with this viewer. Only a CRM User (not a
// fleet-partner Owner document, whose synthesized role is also 'owner')
// with role 'owner' sees full numbers.
function runAsViewer(user, next) {
  return storage.run({ revealPhones: user?.role === 'owner' }, next);
}

const revealPhones = () => storage.getStore()?.revealPhones === true;

// The full number for an owner (10 digits when it is an Indian mobile),
// undefined for anyone else — so the field is simply absent from their JSON.
function fullPhone(raw) {
  if (!revealPhones() || raw == null || raw === '') return undefined;
  const ten = normalisePhone(raw);
  return ten.length === 10 ? ten : String(raw);
}

module.exports = { runAsViewer, revealPhones, fullPhone };
