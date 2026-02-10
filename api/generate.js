// /api/generate.js
// ClearBound — Vercel Serverless API (vNext) — 2-PASS, PACKAGE-FIRST
// Pass 1: Normalize + Layer1 (decision/control JSON)
// Pass 2: Assemble final deliverables (JSON only)

// =========================================================
// 0) Cache helpers (same style as your current file)
// =========================================================
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const promptCache =
  globalThis.__CB_PROMPT_CACHE__ || (globalThis.__CB_PROMPT_CACHE__ = new Map());

function now() { return Date.now(); }

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
  try { return JSON.parse(text); } catch { return null; }
}

function extractOutputText(data) {
  // Prefer convenience field if present
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  // Otherwise attempt to extract from Responses API structured output
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

  // Retry once on transient errors
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
  if (!obj || typeof obj !== "object") return false;
  if ("value" in obj) {
    const v = obj.value;
    if (typeof v === "string") return v.trim().length > 0;
    if (v != null) return true;
  }
  return false;
}

// =========================================================
// 1) Prompt path resolvers (intent/output)
// =========================================================
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

function pickModelBase() {
  return pickEnv("OPENAI_MODEL", "gpt-4.1-mini");
}

function pickModelForPass(passName) {
  // Optional overrides per pass
  const base = pickModelBase();
  if (passName === "pass1") return pickEnv("OPENAI_MODEL_PASS1", base);
  if (passName === "pass2") return pickEnv("OPENAI_MODEL_PASS2", base);
  return base;
}

function buildSafetyDisclaimerShort() {
  // Keep short + stable. (Front can render consistently.)
  return "This output is for communication support only and is not legal or medical advice.";
}

// =========================================================
// 2) Package plan (PACKAGE-FIRST)
// =========================================================
function pickPackageFromState(state) {
  // Prefer the LOCK-authoritative location when present:
  // - state.paywall.package (LOCK front state)
  // But tolerate your current “context.paywall.package” (front adapter)
  const p1 = state?.paywall?.package;
  const p2 = state?.context?.paywall?.package;
  const p3 = state?.context?.package; // last resort
  return asLowerId(p1 || p2 || p3 || "");
}

function isValidPackage(p) {
  return new Set(["message","email","analysis_message","analysis_email","total"]).has(p);
}

function planFromPackage(pkg) {
  // Deliverables mapping (LOCK)
  if (pkg === "message") return { wantReport:false, wantMessage:true,  wantEmail:false };
  if (pkg === "email")   return { wantReport:false, wantMessage:false, wantEmail:true  };
  if (pkg === "analysis_message") return { wantReport:true, wantMessage:true,  wantEmail:false };
  if (pkg === "analysis_email")   return { wantReport:true, wantMessage:false, wantEmail:true  };
  if (pkg === "total")  return { wantReport:true, wantMessage:true,  wantEmail:true  };
  return null;
}

// =========================================================
// 3) JSON guard (critical for “uniform output”)
// =========================================================
function ensureObjectJson(text) {
  if (!isNonEmptyString(text)) return null;
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  const obj = safeJsonParse(t);
  return obj && typeof obj === "object" ? obj : null;
}

function normalizeNullString(v) {
  // Prevent "null" string leakage
  if (v === "null") return null;
  return v;
}

function coerceFinalSchema(obj, pkg) {
  // Ensure required keys exist, fill missing with nulls
  const out = {
    package: pkg || obj?.package || null,
    message_text: null,
    email_text: null,
    analysis_report: null,
    notes: null,
    safety_disclaimer: buildSafetyDisclaimerShort(),
  };

  if (obj && typeof obj === "object") {
    out.package = out.package || obj.package || null;
    out.message_text = normalizeNullString(obj.message_text ?? null);
    out.email_text = normalizeNullString(obj.email_text ?? null);
    out.analysis_report = normalizeNullString(obj.analysis_report ?? null);
    out.notes = normalizeNullString(obj.notes ?? null);

    // Always keep disclaimer short + stable
    if (isNonEmptyString(obj.safety_disclaimer)) {
      // override only if you really want; recommended to keep fixed
      // out.safety_disclaimer = obj.safety_disclaimer.trim();
    }
  }

  return out;
}

function buildResultTextFallback(payload) {
  // Backward-compat concatenation (front expects single string sometimes)
  const parts = [];
  if (payload.analysis_report) parts.push(`=== Analysis ===\n${payload.analysis_report}`);
  if (payload.message_text) parts.push(`=== Message ===\n${payload.message_text}`);
  if (payload.email_text) parts.push(`=== Email ===\n${payload.email_text}`);
  if (!parts.length) return "";
  return parts.join("\n\n");
}

// =========================================================
// 4) Handler
// =========================================================
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
    // -------------------------
    // 4.1 Validate incoming body
    // -------------------------
    const body = req.body || {};
    const state = body.state;

    if (!state || typeof state !== "object") {
      return fail(400, "validate_body", {
        error: "Missing or invalid `state` object",
      });
    }

    // Your current pipeline expects these top keys (loose shape):
    // relationship/target/intent/tone/format/context
    // BUT we will be permissive since normalize takes "state" anyway.
    const requiredKeys = ["intent", "tone", "context"];
    const missingKeys = requiredKeys.filter((k) => !(k in state));
    if (missingKeys.length) {
      return fail(400, "validate_state", {
        error: `Missing fields: ${missingKeys.join(", ")}`,
      });
    }

    // Light shape checks for intent/tone (accept {value:"x"} or string)
    const intentOk =
      isNonEmptyString(state.intent) || hasValueLike(state.intent);
    const toneOk =
      isNonEmptyString(state.tone) || hasValueLike(state.tone);

    // context must include some non-empty text in your vNext front
    const contextOk =
      isNonEmptyString(state.context) ||
      (state.context &&
        typeof state.context === "object" &&
        (isNonEmptyString(state.context.text) ||
          isNonEmptyString(state.context.value) ||
          isNonEmptyString(state.context.summary) ||
          isNonEmptyString(state.context.raw)));

    if (!intentOk || !toneOk || !contextOk) {
      return fail(400, "validate_state_shape", {
        error: "Invalid or empty fields",
        details: {
          missing: [
            ...(intentOk ? [] : ["intent(value)"]),
            ...(toneOk ? [] : ["tone(value)"]),
            ...(contextOk ? [] : ["context(text)"]),
          ],
        },
      });
    }

    // -------------------------
    // 4.2 Env
    // -------------------------
    const OPENAI_API_KEY = pickEnv("OPENAI_API_KEY");
    const PROMPTS_REPO = pickEnv("PROMPTS_REPO");
    const PROMPTS_REF = pickEnv("PROMPTS_REF", "main");

    if (!OPENAI_API_KEY) return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return fail(500, "env", { error: "PROMPTS_REPO missing" });

    const ttlMs =
      Number(pickEnv("PROMPT_CACHE_TTL_MS", String(DEFAULT_CACHE_TTL_MS))) ||
      DEFAULT_CACHE_TTL_MS;

    const retryOnce = String(pickEnv("OPENAI_RETRY_ONCE", "1")) === "1";

    // -------------------------
    // 4.3 Package-first plan
    // -------------------------
    const pkg = pickPackageFromState(state);
    if (!isValidPackage(pkg)) {
      return fail(400, "validate_package", {
        error: "Invalid or missing package (paywall.package)",
        details: { package: pkg || null },
      });
    }
    const plan = planFromPackage(pkg);
    if (!plan) {
      return fail(400, "plan", { error: "Failed to build plan", details: { package: pkg } });
    }

    // -------------------------
    // 4.4 IDs for prompt fetch
    // -------------------------
    // intent value can be string or {value:"x"}
    const intentId = asLowerId(
      (typeof state.intent === "string") ? state.intent : state.intent?.value
    );

    const intentPath = resolveIntentPath(intentId);
    if (!intentPath) {
      return fail(400, "validate_ids", {
        error: "Invalid intent value",
        details: { intentId },
      });
    }

    // GitHub raw URL
    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    // -------------------------
    // 4.5 Fetch prompts (shared)
    // -------------------------
    const normalizePath = "prompts/normalize/normalize_state_to_canonical.prompt.md";
    const assemblePath = "prompts/assemble/assemble_generate.prompt.md";
    const qaCorePath = "qa/rules/core.yaml";

    // You should add this file in repo (recommended):
    // prompts/layer1/layer1_control.prompt.md
    const layer1Path = pickEnv(
      "LAYER1_PROMPT_PATH",
      "prompts/layer1/layer1_control.prompt.md"
    );

    const includeQa = String(pickEnv("INCLUDE_QA_RULES", "1")) === "1";

    let intentPrompt, normalizePrompt, layer1Prompt, assemblePrompt, qaRulesPrompt;

    try {
      const fetches = [
        ["intent", intentPath],
        ["normalize", normalizePath],
        ["layer1", layer1Path],
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
      layer1Prompt = byLabel.layer1;
      assemblePrompt = byLabel.assemble;
      qaRulesPrompt = byLabel.qa || "";
    } catch (e) {
      return fail(502, "prompt_fetch", { error: String(e?.message || e) });
    }

    // =========================================================
    // PASS 1: Normalize + Layer1 (deterministic JSON)
    // =========================================================
    const pass1SystemParts = [
      "Return ONLY valid JSON. No markdown. No explanations.",
      "",
      // Normalize expects: { "state": ... } and outputs: { "canonical": ... }
      normalizePrompt,
      "",
      // Layer1 should accept: { "canonical": ... } (or { canonical } + maybe state) and output: { "layer1": ... }
      layer1Prompt,
    ];

    if (includeQa && qaRulesPrompt) {
      pass1SystemParts.push("", "=== QA RULES (for internal compliance) ===", qaRulesPrompt);
    }

    const pass1System = pass1SystemParts.join("\n");

    const pass1User = JSON.stringify({ state }, null, 2);

    const pass1Payload = {
      model: pickModelForPass("pass1"),
      input: [
        { role: "system", content: pass1System },
        { role: "user", content: pass1User },
      ],
      temperature: Number(pickEnv("OPENAI_TEMPERATURE_PASS1", "0.0")),
      max_output_tokens: Number(pickEnv("OPENAI_MAX_OUTPUT_TOKENS_PASS1", "900")),
    };

    const r1 = await callOpenAIWithOptionalRetry({
      apiKey: OPENAI_API_KEY,
      payload: pass1Payload,
      retryOnce,
    });

    if (!r1.ok) {
      return fail(502, "openai_pass1", {
        error: "OpenAI failed (pass1)",
        http_status: r1.status,
        details: r1.data || { raw: (r1.raw || "").slice(0, 600) },
      });
    }

    const pass1Text = extractOutputText(r1.data);
    const pass1Obj = ensureObjectJson(pass1Text);

    if (!pass1Obj || typeof pass1Obj !== "object") {
      return fail(502, "pass1_parse", {
        error: "Pass1 did not return valid JSON",
        details: { snippet: String(pass1Text || "").slice(0, 600) },
      });
    }

    // Accept a few shapes; normalize to { canonical, layer1 }
    const canonical = pass1Obj.canonical || pass1Obj?.canonical_object || null;
    const layer1 = pass1Obj.layer1 || pass1Obj?.control || pass1Obj?.layer1_internal || null;

    if (!canonical || typeof canonical !== "object") {
      return fail(502, "pass1_missing_canonical", {
        error: "Pass1 missing `canonical` object",
        details: { keys: Object.keys(pass1Obj || {}) },
      });
    }
    if (!layer1 || typeof layer1 !== "object") {
      return fail(502, "pass1_missing_layer1", {
        error: "Pass1 missing `layer1` object",
        details: { keys: Object.keys(pass1Obj || {}) },
      });
    }

    // Force canonical.package = package-first truth (prevent drift)
    canonical.package = pkg;

    // =========================================================
    // PASS 2: Assemble final deliverables (JSON only)
    // =========================================================
    const pass2SystemParts = [
      "Return ONLY valid JSON. No markdown. No explanations.",
      "",
      // Intent rules (what the message should do)
      intentPrompt,
      "",
      // Assemble controller (package mapping + schema)
      assemblePrompt,
    ];

    if (includeQa && qaRulesPrompt) {
      pass2SystemParts.push("", "=== QA RULES (for internal compliance) ===", qaRulesPrompt);
    }

    const pass2System = pass2SystemParts.join("\n");
    const pass2User = JSON.stringify({ canonical, layer1 }, null, 2);

    const pass2Payload = {
      model: pickModelForPass("pass2"),
      input: [
        { role: "system", content: pass2System },
        { role: "user", content: pass2User },
      ],
      temperature: Number(pickEnv("OPENAI_TEMPERATURE_PASS2", "0.4")),
      max_output_tokens: Number(pickEnv("OPENAI_MAX_OUTPUT_TOKENS_PASS2", "1100")),
    };

    const r2 = await callOpenAIWithOptionalRetry({
      apiKey: OPENAI_API_KEY,
      payload: pass2Payload,
      retryOnce,
    });

    if (!r2.ok) {
      return fail(502, "openai_pass2", {
        error: "OpenAI failed (pass2)",
        http_status: r2.status,
        details: r2.data || { raw: (r2.raw || "").slice(0, 600) },
      });
    }

    const pass2Text = extractOutputText(r2.data);
    const pass2Obj = ensureObjectJson(pass2Text);

    if (!pass2Obj || typeof pass2Obj !== "object") {
      return fail(502, "pass2_parse", {
        error: "Pass2 did not return valid JSON",
        details: { snippet: String(pass2Text || "").slice(0, 600) },
      });
    }

    // Coerce schema + enforce package truth + stable disclaimer
    const finalPayload = coerceFinalSchema(pass2Obj, pkg);

    // Enforce deliverables based on plan (prevent leakage)
    if (!plan.wantReport) finalPayload.analysis_report = null;
    if (!plan.wantMessage) finalPayload.message_text = null;
    if (!plan.wantEmail) finalPayload.email_text = null;

    // Notes policy enforcement (light)
    if (finalPayload.analysis_report && isNonEmptyString(finalPayload.notes)) {
      // keep minimal but do not hard-fail; or null it to be strict
      const n = String(finalPayload.notes).trim();
      finalPayload.notes = n.length > 220 ? (n.slice(0, 219) + "…") : n;
    }

    // Backward compatible `result_text`
    const result_text = buildResultTextFallback(finalPayload);

    return res.status(200).json({
      ok: true,
      result_text, // fallback for older front
      data: finalPayload, // stable structured output
      meta: {
        package: pkg,
        intent: intentId,
        model_pass1: pass1Payload.model,
        model_pass2: pass2Payload.model,
        prompts_repo: PROMPTS_REPO,
        prompts_ref: PROMPTS_REF,
        include_qa: includeQa,
        plan,
        version: "vnext-2pass-1",
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
