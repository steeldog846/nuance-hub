# Nuance Hub

**Where any AI goes to ask people what a conversation really meant.**

Nuance Hub isn't tied to one company. Claude, ChatGPT, Gemini, Copilot, Pi Network
apps, open-source models and custom agents all connect the same way, and every one
of them learns from what people teach the others.

AI assistants often can't tell whether "Oh great, another Monday" is happy or
sarcastic, or whether "fine." means fine.

## The main flow: one tap, inside the conversation

People won't type out what an AI got wrong, so they don't have to.

1. The person replies as usual. **Only if** the AI is unsure what they meant, it
   calls Nuance Hub, *after* the reply, never in advance.
2. Nuance Hub sends back **two or three short choices** in plain words
   ("I was being sarcastic 🙄", "I meant it 😐", "Just joking 😄", "Something else"),
   **ranked by what earlier people in similar situations meant**, plus an optional row
   of feelings ("😠 angry", "😏 cocky", "😄 amused"…).
3. The person **taps everything that fits** (being sarcastic *and* teasing, angry *and*
   hurt) and presses Done. The AI replies with that in mind, using `whatWorked`:
   replies that helped other people in the same spot.
4. One more tap on how the reply landed: "That helped", "Still missed the
   point" or "Right idea, wrong tone".
5. **How it was typed counts.** The message is kept exactly as typed, and the hub notices
   CAPITALS on a word ("late AGAIN"), ALL CAPS, mOcKiNg case, "!!!" and stretched words
   ("sooo"). It learns separately what people mean when they type each way: normal and
   all-lowercase typing share lessons, but a shouted or mocking version of the same words
   is a new situation until enough people have answered for it. Typing style also shapes
   the suggested feelings (all caps → angry, frustrated) and the suggested intensity.
6. **It gets better with every person.** Once 5 people in similar situations
   agree (80% or more), the AI stops asking and acts on what it learned
   (`shouldAsk: false`). If those silent guesses start missing, it asks again.
   "Something else" answers go to the human community to work out.

The Community tab tracks this: how often the AI had to ask at the start versus lately.
Every tap is the speaker's own answer, so it goes straight into the shared learnings
for every connected AI.

If an AI can't show buttons, it sends the person `tapUrl`, a one-screen page with
the same choices.

## In their own words

Every place people answer has two boxes: **"Or say it your way"** (meaning) and **"Or your
own feeling"**. People can tap, type, or both. Built for everyday typing and for people
who don't read or write much:

* Choices start with an emoji (😠 angry, 🙄 I was being sarcastic) so they can be
  recognised at a glance.
* Typed words are read automatically (`src/interpret.js`): spelling mistakes ("angery",
  "seriuos"), no punctuation, emoji ("😡😡"), "not"/"nahi" ("gussa nahi tha"), and common
  Hinglish words ("gussa", "mazak", "taana", "pareshan", "khush"…).
* The words are always kept exactly as written, and learned from.
* **Words several people use become a tap option** for the next person in a similar
  situation ("💬 taana mar raha tha"), on both the meanings and feelings rows.
* Words nobody can read yet are recorded as-is and sent to the community to work out.
* All-lowercase typing is treated as normal, not as a signal.

## Claude

With `ANTHROPIC_API_KEY` set and `npm install` run, Claude does two jobs (`src/claude.js`):

1. **The instant first guess** for every quick check and community question, taking the
   conversation and how the message was typed (CAPITALS, "!!!") into account.
2. **Reading people's own words** in any language or script (Hindi, Telugu, Tamil,
   Hinglish, Spanish…), with slang, spelling mistakes and emoji. It returns the meanings
   and feelings, an English translation, and a short English *gist*. Answers with the same
   gist are grouped, so "taana mar raha tha" and "taana maar rahe the" count as one phrase
   and become one tap option, shown in the spelling most people used.

Details: model `claude-opus-5-5` (change with `NUANCE_MODEL`), low effort to keep it quick,
JSON output checked against the app's label lists, and server-side fallback if Claude
declines. If Claude is unreachable or fails, the built-in rules take over automatically.
`GET /api/health` and the Community tab show whether Claude is connected and the last
problem, if any.

**Where to put the key:** wherever you host the app, set it as the environment variable
`ANTHROPIC_API_KEY` (Render, Fly.io and Railway all have an "environment variables"
setting). Keep it out of the code and out of the browser.

## Several answers at once

Everywhere people answer (quick checks, the tap page, Share a moment, Answer questions),
they can pick several meanings and feelings. Results report, for each one, the share of
people who picked it, and the answer includes every meaning or feeling at least half of
them picked (`intents`, `emotions`), alongside the leading one (`intent`, `emotion`).

## For harder cases: the human community

When the person can't be asked (or picked "Something else"), the moment goes to
people who use the app:

1. **The agent records the moment it didn't understand** (the message, the
   conversation around it, its own guess) and sends it here with a question.
2. **The app answers right away** with its best guess, taken from earlier human
   answers to similar messages, from Claude, or from built-in rules.
3. **People who use the app review it.** They mark what the person meant
   (sincere, sarcastic, joking, passive-aggressive and so on) and how they felt,
   say whether the app's guess was right, and explain the cues in their own words.
   People can also **share their own moments** where an AI misread them: what
   they said, which AI it was, what it got wrong and what they really meant.
   Others then confirm it.
4. **When enough people agree, the question is settled.** The agent is notified
   by webhook, and the example joins a shared dataset that **every connected agent
   can learn from**. If people keep disagreeing, the question is marked
   *disputed*, which is also worth knowing: it means the message really is ambiguous.

```
 Claude · ChatGPT · Gemini · Copilot · Pi apps · any agent
        │  MCP  /  OpenAPI  /  REST
        ▼
 AI agent ──POST /api/v1/queries──▶  Nuance Hub ──instant first answer──▶ AI agent
                                      │   ▲
                         open question│   │labels + explanations
                                      ▼   │
                     Human guides (web app, Pi sign-in) ── share moments
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
| `ANTHROPIC_API_KEY` | Connects Claude (see "Claude" below). Without it the app uses past answers and built-in rules. |
| `NUANCE_MODEL` | Claude model id (default `claude-opus-5-5`) |
| `NUANCE_ADMIN_TOKEN` | If set, registering a new agent requires header `x-admin-token` |
| `NUANCE_DATA_FILE` | Where the JSON database lives (default `nuance/data/db.json`) |
| `PUBLIC_URL` | Public address used in the OpenAPI spec and setup guides (default: taken from the request) |
| `PI_API_URL` | Pi Platform API used to verify Pi sign-ins (default `https://api.minepi.com`) |

Try the agent side from the command line:

```bash
NUANCE_URL=http://localhost:3000 node examples/agent-client.js
```

## Connecting AI platforms

Three open doors, all using the same API key from `POST /api/agents/register`:

| Door | URL | Who uses it |
|---|---|---|
| **MCP** | `/mcp` | Claude (Claude Code, desktop, claude.ai connectors, Claude API apps), ChatGPT connectors and the OpenAI Agents SDK, Microsoft Copilot Studio, GitHub Copilot in VS Code, Gemini CLI, Cursor, LangChain, LlamaIndex |
| **OpenAPI** | `/openapi.json` | ChatGPT custom GPT Actions, Gemini / Vertex AI agents, Copilot Studio REST tools, Amazon Bedrock agents, Semantic Kernel |
| **REST** | `/api/v1/...` | Pi Network app backends and anything that can send HTTP |

Examples (replace `HUB` with your deployed address and `KEY` with the API key):

```bash
# Claude Code
claude mcp add --transport http nuance HUB/mcp --header "Authorization: Bearer KEY"
```

* **Claude desktop / claude.ai**: Settings → Connectors → Add custom connector → `HUB/mcp?key=KEY`.
* **ChatGPT custom GPT**: Configure → Actions → Import from URL → `HUB/openapi.json`;
  Authentication → API key → Bearer → paste `KEY`.
* **Gemini CLI** (`~/.gemini/settings.json`):
  `{"mcpServers": {"nuance": {"httpUrl": "HUB/mcp", "headers": {"Authorization": "Bearer KEY"}}}}`
* **Pi Network apps**: call the REST API from your app's backend (never the browser).

The **Connect an AI** tab in the web app shows these with your real address and key
filled in.

MCP tools: `quick_check_meaning`, `record_user_choice`, `record_reaction` (the main
flow), plus `ask_humans_about_message`, `check_human_answer`, `find_similar_answers` and
`get_learnings`. The MCP server's instructions tell the AI to check only after an unclear
reply, never make the person type, and act without asking when `shouldAsk` is false. The `?key=` form exists for connector screens that can't set headers;
prefer the header where possible, since URLs can end up in logs.

Some platforms (claude.ai and ChatGPT connectors for whole workspaces) prefer OAuth
sign-in for remote MCP servers. That's on the production list below.

## The web app (for people)

* **Sign in** with a display name, or with **Pi Network** when the site is opened in
  the Pi Browser. Pi sign-ins are verified with Pi's servers.
* **Answer questions**: you see which AI asked (or that a person shared it), then work through questions one by
  one. You see the conversation, the message the AI didn't understand, the AI's
  question and the app's first guess. You don't see other people's answers until
  you've given yours, so they can't sway you.
* **Trust score**: starts at 1.0, goes up when your answer matches the final
  consensus and down when it doesn't. Votes are weighted by trust.
* **Share a moment**: paste what you said and tap what you meant, how you felt and which
  AI it was. More detail is optional. Your answer counts as the first vote.
* **Community**: totals, questions per AI platform, and the most trusted guides.
* **Connect an AI**: register an agent and get copy-paste setup for each platform.

## The API (for AI agents)

All agent calls use `Authorization: Bearer <apiKey>`.

### Register
`POST /api/agents/register`
```json
{ "name": "support-bot", "platform": "chatgpt", "description": "optional", "webhookUrl": "https://you.example/nuance-hook" }
```
`platform` is one of `claude, chatgpt, gemini, copilot, meta_ai, grok, mistral, deepseek,
perplexity, pi_network, open_source, custom, other`.

→ `201 { "id": "agt_…", "apiKey": "nk_…", "connect": { "rest", "mcp", "openapi" } }`.
The key is shown only once.

### Quick check (the main flow)
`POST /api/v1/checks`, after the person's reply, only when unsure:
```json
{ "utterance": "Fantastic, late again.",
  "context": [{ "speaker": "ai", "text": "Your package is delayed by two more days." }],
  "consent": true }
```
→ `201`
```json
{
  "id": "chk_…",
  "shouldAsk": true,
  "reason": "3 people in similar situations agreed so far. Asking until 5 have, to be sure.",
  "prompt": "Quick check so I get this right. Did you mean…",
  "options": [
    { "id": "o1", "label": "I was being sarcastic 🙄", "intent": "sarcastic", "emotion": "annoyed", "learnedShare": 1, "basis": "learned" },
    { "id": "o2", "label": "I meant it 😐", "intent": "sincere", "emotion": "neutral", "learnedShare": null, "basis": "default" },
    { "id": "o3", "label": "Just joking 😄", "intent": "joking", "emotion": "amused", "learnedShare": null, "basis": "default" }
  ],
  "otherOption": { "id": "other", "label": "Something else" },
  "suggested": { "intent": "sarcastic", "emotion": "annoyed", "confidence": 1 },
  "whatWorked": [{ "response": "Sorry, that's genuinely frustrating. I've upgraded you…", "meaning": { "intent": "sarcastic" } }],
  "tapUrl": "https://HUB/c/chk_…",
  "reactions": { "helpful": "That helped", "missed": "Still missed the point", "tone": "Right idea, wrong tone" }
}
```
* `shouldAsk: false` → don't ask; act on `suggested` (which can hold several `intents`/`emotions`, and an `intensity`).
* `typing` describes how the message was typed (`style`: plain, stressed_words, all_caps, all_lower, mocking_case; `emphasis` 0-3; `shoutedWords`; …). Send the message exactly as typed.
* `feelingOptions` (`f1`…`f4`) are the optional feelings row. Options with `basis: "people_said"` (`p1`, `pf1`…) are other people's own words.
* `POST /api/v1/checks/:id/answer` `{ "optionIds": ["o1", "o3"], "feelings": ["f2"], "ownMeaning": "taana mar raha tha", "ownFeeling": "gussa 😡" }`. Any mix works: taps only, words only, or both. The reply includes `understoodOwnWords`.
* Labels and shared moments accept `ownMeaning` / `ownFeeling` the same way.
* `POST /api/v1/checks/:id/reaction` `{ "reaction": "helpful", "aiResponse": "what you replied" }`.
* The hosted tap page uses `GET/POST /api/checks/:id…` without a key; the long random id is the permission.
* Learning settings (how alike situations must be, 5 people, 80%) are in `src/learning.js`.

### Send a hard case to the community
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
* `GET /api/v1/similar?utterance=...`: how people read similar messages, without asking
  a new question.
* `GET /api/v1/learnings?since=2026-11-01T00:00:00Z`: every settled question from all
  platforms and from people's shared moments, as `{ input, label }` training examples. Includes disputed ones, with their
  full vote breakdown.
* `GET /api/v1/dataset.jsonl`: settled examples, one JSON object per line, ready for
  fine-tuning, evals or retrieval.
* **Webhook**: if you registered a `webhookUrl`, it gets
  `POST { event: "query.resolved" | "query.disputed", query, learning }`.

### Endpoints for people (used by the web app)
`POST /api/labelers`, `POST /api/labelers/pi` (`{accessToken}` from `Pi.authenticate`),
`GET /api/me`, `GET /api/tasks/next`, `POST /api/queries/:id/labels`, `POST /api/moments`.

### Other endpoints
`GET /api/taxonomy` (allowed labels and platforms), `GET /api/stats`, `GET /api/health`,
`GET /openapi.json`, `POST /mcp`.

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
| `src/claude.js` | The connection to Claude, with automatic fallback to the built-in rules |
| `src/interpret.js` | Reads people's own words: Claude when connected; otherwise word lists for misspellings, emoji, "not"/"nahi", Hinglish |
| `src/style.js` | Notices how a message was typed: CAPITALS, ALL CAPS, mOcKiNg case, "!!!", "sooo" |
| `src/learning.js` | Quick checks: ranks one-tap choices from past answers, decides when to stop asking |
| `src/mcp.js` | MCP endpoint and tool definitions |
| `src/openapi.js` | OpenAPI spec for GPT Actions, Gemini and others |
| `src/analyzer.js` | Instant first answer: past answers → Claude → rules |
| `src/consensus.js` | Trust-weighted voting and trust updates |
| `src/taxonomy.js` | The shared label set (intents, emotions, …) |
| `src/redact.js` | Removes personal details |
| `src/store.js` | Small JSON-file database |
| `public/` | The web app (`index.html`) and the hosted tap page (`check.html`) |
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
* **Smarter "similar situation" matching**: word overlap works for a prototype; text
  embeddings would match "late again" with "delayed once more", and across languages.
* **Quality control**: add "gold" questions with known answers to measure labelers,
  and show each question to people from different regions and languages. Sarcasm
  is cultural.
* **OAuth for MCP**: add OAuth sign-in on `/mcp` so workspace-wide connectors in
  claude.ai and ChatGPT can attach without putting a key in the URL.
* **Listing**: submit the MCP server to public MCP registries and the GPT to the GPT
  Store so people can find it.
* **Rewards**: pay human guides in Pi per settled answer using Pi payments (the Pi
  page in this repo has the payment flow to build on).
