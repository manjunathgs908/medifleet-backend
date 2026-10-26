'use strict';
/**
 * Customer numbers by role, end to end: real JWT, real protect(), real
 * model toJSON transforms and the real WhatsApp / quote handlers (only
 * the database reads are stubbed). The CRM owner gets the full number; a
 * telecaller — and anyone else — never finds it anywhere in a response.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../utils/pushService', () => ({ sendPush: jest.fn() }));
jest.mock('../utils/fcmService', () => ({ sendFullScreenTrip: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const { User, Trip, Lead } = require('../models');
const CallLog = require('../models/CallLog');
const WhatsAppLead = require('../models/WhatsAppLead');
const WhatsAppCallLog = require('../models/WhatsAppCallLog');
const WhatsAppFunnelEvent = require('../models/WhatsAppFunnelEvent');
const Quote = require('../models/Quote');
const { protect, authorize, OPERATIONS } = require('../middleware/auth');
const { runAsViewer, fullPhone } = require('../utils/phoneViewer');
const { customerRef } = require('../utils/customerPhone');

const PHONE = '9986844442';
const LEAKS = [PHONE, `91${PHONE}`, '99868 44442'];
const MASKED = '••••••4442';

const USERS = {
  owner     : { _id: '64b0000000000000000000a1', role: 'owner', isActive: true, name: 'Manjunath' },
  telecaller: { _id: '64b0000000000000000000a2', role: 'telecaller', isActive: true, name: 'santosh' },
  driver    : { _id: '64b0000000000000000000a3', role: 'driver', isActive: true, name: 'Ravi' },
};
const tokenFor = (role) => jwt.sign({ id: USERS[role]._id }, process.env.JWT_SECRET);

// Chainable stand-in for a Mongoose query.
const chain = (value) => {
  const q = { then: (res, rej) => Promise.resolve(value).then(res, rej) };
  for (const m of ['select', 'sort', 'limit', 'lean', 'populate']) q[m] = () => q;
  return q;
};

const docs = () => ({
  trip   : new Trip({ patientName: 'P', patientPhone: PHONE, pickup: { address: 'x' } }),
  lead   : new Lead({ name: 'L', phone: PHONE }),
  waLead : new WhatsAppLead({ phone: `91${PHONE}` }),
  waCall : new WhatsAppCallLog({ phone: `91${PHONE}`, outcome: 'booked' }),
  callLog: new CallLog({ provider: 'plivo', direction: 'inbound', context: 'incoming', customerPhone: PHONE }),
});

let server;
let base;
beforeAll(async () => {
  jest.spyOn(User, 'findById').mockImplementation((id) => chain(Object.values(USERS).find((u) => u._id === id) || null));
  // Database reads behind the real handlers.
  jest.spyOn(WhatsAppFunnelEvent, 'aggregate').mockResolvedValue([{
    counts: [{ total: 1, completed: 0, dropped: 1, live: 0, needsCall: 1, done: 0 }],
    rows  : [{ phone: `91${PHONE}`, lastStep: 'X', completed: false }],
  }]);
  jest.spyOn(WhatsAppFunnelEvent, 'find').mockReturnValue(chain([{ step: 'AWAITING_LANGUAGE', enteredAt: new Date() }]));
  jest.spyOn(WhatsAppCallLog, 'find').mockReturnValue(chain([{ phone: `91${PHONE}`, outcome: 'booked', createdAt: new Date() }]));
  jest.spyOn(Trip, 'find').mockReturnValue(chain([{ tripNumber: 'TRP-1', patientPhone: PHONE, status: 'completed' }]));
  jest.spyOn(Quote, 'find').mockReturnValue(chain([{ _id: 'q1', phone: PHONE, status: 'sent', sentAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) }]));

  const app = express();
  const ops = [protect, authorize(...OPERATIONS)];
  // Each model as the CRM's endpoints return it (res.json of the document).
  app.get('/doc/:kind', ...ops, (req, res) => res.json({ item: docs()[req.params.kind] }));
  app.use('/api/whatsapp', require('../routes/whatsappRoutes'));
  app.use('/api/quotes', require('../routes/quotes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const get = async (role, path) => {
  const res = await fetch(base + path, { headers: role ? { authorization: `Bearer ${tokenFor(role)}` } : {} });
  return { status: res.status, text: await res.text() };
};

const PAGES = {
  'Trips / Dispatch (Trip)'        : '/doc/trip',
  'Leads (Lead)'                   : '/doc/lead',
  'WhatsApp Leads (WhatsAppLead)'  : '/doc/waLead',
  'WhatsApp call outcome'          : '/doc/waCall',
  'Call Logs / call detail (CallLog)': '/doc/callLog',
  'WhatsApp Chats list'            : '/api/whatsapp/conversations',
  'WhatsApp customer history'      : `/api/whatsapp/customer/${encodeURIComponent(customerRef(`91${PHONE}`))}`,
  'Dispatch quotes'                : '/api/quotes',
};

describe('telecaller: masked everywhere, never the full number', () => {
  for (const [page, path] of Object.entries(PAGES)) {
    it(page, async () => {
      const { status, text } = await get('telecaller', path);
      expect(status).toBe(200);
      for (const leak of LEAKS) expect(text).not.toContain(leak);
      expect(text).toContain(MASKED);
    });
  }

  it('even asking the customer history by the raw number returns it masked', async () => {
    const { status, text } = await get('telecaller', `/api/whatsapp/customer/${PHONE}`);
    expect(status).toBe(200);
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });
});

describe('owner: the full number everywhere', () => {
  for (const [page, path] of Object.entries(PAGES)) {
    it(page, async () => {
      const { status, text } = await get('owner', path);
      expect(status).toBe(200);
      expect(text).toContain(PHONE);
      expect(text).toContain(MASKED); // the masked form stays alongside
    });
  }
});

describe('nobody else gets it either', () => {
  it('outside any request (sockets, logs, public pages) a document serialises masked', () => {
    for (const d of Object.values(docs())) {
      const text = JSON.stringify(d);
      for (const leak of LEAKS) expect(text).not.toContain(leak);
    }
  });

  it('a fleet-partner Owner (synthesized role owner, not a CRM user) is not given full numbers by the viewer', () => {
    // protectOwner never sets a viewer; only CRM User logins do.
    expect(fullPhone(PHONE)).toBeUndefined();
    runAsViewer({ role: 'telecaller' }, () => expect(fullPhone(PHONE)).toBeUndefined());
    runAsViewer({ role: 'driver' }, () => expect(fullPhone(PHONE)).toBeUndefined());
    runAsViewer({ role: 'owner' }, () => expect(fullPhone(`91${PHONE}`)).toBe(PHONE));
  });

  it('a driver is refused the operations endpoints outright', async () => {
    expect((await get('driver', '/doc/trip')).status).toBe(403);
  });
});
