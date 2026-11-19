// Model Context Protocol endpoint (Streamable HTTP transport, JSON responses).
// MCP is the open standard most AI platforms use to plug in outside tools:
// Claude (desktop, web, Claude Code), ChatGPT connectors, Microsoft Copilot
// Studio, Cursor, VS Code, Gemini CLI, and agent frameworks such as the
// OpenAI Agents SDK and LangChain. One endpoint therefore reaches all of them.

import { INTENTS, EMOTIONS, DIFFICULTY_TYPES, REACTIONS } from './taxonomy.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const turns = {
  type: 'array',
  description: 'The turns just before it, oldest first (up to 20).',
  items: {
    type: 'object',
    properties: { speaker: { type: 'string', enum: ['ai', 'human'] }, text: { type: 'string' } },
    required: ['speaker', 'text'],
  },
};

export const MCP_TOOLS = [
  {
    name: 'quick_check_meaning',
    title: 'Check what the person meant, with one-tap choices',
    description:
      'Call this right AFTER the person replies, only when you are unsure whether they are sincere, sarcastic, joking, ' +
      'annoyed and so on. Never ask in advance. It returns what people in similar situations meant. If shouldAsk is false, ' +
      'act on "suggested" without bothering the person. If shouldAsk is true, show them "prompt" with the short options ' +
      '(as buttons or a numbered list, plus "Something else"; they may pick several), optionally the feelingOptions, ' +
      'and pass their picks to record_user_choice. "typing" says how the message was typed (CAPITALS, mOcKiNg case, ' +
      '"!!!"), which changes the meaning. Pass the message exactly as typed; never change its capitals. ' +
      '"whatWorked" lists replies that helped others in the same spot.',
    inputSchema: {
      type: 'object',
      properties: {
        utterance: { type: 'string', description: "The person's message you are unsure about, exactly as typed (keep CAPITALS, !!!, emoji)." },
        context: turns,
        locale: { type: 'string' },
        consent: { type: 'boolean', description: 'Must be true: the person agreed their anonymous answers help AIs learn.' },
      },
      required: ['utterance', 'consent'],
    },
  },
  {
    name: 'record_user_choice',
    title: 'Record what the person tapped',
    description:
      'People may tap several meanings (e.g. sarcastic AND teasing) and several feelings. Send every option id they ' +
      'picked (o1, o2, o3, or "other" with their words if they typed any), plus any feeling ids (f1, f2, ...).',
    inputSchema: {
      type: 'object',
      properties: {
        check_id: { type: 'string' },
        option_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        feelings: { type: 'array', items: { type: 'string' } },
        other_text: { type: 'string' },
      },
      required: ['check_id', 'option_ids'],
    },
  },
  {
    name: 'record_reaction',
    title: 'Record how your reply landed',
    description:
      `After you reply, offer the person three taps: ${Object.values(REACTIONS).map((r) => `"${r}"`).join(', ')}. ` +
      'Send their pick and your reply. This teaches every AI what to say next time, and stops silent guesses that go wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        check_id: { type: 'string' },
        reaction: { type: 'string', enum: Object.keys(REACTIONS) },
        ai_response: { type: 'string', description: 'What you replied after the check.' },
      },
      required: ['check_id', 'reaction'],
    },
  },
  {
    name: 'ask_humans_about_message',
    title: 'Ask people what a message really meant',
    description:
      'For harder cases, or when you cannot ask the person: sends the moment to human reviewers. Returns an instant best ' +
      'guess; check back later with check_human_answer. Prefer quick_check_meaning when the person is still in the chat. ' +
      'Only send conversations the person agreed to have reviewed, and remove names first.',
    inputSchema: {
      type: 'object',
      properties: {
        utterance: { type: 'string', description: 'The exact message you did not understand.' },
        context: turns,
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
        serverInfo: { name: 'nuance-hub', title: 'Nuance Hub', version: '0.3.0' },
        instructions:
          'When a person\'s reply leaves you unsure of their tone or meaning (sarcasm, irony, a joke, hidden annoyance), call ' +
          'quick_check_meaning AFTER they reply. If it says shouldAsk=false, act on the suggestion. Otherwise show the short ' +
          'options, record their tap with record_user_choice, reply, then offer the three reaction taps and call record_reaction. ' +
          'Keep it light: never more than one quick check per reply, and never make the person type.',
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
    if (name === 'quick_check_meaning') {
      data = await service.createCheck(agent, { utterance: args.utterance, context: args.context, locale: args.locale, consent: args.consent });
    } else if (name === 'record_user_choice') {
      const optionIds = args.option_ids || (args.option_id ? [args.option_id] : []);
      data = await service.answerCheck(service.getCheck(agent, args.check_id), { optionIds, feelings: args.feelings, otherText: args.other_text });
    } else if (name === 'record_reaction') {
      data = service.reactToCheck(service.getCheck(agent, args.check_id), { reaction: args.reaction, aiResponse: args.ai_response });
    } else if (name === 'ask_humans_about_message') {
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
