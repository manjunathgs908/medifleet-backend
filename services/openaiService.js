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

async function askAstra(prompt) {
  const openai = getOpenAIClient();

  const response = await openai.responses.create({
    model: 'gpt-6-astra',
    input: prompt,
    reasoning: {
      effort: 'low',
    },
  });

  return response.output_text;
}

module.exports = {
  askAstra,
};