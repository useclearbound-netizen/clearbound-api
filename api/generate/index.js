// api/generate/index.js
// ClearBound vNext — Generation API (Vercel)
// - Browser -> Vercel direct (no WP plugin required)
// - Reads prompts from clearbound-prompts repo (raw GitHub)
// - Runs deterministic engine compute (v3.0 baseline)
// - Calls OpenAI with strict JSON-only instruction
//
// Env required in Vercel:
// - OPENAI_API_KEY
// - ALLOW_ORIGIN (e.g. https://useclearbound.com)
// - PROMPTS_REPO (e.g. useclearbound-netizen/clearbound-prompts)
// - PROMPTS_REF  (e.g. main)
// - CB_MODEL_DEFAULT (e.g. gpt-4.1-mini)
// - CB_MODEL_HIGH_RISK (e.g. gpt-4.1)
// - CB_MODEL_ANALYSIS (optional, e.g. gpt-4.1)

const { computeEngineDecisions } = require("../../engine/compute.js");

const PROMPT_CACHE = new Map(); // key -> { text, exp }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function setCors(req, res) {
  const allow = process.env.ALLOW_ORIGIN || "*";
  const origin = req.headers.origin || "";
  const isAllowed = allow === "*" || origin === allow;

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (allow === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", allow);
  }
  return isAllowed;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // basic guard (1MB)
      if (data.length > 1_000_000) reject(new Error("Payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function now() {
  return Date.now();
}

function cacheGet(key) {
  const v = PROMPT_CACHE.get(key);
  if (!v) return null;
  if (v.exp < now()) {
    PROMPT_CACHE.delete(key);
    return null;
  }
  return v.text;
}

function cacheSet(key, text) {
  PROMPT_CACHE.set(key, { text, exp: now() + CACHE_TTL_MS });
}

function buildRawPromptUrl({ repo, ref, path }) {
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
}

async function fetchPromptText(path) {
  const repo = process.env.PROMPTS_REPO;
  const ref = process.env.PROMPTS_REF || "main";
  if (!repo) return null;

  const key = `${repo}@${ref}:${path}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = buildRawPromptUrl({ repo, ref, path });
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return null;
  const text = await r.text();
  cacheSet(key, text);
  return text;
}

function pickModel(decisions, wantAnalysis) {
  // keep it simple & fast:
  // - high risk -> CB_MODEL_HIGH_RISK
  // - otherwise -> CB_MODEL_DEFAULT
  // analysis could use CB_MODEL_ANALYSIS if you want later
  const high = process.env.CB_MODEL_HIGH_RISK || process.env.CB_MODEL_DEFAULT;
  const def = process.env.CB_MODEL_DEFAULT || "gpt-4.1-mini";
  const analysis = process.env.CB_MODEL_ANALYSIS || def;

  if (wantAnalysis) return analysis;
  if (decisions?.risk_level === "high") return high;
  return def;
}

function normalizeText(s, max = 4000) {
  const t = (s ?? "").toString().trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) : t;
}

function buildUserPayload(state, decisions) {
  // Keep the LLM input minimal for latency.
  // Front already assembles context.text and key fields.
  const ctx = state?.context || {};
  const rel = state?.relationship?.value || null;
  const intent = state?.intent?.value || null;
  const tone = state?.tone?.value || null;
  const format = state?.format?.value || null;

  return {
    relationship: rel,
    intent,
    tone,
    format,
    context_text: normalizeText(ctx?.text, 2500),

    // keep deterministic decisions separate (engine authority)
    engine: {
      risk_level: decisions.risk_level,
      record_safe_level: decisions.record_safe_level,
      direction_suggestion: decisions.direction_suggestion,
      tone_recommendation: decisions.tone_recommendation,
      detail_recommendation: decisions.detail_recommendation,
      insight_candor_level: decisions.insight_candor_level,
      constraints: decisions.constraints
    },

    // package selection (message/email/bundle) + include_analysis
    paywall: {
      package: ctx?.paywall?.package || null,
      output: ctx?.paywall?.output || null,
      include_analysis: !!ctx?.paywall?.include_analysis
    }
  };
}

function expectedKeysForPackage(pkg) {
  // Always allow note_text; analysis_text optional based on include_analysis.
  if (pkg === "message") return ["message_text", "note_text"];
  if (pkg === "email") return ["email_text", "note_text"];
  if (pkg === "bundle") return ["message_text", "email_text", "note_text"];
  // fallback
  return ["message_text", "note_text"];
}

function buildSystemInstruction() {
  // IMPORTANT: keep it short for latency.
  return [
    "You are ClearBound.",
    "You must output JSON only.",
    "No markdown. No backticks. No extra keys.",
    "Use the engine decisions as authoritative constraints.",
    "Do not give advice. Do not predict outcomes. Do not use legal language.",
  ].join(" ");
}

function buildUserInstruction(pkg, includeAnalysis, keys) {
  const analysisLine = includeAnalysis
    ? "Include analysis_text as 3 lines: signals · strategy · bounded next step. Keep it calm and non-judgmental."
    : "Do NOT include analysis_text.";

  // Note: subject line for email can be embedded into email_text at top if you want later.
  return [
    `Return a JSON object with exactly these keys: ${keys.join(", ")}${includeAnalysis ? ", analysis_text" : ""}.`,
    analysisLine,
    "note_text must be short and practical (1–3 lines).",
    pkg === "email" || pkg === "bundle"
      ? "email_text must be structured with paragraphs and a clear closing."
      : "message_text must be structured (not one blob).",
  ].join(" ");
}

async function callOpenAI({ model, system, user, promptText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Use Responses API (recommended). Keep payload small.
  const input = [
    { role: "system", content: system },
    // promptText is optional; if file is empty, it won't hurt
    ...(promptText ? [{ role: "system", content: promptText }] : []),
    { role: "user", content: user },
  ];

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      // Force JSON-only output
      response_format: { type: "json_object" },
      // Smallish cap; adjust later
      max_output_tokens: 900,
    }),
  });

  const raw = await resp.text();
  const parsed = safeParseJson(raw);

  if (!resp.ok) {
    const msg = parsed?.error?.message || raw || "OpenAI request failed";
    throw new Error(msg);
  }

  // Responses API returns output_text in a few shapes; safest is to extract text.
  // Most reliably: parsed.output[0].content[0].text OR parsed.output_text
  const outText =
    parsed?.output_text ||
    parsed?.output?.[0]?.content?.[0]?.text ||
    "";

  const outJson = safeParseJson(outText.trim());
  if (!outJson) {
    throw new Error("Model did not return valid JSON");
  }
  return outJson;
}

module.exports = async (req, res) => {
  const okOrigin = setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // If you set a specific ALLOW_ORIGIN, reject others
  if (process.env.ALLOW_ORIGIN && process.env.ALLOW_ORIGIN !== "*" && !okOrigin) {
    return json(res, 403, { ok: false, error: "ORIGIN_NOT_ALLOWED" });
  }

  try {
    const bodyRaw = await readBody(req);
    const body = safeParseJson(bodyRaw);

    // Expect: { state: <object> } from front
    const state = body?.state;
    if (!state || typeof state !== "object") {
      return json(res, 400, { ok: false, error: "BAD_REQUEST", message: "Missing state object" });
    }

    // Minimal required: context.text + paywall.package
    const ctxText = normalizeText(state?.context?.text, 2500);
    const pkg = state?.context?.paywall?.package || null;
    const includeAnalysis = !!state?.context?.paywall?.include_analysis;

    if (!ctxText) {
      return json(res, 400, { ok: false, error: "MISSING_CONTEXT", message: "context.text is required" });
    }
    if (!pkg) {
      return json(res, 400, { ok: false, error: "MISSING_PACKAGE", message: "context.paywall.package is required" });
    }

    // 1) Engine decisions (deterministic)
    const decisions = computeEngineDecisions(state);

    // 2) Prompt selection (from clearbound-prompts)
    // Repo paths you showed:
    // prompts/v1/message.prompt.md
    // prompts/v1/email.prompt.md
    // prompts/v1/insight.prompt.md
    //
    // We’ll use:
    // - pkg=message -> message.prompt.md
    // - pkg=email   -> email.prompt.md
    // - pkg=bundle  -> message.prompt.md + email.prompt.md (merged as system text)
    let promptText = "";
    const msgPrompt = await fetchPromptText("prompts/v1/message.prompt.md");
    const emailPrompt = await fetchPromptText("prompts/v1/email.prompt.md");
    const insightPrompt = await fetchPromptText("prompts/v1/insight.prompt.md");

    if (pkg === "message") promptText = msgPrompt || "";
    if (pkg === "email") promptText = emailPrompt || "";
    if (pkg === "bundle") promptText = [msgPrompt || "", "\n\n", emailPrompt || ""].join("");

    // Optional: if includeAnalysis, append insight prompt as extra system guidance
    if (includeAnalysis && insightPrompt) {
      promptText = [promptText, "\n\n", insightPrompt].join("");
    }

    // 3) LLM call
    const model = pickModel(decisions, includeAnalysis);
    const keys = expectedKeysForPackage(pkg);
    const system = buildSystemInstruction();

    const userPayload = buildUserPayload(state, decisions);
    const user = [
      buildUserInstruction(pkg, includeAnalysis, keys),
      "",
      "INPUT_JSON:",
      JSON.stringify(userPayload),
    ].join("\n");

    const out = await callOpenAI({ model, system, user, promptText });

    // 4) Shape guard: only allow expected keys (+ analysis_text if includeAnalysis)
    const allowed = new Set(keys.concat(includeAnalysis ? ["analysis_text"] : []));
    const cleaned = {};
    for (const k of allowed) {
      if (typeof out?.[k] === "string" && out[k].trim()) cleaned[k] = out[k].trim();
    }

    // hard require note_text
    if (!cleaned.note_text) cleaned.note_text = "—";

    return json(res, 200, {
      ok: true,
      data: cleaned,
      engine: {
        risk_level: decisions.risk_level,
        record_safe_level: decisions.record_safe_level,
        tone_recommendation: decisions.tone_recommendation,
        detail_recommendation: decisions.detail_recommendation,
        direction_suggestion: decisions.direction_suggestion,
        insight_candor_level: decisions.insight_candor_level,
        constraints: decisions.constraints
      }
    });
  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: "GENERATION_FAILED",
      message: e?.message || String(e)
    });
  }
};
