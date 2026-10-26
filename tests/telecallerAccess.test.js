'use strict';
/**
 * Telecaller = operations access. Real HTTP requests through the real
 * routers and their real authorize() guards, as server.js mounts them; only
 * the login lookup is stubbed (the role comes from a test header) and each
 * route's final handler is swapped for a 200 stub, so a 200 here means "the
 * guards let this role through to the page's API" and a 403 means blocked.
 */

jest.mock('../middleware/auth', () => {
  const actual = jest.requireActual('../middleware/auth');
  const asUser = (req, res, next) => {
    const role = req.get('x-test-role');
    if (!role) return res.status(401).json({ success: false });
    req.user = { _id: { toString: () => 'u1' }, role, name: 'Test' };
    req.actorType = 'user';
    return next();
  };
  return {
    ...actual,
    protect: asUser,
    protectUserOrOwner: asUser,
    // Fleet-partner (Owner document) logins only — never a CRM User.
    protectOwner: (req, res) => res.status(401).json({ success: false }),
  };
});

// Loaded by the controllers; nothing here sends anything.
jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));

const express = require('express');

const MOUNTS = {
  '/api/auth'            : '../routes/auth',
  '/api/billing'         : '../routes/billing',
  '/api/trips'           : '../routes/trips',
  '/api/hospitals'       : '../routes/hospitals',
  '/api/leads'           : '../routes/leads',
  '/api/salary'          : '../routes/salary',
  '/api/finance'         : '../routes/finance',
  '/api/trip-call-events': '../routes/tripCallEvents',
  '/api/geofence-events' : '../routes/geofenceEvents',
  '/api/advances'        : '../routes/advance',
  '/api/owners'          : '../routes/owners',
  '/api/ambulances'      : '../routes/ambulances',
  '/api/sos'             : '../routes/sos',
  '/api/whatsapp'        : '../routes/whatsappRoutes',
  '/api/whatsapp-leads'  : '../routes/whatsappLeads',
  '/api/seo'             : '../routes/seo',
  '/api/quotes'          : '../routes/quotes',
  '/api/calls'           : '../routes/calls',
};

// Every route's own handler -> 200, keeping all the guards in front of it.
function stubHandlers(router) {
  for (const layer of router.stack) {
    const stack = layer.route?.stack;
    if (stack?.length) stack[stack.length - 1].handle = (req, res) => res.status(200).json({ reached: true });
  }
}

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  for (const [prefix, mod] of Object.entries(MOUNTS)) {
    const router = require(mod);
    stubHandlers(router);
    app.use(prefix, router);
  }
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const call = async (role, method, path) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-test-role': role, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
  return res.status;
};

const ID = '64b000000000000000000001';

// The APIs behind each page a telecaller may use.
const ALLOWED = {
  'Call Logs'      : [['GET', '/api/calls/logs'], ['GET', `/api/calls/${ID}`], ['GET', `/api/calls/${ID}/recording`], ['POST', '/api/calls/click-to-call']],
  'Call settings'  : [['GET', '/api/calls/me'], ['PUT', '/api/calls/me'], ['PUT', '/api/calls/duty'], ['POST', '/api/calls/test-ring']],
  Fleet            : [['GET', '/api/ambulances/admin'], ['GET', '/api/auth/users?role=driver']],
  Dispatch         : [['GET', '/api/trips/live'], ['POST', '/api/trips/estimate'], ['GET', `/api/trips/${ID}/suggested-ambulances`],
                      ['PUT', `/api/trips/${ID}/assign`], ['PUT', `/api/trips/${ID}/cancel`], ['PUT', `/api/trips/${ID}/complete`],
                      ['GET', '/api/quotes'], ['POST', '/api/quotes'], ['GET', '/api/hospitals']],
  Trips            : [['GET', '/api/trips']],
  'Trip Alerts'    : [['GET', '/api/trip-call-events?type=NO_RESPONSE']],
  'Posting Alerts' : [['GET', '/api/geofence-events']],
  'SOS Alerts'     : [['GET', '/api/sos'], ['PATCH', `/api/sos/${ID}/resolve`]],
  'WhatsApp Chats' : [['GET', '/api/whatsapp/conversations'], ['POST', '/api/whatsapp/call-outcome'], ['GET', '/api/whatsapp/customer/9000000001']],
  'WhatsApp Leads' : [['GET', '/api/whatsapp-leads'], ['PATCH', `/api/whatsapp-leads/${ID}/status`]],
  Leads            : [['GET', '/api/leads'], ['PUT', `/api/leads/${ID}`]],
  Hospitals        : [['GET', '/api/hospitals'], ['POST', '/api/hospitals']],
};

// The APIs behind each page a telecaller must NOT reach.
const BLOCKED = {
  Dashboard : [['GET', '/api/billing/dashboard']],
  Finance   : [['GET', '/api/finance/expenses'], ['GET', '/api/finance/income'], ['GET', '/api/finance/loans'], ['GET', '/api/finance/summary']],
  Salaries  : [['GET', '/api/salary/summary/10/2026'], ['POST', '/api/salary/calculate/10/2026'], ['GET', `/api/salary/${ID}/10/2026`]],
  Staff     : [['POST', '/api/auth/register'], ['PUT', `/api/auth/users/${ID}`], ['PUT', `/api/auth/users/${ID}/deactivate`],
               ['PUT', `/api/auth/users/${ID}/password`], ['PUT', `/api/auth/users/${ID}/owner`]],
  Advances  : [['GET', '/api/advances'], ['PUT', `/api/advances/${ID}/approve`]],
  Owners    : [['GET', '/api/owners']],
  Billing   : [['GET', '/api/billing/bills'], ['GET', '/api/billing/hospital-invoices']],
  SEO       : [['GET', '/api/seo/articles']],
  'Plivo live calls': [['GET', '/api/calls/plivo/live']],
};

describe('telecaller (operations) access', () => {
  for (const [page, apis] of Object.entries(ALLOWED)) {
    it(`reaches ${page}`, async () => {
      for (const [method, path] of apis) {
        expect([method, path, await call('telecaller', method, path)]).toEqual([method, path, 200]);
      }
    });
  }
  for (const [page, apis] of Object.entries(BLOCKED)) {
    it(`is refused ${page} (403)`, async () => {
      for (const [method, path] of apis) {
        expect([method, path, await call('telecaller', method, path)]).toEqual([method, path, 403]);
      }
    });
  }

  it('the owner still reaches every blocked page', async () => {
    for (const apis of Object.values(BLOCKED)) {
      for (const [method, path] of apis) {
        expect([method, path, await call('owner', method, path)]).toEqual([method, path, 200]);
      }
    }
  });

  it('a driver gets none of the operations pages', async () => {
    for (const [method, path] of [['GET', '/api/sos'], ['GET', '/api/leads'], ['GET', '/api/whatsapp-leads'], ['GET', '/api/auth/users']]) {
      expect([method, path, await call('driver', method, path)]).toEqual([method, path, 403]);
    }
  });
});

describe('the staff list a telecaller sees has no pay fields', () => {
  it('drops salary, bonus and device fields for a telecaller, not for the owner', async () => {
    jest.resetModules();
    const select = jest.fn(async () => []);
    jest.doMock('../models', () => ({ User: { find: jest.fn(() => ({ select })) } }));
    const router = require('../routes/auth');
    const layer = router.stack.find((l) => l.route?.path === '/users' && l.route.methods.get);
    const handler = layer.route.stack.at(-1).handle;
    const res = { json: jest.fn() };
    await handler({ query: { role: 'driver' }, user: { role: 'telecaller' } }, res, jest.fn());
    expect(select.mock.calls[0][0]).toMatch(/-baseSalary/);
    expect(select.mock.calls[0][0]).toMatch(/-perTripBonus/);
    await handler({ query: {}, user: { role: 'owner' } }, res, jest.fn());
    expect(select.mock.calls[1][0]).not.toMatch(/baseSalary/);
  });
});
