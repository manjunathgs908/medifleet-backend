/**
 * tests/whatsappTemplatePayload.test.js
 * ============================================================
 * services/whatsappService.sendTemplateResult — the exact JSON posted to
 * Meta. A fully static template (savelife_pickup: no header, no body
 * variables, a static quick-reply) is sent as { name, language: { code } }
 * with NO `components` key; a template with parameters gets them as given.
 * axios is stubbed: nothing leaves the process.
 * ============================================================
 */
'use strict';

process.env.WA_TOKEN = 'test-token';
process.env.WA_PHONE_NUMBER_ID = '123456789';

jest.mock('axios', () => ({ post: jest.fn(async () => ({ data: { messages: [{ id: 'wamid.T1' }] } })) }));

const axios = require('axios');
const whatsapp = require('../services/whatsappService');

beforeEach(() => axios.post.mockClear());

const posted = () => axios.post.mock.calls[0][1];

test('no components given: the template has no components key at all', async () => {
  const r = await whatsapp.sendTemplateResult('919986844442', 'savelife_pickup', 'en');
  expect(r).toEqual({ ok: true, data: { messages: [{ id: 'wamid.T1' }] } });
  expect(posted()).toEqual({
    messaging_product: 'whatsapp',
    to: '919986844442',
    type: 'template',
    template: { name: 'savelife_pickup', language: { code: 'en' } },
  });
  expect(posted().template).not.toHaveProperty('components');
});

test.each([[undefined], [null], [[]]])('components %p: still no components key', async (components) => {
  await whatsapp.sendTemplateResult('919986844442', 'savelife_pickup', 'en', components);
  expect(posted().template).not.toHaveProperty('components');
});

test('components given (an image header): sent exactly as given', async () => {
  const components = [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.example/b.png' } }] }];
  await whatsapp.sendTemplateResult('919986844442', 'savelife_welcome', 'en', components);
  expect(posted().template).toEqual({ name: 'savelife_welcome', language: { code: 'en' }, components });
});

test('a Meta refusal comes back with its code, never thrown', async () => {
  axios.post.mockRejectedValueOnce({ response: { data: { error: { code: 132001, message: 'Template name does not exist' } } } });
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const r = await whatsapp.sendTemplateResult('919986844442', 'savelife_pickup', 'en');
  spy.mockRestore();
  expect(r).toEqual({ ok: false, error: { code: 132001, message: 'Template name does not exist' } });
});
