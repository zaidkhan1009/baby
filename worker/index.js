// ═══════════════════════════════════════════════
// NEXUS Core — Cloudflare Worker
// AI:     Groq — llama-3.3-70b-versatile (free)
// Memory: Supabase — messages, facts, app_state
// Tools:  datetime, calculate, fetch_url, notes, web_search
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

    if (m === 'POST' && url.pathname === '/chat')          return handleChat(request, env);
    if (m === 'POST' && url.pathname === '/insights')      return handleInsights(request, env);
    if (m === 'GET'  && url.pathname === '/history')       return handleHistory(request, env);
    if (m === 'POST' && url.pathname === '/history/clear') return handleHistoryClear(request, env);
    if (m === 'POST' && url.pathname === '/state')         return handleStateSave(request, env);
    if (m === 'GET'  && url.pathname === '/state')         return handleStateLoad(request, env);
    if (m === 'GET'  && url.pathname === '/tools')         return handleToolsList(request, env);
    if (m === 'PATCH'&& url.pathname.startsWith('/tools/'))return handleToolUpdate(request, env, url.pathname.split('/')[2]);

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
  const res = await sb(env, 'tools?enabled=eq.true&order=name.asc');
  if (!res.ok) return [];
  return res.json();
}

// ── Tool definitions (Groq function calling format) ──
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
        properties: {
          expression: { type: 'string', description: 'Math expression, e.g. "15% of 50000" or "(120000 - 40000) / 12"' },
        },
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
        properties: { url: { type: 'string', description: 'The full URL to fetch' } },
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
        properties: { content: { type: 'string', description: 'The note to save' } },
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
        properties: { query: { type: 'string', description: 'Search query' } },
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
    return { error: 'Could not evaluate expression', expression };
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

// ── Groq call with optional tool support ─────────
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

// ── /chat  (agentic loop) ─────────────────────────
async function handleChat(request, env) {
  try {
    const { message, systemPrompt } = await request.json();

    const [history, facts, enabledTools] = await Promise.all([
      loadMessages(env, 30),
      loadFacts(env),
      loadEnabledTools(env),
    ]);

    const factsBlock = facts.length
      ? `\n\nKNOWN FACTS ABOUT UMAR:\n${facts.map(f => `- [${f.tag}] ${f.text}`).join('\n')}`
      : '';

    const messages = [
      { role: 'system', content: systemPrompt + factsBlock },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const tools = enabledTools.map(t => TOOL_DEFS[t.name]).filter(Boolean);

    // Agentic loop — up to 5 tool call rounds
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

    return json({ text: reply });
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

// ── /history/clear ────────────────────────────────
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
    const res = await sb(env, 'tools?order=builtin.desc,name.asc', { headers: { 'Prefer': 'return=representation' } });
    if (!res.ok) return json({ tools: [] });
    return json({ tools: await res.json() });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleToolUpdate(request, env, name) {
  try {
    const body = await request.json();
    await sb(env, `tools?name=eq.${name}`, { method: 'PATCH', body: JSON.stringify(body) });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── Background: extract facts ─────────────────────
async function extractAndSaveFacts(env, userMessage, aiReply) {
  const res = await callGroq(env, [{
    role: 'user',
    content: `Extract specific, durable facts about the user (Umar) from this exchange. Only include personal, long-lasting info (preferences, goals, constraints, decisions). Skip generic info.

User: ${userMessage}
AI: ${aiReply}

JSON only: {"facts": [{"text": "...", "tag": "preference|goal|constraint|fact|decision"}]}
If nothing worth saving: {"facts": []}`,
  }]);
  const parsed = JSON.parse(res.choices[0].message.content);
  if (parsed.facts?.length) await saveFacts(env, parsed.facts);
}

// ── helper ────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
