// ═══════════════════════════════════════════════
// NEXUS Core — Cloudflare Worker
// AI:     Groq — llama-3.3-70b-versatile (free)
// Memory: Supabase — messages, facts, app_state
// Tools:  datetime, calculate, fetch_url, notes, web_search
// Agents: advisor, planner, researcher, analyst
//
// Secrets (wrangler secret put <NAME>):
//   GROQ_API_KEY
//   SUPABASE_URL
//   SUPABASE_KEY
//   TAVILY_API_KEY  (optional — enables web search)
// ═══════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://zaidkhan1009.github.io';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const m = request.method;
    const p = url.pathname;

    if (m === 'POST'  && p === '/chat')            return handleChat(request, env);
    if (m === 'POST'  && p === '/insights')        return handleInsights(request, env);
    if (m === 'GET'   && p === '/history')         return handleHistory(request, env);
    if (m === 'POST'  && p === '/history/clear')   return handleHistoryClear(request, env);
    if (m === 'POST'  && p === '/state')           return handleStateSave(request, env);
    if (m === 'GET'   && p === '/state')           return handleStateLoad(request, env);
    if (m === 'GET'   && p === '/tools')           return handleToolsList(request, env);
    if (m === 'PATCH' && p.startsWith('/tools/'))  return handleToolUpdate(request, env, p.split('/')[2]);
    if (m === 'GET'   && p === '/agents')           return handleAgentsList(request, env);
    if (m === 'PATCH' && p.startsWith('/agents/'))  return handleAgentUpdate(request, env, p.split('/')[2]);
    if (m === 'GET'   && p === '/nudges')           return handleNudgesList(request, env);
    if (m === 'POST'  && p === '/nudges/generate')  return handleNudgesGenerate(request, env);
    if (m === 'PATCH' && p.startsWith('/nudges/'))  return handleNudgeDismiss(request, env, p.split('/')[2]);
    if (m === 'POST'  && p === '/telegram')         return handleTelegram(request, env);
    if (m === 'GET'   && p === '/github')           return handleGitHub(request, env);
    if (m === 'GET'   && p === '/calendar')         return handleCalendar(request, env);

    return new Response('Not found', { status: 404 });
  }
};

// ── Supabase helpers ──────────────────────────────
async function sb(env, path, options = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...options.headers,
    },
  });
}

async function loadMessages(env, limit = 40) {
  const res = await sb(env, `messages?order=created_at.asc&limit=${limit}`);
  if (!res.ok) return [];
  return res.json();
}

async function saveMessage(env, role, content) {
  await sb(env, 'messages', { method: 'POST', body: JSON.stringify({ role, content }) });
}

async function loadFacts(env) {
  const res = await sb(env, 'facts?order=created_at.desc&limit=60');
  if (!res.ok) return [];
  return res.json();
}

async function saveFacts(env, facts) {
  if (!facts?.length) return;
  await sb(env, 'facts', { method: 'POST', body: JSON.stringify(facts) });
}

async function loadEnabledTools(env) {
  const res = await sb(env, 'tools?enabled=eq.true');
  if (!res.ok) return [];
  return res.json();
}

// ── Agent routing ─────────────────────────────────
function classifyIntent(message) {
  const m = message.toLowerCase();
  if (/\b(plan|steps|roadmap|action plan|how do i|break.?down|strategy for|what should i do first|guide me)\b/.test(m)) return 'planner';
  if (/\b(search|look up|find out|research|what is|what are|current price|latest news|tell me about|who is)\b/.test(m)) return 'researcher';
  if (/\b(analys|analyse|profit|revenue|financ|numbers|calculate my|compare|trend|how much|roi|margin|breakdown of)\b/.test(m)) return 'analyst';
  return 'advisor';
}

const AGENT_FALLBACKS = {
  advisor:    { name: 'advisor',    icon: '◎', color: '#6c63ff', system_prompt: null, tools: [] },
  planner:    { name: 'planner',    icon: '◈', color: '#38bdf8', system_prompt: null, tools: [] },
  researcher: { name: 'researcher', icon: '◐', color: '#34d399', system_prompt: null, tools: [] },
  analyst:    { name: 'analyst',    icon: '◉', color: '#fb923c', system_prompt: null, tools: [] },
};

async function loadAgent(env, name) {
  try {
    const res = await sb(env, `agents?name=eq.${name}&enabled=eq.true`, {
      headers: { 'Prefer': 'return=representation' },
    });
    if (!res.ok) return AGENT_FALLBACKS[name] || AGENT_FALLBACKS.advisor;
    const rows = await res.json();
    return rows[0] || AGENT_FALLBACKS[name] || AGENT_FALLBACKS.advisor;
  } catch {
    return AGENT_FALLBACKS[name] || AGENT_FALLBACKS.advisor;
  }
}

// ── Tool definitions ──────────────────────────────
const TOOL_DEFS = {
  get_datetime: {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Get the current date, time, and day of week.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  calculate: {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression. Use for calculations, percentages, financial projections.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Math expression e.g. "15% of 50000"' } },
        required: ['expression'],
      },
    },
  },
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and read content from a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  save_note: {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a note, reminder or important information for later retrieval.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    },
  },
  get_notes: {
    type: 'function',
    function: {
      name: 'get_notes',
      description: 'Retrieve all previously saved notes and reminders.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, news, prices, or facts.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
};

// ── Tool implementations ──────────────────────────
function getCurrentDateTime() {
  const now = new Date();
  return {
    date: now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    dayOfWeek: now.toLocaleDateString('en-IN', { weekday: 'long' }),
    iso: now.toISOString(),
  };
}

function calculate(expression) {
  try {
    const safe = expression.replace(/[^0-9+\-*/().%\s]/g, '');
    const result = Function('"use strict"; return (' + safe + ')')();
    return { expression, result };
  } catch {
    return { error: 'Could not evaluate', expression };
  }
}

async function fetchUrl(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'NEXUS/1.0' } });
    const text = await res.text();
    const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    return { url, content: clean, status: res.status };
  } catch (e) {
    return { error: e.message, url };
  }
}

async function saveNote(env, content) {
  await sb(env, 'notes', { method: 'POST', body: JSON.stringify({ content }) });
  return { saved: true, content };
}

async function getNotes(env) {
  const res = await sb(env, 'notes?order=created_at.desc&limit=20');
  if (!res.ok) return { notes: [] };
  const notes = await res.json();
  return { notes: notes.map(n => ({ id: n.id, content: n.content, date: n.created_at.slice(0, 10) })) };
}

async function webSearch(env, query) {
  if (!env.TAVILY_API_KEY) return { error: 'Web search not configured. Set TAVILY_API_KEY secret.' };
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: 5, search_depth: 'basic' }),
    });
    if (!res.ok) return { error: 'Search failed' };
    const data = await res.json();
    return { results: data.results?.map(r => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 300) })) || [] };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeTool(env, name, args) {
  switch (name) {
    case 'get_datetime': return getCurrentDateTime();
    case 'calculate':    return calculate(args.expression);
    case 'fetch_url':    return fetchUrl(args.url);
    case 'save_note':    return saveNote(env, args.content);
    case 'get_notes':    return getNotes(env);
    case 'web_search':   return webSearch(env, args.query);
    default:             return { error: `Unknown tool: ${name}` };
  }
}

// ── Groq call ─────────────────────────────────────
async function callGroq(env, messages, tools = []) {
  const body = {
    model: 'llama-3.3-70b-versatile',
    messages,
    temperature: 0.7,
    max_tokens: 1024,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── /chat  (multi-agent agentic loop) ────────────
async function handleChat(request, env) {
  try {
    const { message, systemPrompt } = await request.json();

    // Classify intent → pick agent, load data in parallel
    const agentName = classifyIntent(message);
    const [history, facts, agent, enabledTools] = await Promise.all([
      loadMessages(env, 30),
      loadFacts(env),
      loadAgent(env, agentName),
      loadEnabledTools(env),
    ]);

    // Enrich prompt with facts
    const factsBlock = facts.length
      ? `\n\nKNOWN FACTS ABOUT UMAR:\n${facts.map(f => `- [${f.tag}] ${f.text}`).join('\n')}`
      : '';

    // Use agent's own system prompt if available, else fall back to frontend's
    const agentPrompt = (agent.system_prompt || systemPrompt) + factsBlock;

    // Filter tools to those the agent is allowed to use
    const agentToolNames = agent.tools || [];
    const tools = enabledTools
      .filter(t => !agentToolNames.length || agentToolNames.includes(t.name))
      .map(t => TOOL_DEFS[t.name])
      .filter(Boolean);

    const messages = [
      { role: 'system', content: agentPrompt },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // Agentic loop — up to 5 tool rounds
    let reply = '';
    for (let i = 0; i < 5; i++) {
      const res = await callGroq(env, messages, tools);
      const choice = res.choices[0];

      if (choice.finish_reason === 'tool_calls') {
        messages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          const result = await executeTool(env, tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else {
        reply = choice.message.content;
        break;
      }
    }

    await saveMessage(env, 'user', message);
    await saveMessage(env, 'assistant', reply);
    extractAndSaveFacts(env, message, reply).catch(() => {});

    return json({
      text: reply,
      agent: { name: agent.name, icon: agent.icon, color: agent.color },
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /history ──────────────────────────────────────
async function handleHistory(request, env) {
  try {
    return json({ messages: await loadMessages(env, 60) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleHistoryClear(request, env) {
  try {
    await sb(env, 'messages?id=gt.0', { method: 'DELETE' });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /insights ─────────────────────────────────────
async function handleInsights(request, env) {
  try {
    const { context, systemPrompt } = await request.json();
    const res = await callGroq(env, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
    ]);
    return json({ text: res.choices[0].message.content });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /state ────────────────────────────────────────
async function handleStateSave(request, env) {
  try {
    const data = await request.json();
    await sb(env, 'app_state', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: 1, data, updated_at: new Date().toISOString() }),
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleStateLoad(request, env) {
  try {
    const res = await sb(env, 'app_state?id=eq.1', { headers: { 'Prefer': 'return=representation' } });
    if (!res.ok) return json({ data: null });
    const rows = await res.json();
    return json({ data: rows[0]?.data ?? null });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /tools ────────────────────────────────────────
async function handleToolsList(request, env) {
  try {
    const res = await sb(env, 'tools?order=name.asc', { headers: { 'Prefer': 'return=representation' } });
    if (!res.ok) return json({ tools: [] });
    return json({ tools: await res.json() });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleToolUpdate(request, env, name) {
  try {
    await sb(env, `tools?name=eq.${name}`, { method: 'PATCH', body: JSON.stringify(await request.json()) });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /agents ───────────────────────────────────────
async function handleAgentsList(request, env) {
  try {
    const res = await sb(env, 'agents?order=name.asc', { headers: { 'Prefer': 'return=representation' } });
    if (!res.ok) return json({ agents: [] });
    return json({ agents: await res.json() });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleAgentUpdate(request, env, name) {
  try {
    await sb(env, `agents?name=eq.${name}`, { method: 'PATCH', body: JSON.stringify(await request.json()) });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── Background: extract facts ─────────────────────
async function extractAndSaveFacts(env, userMessage, aiReply) {
  const res = await callGroq(env, [{
    role: 'user',
    content: `Extract specific, durable facts about the user (Umar) from this exchange. Only personal, long-lasting info: preferences, goals, constraints, key decisions.

User: ${userMessage}
AI: ${aiReply}

JSON only: {"facts": [{"text": "...", "tag": "preference|goal|constraint|fact|decision"}]}
Nothing to save? Return: {"facts": []}`,
  }]);
  try {
    const parsed = JSON.parse(res.choices[0].message.content);
    if (parsed.facts?.length) await saveFacts(env, parsed.facts);
  } catch {}
}

// ── /telegram ─────────────────────────────────────
const DEFAULT_SYSTEM = "You are NEXUS, Umar's personal AI assistant. Be concise and direct. Use ₹ for Indian currency.";

async function handleTelegram(request, env) {
  try {
    const body = await request.json();
    const msg = body.message || body.edited_message;
    if (!msg?.text) return json({ ok: true });

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);

    // Auth — only allow configured Telegram ID
    if (env.TELEGRAM_ALLOWED_ID && userId !== String(env.TELEGRAM_ALLOWED_ID)) {
      await tgSend(env, chatId, '⛔ Unauthorized.');
      return json({ ok: true });
    }

    const text = msg.text;
    const agentName = classifyIntent(text);
    const [history, facts, agent, tools] = await Promise.all([
      loadMessages(env, 20),
      loadFacts(env),
      loadAgent(env, agentName),
      loadEnabledTools(env),
    ]);

    const factsBlock = facts.length
      ? `\n\nKNOWN FACTS:\n${facts.map(f => `- [${f.tag}] ${f.text}`).join('\n')}` : '';
    const prompt = (agent.system_prompt || DEFAULT_SYSTEM) + factsBlock;
    const agentToolNames = agent.tools || [];
    const toolDefs = tools
      .filter(t => !agentToolNames.length || agentToolNames.includes(t.name))
      .map(t => TOOL_DEFS[t.name]).filter(Boolean);

    const messages = [
      { role: 'system', content: prompt },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];

    let reply = '';
    for (let i = 0; i < 5; i++) {
      const res = await callGroq(env, messages, toolDefs);
      const choice = res.choices[0];
      if (choice.finish_reason === 'tool_calls') {
        messages.push(choice.message);
        for (const tc of choice.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          const result = await executeTool(env, tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else { reply = choice.message.content; break; }
    }

    await saveMessage(env, 'user', `[TG] ${text}`);
    await saveMessage(env, 'assistant', reply);
    extractAndSaveFacts(env, text, reply).catch(() => {});

    await tgSend(env, chatId, `${agent.icon} *${agent.name.toUpperCase()}*\n\n${reply}`);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function tgSend(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

// ── /github ───────────────────────────────────────
async function handleGitHub(_request, env) {
  try {
    const user = env.GITHUB_USERNAME || 'zaidkhan1009';
    const headers = { 'User-Agent': 'NEXUS/1.0', 'Accept': 'application/vnd.github.v3+json' };
    if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;

    const [evRes, repoRes] = await Promise.all([
      fetch(`https://api.github.com/users/${user}/events/public?per_page=15`, { headers }),
      fetch(`https://api.github.com/users/${user}/repos?sort=updated&per_page=6`, { headers }),
    ]);

    const events = evRes.ok ? await evRes.json() : [];
    const repos  = repoRes.ok ? await repoRes.json() : [];

    const EVENT_LABELS = {
      PushEvent: '⬆ Push', CreateEvent: '✦ Create', PullRequestEvent: '⇄ PR',
      IssuesEvent: '◉ Issue', WatchEvent: '★ Star', ForkEvent: '⑂ Fork',
    };

    const activity = events.slice(0, 8).map(e => ({
      type: EVENT_LABELS[e.type] || e.type.replace('Event', ''),
      repo: e.repo.name.split('/')[1],
      time: e.created_at,
    }));

    const repoList = repos.map(r => ({
      name: r.name, description: r.description,
      stars: r.stargazers_count, updated: r.updated_at,
    }));

    return json({ activity, repos: repoList, user });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /calendar ─────────────────────────────────────
async function handleCalendar(_request, env) {
  try {
    if (!env.CALENDAR_ICS_URL) return json({ events: [], configured: false });
    const res = await fetch(env.CALENDAR_ICS_URL);
    if (!res.ok) return json({ events: [], configured: true, error: 'Fetch failed' });
    const events = parseICS(await res.text());
    return json({ events: events.slice(0, 10), configured: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function parseICS(ics) {
  const events = [];
  const blocks = ics.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const get = key => { const m = blocks[i].match(new RegExp(key + '[^:]*:(.+)')); return m ? m[1].trim() : ''; };
    const title = get('SUMMARY');
    const start = get('DTSTART');
    if (!title || !start) continue;
    const d = start.replace(/[TZ]/g, ' ').trim();
    const iso = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(9,11)||'00'}:${d.slice(11,13)||'00'}:00`).toISOString();
    events.push({ title, start: iso });
  }
  return events
    .filter(e => new Date(e.start) >= new Date(Date.now() - 3_600_000))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ── /nudges ───────────────────────────────────────
async function handleNudgesList(request, env) {
  try {
    const res = await sb(env, 'nudges?dismissed=eq.false&order=priority.desc', {
      headers: { 'Prefer': 'return=representation' },
    });
    if (!res.ok) return json({ nudges: [] });
    return json({ nudges: await res.json() });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleNudgesGenerate(_request, env) {
  try {
    // Load all context in parallel
    const [stateRows, messages, facts] = await Promise.all([
      sb(env, 'app_state?id=eq.1', { headers: { 'Prefer': 'return=representation' } })
        .then(r => r.ok ? r.json() : []),
      loadMessages(env, 30),
      loadFacts(env),
    ]);

    const appData = stateRows[0]?.data || {};
    const ventures  = appData.ventures  || [];
    const tasks     = appData.tasks     || [];
    const decisions = appData.decisions || [];
    const now       = new Date();

    const overdue = tasks.filter(t => !t.done && t.due && new Date(t.due) < now);
    const pending = tasks.filter(t => !t.done);

    const context = [
      `Date: ${now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`,
      `\nVENTURES (${ventures.length}):\n${ventures.map(v => `- ${v.name}: ${v.status||'active'} | ${v.kpi||'-'}`).join('\n')}`,
      `\nTASKS: ${pending.length} pending, ${overdue.length} overdue${overdue.length ? ' ('+overdue.map(t=>t.title).join(', ')+')' : ''}`,
      `\nRECENT DECISIONS:\n${decisions.slice(0,3).map(d=>`- ${d.title}: ${d.outcome||'no outcome yet'}`).join('\n')}`,
      `\nKNOWN FACTS:\n${facts.slice(0,15).map(f=>`- [${f.tag}] ${f.text}`).join('\n')}`,
      `\nRECENT CHAT:\n${messages.slice(-8).map(m=>`${m.role}: ${m.content.slice(0,80)}`).join('\n')}`,
    ].join('');

    const res = await callGroq(env, [
      { role: 'system', content: 'You are NEXUS, a proactive AI assistant for Umar. Generate 4-5 specific, actionable nudges based on his current situation. Be specific — use real venture/task names. Mix types: warnings for overdue items, actions for opportunities, info for patterns. Keep each nudge under 15 words. Return JSON only: {"nudges":[{"text":"...","type":"info|warning|action","priority":1-10}]}' },
      { role: 'user', content: context },
    ]);

    const parsed = JSON.parse(res.choices[0].message.content);
    const nudges = parsed.nudges || [];

    // Replace undismissed nudges with fresh ones
    await sb(env, 'nudges?dismissed=eq.false', { method: 'DELETE' });
    if (nudges.length) {
      await sb(env, 'nudges', { method: 'POST', body: JSON.stringify(nudges) });
    }

    const fresh = await sb(env, 'nudges?dismissed=eq.false&order=priority.desc', {
      headers: { 'Prefer': 'return=representation' },
    });
    return json({ nudges: fresh.ok ? await fresh.json() : [] });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleNudgeDismiss(_request, env, id) {
  try {
    await sb(env, `nudges?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ dismissed: true }) });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── helper ────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
