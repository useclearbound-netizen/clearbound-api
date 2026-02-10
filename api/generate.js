// /api/generate.js
// ClearBound — Vercel Serverless API (vNext)
// 3-PASS Stable Pipeline (kept)
// Pass A: state -> canonical
// Pass B: canonical -> layer1 (internal minimal safety analysis)
// Pass C: {canonical, layer1, requested_outputs} -> final deliverables JSON
//
// vNext Fix:
// - Enforce package-based output limits (ONLY generate requested fields)
// - Include ONLY relevant output prompts in Pass C
// - Server-side strip of disallowed fields (hard guarantee)
// - Better schema validation per package

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const promptCache =
  globalThis.__CB_PROMPT_CACHE__ || (globalThis.__CB_PROMPT_CACHE__ = new Map());

function now() { return Date.now(); }
function cacheKey(repo, ref, path) { return `${repo}@${ref}:${path}`; }

function getCached(key) {
  const hit = promptCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now()) { promptCache.delete(key); return null; }
  return hit.value;
}
function setCached(key, value, ttlMs) { promptCache.set(key, { value, expiresAt: now() + ttlMs }); }

function pickEnv(name, fallback = null) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function jsonFail(res, status, stage, extra = {}) {
  return res.status(status).json({ ok: false, stage, ...extra });
}

function asLowerId(v) { return String(v || "").trim().toLowerCase(); }

async function fetchTextWithCache(url, key, ttlMs) {
  const cached = getCached(key);
  if (cached != null) return cached;

  const r = await fetch(url, { method: "GET", headers: { "Cache-Control": "no-cache" } });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`PROMPT_FETCH_FAIL:${r.status}:${url}:${text.slice(0, 200)}`);

  setCached(key, text, ttlMs);
  return text;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

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
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await resp.text().catch(() => "");
    const data = safeJsonParse(raw);
    return { ok: resp.ok, status: resp.status, data, raw };
  };

  const r1 = await attempt();
  if (r1.ok) return r1;

  const transient = [408, 429, 500, 502, 503, 504].includes(r1.status);
  if (retryOnce && transient) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return await attempt();
  }
  return r1;
}

function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }

function hasValueLike(obj) {
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
 * - prompts/normalize/normalize_state_to_canonical.prompt.md
 * - prompts/layer1/layer1_control.prompt.md
 * - prompts/intent/<intent>.prompt.md
 * - prompts/output/message.prompt.md
 * - prompts/output/email.prompt.md
 * - prompts/output/analysis_report.prompt.md
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

function looksLikeFrontState(state) {
  const requiredKeys = ["relationship", "target", "intent", "tone", "format", "context"];
  const missing = requiredKeys.filter((k) => !(k in state));
  return { ok: missing.length === 0, missing };
}

function validateFrontStateShape(state) {
  const relationshipOk = hasValueLike(state.relationship);
  const targetOk = hasValueLike(state.target);
  const intentOk = hasValueLike(state.intent);
  const toneOk = hasValueLike(state.tone);
  const formatOk = hasValueLike(state.format);

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

  return { ok: shapeMissing.length === 0, shapeMissing };
}

function ensureObjectHasKey(obj, key) {
  return obj && typeof obj === "object" && key in obj;
}

function coerceJsonObjectOrFail(text) {
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

function pickModel(passName, formatId) {
  const base = pickEnv("OPENAI_MODEL", "gpt-4.1-mini");
  if (passName === "passA_normalize") return pickEnv("OPENAI_MODEL_NORMALIZE", base);
  if (passName === "passB_layer1") return pickEnv("OPENAI_MODEL_LAYER1", base);
  if (passName === "passC_assemble") {
    const f = asLowerId(formatId);
    if (f === "email") return pickEnv("OPENAI_MODEL_EMAIL", base);
    return pickEnv("OPENAI_MODEL_MESSAGE", base);
  }
  return base;
}

function promptHeader(passName) {
  return [
    "CRITICAL OUTPUT CONTRACT:",
    "- Return ONLY valid JSON.",
    "- Do NOT include markdown.",
    "- Do NOT include extra commentary.",
    "- If you cannot comply, return: {\"error\":\"noncompliant_output\"}",
    `- Pass: ${passName}`,
  ].join("\n");
}

/** ----------------------------
 * Package-based output contract
 * ---------------------------- */
function normalizePackageId(pkg) {
  const p = asLowerId(pkg);
  const allowed = new Set(["message", "email", "analysis_message", "analysis_email", "total"]);
  return allowed.has(p) ? p : null;
}

function requestedOutputsForPackage(pkg) {
  // 대표님 원칙 그대로:
  // message -> message_text
  // email -> email_text
  // analysis_email -> analysis_report + email_text
  // analysis_message -> analysis_report + message_text
  // total -> analysis_report + message_text + email_text
  switch (pkg) {
    case "message":
      return { wantMessage: true, wantEmail: false, wantAnalysis: false };
    case "email":
      return { wantMessage: false, wantEmail: true, wantAnalysis: false };
    case "analysis_message":
      return { wantMessage: true, wantEmail: false, wantAnalysis: true };
    case "analysis_email":
      return { wantMessage: false, wantEmail: true, wantAnalysis: true };
    case "total":
      return { wantMessage: true, wantEmail: true, wantAnalysis: true };
    default:
      return { wantMessage: false, wantEmail: false, wantAnalysis: false };
  }
}

function enforceFinalSchemaByPackage(finalObj, pkg) {
  const p = normalizePackageId(pkg);
  if (!p) return { ok: false, error: "invalid_package" };

  const need = requestedOutputsForPackage(p);

  // Keep only allowed keys (hard guarantee)
  const keep = new Set(["package", "message_text", "email_text", "analysis_report", "notes", "safety_disclaimer"]);
  for (const k of Object.keys(finalObj)) {
    if (!keep.has(k)) delete finalObj[k];
  }

  // Force package to the requested one (don’t allow model to drift)
  finalObj.package = p;

  // Strip disallowed payloads
  if (!need.wantMessage) delete finalObj.message_text;
  if (!need.wantEmail) delete finalObj.email_text;
  if (!need.wantAnalysis) delete finalObj.analysis_report;

  // Validate required fields
  if (!isNonEmptyString(finalObj.safety_disclaimer)) {
    return { ok: false, error: "missing_safety_disclaimer" };
  }
  if (need.wantMessage && !isNonEmptyString(finalObj.message_text)) {
    return { ok: false, error: "missing_message_text" };
  }
  if (need.wantEmail && !isNonEmptyString(finalObj.email_text)) {
    return { ok: false, error: "missing_email_text" };
  }
  if (need.wantAnalysis && !isNonEmptyString(finalObj.analysis_report)) {
    return { ok: false, error: "missing_analysis_report" };
  }

  return { ok: true };
}

function pickPackageFromFrontState(state) {
  // front sends: state.context.paywall.package (from your adapter)
  const pkg =
    state?.context?.paywall?.package ||
    state?.context?.paywall?.package_id ||
    state?.context?.package ||
    state?.package;
  return normalizePackageId(pkg) || "message"; // safe default
}

export default async function handler(req, res) {
  // CORS (minimal)
  const allowOrigin = pickEnv("ALLOW_ORIGIN", "*");
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return jsonFail(res, 405, "method", { error: "Method not allowed" });

  const fail = (status, stage, extra = {}) => jsonFail(res, status, stage, extra);

  try {
    const body = req.body || {};
    const state = body.state;

    if (!state || typeof state !== "object") {
      return fail(400, "validate_body", { error: "Missing or invalid `state` object" });
    }

    const { ok: keysOk, missing } = looksLikeFrontState(state);
    if (!keysOk) {
      return fail(400, "validate_state_keys", { error: `Missing fields: ${missing.join(", ")}` });
    }

    const shape = validateFrontStateShape(state);
    if (!shape.ok) {
      return fail(400, "validate_state_shape", {
        error: "Invalid or empty fields",
        details: { missing: shape.shapeMissing },
      });
    }

    // Package enforcement inputs
    const pkg = pickPackageFromFrontState(state);
    const requested = requestedOutputsForPackage(pkg);

    // Env
    const OPENAI_API_KEY = pickEnv("OPENAI_API_KEY");
    const PROMPTS_REPO = pickEnv("PROMPTS_REPO");
    const PROMPTS_REF = pickEnv("PROMPTS_REF", "main");

    if (!OPENAI_API_KEY) return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return fail(500, "env", { error: "PROMPTS_REPO missing" });

    const ttlMs =
      Number(pickEnv("PROMPT_CACHE_TTL_MS", String(DEFAULT_CACHE_TTL_MS))) || DEFAULT_CACHE_TTL_MS;

    const includeQa = String(pickEnv("INCLUDE_QA_RULES", "1")) === "1";
    const retryOnce = String(pickEnv("OPENAI_RETRY_ONCE", "1")) === "1";

    const ghRaw = (path) => `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    // Fixed prompt paths
    const normalizePath = "prompts/normalize/normalize_state_to_canonical.prompt.md";
    const layer1Path = "prompts/layer1/layer1_control.prompt.md";
    const assemblePath = "prompts/assemble/assemble_generate.prompt.md";

    // Output prompts (load ONLY what we need)
    const outputMessagePath = "prompts/output/message.prompt.md";
    const outputEmailPath = "prompts/output/email.prompt.md";
    const outputAnalysisPath = "prompts/output/analysis_report.prompt.md";

    const qaCorePath = "qa/rules/core.yaml";

    // Fetch shared prompts early
    let normalizePrompt, layer1Prompt, assemblePrompt;
    let outMsgPrompt = "", outEmailPrompt = "", outAnalysisPrompt = "", qaRulesPrompt = "";

    try {
      const fetches = [
        ["normalize", normalizePath],
        ["layer1", layer1Path],
        ["assemble", assemblePath],
      ];

      if (requested.wantMessage) fetches.push(["out_msg", outputMessagePath]);
      if (requested.wantEmail) fetches.push(["out_email", outputEmailPath]);
      if (requested.wantAnalysis) fetches.push(["out_analysis", outputAnalysisPath]);

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
      normalizePrompt = byLabel.normalize;
      layer1Prompt = byLabel.layer1;
      assemblePrompt = byLabel.assemble;
      outMsgPrompt = byLabel.out_msg || "";
      outEmailPrompt = byLabel.out_email || "";
      outAnalysisPrompt = byLabel.out_analysis || "";
      qaRulesPrompt = byLabel.qa || "";
    } catch (e) {
      return fail(502, "prompt_fetch", { error: String(e?.message || e) });
    }

    // -----------------------
    // PASS A: state -> canonical
    // -----------------------
    const passA_system = [promptHeader("passA_normalize"), "", normalizePrompt].join("\n");
    const passA_user = JSON.stringify({ state }, null, 2);

    const passA_payload = {
      model: pickModel("passA_normalize", state.format?.value),
      input: [
        { role: "system", content: passA_system },
        { role: "user", content: passA_user },
      ],
      temperature: Number(pickEnv("OPENAI_TEMPERATURE_NORMALIZE", "0.0")),
      max_output_tokens: Number(pickEnv("OPENAI_MAX_OUTPUT_TOKENS_NORMALIZE", "700")),
    };

    const a = await callOpenAIWithOptionalRetry({ apiKey: OPENAI_API_KEY, payload: passA_payload, retryOnce });
    if (!a.ok) {
      return fail(502, "passA_openai", {
        error: "OpenAI failed (Pass A)",
        http_status: a.status,
        details: a.data || { raw: (a.raw || "").slice(0, 600) },
      });
    }

    const passA_text = extractOutputText(a.data);
    const passA_obj = coerceJsonObjectOrFail(passA_text);

    if (!passA_obj || !ensureObjectHasKey(passA_obj, "canonical")) {
      return fail(502, "passA_missing_canonical", {
        error: "Pass A missing `canonical` object",
        details: { snippet: (passA_text || "").slice(0, 400), keys: passA_obj ? Object.keys(passA_obj) : null },
      });
    }

    const canonical = passA_obj.canonical;
    if (!canonical || typeof canonical !== "object") {
      return fail(502, "passA_bad_canonical", { error: "Invalid canonical payload" });
    }

    // -----------------------
    // PASS B: canonical -> layer1
    // -----------------------
    const passB_system = [promptHeader("passB_layer1"), "", layer1Prompt].join("\n");
    const passB_user = JSON.stringify({ canonical }, null, 2);

    const passB_payload = {
      model: pickModel("passB_layer1", state.format?.value),
      input: [
        { role: "system", content: passB_system },
        { role: "user", content: passB_user },
      ],
      temperature: Number(pickEnv("OPENAI_TEMPERATURE_LAYER1", "0.0")),
      max_output_tokens: Number(pickEnv("OPENAI_MAX_OUTPUT_TOKENS_LAYER1", "900")),
    };

    const b = await callOpenAIWithOptionalRetry({ apiKey: OPENAI_API_KEY, payload: passB_payload, retryOnce });
    if (!b.ok) {
      return fail(502, "passB_openai", {
        error: "OpenAI failed (Pass B)",
        http_status: b.status,
        details: b.data || { raw: (b.raw || "").slice(0, 600) },
      });
    }

    const passB_text = extractOutputText(b.data);
    const passB_obj = coerceJsonObjectOrFail(passB_text);

    if (!passB_obj || !ensureObjectHasKey(passB_obj, "layer1")) {
      return fail(502, "passB_missing_layer1", {
        error: "Pass B missing `layer1` object",
        details: { snippet: (passB_text || "").slice(0, 400), keys: passB_obj ? Object.keys(passB_obj) : null },
      });
    }

    const layer1 = passB_obj.layer1;
    if (!layer1 || typeof layer1 !== "object") {
      return fail(502, "passB_bad_layer1", { error: "Invalid layer1 payload" });
    }

    // -----------------------
    // PASS C: {canonical, layer1, requested_outputs} -> final deliverables JSON
    // -----------------------
    const intentId = asLowerId(canonical.intent);
    const intentPath = resolveIntentPath(intentId);

    if (!intentPath) {
      return fail(400, "validate_ids", {
        error: "Invalid intent value (canonical.intent)",
        details: { intentId },
      });
    }

    // Fetch intent prompt
    let intentPrompt;
    try {
      const url = ghRaw(intentPath);
      const key = cacheKey(PROMPTS_REPO, PROMPTS_REF, intentPath);
      intentPrompt = await fetchTextWithCache(url, key, ttlMs);
    } catch (e) {
      return fail(502, "prompt_fetch_intent", { error: String(e?.message || e) });
    }

    // Build Pass C system with ONLY required output prompts
    const systemParts = [
      promptHeader("passC_assemble"),
      "",
      "Return ONLY the final JSON deliverables. No explanations.",
      "",
      `REQUESTED PACKAGE: ${pkg}`,
      `REQUESTED OUTPUTS: ${JSON.stringify(requested)}`,
      "",
      "Hard rules:",
      "- If requested.wantAnalysis is false: DO NOT include analysis_report.",
      "- If requested.wantMessage is false: DO NOT include message_text.",
      "- If requested.wantEmail is false: DO NOT include email_text.",
      "- Always include: package, safety_disclaimer.",
      "- package MUST equal REQUESTED PACKAGE.",
      "",
      intentPrompt,
    ];

    if (requested.wantMessage) systemParts.push("", "=== OUTPUT RULES: MESSAGE ===", outMsgPrompt);
    if (requested.wantEmail) systemParts.push("", "=== OUTPUT RULES: EMAIL ===", outEmailPrompt);
    if (requested.wantAnalysis) systemParts.push("", "=== OUTPUT RULES: ANALYSIS REPORT ===", outAnalysisPrompt);

    systemParts.push("", assemblePrompt);

    if (includeQa && qaRulesPrompt) {
      systemParts.push("", "=== QA RULES (internal compliance) ===", qaRulesPrompt);
    }

    const passC_system = systemParts.join("\n");

    // Feed requested outputs into user content so it’s “visible” in both system+user
    const passC_user = JSON.stringify(
      { canonical, layer1, requested, package: pkg },
      null,
      2
    );

    const formatId = asLowerId(state.format?.value);
    const passC_payload = {
      model: pickModel("passC_assemble", formatId),
      input: [
        { role: "system", content: passC_system },
        { role: "user", content: passC_user },
      ],
      // keep creativity moderate, but not too high
      temperature: Number(pickEnv("OPENAI_TEMPERATURE", "0.3")),
      // reduce output tokens when fewer outputs requested
      max_output_tokens: Number(
        pickEnv(
          "OPENAI_MAX_OUTPUT_TOKENS",
          requested.wantAnalysis ? "900" : "450"
        )
      ),
    };

    const c = await callOpenAIWithOptionalRetry({ apiKey: OPENAI_API_KEY, payload: passC_payload, retryOnce });
    if (!c.ok) {
      return fail(502, "passC_openai", {
        error: "OpenAI failed (Pass C)",
        http_status: c.status,
        details: c.data || { raw: (c.raw || "").slice(0, 600) },
      });
    }

    const passC_text = extractOutputText(c.data);
    if (!passC_text) {
      return fail(502, "passC_empty_output", {
        error: "Empty result (Pass C)",
        details: { id: c.data?.id, status: c.data?.status },
      });
    }

    const finalObj = safeJsonParse(passC_text);
    if (!finalObj || typeof finalObj !== "object") {
      return fail(502, "passC_non_json", {
        error: "Final output is not valid JSON",
        details: { snippet: passC_text.slice(0, 600) },
      });
    }

    // Must contain minimum required fields
    if (!("package" in finalObj) || !("safety_disclaimer" in finalObj)) {
      return fail(502, "passC_bad_schema", {
        error: "Final JSON missing required fields",
        details: { keys: Object.keys(finalObj).slice(0, 50) },
      });
    }

    // HARD ENFORCEMENT by package (strip + validate)
    const enforced = enforceFinalSchemaByPackage(finalObj, pkg);
    if (!enforced.ok) {
      return fail(502, "passC_package_contract_failed", {
        error: "Final JSON violates package output contract",
        details: { package: pkg, reason: enforced.error, keys: Object.keys(finalObj) },
      });
    }

    return res.status(200).json({
      ok: true,
      result_text: JSON.stringify(finalObj), // IMPORTANT: stringify normalized/stripped object
      meta: {
        pipeline: "3-pass",
        package: pkg,
        requested,
        model: passC_payload.model,
        prompts_repo: PROMPTS_REPO,
        prompts_ref: PROMPTS_REF,
        intent: intentId,
        include_qa: includeQa,
        passA_model: passA_payload.model,
        passB_model: passB_payload.model,
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
