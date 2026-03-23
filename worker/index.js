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
    if (m === 'GET'   && p === '/telegram/status')  return handleTelegramStatus(request, env);
    if (m === 'GET'   && p === '/github')           return handleGitHub(request, env);
    if (m === 'GET'   && p === '/calendar')         return handleCalendar(request, env);
    if (m === 'POST'  && p === '/brief')            return handleMorningBrief(env).then(() => json({ ok: true }));
    if (m === 'GET'   && p === '/state/debug')      return sb(env, 'app_state?id=eq.1', { headers: { 'Prefer': 'return=representation' } }).then(r => r.json()).then(d => json(d));

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env) {
    if (event.cron === '0 3 * * *') {
      await handleMorningBrief(env);
    } else {
      await handleReminderCheck(env);
    }
  },
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

async function generateEmbedding(env, text) {
  try {
    const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
    return result.data[0]; // 768-dim float array
  } catch {
    return null;
  }
}

async function searchFacts(env, queryText) {
  try {
    const embedding = await generateEmbedding(env, queryText);
    if (!embedding) return loadFacts(env);
    const res = await sb(env, 'rpc/match_facts', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ query_embedding: embedding, match_count: 10 }),
    });
    if (!res.ok) return loadFacts(env);
    return res.json();
  } catch {
    return loadFacts(env);
  }
}

async function saveFacts(env, facts) {
  if (!facts?.length) return;
  const withEmbeddings = await Promise.all(
    facts.map(async f => {
      const embedding = await generateEmbedding(env, f.text);
      return embedding ? { ...f, embedding: JSON.stringify(embedding) } : f;
    })
  );
  await sb(env, 'facts', { method: 'POST', body: JSON.stringify(withEmbeddings) });
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
      searchFacts(env, message),
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
const DEFAULT_SYSTEM = "You are NEXUS, Umar's personal AI assistant. Be concise and direct. Use ₹ for Indian currency. Only use tools when genuinely needed — do NOT call save_note or get_notes for simple conversational messages.";

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

    // ── Command interception (before AI pipeline) ──
    const handled = await handleTelegramCommand(env, chatId, text);
    if (handled) return json({ ok: true });

    const agentName = classifyIntent(text);
    const [history, facts, agent, tools] = await Promise.all([
      loadMessages(env, 20),
      searchFacts(env, text),
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

    // Strip leaked function-call syntax the model occasionally emits as plain text
    reply = reply.replace(/<function[^>]*>[\s\S]*?<\/function>/g, '').trim();
    reply = reply.replace(/\{?\s*"function"\s*:[\s\S]*?\}/g, '').trim();
    if (!reply) reply = "I'm here — what would you like to know?";

    await saveMessage(env, 'user', `[TG] ${text}`);
    await saveMessage(env, 'assistant', reply);
    extractAndSaveFacts(env, text, reply).catch(() => {});

    const wantsVoice = /\bvoice\b|\bspeak\b|\baudio\b|\bread (it |this |out|aloud)/i.test(text);
    if (wantsVoice) {
      const plainReply = reply.replace(/[*_`]/g, '').trim();
      const voiceText  = plainReply.length > 1500 ? plainReply.slice(0, 1500) + '...' : plainReply;
      const audio = await textToSpeech(env, voiceText).catch(() => null);
      if (audio) {
        await tgSendVoice(env, chatId, audio);
        if (plainReply.length > 1500) {
          await tgSend(env, chatId, `${agent.icon} *${agent.name.toUpperCase()}*\n\n${reply}`);
        }
      } else {
        await tgSend(env, chatId, `${agent.icon} *${agent.name.toUpperCase()}*\n\n${reply}`);
      }
    } else {
      await tgSend(env, chatId, `${agent.icon} *${agent.name.toUpperCase()}*\n\n${reply}`);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleTelegramStatus(_request, env) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ connected: false, reason: 'Token not set' });
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (!data.ok) return json({ connected: false, reason: data.description });
    return json({ connected: true, bot: data.result });
  } catch (e) {
    return json({ connected: false, reason: e.message });
  }
}

async function tgSend(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function textToSpeech(env, text) {
  if (!env.VOICERSS_API_KEY) return null;
  const params = new URLSearchParams({
    key: env.VOICERSS_API_KEY,
    hl:  'en-us',
    src: text,
    c:   'MP3',
    f:   '44khz_16bit_stereo',
  });
  const res = await fetch(`https://api.voicerss.org/?${params}`);
  if (!res.ok) return null;
  // VoiceRSS returns error as plain text starting with "ERROR:"
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text')) return null;
  return res.arrayBuffer();
}

async function tgSendVoice(env, chatId, audioBuffer) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'nexus.mp3');
  form.append('title', 'NEXUS');
  form.append('performer', 'NEXUS AI');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendAudio`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Telegram sendAudio ${res.status}: ${await res.text()}`);
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

// ── Telegram command handler ──────────────────────
async function loadAppState(env) {
  const res = await sb(env, 'app_state?id=eq.1', { headers: { 'Prefer': 'return=representation' } });
  if (!res.ok) return {};
  const rows = await res.json();
  return rows[0]?.data || {};
}

async function saveAppState(env, data) {
  await sb(env, 'app_state', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 1, data, updated_at: new Date().toISOString() }),
  });
}

async function handleTelegramCommand(env, chatId, text) {
  const t = text.trim();
  const lower = t.toLowerCase();

  // ── SHOW DASHBOARD ──
  if (/\bdashboard\b/i.test(t)) {
    const state = await loadAppState(env);
    const ventures = state.ventures || [];
    const tasks    = state.tasks    || [];
    const now      = new Date();
    const overdue  = tasks.filter(t => !t.done && t.due && new Date(t.due) < now);
    const pending  = tasks.filter(t => !t.done);
    let msg = '🖥 *NEXUS DASHBOARD*\n━━━━━━━━━━━━━━━━━━━━\n';
    msg += ventures.length
      ? '\n🏢 *VENTURES*\n' + ventures.map(v => `• *${v.name}* — ${v.status || 'active'}${v.kpi ? ` | ${v.kpi}` : ''}`).join('\n')
      : '\n🏢 *VENTURES*\n_None added yet_';
    msg += pending.length
      ? '\n\n📋 *TASKS*\n' + pending.map((t, i) => `${i + 1}. ${t.title}${t.due ? ` _(${t.due})_` : ''}${overdue.includes(t) ? ' ⚠️' : ''}`).join('\n')
      : '\n\n📋 *TASKS*\n_None added yet_';
    await tgSend(env, chatId, msg);
    return true;
  }

  // ── SHOW TASKS ──
  if (/\b(show|list|my|see|what('s| is| are)?( (my|the))?)?\s*tasks?\b/i.test(t) && !/add|create|new|set/i.test(t)) {
    const state = await loadAppState(env);
    const tasks = state.tasks || [];
    if (!tasks.length) { await tgSend(env, chatId, '📋 *Tasks*\n\nNo tasks yet.'); return true; }
    const pending = tasks.filter(t => !t.done);
    const done    = tasks.filter(t => t.done);
    let msg = '📋 *TASKS*\n━━━━━━━━━━━━━━━━━━━━\n';
    if (pending.length) {
      msg += '\n*Pending*\n' + pending.map((t, i) => `${i + 1}. ${t.title}${t.due ? ` _(due ${t.due})_` : ''}`).join('\n');
    }
    if (done.length) {
      msg += '\n\n*Done*\n' + done.map(t => `✓ ${t.title}`).join('\n');
    }
    await tgSend(env, chatId, msg);
    return true;
  }

  // ── ADD TASK ──
  if (/\b(add|create|new)\b.*\btask\b/i.test(t)) {
    const extracted = await extractTaskOrVenture(env, t, 'task');
    if (!extracted.title) { await tgSend(env, chatId, '❌ Could not extract task. Try: "add task: Call supplier by Friday"'); return true; }
    const state = await loadAppState(env);
    const tasks = state.tasks || [];
    tasks.push({ id: Date.now(), title: extracted.title, due: extracted.due || null, done: false });
    await saveAppState(env, { ...state, tasks });
    await tgSend(env, chatId, `✅ *Task added*\n\n${extracted.title}${extracted.due ? `\n_Due: ${extracted.due}_` : ''}`);
    return true;
  }

  // ── DONE TASK ──
  if (/\b(done|complete|finished|mark)\b/i.test(t) && /\btask\b/i.test(t)) {
    const extracted = await extractTaskOrVenture(env, t, 'task');
    const state = await loadAppState(env);
    const tasks = state.tasks || [];
    const idx = tasks.findIndex(tk => tk.title.toLowerCase().includes((extracted.title || '').toLowerCase()));
    if (idx === -1) { await tgSend(env, chatId, '❌ Task not found. Use "show tasks" to see your list.'); return true; }
    tasks[idx].done = true;
    await saveAppState(env, { ...state, tasks });
    await tgSend(env, chatId, `✅ *Marked done*\n\n${tasks[idx].title}`);
    return true;
  }

  // ── SHOW VENTURES ──
  if (/\b(show|list|my)?\s*ventures?\b/i.test(t) && !/add|create|new/i.test(t)) {
    const state = await loadAppState(env);
    const ventures = state.ventures || [];
    if (!ventures.length) { await tgSend(env, chatId, '🏢 *Ventures*\n\nNo ventures yet.'); return true; }
    const msg = '🏢 *VENTURES*\n━━━━━━━━━━━━━━━━━━━━\n\n' +
      ventures.map(v => `*${v.name}*\nStatus: ${v.status || 'active'}${v.kpi ? `\nKPI: ${v.kpi}` : ''}`).join('\n\n');
    await tgSend(env, chatId, msg);
    return true;
  }

  // ── ADD VENTURE ──
  if (/\b(add|create|new)\b.*\bventure\b/i.test(t)) {
    const extracted = await extractTaskOrVenture(env, t, 'venture');
    if (!extracted.title) { await tgSend(env, chatId, '❌ Could not extract venture. Try: "add venture: Bakery"'); return true; }
    const state = await loadAppState(env);
    const ventures = state.ventures || [];
    ventures.push({ id: Date.now(), name: extracted.title, status: extracted.status || 'planning', kpi: extracted.kpi || null });
    await saveAppState(env, { ...state, ventures });
    await tgSend(env, chatId, `✅ *Venture added*\n\n${extracted.title}`);
    return true;
  }

  // ── SHOW NOTES ──
  if (/\bshow\s+notes?\b/i.test(t)) {
    const res = await sb(env, 'notes?order=created_at.desc&limit=20', { headers: { 'Prefer': 'return=representation' } });
    const notes = res.ok ? await res.json() : [];
    if (!notes.length) { await tgSend(env, chatId, '📝 *Notes*\n\nNo notes saved.'); return true; }
    const msg = '📝 *NOTES*\n━━━━━━━━━━━━━━━━━━━━\n\n' +
      notes.map((n, i) => `*${i + 1}.* [ID:${n.id}] ${n.content}`).join('\n\n');
    await tgSend(env, chatId, msg);
    return true;
  }

  // ── DELETE NOTE (confirm) ──
  if (/^confirm\s+delete\s+note\s+\d+/i.test(t)) {
    const id = t.match(/\d+/)[0];
    const res = await sb(env, `notes?id=eq.${id}`, { headers: { 'Prefer': 'return=representation' } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) { await tgSend(env, chatId, '❌ Note not found.'); return true; }
    await sb(env, 'deleted_notes', { method: 'POST', body: JSON.stringify({ original_id: rows[0].id, content: rows[0].content }) });
    await sb(env, `notes?id=eq.${id}`, { method: 'DELETE' });
    await tgSend(env, chatId, `🗑 *Note deleted & backed up*\n\n_${rows[0].content}_`);
    return true;
  }
  if (/\bdelete\s+note\b/i.test(t)) {
    const idMatch = t.match(/\d+/);
    if (!idMatch) { await tgSend(env, chatId, '❌ Specify note ID. Use "show notes" to see IDs.'); return true; }
    const res = await sb(env, `notes?id=eq.${idMatch[0]}`, { headers: { 'Prefer': 'return=representation' } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) { await tgSend(env, chatId, '❌ Note not found.'); return true; }
    await tgSend(env, chatId, `⚠️ *Delete this note?*\n\n_${rows[0].content}_\n\nReply: \`confirm delete note ${idMatch[0]}\``);
    return true;
  }

  // ── CLEAR NOTES (confirm) ──
  if (/^confirm\s+clear\s+all?\s+notes?/i.test(t)) {
    const res = await sb(env, 'notes?id=gt.0', { headers: { 'Prefer': 'return=representation' } });
    const notes = res.ok ? await res.json() : [];
    if (notes.length) {
      await sb(env, 'deleted_notes', { method: 'POST', body: JSON.stringify(notes.map(n => ({ original_id: n.id, content: n.content }))) });
    }
    await sb(env, 'notes?id=gt.0', { method: 'DELETE' });
    await tgSend(env, chatId, `🗑 *${notes.length} notes deleted & backed up.*`);
    return true;
  }
  if (/\bclear\s+all?\s+notes?\b/i.test(t)) {
    const res = await sb(env, 'notes?id=gt.0', { headers: { 'Prefer': 'return=representation' } });
    const notes = res.ok ? await res.json() : [];
    await tgSend(env, chatId, `⚠️ *Delete all ${notes.length} notes?*\n\nReply: \`confirm clear all notes\``);
    return true;
  }

  // ── SHOW FACTS ──
  if (/\bshow\s+facts?\b/i.test(t)) {
    const res = await sb(env, 'facts?order=created_at.desc&limit=30', { headers: { 'Prefer': 'return=representation' } });
    const facts = res.ok ? await res.json() : [];
    if (!facts.length) { await tgSend(env, chatId, '🧠 *Facts*\n\nNo facts stored yet.'); return true; }
    const msg = '🧠 *STORED FACTS*\n━━━━━━━━━━━━━━━━━━━━\n\n' +
      facts.map((f, i) => `*${i + 1}.* [ID:${f.id}] [${f.tag}] ${f.text}`).join('\n\n');
    await tgSend(env, chatId, msg);
    return true;
  }

  // ── DELETE FACT (confirm) ──
  if (/^confirm\s+delete\s+fact\s+\d+/i.test(t)) {
    const id = t.match(/\d+/)[0];
    const res = await sb(env, `facts?id=eq.${id}`, { headers: { 'Prefer': 'return=representation' } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) { await tgSend(env, chatId, '❌ Fact not found.'); return true; }
    await sb(env, 'deleted_facts', { method: 'POST', body: JSON.stringify({ original_id: rows[0].id, text: rows[0].text, tag: rows[0].tag }) });
    await sb(env, `facts?id=eq.${id}`, { method: 'DELETE' });
    await tgSend(env, chatId, `🗑 *Fact deleted & backed up*\n\n_[${rows[0].tag}] ${rows[0].text}_`);
    return true;
  }
  if (/\bdelete\s+fact\b/i.test(t)) {
    const idMatch = t.match(/\d+/);
    if (!idMatch) { await tgSend(env, chatId, '❌ Specify fact ID. Use "show facts" to see IDs.'); return true; }
    const res = await sb(env, `facts?id=eq.${idMatch[0]}`, { headers: { 'Prefer': 'return=representation' } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) { await tgSend(env, chatId, '❌ Fact not found.'); return true; }
    await tgSend(env, chatId, `⚠️ *Delete this fact?*\n\n_[${rows[0].tag}] ${rows[0].text}_\n\nReply: \`confirm delete fact ${idMatch[0]}\``);
    return true;
  }

  // ── CLEAR FACTS (confirm) ──
  if (/^confirm\s+clear\s+all?\s+facts?/i.test(t)) {
    const res = await sb(env, 'facts?id=gt.0', { headers: { 'Prefer': 'return=representation' } });
    const facts = res.ok ? await res.json() : [];
    if (facts.length) {
      await sb(env, 'deleted_facts', { method: 'POST', body: JSON.stringify(facts.map(f => ({ original_id: f.id, text: f.text, tag: f.tag }))) });
    }
    await sb(env, 'facts?id=gt.0', { method: 'DELETE' });
    await tgSend(env, chatId, `🗑 *${facts.length} facts deleted & backed up.*`);
    return true;
  }
  if (/\bclear\s+all?\s+facts?\b/i.test(t)) {
    const res = await sb(env, 'facts?id=gt.0', { headers: { 'Prefer': 'return=representation' } });
    const facts = res.ok ? await res.json() : [];
    await tgSend(env, chatId, `⚠️ *Delete all ${facts.length} facts?*\n\nReply: \`confirm clear all facts\``);
    return true;
  }

  // ── REMINDER ──
  if (/\bremind\b/i.test(t)) {
    const reminder = await extractReminder(env, t);
    if (reminder.text && reminder.remind_at) {
      const recurring = /\bdaily\b|\bevery day\b/i.test(t);
      await sb(env, 'reminders', { method: 'POST', body: JSON.stringify({ text: reminder.text, remind_at: reminder.remind_at, recurring }) });
      const when = new Date(reminder.remind_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      await tgSend(env, chatId, `⏰ *Reminder set*\n\n${reminder.text}\n_${when} IST${recurring ? ' · daily' : ''}_`);
      return true;
    }
  }

  return false; // not a command — fall through to AI
}

async function extractTaskOrVenture(env, text, type) {
  const res = await callGroq(env, [{
    role: 'user',
    content: `Extract the ${type} details from this message.
Message: "${text}"
Return JSON only: {"title": "...", "due": "YYYY-MM-DD or null", "status": "planning|active|done or null", "kpi": "metric or null"}
If nothing found return: {"title": null}`,
  }]);
  try {
    const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch {
    return { title: null };
  }
}

// ── Reminders ─────────────────────────────────────
async function extractReminder(env, text) {
  const now = new Date();
  const res = await callGroq(env, [{
    role: 'user',
    content: `Extract the reminder from this message. Current datetime: ${now.toISOString()} (user is in IST = UTC+5:30).
Message: "${text}"
Return JSON only: {"text": "what to remind about", "remind_at": "ISO datetime in UTC"}
If no clear reminder intent, return: {"text": null, "remind_at": null}`,
  }]);
  try {
    const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch {
    return { text: null, remind_at: null };
  }
}

async function handleReminderCheck(env) {
  try {
    const chatId = env.TELEGRAM_ALLOWED_ID;
    if (!chatId || !env.TELEGRAM_BOT_TOKEN) return;

    const now = new Date().toISOString();
    const res = await sb(env, `reminders?fired=eq.false&remind_at=lte.${now}`, {
      headers: { 'Prefer': 'return=representation' },
    });
    if (!res.ok) return;
    const due = await res.json();
    if (!due.length) return;

    for (const r of due) {
      await tgSend(env, chatId, `⏰ *Reminder*\n\n${r.text}`);
      if (r.recurring) {
        // Reschedule for same time tomorrow
        const next = new Date(r.remind_at);
        next.setDate(next.getDate() + 1);
        await sb(env, `reminders?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ fired: false, remind_at: next.toISOString() }) });
      } else {
        await sb(env, `reminders?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ fired: true }) });
      }
    }
  } catch (_e) {}
}

// ── Cron: morning brief ───────────────────────────
async function handleMorningBrief(env) {
  try {
    const chatId = env.TELEGRAM_ALLOWED_ID;
    if (!chatId || !env.TELEGRAM_BOT_TOKEN) return;

    const now = new Date();
    const [stateRows, facts, nudgesRes] = await Promise.all([
      sb(env, 'app_state?id=eq.1', { headers: { 'Prefer': 'return=representation' } }).then(r => r.ok ? r.json() : []),
      loadFacts(env),
      sb(env, 'nudges?dismissed=eq.false&order=priority.desc&limit=5', { headers: { 'Prefer': 'return=representation' } }).then(r => r.ok ? r.json() : []),
    ]);

    const appData = stateRows[0]?.data || {};
    const ventures  = appData.ventures  || [];
    const tasks     = appData.tasks     || [];
    const overdue   = tasks.filter(t => !t.done && t.due && new Date(t.due) < now);
    const dueToday  = tasks.filter(t => !t.done && t.due && new Date(t.due).toDateString() === now.toDateString());

    const context = [
      `Date: ${now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      ventures.length  ? `Ventures: ${ventures.map(v => `${v.name} (${v.status || 'active'})`).join(', ')}` : '',
      overdue.length   ? `OVERDUE (${overdue.length}): ${overdue.map(t => t.title).join(', ')}` : '',
      dueToday.length  ? `Due today: ${dueToday.map(t => t.title).join(', ')}` : '',
      nudgesRes.length ? `Nudges: ${nudgesRes.map(n => n.text).join(' | ')}` : '',
      facts.length     ? `Key facts: ${facts.slice(0, 10).map(f => f.text).join('. ')}` : '',
    ].filter(Boolean).join('\n');

    const res = await callGroq(env, [
      { role: 'system', content: `You are NEXUS. Generate a morning briefing for Umar using Telegram Markdown formatting (single asterisks for *bold*, underscores for _italic_). Structure it EXACTLY like this template — only include sections that have data:

🌅 *NEXUS MORNING BRIEF*
_Friday, 20 March 2026_
━━━━━━━━━━━━━━━━━━━━

🏢 *VENTURES*
• Venture Name — status

⚠️ *OVERDUE* _(urgent)_
• Task name

📌 *TODAY*
• Task name

💡 *NUDGES*
• Nudge text

🧠 *INSIGHT*
One sharp, personalised observation about Umar's situation.

━━━━━━━━━━━━━━━━━━━━
Use ₹ for currency. Be specific, not generic. Max 250 words. Output only the message — no extra commentary.` },
      { role: 'user', content: context },
    ]);

    await tgSend(env, chatId, res.choices[0].message.content);
  } catch (_e) {
    // silent — cron failures must not crash the worker
  }
}

// ── helper ────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
