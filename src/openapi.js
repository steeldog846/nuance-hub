// OpenAPI 3.1 description of the agent API. Paste its URL into:
//   ChatGPT  → custom GPT → Actions → Import from URL
//   Gemini / Vertex AI, Microsoft Copilot Studio, Amazon Bedrock agents,
//   LangChain, LlamaIndex, Semantic Kernel → any "OpenAPI tool" loader.

import { INTENTS, EMOTIONS, DIFFICULTY_TYPES, MODALITIES, PLATFORMS } from './taxonomy.js';

const Turn = {
  type: 'object',
  properties: { speaker: { type: 'string', enum: ['ai', 'human'] }, text: { type: 'string' } },
  required: ['speaker', 'text'],
};

const Consensus = {
  type: ['object', 'null'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    emotion: { type: 'string', enum: EMOTIONS },
    intensity: { type: 'number' },
    intentDistribution: { type: 'object', additionalProperties: { type: 'number' } },
    emotionDistribution: { type: 'object', additionalProperties: { type: 'number' } },
    agreement: { type: 'number' },
    labelCount: { type: 'integer' },
    explanations: { type: 'array', items: { type: 'string' } },
    resolved: { type: 'boolean' },
  },
};

const Query = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['open', 'resolved', 'disputed'] },
    utterance: { type: 'string' },
    platform: { type: 'string' },
    appAnswer: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['precedent', 'llm', 'heuristic'] },
        intent: { type: 'string' }, emotion: { type: 'string' },
        confidence: { type: 'number' }, explanation: { type: 'string' },
      },
    },
    consensus: Consensus,
  },
};

export function openApiSpec(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Nuance Hub',
      version: '0.2.0',
      description: 'Ask people what a message really meant (sarcasm, irony, emotion, intent) and learn from their answers.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
      schemas: { Turn, Query, Consensus },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/api/v1/queries': {
        post: {
          operationId: 'askHumansAboutMessage',
          summary: 'Ask people what a message really meant',
          description: 'Use when you cannot tell if the person is sincere, sarcastic, joking or upset. Returns an instant guess; people then review it.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    utterance: { type: 'string' },
                    context: { type: 'array', items: { $ref: '#/components/schemas/Turn' } },
                    question: { type: 'string' },
                    agentGuess: { type: 'string' },
                    difficulty: { type: 'string', enum: DIFFICULTY_TYPES },
                    modality: { type: 'string', enum: MODALITIES },
                    locale: { type: 'string' },
                    consent: { type: 'boolean', description: 'Must be true: the person agreed to human review.' },
                  },
                  required: ['utterance', 'consent'],
                },
              },
            },
          },
          responses: { 201: { description: 'Question created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Query' } } } } },
        },
      },
      '/api/v1/queries/{id}': {
        get: {
          operationId: 'checkHumanAnswer',
          summary: 'Get the status and human answer for a question',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'The question', content: { 'application/json': { schema: { $ref: '#/components/schemas/Query' } } } } },
        },
      },
      '/api/v1/similar': {
        get: {
          operationId: 'findSimilarAnswers',
          summary: 'See how people read similar messages, without asking a new question',
          parameters: [
            { name: 'utterance', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10 } },
          ],
          responses: { 200: { description: 'Matches', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/v1/learnings': {
        get: {
          operationId: 'getLearnings',
          summary: 'Settled examples from every connected AI',
          parameters: [
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: { 200: { description: 'Examples', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/agents/register': {
        post: {
          operationId: 'registerAgent',
          summary: 'Register an AI agent and get an API key',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    platform: { type: 'string', enum: PLATFORMS },
                    description: { type: 'string' },
                    webhookUrl: { type: 'string', format: 'uri' },
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: { 201: { description: 'Registered; returns apiKey once' } },
        },
      },
    },
  };
}
