// Khudra agent proxy — a Cloudflare Worker that lets every visitor use the smart agent
// without exposing the Gemini API key. The key lives only in the Worker as a secret
// named GEMINI_API_KEY; the browser never sees it.
//
// Speed: Google's free tier has very uneven latency (2 s to 30 s for the same prompt).
// To cut the slow tail, each request is sent to two different models at once (each has
// its own free quota) and the first one that starts answering wins; the other is cancelled.
// If both fail, the next pair is tried. With {"stream": true} the reply is streamed back as
// server-sent events. The header X-Model says which model answered.
//
// Limits (best effort, not a security boundary against a determined attacker):
// - only requests from the allowed origins are served (browsers send Origin; scripts can fake it)
// - only generateContent on the models below, with an output-token cap; no tools
// - about 12 requests per minute per IP per Worker instance
// Use a Gemini key with no billing attached: then the worst case is hitting the free quota, not a bill.

const ALLOWED_ORIGINS = ["https://aiwadod.github.io"];
const PAIRS = [["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"], ["gemini-flash-lite-latest", "gemini-3.8-flash"]];
const MAX_BODY_BYTES = 300000;
const MAX_OUTPUT_TOKENS = 2048;
const PER_MINUTE = 12;
const ATTEMPT_MS = 15000; // time allowed until a model starts answering
const RETRY = [429, 500, 503, 404];
const hits = new Map();

async function race(models, payload, stream, key) {
  const ctls = models.map(() => new AbortController());
  const timers = ctls.map(c => setTimeout(() => c.abort(), ATTEMPT_MS));
  const tries = models.map((m, i) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
      signal: ctls[i].signal,
    }).then(async r => {
      if (r.ok) return { i, m, r };
      throw { m, status: r.status, text: await r.text() };
    }, () => { throw { m, status: 504, text: JSON.stringify({ error: { message: "Model timed out" } }) }; })
  );
  try {
    const win = await Promise.any(tries);
    ctls.forEach((c, i) => { clearTimeout(timers[i]); if (i !== win.i) c.abort(); });
    return win;
  } catch (agg) {
    timers.forEach(clearTimeout);
    return { errors: agg.errors || [] };
  }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-Model",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method === "GET") return json({ ok: true, ready: !!env.GEMINI_API_KEY, models: PAIRS.flat() });
    if (req.method !== "POST") return json({ error: { message: "POST only" } }, 405);
    if (!allowed) return json({ error: { message: "Origin not allowed" } }, 403);
    if (!env.GEMINI_API_KEY) return json({ error: { message: "The server key is not set yet" } }, 503);

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (recent.length >= PER_MINUTE) return json({ error: { message: "Too many requests, wait a minute" } }, 429);
    recent.push(now); hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();

    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: { message: "Request too large" } }, 413);
    let b;
    try { b = JSON.parse(text); } catch { return json({ error: { message: "Bad JSON" } }, 400); }
    if (!Array.isArray(b.contents) || !b.contents.length) return json({ error: { message: "Missing contents" } }, 400);

    const payload = {
      contents: b.contents,
      generationConfig: { ...(b.generationConfig || {}), maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
    if (b.system_instruction) payload.system_instruction = b.system_instruction;
    const stream = b.stream === true;

    let last = null;
    for (const pair of PAIRS) {
      const w = await race(pair, payload, stream, env.GEMINI_API_KEY);
      if (w.r) return new Response(w.r.body, { status: 200, headers: { ...cors, "Content-Type": stream ? "text/event-stream" : "application/json", "Cache-Control": "no-cache", "X-Model": w.m } });
      last = w.errors[w.errors.length - 1] || last;
      if (w.errors.length && w.errors.every(e => !RETRY.includes(e.status))) break;
    }
    return new Response(last?.text || JSON.stringify({ error: { message: "No model available" } }), { status: last && !RETRY.includes(last.status) ? last.status : 503, headers: { ...cors, "Content-Type": "application/json", "X-Model": last?.m || "" } });
  },
};
