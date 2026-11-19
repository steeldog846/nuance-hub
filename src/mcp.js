// Model Context Protocol endpoint (Streamable HTTP transport, JSON responses).
// MCP is the open standard most AI platforms use to plug in outside tools:
// Claude (desktop, web, Claude Code), ChatGPT connectors, Microsoft Copilot
// Studio, Cursor, VS Code, Gemini CLI, and agent frameworks such as the
// OpenAI Agents SDK and LangChain. One endpoint therefore reaches all of them.

import { INTENTS, EMOTIONS, DIFFICULTY_TYPES } from './taxonomy.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const MCP_TOOLS = [
  {
    name: 'ask_humans_about_message',
    title: 'Ask people what a message really meant',
    description:
      'Use when you cannot tell what a person really meant or felt: possible sarcasm, irony, a joke, ' +
      'passive aggression, hidden frustration, slang or a cultural expression. Returns an instant best ' +
      'guess and opens the question to human reviewers; check back later with check_human_answer. ' +
      'Only send conversations the person agreed to have reviewed, and remove names first.',
    inputSchema: {
      type: 'object',
      properties: {
        utterance: { type: 'string', description: 'The exact message you did not understand.' },
        context: {
          type: 'array',
          description: 'The turns just before it, oldest first (up to 20).',
          items: {
            type: 'object',
            properties: { speaker: { type: 'string', enum: ['ai', 'human'] }, text: { type: 'string' } },
            required: ['speaker', 'text'],
          },
        },
        question: { type: 'string', description: 'What you want to know, e.g. "Is this sarcastic?"' },
        agent_guess: { type: 'string', description: 'Your own best guess, if any.' },
        difficulty: { type: 'string', enum: DIFFICULTY_TYPES },
        locale: { type: 'string', description: 'Language/region code such as en, en-IN, hi, es-MX.' },
        consent: { type: 'boolean', description: 'Must be true: the person agreed to have this reviewed by humans.' },
      },
      required: ['utterance', 'consent'],
    },
  },
  {
    name: 'check_human_answer',
    title: 'Get the human answer to an earlier question',
    description: 'Returns the status (open, resolved, disputed) and, once people have answered, the agreed intent, emotion, vote breakdown and their explanations.',
    inputSchema: { type: 'object', properties: { query_id: { type: 'string' } }, required: ['query_id'] },
  },
  {
    name: 'find_similar_answers',
    title: 'Look up how people read similar messages',
    description: 'Searches messages people have already settled, without asking a new question. Try this first.',
    inputSchema: {
      type: 'object',
      properties: { utterance: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['utterance'],
    },
  },
  {
    name: 'get_learnings',
    title: 'Download settled examples to learn from',
    description: `Settled examples from every connected AI, each with the human-agreed intent (${INTENTS.slice(0, 4).join(', ')}, …) and emotion (${EMOTIONS.slice(0, 4).join(', ')}, …).`,
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'ISO timestamp; only newer examples.' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
    },
  },
];

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// service: { createQuery(agent, body), getQuery(agent, id), similar(utterance, limit), learnings(since, limit) }
export async function handleMcpMessage(msg, agent, service) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification: nothing to send back

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nuance-hub', title: 'Nuance Hub', version: '0.2.0' },
        instructions:
          'When a person\'s tone or meaning is unclear (sarcasm, irony, jokes, hidden emotion), call find_similar_answers, ' +
          'then ask_humans_about_message if nothing matches. Treat the instant answer as a guess until check_human_answer says resolved.',
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call':
      return rpcResult(id, await callTool(params.name, params.arguments || {}, agent, service));
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function callTool(name, args, agent, service) {
  try {
    let data;
    if (name === 'ask_humans_about_message') {
      data = await service.createQuery(agent, {
        utterance: args.utterance, context: args.context, question: args.question,
        agentGuess: args.agent_guess, difficulty: args.difficulty, locale: args.locale, consent: args.consent,
      });
    } else if (name === 'check_human_answer') {
      data = service.getQuery(agent, args.query_id);
    } else if (name === 'find_similar_answers') {
      data = { matches: service.similar(args.utterance, args.limit) };
    } else if (name === 'get_learnings') {
      data = { learnings: service.learnings(args.since, args.limit) };
    } else {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
}
