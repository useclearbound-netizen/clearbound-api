// /api/generate.js
// ClearBound — Vercel Serverless API (vNext)
// - Pulls prompts from clearbound-vnext repo structure
// - In-memory prompt caching (TTL default 10m)
// - Stageful errors for debugging
// - Optional OpenAI retry (1x) for transient failures
// - Model can be configured per output type via env

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

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function hasValueLike(obj) {
  // Accepts: {value:"x"} or {"value":{...}} etc. Just check key exists and not empty.
  if (!obj || typeof obj !== "object") return false;
  if ("value" in obj) {
    const v = obj.value;
    if (typeof v === "string") return v.trim().length > 0;
    if (v != null) return true;
  }
  return false;
}

/**
 * vNext prompt paths:
 * - prompts/intent/<intent>.prompt.md
 * - prompts/normalize/normalize_state_to_canonical.prompt.md
 * - prompts/output/{message|email|analysis_report}.prompt.md
 * - prompts/assemble/assemble_generate.prompt.md
 * - qa/rules/core.yaml (optional include)
 */
function resolveIntentPath(intentId) {
  const map = {
    address_issue: "prompts/intent/address_issue.prompt.md",
    clarify_correct: "prompts/intent/clarify_correct.prompt.md",
    close_loop: "prompts/intent/close_loop.prompt.md",
    official: "prompts/intent/official.prompt.md",
    push_back: "prompts/intent/push_back.prompt.md",
    reset_expectations: "prompts/intent/reset_expectations.prompt.md",
    set_boundary: "prompts/intent/set_boundary.prompt.md",
  };
  return map[intentId] || null;
}

function resolveOutputPath(formatId) {
  // keep this permissive so UI tweaks won’t break backend
  const f = asLowerId(formatId);

  const messageAliases = new Set([
    "message",
    "text",
    "sms",
    "dm",
    "chat",
    "im",
    "note",
  ]);

  const emailAliases = new Set(["email", "e-mail", "mail"]);

  const analysisAliases = new Set([
    "analysis",
    "analysis_report",
    "report",
    "diagnosis",
    "review",
  ]);

  if (messageAliases.has(f)) return "prompts/output/message.prompt.md";
  if (emailAliases.has(f)) return "prompts/output/email.prompt.md";
  if (analysisAliases.has(f)) return "prompts/output/analysis_report.prompt.md";

  // Default to message if unknown to avoid hard-fail
  return "prompts/output/message.prompt.md";
}

function pickModelForFormat(formatId) {
  const base = pickEnv("OPENAI_MODEL", "gpt-4.1-mini");

  const f = asLowerId(formatId);
  const outputPath = resolveOutputPath(f);

  // Optional per-type overrides
  if (outputPath.includes("/analysis_report.")) {
    return pickEnv("OPENAI_MODEL_ANALYSIS", base);
  }
  if (outputPath.includes("/email.")) {
    return pickEnv("OPENAI_MODEL_EMAIL", base);
  }
  return pickEnv("OPENAI_MODEL_MESSAGE", base);
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

  const fail = (status, stage, extra = {}) => jsonFail(res, status, stage, extra);

  try {
    // Body validation
    const body = req.body || {};
    const state = body.state;

    if (!state || typeof state !== "object") {
      return fail(400, "validate_body", {
        error: "Missing or invalid `state` object",
      });
    }

    // Required keys (vNext frontend still expected to send these)
    // NOTE: we validate shape lightly (avoid breaking on UI schema changes)
    const requiredKeys = ["relationship", "target", "intent", "tone", "format", "context"];
    const missingKeys = requiredKeys.filter((k) => !(k in state));
    if (missingKeys.length) {
      return fail(400, "validate_state", {
        error: `Missing fields: ${missingKeys.join(", ")}`,
      });
    }

    // Light shape checks so "present but empty" fails clearly
    const relationshipOk = hasValueLike(state.relationship);
    const targetOk = hasValueLike(state.target);
    const intentOk = hasValueLike(state.intent);
    const toneOk = hasValueLike(state.tone);
    const formatOk = hasValueLike(state.format);

    // context can be string, or object containing any non-empty text
    const contextOk =
      isNonEmptyString(state.context) ||
      (state.context &&
        typeof state.context === "object" &&
        (isNonEmptyString(state.context.text) ||
          isNonEmptyString(state.context.value) ||
          isNonEmptyString(state.context.summary) ||
          isNonEmptyString(state.context.raw)));

    const shapeMissing = [];
    if (!relationshipOk) shapeMissing.push("relationship.value");
    if (!targetOk) shapeMissing.push("target.value");
    if (!intentOk) shapeMissing.push("intent.value");
    if (!toneOk) shapeMissing.push("tone.value");
    if (!formatOk) shapeMissing.push("format.value");
    if (!contextOk) shapeMissing.push("context(text)");

    if (shapeMissing.length) {
      return fail(400, "validate_state_shape", {
        error: "Invalid or empty fields",
        details: { missing: shapeMissing },
      });
    }

    // Env
    const OPENAI_API_KEY = pickEnv("OPENAI_API_KEY");
    const PROMPTS_REPO = pickEnv("PROMPTS_REPO");
    const PROMPTS_REF = pickEnv("PROMPTS_REF", "main");

    if (!OPENAI_API_KEY) return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return fail(500, "env", { error: "PROMPTS_REPO missing" });

    const ttlMs =
      Number(pickEnv("PROMPT_CACHE_TTL_MS", String(DEFAULT_CACHE_TTL_MS))) ||
      DEFAULT_CACHE_TTL_MS;

    // IDs
    const intentId = asLowerId(state.intent?.value);
    const formatId = asLowerId(state.format?.value);

    const intentPath = resolveIntentPath(intentId);
    if (!intentPath) {
      return fail(400, "validate_ids", {
        error: "Invalid intent value",
        details: { intentId },
      });
    }

    const outputPath = resolveOutputPath(formatId);

    // GitHub raw URL
    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    // Prompts
    const normalizePath = "prompts/normalize/normalize_state_to_canonical.prompt.md";
    const assemblePath = "prompts/assemble/assemble_generate.prompt.md";
    const qaCorePath = "qa/rules/core.yaml";

    const includeQa = String(pickEnv("INCLUDE_QA_RULES", "1")) === "1";

    let intentPrompt, normalizePrompt, outputPrompt, assemblePrompt, qaRulesPrompt;

    try {
      const fetches = [
        ["intent", intentPath],
        ["normalize", normalizePath],
        ["output", outputPath],
        ["assemble", assemblePath],
      ];

      if (includeQa) fetches.push(["qa", qaCorePath]);

      const results = await Promise.all(
        fetches.map(async ([label, path]) => {
          const url = ghRaw(path);
          const key = cacheKey(PROMPTS_REPO, PROMPTS_REF, path);
          const text = await fetchTextWithCache(url, key, ttlMs);
          return [label, text];
        })
      );

      const byLabel = Object.fromEntries(results);
      intentPrompt = byLabel.intent;
      normalizePrompt = byLabel.normalize;
      outputPrompt = byLabel.output;
      assemblePrompt = byLabel.assemble;
      qaRulesPrompt = byLabel.qa || "";
    } catch (e) {
      return fail(502, "prompt_fetch", { error: String(e?.message || e) });
    }

    // System assembly (vNext)
    // Order:
    // normalize → intent → output → assemble (+ optional qa rules)
    const systemParts = [
      "Return ONLY the final output. No explanations.",
      "",
      normalizePrompt,
      "",
      intentPrompt,
      "",
      outputPrompt,
      "",
      assemblePrompt,
    ];

    if (includeQa && qaRulesPrompt) {
      systemParts.push("", "=== QA RULES (for internal compliance) ===", qaRulesPrompt);
    }

    const system = systemParts.join("\n");

    const user = JSON.stringify(state, null, 2);

    // OpenAI request
    const model = pickModelForFormat(formatId);
    const retryOnce = String(pickEnv("OPENAI_RETRY_ONCE", "1")) === "1";

    const payload = {
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: Number(pickEnv("OPENAI_TEMPERATURE", "0.4")),
      max_output_tokens: Number(pickEnv("OPENAI_MAX_OUTPUT_TOKENS", "700")),
    };

    const r = await callOpenAIWithOptionalRetry({
      apiKey: OPENAI_API_KEY,
      payload,
      retryOnce,
    });

    if (!r.ok) {
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
        details: { id: r.data?.id, status: r.data?.status },
      });
    }

    return res.status(200).json({
      ok: true,
      result_text: resultText,
      meta: {
        model,
        prompts_repo: PROMPTS_REPO,
        prompts_ref: PROMPTS_REF,
        intent: intentId,
        output: outputPath,
        include_qa: includeQa,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      stage: "server_error",
      error: "Server error",
      details: String(e?.message || e),
    });
  }
}
