// /api/generate.js
// ClearBound — Vercel Serverless API
// - Adds in-memory prompt caching (TTL default 10m)
// - Improves upstream error visibility + safe parsing
// - Optional OpenAI retry (1x) for transient failures
// ✅ v1.1: adds relationship pack loading + validation

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const promptCache =
  globalThis.__CB_PROMPT_CACHE__ || (globalThis.__CB_PROMPT_CACHE__ = new Map());

function now() {
  return Date.now();
}

function cacheKey(repo, ref, path) {
  return `${repo}@${ref}:${path}`;
}

function getCached(key) {
  const hit = promptCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now()) {
    promptCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value, ttlMs) {
  promptCache.set(key, { value, expiresAt: now() + ttlMs });
}

function pickEnv(name, fallback = null) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function jsonFail(res, status, stage, extra = {}) {
  return res.status(status).json({ ok: false, stage, ...extra });
}

function asLowerId(v) {
  return String(v || "").trim().toLowerCase();
}

async function fetchTextWithCache(url, key, ttlMs) {
  const cached = getCached(key);
  if (cached != null) return cached;

  const r = await fetch(url, {
    method: "GET",
    headers: { "Cache-Control": "no-cache" },
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    throw new Error(`PROMPT_FETCH_FAIL:${r.status}:${url}:${text.slice(0, 200)}`);
  }

  setCached(key, text, ttlMs);
  return text;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractOutputText(data) {
  // Prefer the convenience field if present
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // Otherwise attempt to extract from structured output (Responses API)
  const out = data?.output;
  if (!Array.isArray(out)) return "";

  let acc = "";
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      // Some SDKs return {type:"output_text", text:"..."} or {type:"text", text:"..."}
      if (typeof c?.text === "string") acc += c.text;
    }
  }
  return acc.trim();
}

async function callOpenAIWithOptionalRetry({ apiKey, payload, retryOnce }) {
  const url = "https://api.openai.com/v1/responses";

  const attempt = async () => {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text().catch(() => "");
    const data = safeJsonParse(raw);

    return { ok: resp.ok, status: resp.status, data, raw };
  };

  // Attempt 1
  let r1 = await attempt();
  if (r1.ok) return r1;

  // Retry once on likely transient errors
  const transient = [408, 429, 500, 502, 503, 504].includes(r1.status);
  if (retryOnce && transient) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const r2 = await attempt();
    return r2;
  }

  return r1;
}

export default async function handler(req, res) {
  // CORS
  const allowOrigin = pickEnv("ALLOW_ORIGIN", "*");
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return jsonFail(res, 405, "method", { error: "Method not allowed" });

  // Small helper for stageful errors
  const fail = (status, stage, extra = {}) => jsonFail(res, status, stage, extra);

  try {
    // Body validation
    const body = req.body || {};
    const state = body.state;

    if (!state || typeof state !== "object") {
      return fail(400, "validate_body", { error: "Missing or invalid `state` object" });
    }

    const required = ["relationship", "target", "intent", "tone", "format", "context"];
    const missing = required.filter((k) => !(k in state));
    if (missing.length) {
      return fail(400, "validate_state", { error: `Missing fields: ${missing.join(", ")}` });
    }

    // Env
    const OPENAI_API_KEY = pickEnv("OPENAI_API_KEY");
    const PROMPTS_REPO = pickEnv("PROMPTS_REPO");
    const PROMPTS_REF = pickEnv("PROMPTS_REF", "main");

    if (!OPENAI_API_KEY) return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return fail(500, "env", { error: "PROMPTS_REPO missing" });

    // Cache TTL (ms)
    const ttlMs =
      Number(pickEnv("PROMPT_CACHE_TTL_MS", String(DEFAULT_CACHE_TTL_MS))) ||
      DEFAULT_CACHE_TTL_MS;

    // Inputs
    const relationshipId = asLowerId(state.relationship?.value);
    const toneId = asLowerId(state.tone?.value);
    const formatId = asLowerId(state.format?.value);
    const intentId = asLowerId(state.intent?.value);

    // Validate IDs
    const allowedRelationships = new Set([
      "family",
      "friends_personal",
      "work_professional",
      "living_proximity",
      "orgs_services",
    ]);

    if (!relationshipId || !allowedRelationships.has(relationshipId)) {
      return fail(400, "validate_ids", {
        error: "Invalid relationship value",
        details: { relationshipId },
      });
    }

    if (!toneId || !formatId || !intentId) {
      return fail(400, "validate_ids", {
        error: "Invalid tone / format / intent value",
        details: { toneId, formatId, intentId },
      });
    }

    // GitHub raw URLs
    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    // Prompt paths (ORDER MATTERS for Object.entries traversal)
    const promptPaths = {
      relationship: `relationship/relationship.${relationshipId}.v1.md`, // ✅ NEW
      tone: `tone/tone.${toneId}.v1.md`,
      format: `format/format.${formatId}.v1.md`,
      intent: `intent/intent.${intentId}.v1.md`,
      normalize: `rules/context.normalize.v1.md`,
      target_rules: `rules/target.rules.v1.md`,
      assemble: `assemble/assemble.generate.v1.md`,
    };

    // Fetch prompts (cached)
    let relationshipPrompt,
      tonePrompt,
      formatPrompt,
      intentPrompt,
      normalizePrompt,
      targetRulesPrompt,
      assemblePrompt;

    try {
      [
        relationshipPrompt,
        tonePrompt,
        formatPrompt,
        intentPrompt,
        normalizePrompt,
        targetRulesPrompt,
        assemblePrompt,
      ] = await Promise.all(
        Object.entries(promptPaths).map(async ([label, path]) => {
          const url = ghRaw(path);
          const key = cacheKey(PROMPTS_REPO, PROMPTS_REF, path);
          return fetchTextWithCache(url, key, ttlMs);
        })
      );
    } catch (e) {
      return fail(502, "prompt_fetch", { error: String(e?.message || e) });
    }

    // System + user
    // Assemble order (LOCK):
    // relationship → tone → format → intent → normalize → target_rules → assemble
    const system = [
      "Return ONLY the final message.",
      "",
      relationshipPrompt,
      "",
      tonePrompt,
      "",
      formatPrompt,
      "",
      intentPrompt,
      "",
      normalizePrompt,
      "",
      targetRulesPrompt,
      "",
      assemblePrompt,
    ].join("\n");

    const user = JSON.stringify(state, null, 2);

    // OpenAI request (Responses API)
    const model = pickEnv("OPENAI_MODEL", "gpt-4.1-mini");
    const retryOnce = String(pickEnv("OPENAI_RETRY_ONCE", "1")) === "1";

    const payload = {
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_output_tokens: 700,
    };

    const r = await callOpenAIWithOptionalRetry({
      apiKey: OPENAI_API_KEY,
      payload,
      retryOnce,
    });

    if (!r.ok) {
      // Keep it compact but useful; do not leak system prompt
      return fail(502, "openai", {
        error: "OpenAI failed",
        http_status: r.status,
        details: r.data || { raw: (r.raw || "").slice(0, 600) },
      });
    }

    const resultText = extractOutputText(r.data);
    if (!resultText) {
      return fail(502, "openai_output", {
        error: "Empty result",
        details: {
          id: r.data?.id,
          status: r.data?.status,
        },
      });
    }

    return res.status(200).json({ ok: true, result_text: resultText });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      stage: "server_error",
      error: "Server error",
      details: String(e?.message || e),
    });
  }
}
