// Khudra agent proxy — a Cloudflare Worker that lets every visitor use the smart agent
// without exposing the Gemini API key. The key lives only in the Worker as a secret
// named GEMINI_API_KEY; the browser never sees it.
//
// Free-tier reality (Nov 2026): Flash models allow ~20 requests/day, Flash-Lite ~500/day,
// and Google Search grounding is not included for the newer models. So the Worker tries
// models in order (Flash-Lite first: it has the larger free quota and answers fastest) and falls back on 429/503/404/timeouts, and drops the search tool if Google
// refuses it. The header X-Model says which model answered, X-Search says if search ran.
//
// Limits (best effort, not a security boundary against a determined attacker):
// - only requests from the allowed origins are served (browsers send Origin; scripts can fake it)
// - only generateContent on the models below, with an output-token cap
// - the only tool allowed is google_search
// - about 12 requests per minute per IP per Worker instance
// Use a Gemini key with no billing attached: then the worst case is hitting the free quota, not a bill.

const ALLOWED_ORIGINS = ["https://aiwadod.github.io"];
const CHAIN = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-3.6-flash"];
const MAX_BODY_BYTES = 300000;
const MAX_OUTPUT_TOKENS = 4096;
const PER_MINUTE = 12;
const ATTEMPT_MS = 25000;
const hits = new Map();

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-Model, X-Search",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method === "GET") return json({ ok: true, ready: !!env.GEMINI_API_KEY, models: CHAIN });
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

    const body = {
      contents: b.contents,
      generationConfig: { ...(b.generationConfig || {}), maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
    if (b.system_instruction) body.system_instruction = b.system_instruction;
    let search = Array.isArray(b.tools) && b.tools.length > 0 && b.tools.every(t => t && Object.keys(t).length === 1 && "google_search" in t);

    const order = CHAIN.includes(b.model) ? [b.model, ...CHAIN.filter(m => m !== b.model)] : CHAIN;
    let last = null, lastModel = order[0];
    for (const model of order.slice(0, 4)) {
      for (let pass = 0; pass < 2; pass++) {
        const payload = search ? { ...body, tools: [{ google_search: {} }] } : body;
        let r;
        try {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(ATTEMPT_MS),
          });
        } catch (e) {
          last = JSON.stringify({ error: { message: "Model timed out" } }); lastModel = model;
          break;
        }
        if (r.ok) return new Response(r.body, { status: 200, headers: { ...cors, "Content-Type": "application/json", "X-Model": model, "X-Search": search ? "on" : "off" } });
        last = await r.text(); lastModel = model;
        if (search && (r.status === 429 || r.status === 400 || r.status === 403)) { search = false; continue; }
        if (![429, 503, 500, 404].includes(r.status)) return new Response(last, { status: r.status, headers: { ...cors, "Content-Type": "application/json", "X-Model": model } });
        break;
      }
    }
    return new Response(last || JSON.stringify({ error: { message: "No model available" } }), { status: 503, headers: { ...cors, "Content-Type": "application/json", "X-Model": lastModel } });
  },
};
