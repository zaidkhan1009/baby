// ═══════════════════════════════════════════════
// NEXUS Core — Cloudflare Worker
// Proxies AI requests to Gemini 2.0 Flash (free)
// Set GEMINI_API_KEY via: wrangler secret put GEMINI_API_KEY
// ═══════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://zaidkhan1009.github.io';

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/chat')     return handleChat(request, env);
    if (url.pathname === '/insights') return handleInsights(request, env);

    return new Response('Not found', { status: 404 });
  }
};

// ── Gemini call ──────────────────────────────────
async function callGemini(env, systemPrompt, messages, jsonMode = false) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' || m.role === 'ai' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── /chat ────────────────────────────────────────
async function handleChat(request, env) {
  try {
    const { messages, systemPrompt } = await request.json();
    const text = await callGemini(env, systemPrompt, messages);
    return json({ text });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── /insights ────────────────────────────────────
async function handleInsights(request, env) {
  try {
    const { context, systemPrompt } = await request.json();
    const text = await callGemini(
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

// ── helper ───────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
