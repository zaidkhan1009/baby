# NEXUS — Complete Project Context
> Feed this file to Claude Code at the start of any session to get full context.
> Last updated: 2026-03-24

---

## What is NEXUS?

NEXUS is Umar's personal AI command centre — a production-level Jarvis system.
- Owner: **Umar** (GitHub: `zaidkhan1009`, Telegram: `@mumar3`, ID: `803303810`)
- Live URL: **https://zaidkhan1009.github.io/baby/**
- Worker: **https://nexus-core.zaidkhan1009.workers.dev**
- Telegram Bot: **@baby_nexus_bot**
- Repo: public GitHub repo, single branch `main`, deploys to `gh-pages` via GitHub Actions
- Stack: static frontend (single `index.html`) + Cloudflare Worker backend + Supabase DB + Groq AI
- Cost: **$0/month** — all free tiers

---

## Architecture

```
Browser (index.html on GitHub Pages)
    │
    ▼
Cloudflare Worker (nexus-core.zaidkhan1009.workers.dev)
    │
    ├── /chat              POST   → Groq AI (multi-agent, tool calling)
    ├── /history           GET    → Supabase messages table
    ├── /history/clear     POST   → Wipes messages table
    ├── /state             GET    → Supabase app_state (ventures, tasks)
    ├── /state             POST   → Saves app_state
    ├── /insights          POST   → Groq AI (analysis)
    ├── /tools             GET    → Supabase tools table
    ├── /tools/:name       PATCH  → Toggle tool on/off
    ├── /agents            GET    → Supabase agents table
    ├── /agents/:name      PATCH  → Toggle agent on/off
    ├── /nudges            GET    → Supabase nudges table
    ├── /nudges/generate   POST   → Groq AI (proactive nudges)
    ├── /nudges/:id        PATCH  → Dismiss nudge
    ├── /telegram          POST   → Telegram webhook receiver
    ├── /telegram/status   GET    → Telegram bot health check
    ├── /github            GET    → GitHub public API (activity + repos)
    ├── /calendar          GET    → ICS URL parser
    ├── /brief             POST   → Manual trigger: morning brief → Telegram
    ├── /patterns/run      POST   → Manual trigger: weekly pattern analysis
    └── /state/debug       GET    → Raw app_state dump (debug)
    │
    ├── Cron: 0 3 * * *    → Morning brief (daily 8:30am IST)
    │                         + Weekly pattern learning (Sundays only)
    └── Cron: */15 * * * * → Reminder check (fires due reminders via Telegram)
    │
    ▼
Supabase (free PostgreSQL + pgvector)       Groq API (free, llama-3.3-70b)
Cloudflare Workers AI (free, bge-base)      VoiceRSS (free, TTS)
```

---

## File Structure

```
c:\Repo\baby\
├── NEXUS_CONTEXT.md            ← this file (project context for AI)
├── index.html                  ← entire frontend (single file)
├── manifest.json               ← PWA manifest
├── sw.js                       ← Service worker (offline cache)
├── icon.svg                    ← PWA icon
├── worker/
│   ├── index.js                ← Cloudflare Worker (all backend logic, ~900 lines)
│   ├── wrangler.toml           ← Cloudflare config (AI binding, cron triggers)
│   └── package.json
└── .github/
    └── workflows/
        └── deploy.yml          ← injects PASSWORD_HASH, deploys to gh-pages
```

---

## Cloudflare Worker Secrets

All set via `npx wrangler secret put <NAME>` from `c:\Repo\baby\worker\`:

| Secret | Purpose | Status |
|---|---|---|
| `GROQ_API_KEY` | AI inference (Llama 3.3 70B, free) | ✅ Set |
| `SUPABASE_URL` | Database URL | ✅ Set |
| `SUPABASE_KEY` | Supabase service_role key | ✅ Set |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | ✅ Set |
| `TELEGRAM_ALLOWED_ID` | Umar's Telegram user ID: `803303810` | ✅ Set |
| `VOICERSS_API_KEY` | Text-to-speech (free, 350 req/day) | ✅ Set |
| `ELEVENLABS_API_KEY` | TTS (set but unused — blocked on free tier from CF IPs) | ⚠️ Not usable |
| `GEMINI_API_KEY` | Legacy, not used in current worker code | ⚠️ Legacy |
| `TAVILY_API_KEY` | Web search (optional, free 1000/mo) | ⬜ Not set |
| `GITHUB_TOKEN` | GitHub higher rate limits (optional) | ⬜ Not set |
| `CALENDAR_ICS_URL` | Google Calendar ICS link (optional) | ⬜ Not set |

---

## Supabase Tables

```sql
-- Chat memory
messages        (id IDENTITY, role, content, created_at)

-- Learned facts about Umar (auto-extracted + pattern learning)
-- Has pgvector embedding column for semantic search
facts           (id IDENTITY, text, tag, embedding vector(768), created_at)
-- tags: preference, goal, constraint, fact, decision, pattern

-- App state (ventures, tasks stored as JSONB)
app_state       (id=1 PK, data jsonb, updated_at)

-- Dynamic tool registry
tools           (id IDENTITY, name UNIQUE, description, config, enabled, builtin, created_at)

-- AI agent configs
agents          (id IDENTITY, name, description, system_prompt, tools[], enabled, color, icon, created_at)

-- Proactive nudges shown on dashboard
nudges          (id IDENTITY, text, type, priority, dismissed, created_at)

-- Notes saved by NEXUS during conversations
notes           (id IDENTITY, content, created_at)

-- Time-based reminders (supports recurring/daily)
reminders       (id IDENTITY, text, remind_at timestamptz, fired boolean, recurring boolean, created_at)

-- Soft-delete backups (data moved here before deletion, never permanently lost)
deleted_notes   (id IDENTITY, original_id, content, deleted_at)
deleted_facts   (id IDENTITY, original_id, text, tag, deleted_at)
```

**Supabase RPC function:**
```sql
-- Semantic similarity search over facts (used by /chat and /telegram)
match_facts(query_embedding vector(768), match_count int) → TABLE(id, text, tag, created_at, similarity)
```

All tables have RLS disabled (personal use, protected by service_role key in Worker).

---

## Enabled Tools (Supabase `tools` table)

| Tool | Description |
|---|---|
| `get_datetime` | Current date, time, day of week |
| `calculate` | Math expressions (safely sandboxed) |
| `fetch_url` | Fetch and read any URL |
| `save_note` | Save notes to Supabase |
| `get_notes` | Retrieve saved notes |
| `web_search` | Tavily search (needs `TAVILY_API_KEY`) |

---

## Multi-Agent System

| Agent | Icon | Colour | Triggered by |
|---|---|---|---|
| **Advisor** | ◎ | Purple `#6c63ff` | Default — general questions, advice |
| **Planner** | ◈ | Blue `#38bdf8` | plan, steps, roadmap, strategy, how do I |
| **Researcher** | ◐ | Green `#34d399` | search, look up, research, what is, who is |
| **Analyst** | ◉ | Orange `#fb923c` | analyse, profit, revenue, calculate, numbers |

Routing is keyword-based via `classifyIntent()` — no extra API call.

---

## Telegram Bot Features

### Command System (intercepted before AI pipeline)
Commands are detected via regex in `handleTelegramCommand()`. If matched, the command executes directly against Supabase — no AI call needed.

| Command | What it does |
|---|---|
| `show dashboard` | Ventures + tasks with overdue flags |
| `show tasks` | All tasks (pending/done) from app_state |
| `add task: [title]` | Adds to app_state.tasks (AI extracts title + due date) |
| `done task: [title]` | Marks task complete |
| `show ventures` | All ventures from app_state |
| `add venture: [name]` | Adds to app_state.ventures |
| `show notes` | All notes with IDs |
| `delete note [id]` | Preview → `confirm delete note [id]` → backup + delete |
| `clear all notes` | Preview → `confirm clear all notes` → backup + delete |
| `show facts` | All stored facts with IDs and tags |
| `delete fact [id]` | Preview → `confirm delete fact [id]` → backup + delete |
| `clear all facts` | Preview → `confirm clear all facts` → backup + delete |
| `remind me [text] [time]` | Creates time-based reminder (supports "daily" for recurring) |

If no command matches → falls through to the full AI pipeline (agent routing, tool calling, memory).

### Telegram AI Pipeline
Same as web `/chat` but:
1. Uses `searchFacts(env, text)` — semantic vector search for top 10 relevant facts (instead of loading all)
2. Messages tagged `[TG]` in history for cross-channel memory
3. Leaked function-call syntax stripped from replies before sending
4. Voice: if user message contains "voice", "speak", "audio", "read out" → TTS via VoiceRSS → sent as MP3 audio
5. Auth: only `TELEGRAM_ALLOWED_ID` can use the bot

### Telegram Webhook
- URL: `https://nexus-core.zaidkhan1009.workers.dev/telegram`
- `allowed_updates=["message"]`
- Verify: `https://api.telegram.org/bot{TOKEN}/getWebhookInfo`

---

## Cron Jobs

| Schedule | IST Time | What it does |
|---|---|---|
| `0 3 * * *` | 8:30 AM daily | Morning brief → Telegram (ventures, overdue tasks, nudges, insight) |
| `0 3 * * *` | 8:30 AM Sunday | + Weekly pattern learning (analyses 200 messages → extracts behavioral patterns → saves as facts) |
| `*/15 * * * *` | Every 15 min | Reminder check (fires due reminders, reschedules recurring ones +1 day) |

Manual triggers:
- `POST /brief` — fire morning brief now
- `POST /patterns/run` — run pattern analysis now (returns debug info)

---

## Vector Memory (Phase 8)

- **Embedding model:** Cloudflare Workers AI `@cf/baai/bge-base-en-v1.5` (768 dimensions, free)
- **Storage:** Supabase pgvector — `facts.embedding` column
- **Search:** `match_facts()` RPC — cosine similarity, returns top 10 most relevant facts
- **When saving facts:** embeddings generated automatically via `generateEmbedding()` before insert
- **When chatting:** user message is embedded → semantic search replaces blind "load last 60 facts"
- **Fallback:** if Workers AI or vector search fails, falls back to `loadFacts()` (recency-based)

---

## Voice Output (Phase 10)

- **TTS Provider:** VoiceRSS (free, 350 req/day, no datacenter IP restrictions)
- **Trigger:** user message must contain "voice", "speak", "audio", or "read out"
- **Flow:** AI reply → strip markdown → truncate to 1500 chars → VoiceRSS → MP3 → Telegram `sendAudio`
- **Fallback:** if TTS fails → normal text reply
- **ElevenLabs:** API key is set but unusable — free tier blocks Cloudflare datacenter IPs

---

## App State Structure (`app_state.data` JSONB)

```javascript
{
  ventures: [
    { id: 1, name: "Cloud Kitchen", status: "operational", kpi: null },
    { id: 2, name: "Cafe", status: "planning", kpi: null },
    { id: 3, name: "Poultry Farm", status: "planning", kpi: null }
  ],
  tasks: [
    { id: 1774292906906, title: "Track IP B.Ed entrance exam for Arshi", due: null, done: false }
  ],
  decisions: [
    { id, title, options, chosen, outcome, date }
  ]
}
```

---

## Authentication

- Login screen on `index.html` with password field
- Password hashed with SHA-256 in browser
- Hash injected at **deploy time** via GitHub Actions `sed` command
- Hash stored as GitHub Secret: `PASSWORD_HASH`
- Placeholder `__PASSWORD_HASH__` in `index.html` replaced during CI/CD
- Session stored in `sessionStorage` (cleared on tab close)

---

## Deployment

### Web app (automatic)
```bash
git push  # triggers GitHub Actions → injects hash → deploys to gh-pages
```

### Worker (manual, from worker/ directory)
```bash
cd c:\Repo\baby\worker
npx wrangler deploy
```

### Secrets
```bash
npx wrangler secret put SECRET_NAME
npx wrangler secret list
```

### Tail logs (real-time)
```bash
npx wrangler tail nexus-core --format pretty
```

---

## Phases Completed

| Phase | Name | What was built |
|---|---|---|
| 0 | Auth | SHA-256 login, GitHub Actions deploy, password never in repo |
| 1 | AI Chat | Cloudflare Worker + Groq (llama-3.3-70b), chat UI |
| 2 | Memory | Supabase: messages, facts, app_state. Auto fact extraction |
| 3 | Tools | 6 tools (datetime, calculate, fetch_url, notes, web_search). Agentic loop |
| 4 | Multi-Agent | 4 agents (advisor, planner, researcher, analyst). Keyword routing |
| 5 | Nudges | AI-generated proactive nudges on dashboard |
| 6 | PWA + Voice Input | Installable app, offline cache, microphone via Web Speech API |
| 7 | Integrations | Telegram bot, GitHub activity, Google Calendar |
| 8 | Vector Memory | Semantic fact search via CF Workers AI + Supabase pgvector |
| 9 | Cron | Morning brief (daily), reminder system (every 15 min) |
| 10 | Voice Output | TTS via VoiceRSS, triggered by keyword in Telegram |
| + | Telegram Commands | Dashboard, tasks, ventures, notes, facts, reminders — all from Telegram |
| + | Data Safety | Delete confirmation flow, soft-delete backups for notes & facts |
| + | Pattern Learning | Weekly behavioural analysis → stored as facts with tag `pattern` |

---

## Known Issues / Gotchas

| Issue | Status | Notes |
|---|---|---|
| ElevenLabs TTS blocked from CF Workers | Won't fix | Free tier blocks datacenter IPs. Using VoiceRSS instead |
| `show dashboard` via AI pipeline hallucinated data | **Fixed** | Now intercepted as a command, reads from real DB |
| `app_state` table didn't exist | **Fixed** | Created manually in Supabase |
| `messages` table didn't exist | **Fixed** | Created manually in Supabase |
| `TELEGRAM_ALLOWED_ID` had wrong value | **Fixed** | Updated to `803303810` |
| Telegram webhook missing `allowed_updates` | **Fixed** | Set to `["message"]` |
| Groq model leaks function-call syntax as text | **Fixed** | Regex sanitiser strips it before sending |
| CF Workers cron doesn't support day-of-week `0` | **Workaround** | Check `getDay() === 0` in code for Sunday-only tasks |
| Web search disabled | Pending | Needs `TAVILY_API_KEY` secret |
| Calendar not configured | Pending | Needs `CALENDAR_ICS_URL` secret |

---

## Future Directions

- **Phase 11 — Email Integration** — Gmail API read/summarise/draft
- **Phase 12 — Decision Intelligence** — track outcomes, learn decision patterns
- **WhatsApp** — possible via WhatsApp Cloud API with a dedicated number ($0 for 1k conversations/mo)
- **Discord** — free, webhook-native, easy to add alongside Telegram
- **SMS via Twilio** — ~$1/mo, natural texting interface

---

## User Profile

- **Name:** Umar
- **GitHub:** `zaidkhan1009`
- **Telegram:** `@mumar3`, ID `803303810`
- **Ventures:** Cloud Kitchen (operational), Cafe (planning), Poultry Farm (planning)
- **Style:** Decisive — says "do it", prefers action over discussion
- **Tech level:** Comfortable with Git, CLI, secrets, GitHub Actions
- **Currency:** ₹ (Indian Rupees)

---

## Cost Summary

| Service | Plan | Monthly Cost |
|---|---|---|
| GitHub Pages | Free | $0 |
| Cloudflare Workers | Free (100K req/day) | $0 |
| Cloudflare Workers AI | Free (10K neurons/day) | $0 |
| Supabase | Free (500MB + pgvector) | $0 |
| Groq API | Free (14,400 req/day) | $0 |
| Telegram Bot API | Free | $0 |
| VoiceRSS | Free (350 req/day) | $0 |
| **Total** | | **$0** |
