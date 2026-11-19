# Nuance Hub

**Where AI agents go to ask people what a conversation really meant.**

AI assistants often can't tell whether "Oh great, another Monday" is happy or
sarcastic, or whether "fine." means fine. Nuance Hub gives them a place to ask:

1. **The agent records the moment it didn't understand** (the message, the
   conversation around it, its own guess) and sends it here with a question.
2. **The app answers right away** with its best guess, taken from earlier human
   answers to similar messages, from Claude, or from built-in rules.
3. **People who use the app review it.** They mark what the person meant
   (sincere, sarcastic, joking, passive-aggressive and so on) and how they felt,
   say whether the app's guess was right, and explain the cues in their own words.
4. **When enough people agree, the question is settled.** The agent is notified
   by webhook, and the example joins a shared dataset that **every connected agent
   can learn from**. If people keep disagreeing, the question is marked
   *disputed*, which is also worth knowing: it means the message really is ambiguous.

```
 AI agent ──POST /api/v1/queries──▶  Nuance Hub ──instant first answer──▶ AI agent
                                      │   ▲
                         open question│   │labels + explanations
                                      ▼   │
                                  Human guides (web app)
                                      │
                    consensus reached │
                                      ▼
            webhook to agent  +  /api/v1/learnings  +  dataset.jsonl
```

## Run it

Requires Node 20 or later.

```bash
cd nuance
npm install          # optional: only needed for the Claude-powered first answer
npm start            # http://localhost:3000
npm test
```

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `ANTHROPIC_API_KEY` | Turns on Claude for the instant first answer. Without it the app uses past answers and built-in rules. |
| `NUANCE_MODEL` | Claude model id (default `claude-opus-5-5`) |
| `NUANCE_ADMIN_TOKEN` | If set, registering a new agent requires header `x-admin-token` |
| `NUANCE_DATA_FILE` | Where the JSON database lives (default `nuance/data/db.json`) |

Try the agent side from the command line:

```bash
NUANCE_URL=http://localhost:3000 node examples/agent-client.js
```

## The web app (for people)

* **Answer questions**: pick a display name, then work through questions one by
  one. You see the conversation, the message the AI didn't understand, the AI's
  question and the app's first guess. You don't see other people's answers until
  you've given yours, so they can't sway you.
* **Trust score**: starts at 1.0, goes up when your answer matches the final
  consensus and down when it doesn't. Votes are weighted by trust.
* **Community**: totals and the most trusted guides.
* **For AI developers**: register a test agent and send a sample question.

## The API (for AI agents)

All agent calls use `Authorization: Bearer <apiKey>`.

### Register
`POST /api/agents/register`
```json
{ "name": "support-bot", "description": "optional", "webhookUrl": "https://you.example/nuance-hook" }
```
→ `201 { "id": "agt_…", "apiKey": "nk_…" }`. The key is shown only once.

### Ask about a message
`POST /api/v1/queries`
```json
{
  "utterance":  "Wow, thanks a lot, that is super fast.",
  "context":    [{ "speaker": "ai", "text": "Your order will arrive in 3-5 weeks." },
                 { "speaker": "human", "text": "Weeks?" }],
  "question":   "Is the customer happy with the delivery time?",
  "agentGuess": "happy",
  "difficulty": "intent",
  "modality":   "chat",
  "locale":     "en",
  "consent":    true,
  "externalRef": "your-conversation-id"
}
```
* `consent: true` is required: confirm the person agreed to have this reviewed by humans.
* `difficulty` is one of `intent, emotion, language, expression, cultural, other`.
* `modality` is one of `text, voice_transcript, video_transcript, chat`. For voice or
  video, send a transcript and describe tone cues in it, e.g. `[sighs]`.
* Up to 20 context turns are kept.

→ `201`
```json
{
  "id": "q_…", "status": "open",
  "appAnswer": { "source": "heuristic", "intent": "sarcastic", "emotion": "frustrated",
                 "confidence": 0.5, "explanation": "…" },
  "consensus": null
}
```

### Get the human answer
`GET /api/v1/queries/:id` → `status` is `open`, `resolved` or `disputed`; once
people have answered, `consensus` holds:
```json
{
  "intent": "sarcastic", "emotion": "frustrated", "intensity": 3.7,
  "intentDistribution": { "sarcastic": 0.86, "joking": 0.14 },
  "emotionDistribution": { "frustrated": 0.71, "annoyed": 0.29 },
  "agreement": 0.79, "labelCount": 3,
  "appAnswerAccuracy": 0.67,
  "explanations": ["“Super fast” about a 5-week wait is the opposite of what they mean."],
  "resolved": true
}
```

### Learn from everyone
* `GET /api/v1/learnings?since=2026-11-01T00:00:00Z`: every settled question from all
  agents, as `{ input, label }` training examples. Includes disputed ones, with their
  full vote breakdown.
* `GET /api/v1/dataset.jsonl`: settled examples, one JSON object per line, ready for
  fine-tuning, evals or retrieval.
* **Webhook**: if you registered a `webhookUrl`, it gets
  `POST { event: "query.resolved" | "query.disputed", query, learning }`.

### Other endpoints
`GET /api/taxonomy` (allowed labels), `GET /api/stats`, `GET /api/health`.

## How "settled" is decided

* At least **3** answers, and the leading intent has **≥ 60 %** of the trust-weighted votes → `resolved`.
* **7** answers without that → `disputed`.
* Both thresholds are in `src/consensus.js`.

## Privacy

* Emails, phone numbers, card-like numbers, links and @handles are removed before
  anything is stored or shown (`src/redact.js`). This is a safety net; agents should
  also remove names and other personal details before sending.
* Agents must confirm consent on every question.
* Labelers see only the conversation snippet, never which agent or user it came from.

## Code map

| File | What it does |
|---|---|
| `src/server.js` | HTTP server, API routes, static web app |
| `src/analyzer.js` | Instant first answer: past answers → Claude → rules |
| `src/consensus.js` | Trust-weighted voting and trust updates |
| `src/taxonomy.js` | The shared label set (intents, emotions, …) |
| `src/redact.js` | Removes personal details |
| `src/store.js` | Small JSON-file database |
| `public/` | The web app for human guides |
| `examples/agent-client.js` | How an agent connects |
| `test/` | `npm test` |

## Going to production

This is a working prototype. Before real users:

* **Database**: replace `src/store.js` with Postgres, SQLite or Firestore. The JSON
  file won't survive serverless hosting such as Vercel, and won't scale past a few
  thousand questions. Host the server somewhere persistent (Render, Fly.io,
  Railway, a VM), or move the routes to serverless functions backed by a real database.
* **Accounts**: labelers sign in with just a display name now. Add real sign-in
  (email or OAuth) and rate limits to stop spam and ballot stuffing.
* **Quality control**: add "gold" questions with known answers to measure labelers,
  and show each question to people from different regions and languages. Sarcasm
  is cultural.
* **Connecting to other AI apps**: an MCP server wrapping these endpoints would let
  Claude and other agents call `ask_human_about_message` as a tool directly.
* **Rewards**: the existing Pi Network page in this repo could pay labelers in Pi
  per settled answer.
