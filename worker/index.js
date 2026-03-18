// ═══════════════════════════════════════════════
// NEXUS Core — Cloudflare Worker
// AI:     Groq — llama-3.3-70b-versatile (free)
// Memory: Supabase — messages, facts, app_state
//
// Secrets (wrangler secret put <NAME>):
//   GROQ_API_KEY
//   SUPABASE_URL   — https://xxxx.supabase.co
//   SUPABASE_KEY   — service_role key
// ═══════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://zaidkhan1009.github.io';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const method = request.method;

    if (method === 'POST' && url.pathname === '/chat')          return handleChat(request, env);
    if (method === 'POST' && url.pathname === '/insights')      return handleInsights(request, env);
    if (method === 'GET'  && url.pathname === '/history')       return handleHistory(request, env);
    if (method === 'POST' && url.pathname === '/history/clear') return handleHistoryClear(request, env);
    if (method === 'POST' && url.pathname === '/state')         return handleStateSave(request, env);
    if (method === 'GET'  && url.pathname === '/state')         return handleStateLoad(request, env);

    return new Response('Not found', { status: 404 });
  }
};

// ── Supabase REST helpers ─────────────────────────
async function sb(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...options.headers,
    },
  });
  return res;
}

async function loadMessages(env, limit = 40) {
  const res = await sb(env, `messages?order=created_at.asc&limit=${limit}`);
  if (!res.ok) return [];
  return res.json();
}

async function saveMessage(env, role, content) {
  await sb(env, 'messages', {
    method: 'POST',
    body: JSON.stringify({ role, content }),
  });
}

async function loadFacts(env) {
  const res = await sb(env, 'facts?order=created_at.desc&limit=60');
  if (!res.ok) return [];
  return res.json();
}

async function saveFacts(env, facts) {
  if (!facts?.length) return;
  await sb(env, 'facts', {
    method: 'POST',
    body: JSON.stringify(facts),
  });
}

// ── Groq call ─────────────────────────────────────
async function callGroq(env, systemPrompt, messages, jsonMode = false) {
  const groqMessages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content,
    })),
  ];

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: groqMessages,
      temperature: 0.7,
      max_tokens: 1024,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── /chat ─────────────────────────────────────────
async function handleChat(request, env) {
  try {
    const { message, systemPrompt } = await request.json();

    // Load history + facts in parallel
    const [history, facts] = await Promise.all([
      loadMessages(env, 30),
      loadFacts(env),
    ]);

    // Enrich system prompt with known facts
    const factsBlock = facts.length
      ? `\n\nKNOWN FACTS ABOUT UMAR (learned over time):\n${facts.map(f => `- [${f.tag}] ${f.text}`).join('\n')}`
      : '';
    const enrichedPrompt = systemPrompt + factsBlock;

    // Build full message list: history + current message
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // Get AI reply
    const reply = await callGroq(env, enrichedPrompt, messages);

    // Persist both messages, extract facts in background
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
    const messages = await loadMessages(env, 60);
    return json({ messages });
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
    const text = await callGroq(
      env,
      systemPrompt,
      [{ role: 'user', content: context }],
      true
    );
    return json({ text });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /state POST ───────────────────────────────────
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

// ── /state GET ────────────────────────────────────
async function handleStateLoad(request, env) {
  try {
    const res = await sb(env, 'app_state?id=eq.1', {
      headers: { 'Prefer': 'return=representation' },
    });
    if (!res.ok) return json({ data: null });
    const rows = await res.json();
    return json({ data: rows[0]?.data ?? null });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── Background: extract facts from conversation ───
async function extractAndSaveFacts(env, userMessage, aiReply) {
  const prompt = `You are a fact extractor. From this conversation snippet, extract any specific, durable facts about the user (Umar). Only include facts that are truly personal and long-lasting (preferences, goals, constraints, key decisions, personal details). Skip generic or temporary info.

User said: ${userMessage}
AI replied: ${aiReply}

Respond with JSON only: {"facts": [{"text": "...", "tag": "preference|goal|constraint|fact|decision"}]}
If nothing worth saving, return: {"facts": []}`;

  const result = await callGroq(env, null, [{ role: 'user', content: prompt }], true);
  const parsed = JSON.parse(result);
  if (parsed.facts?.length) {
    await saveFacts(env, parsed.facts);
  }
}

// ── Helper ────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
