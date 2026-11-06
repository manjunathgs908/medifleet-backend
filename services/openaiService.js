'use strict';

const OpenAI = require('openai');

let openaiClient = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openaiClient;
}

// instructions (optional): the system rules, sent separately from `input`
// so text a customer typed is never read as part of the rules.
async function askAstra(prompt, { instructions } = {}) {
  const openai = getOpenAIClient();

  const response = await openai.responses.create({
    model: 'gpt-6-astra',
    ...(instructions ? { instructions } : {}),
    input: prompt,
    reasoning: {
      effort: 'low',
    },
  });

  return response.output_text;
}

// Strict-JSON answer: the reply must match `schema` (OpenAI structured
// outputs, strict), parsed here. The rules go in `instructions`, the data
// (a call transcript) in `input`, so the data is never read as rules.
async function extractJson({ instructions, input, schema, name = 'extraction', model = 'gpt-6-astra' }) {
  const openai = getOpenAIClient();

  const response = await openai.responses.create({
    model,
    instructions,
    input,
    reasoning: { effort: 'low' },
    text: { format: { type: 'json_schema', name, schema, strict: true } },
  });

  return JSON.parse(response.output_text);
}

module.exports = {
  askAstra,
  extractJson,
};