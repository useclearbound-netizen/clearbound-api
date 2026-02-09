// /api/generate.js
// ClearBound — Vercel Serverless API (v1 service baseline)
// ✅ Updated to accept vNext frontend state schema (relationship_axis / risk_scan / context_builder / intent / tone / depth / paywall / format)
// ✅ Wires prompt loading to clearbound-vnext repo structure:
//    prompts/normalize/normalize_state_to_canonical.prompt.md
//    prompts/intent/<intent>.prompt.md
//    prompts/assemble/assemble_generate.prompt.md
//    prompts/output/{message,email,analysis_report}.prompt.md
//
// Notes:
// - Frontend + WP plugin stay unchanged.
// - Validation is vNext-aware (no more relationship/target/context legacy keys).
// - Model routing supports base/premium via env with a simple risk-based switch.

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
  // Prefer convenience field if present
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // Otherwise attempt structured output extraction (Responses API)
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

/* =========================================================
   vNext State Helpers
   ========================================================= */

function getVNextIds(state) {
  // vNext frontend schema (expected)
  const relationship_axis = asLowerId(state?.relationship_axis?.value);
  const impact = asLowerId(state?.risk_scan?.impact);        // high | low
  const continuity = asLowerId(state?.risk_scan?.continuity); // high | mid | low

  const situation_type = asLowerId(state?.context_builder?.situation_type);
  const key_facts = String(state?.context_builder?.key_facts || "");
  const main_concerns = Array.isArray(state?.context_builder?.main_concerns)
    ? state.context_builder.main_concerns
    : [];
  const constraints = Array.isArray(state?.context_builder?.constraints)
    ? state.context_builder.constraints
    : [];

  const intent = asLowerId(state?.intent); // vNext uses string id (e.g., "push_back")
  const tone = asLowerId(state?.tone);     // calm | firm | formal
  const depth = asLowerId(state?.depth || "standard"); // concise | standard | detailed

  // backend-compat kept in frontend: state.format.value ("message"|"email")
  const format = asLowerId(state?.format?.value);

  // paywall (Step 6)
  const paywallPkg = asLowerId(state?.paywall?.package);
  const includeAnalysis = !!state?.paywall?.include_analysis;
  const outputSel = asLowerId(state?.paywall?.output); // "message"|"email"|"both" (optional)

  return {
    relationship_axis,
    impact,
    continuity,
    situation_type,
    key_facts,
    main_concerns,
    constraints,
    intent,
    tone,
    depth,
    format,
    paywallPkg,
    includeAnalysis,
    outputSel,
  };
}

function validateVNextStateOrFail(fail, state) {
  const ids = getVNextIds(state);

  // Minimal required set to avoid breaking on minor UI changes.
  // (We keep this conservative; normalize prompt handles many details.)
  const missing = [];

  if (!ids.relationship_axis) missing.push("relationship_axis.value");
  if (!ids.impact) missing.push("risk_scan.impact");
  if (!ids.continuity) missing.push("risk_scan.continuity");
  if (!ids.situation_type) missing.push("context_builder.situation_type");

  const facts = (ids.key_facts || "").trim();
  if (facts.length < 20) missing.push("context_builder.key_facts(min 20 chars)");

  if (!ids.intent) missing.push("intent");
  if (!ids.tone) missing.push("tone");
  if (!ids.format) missing.push("format.value");

  if (missing.length) {
    return fail(400, "validate_state_vnext", {
      error: `Missing fields: ${missing.join(", ")}`,
    });
  }

  // Soft checks
  if (Array.isArray(ids.main_concerns) && ids.main_concerns.length > 2) {
    return fail(400, "validate_state_vnext", {
      error: "Too many main_concerns (max 2).",
    });
  }

  return null; // OK
}

function riskScoreHeuristic(ids, rawText) {
  // Simple, transparent heuristic for v1:
  // - "official" intent or "high" consequences or "both+analysis" => higher risk
  // - keyword bump (legal/financial/tenancy/employment/medical)
  let score = 0;

  const hiIntents = new Set(["official", "set_boundary", "push_back", "reset_expectations"]);
  if (hiIntents.has(ids.intent)) score += 2;

  if (ids.impact === "high") score += 2;
  if (ids.continuity === "high") score += 1;

  if (ids.includeAnalysis) score += 1;
  if (ids.outputSel === "both") score += 1;

  const t = String(rawText || "").toLowerCase();
  const keywords = [
    "law", "legal", "attorney", "lawsuit", "court", "contract", "invoice", "refund",
    "rent", "tenant", "landlord", "evict", "deposit",
    "terminate", "fired", "hr", "harassment", "discrimination",
    "hospital", "clinic", "doctor", "medical", "insurance",
    "police", "report", "threat", "safety",
    "debt", "payment", "chargeback", "scam",
  ];
  for (const k of keywords) {
    if (t.includes(k)) { score += 2; break; }
  }

  return score;
}

function selectModelFromHeuristic(ids, rawStateText) {
  const base = pickEnv("OPENAI_MODEL_BASE", pickEnv("OPENAI_MODEL", "gpt-4.1-mini"));
  const premium = pickEnv("OPENAI_MODEL_PREMIUM", "gpt-4.1");

  // Threshold can be tuned via env
  const threshold = Number(pickEnv("MODEL_SWITCH_RISK_THRESHOLD", "4")) || 4;

  const score = riskScoreHeuristic(ids, rawStateText);

  return {
    model: score >= threshold ? premium : base,
    risk_score: score,
    threshold,
  };
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
      return fail(400, "validate_body", { error: "Missing or invalid `state` object" });
    }

    // vNext validation (replaces v1 relationship/target/context requirement)
    const vErr = validateVNextStateOrFail(fail, state);
    if (vErr) return vErr;

    const ids = getVNextIds(state);

    // Env
    const OPENAI_API_KEY = pickEnv("OPENAI_API_KEY");
    const PROMPTS_REPO = pickEnv("PROMPTS_REPO"); // should point to useclearbound-netizen/clearbound-vnext
    const PROMPTS_REF = pickEnv("PROMPTS_REF", "main");

    if (!OPENAI_API_KEY) return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return fail(500, "env", { error: "PROMPTS_REPO missing" });

    // Cache TTL (ms)
    const ttlMs =
      Number(pickEnv("PROMPT_CACHE_TTL_MS", String(DEFAULT_CACHE_TTL_MS))) ||
      DEFAULT_CACHE_TTL_MS;

    // Determine requested outputs
    // - Prefer explicit paywall.output when present, else fall back to format.value
    // - If paywall says "both", we include both output specs.
    const wantBoth = ids.outputSel === "both";
    const wantEmail = wantBoth ? true : (ids.outputSel ? ids.outputSel === "email" : ids.format === "email");
    const wantMessage = wantBoth ? true : (ids.outputSel ? ids.outputSel === "message" : ids.format === "message");
    const wantAnalysis = ids.includeAnalysis === true;

    // GitHub raw URLs
    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    // Prompt paths (clearbound-vnext repo)
    // (These files were committed in your baseline.)
    const promptPaths = {
      normalize: `prompts/normalize/normalize_state_to_canonical.prompt.md`,
      intent: `prompts/intent/${ids.intent}.prompt.md`,
      assemble: `prompts/assemble/assemble_generate.prompt.md`,
      output_message: `prompts/output/message.prompt.md`,
      output_email: `prompts/output/email.prompt.md`,
      output_analysis: `prompts/output/analysis_report.prompt.md`,
    };

    // Fetch prompts (cached)
    let normalizePrompt,
      intentPrompt,
      assemblePrompt,
      outputMessagePrompt,
      outputEmailPrompt,
      outputAnalysisPrompt;

    try {
      const entries = Object.entries(promptPaths);

      const fetched = await Promise.all(
        entries.map(async ([label, path]) => {
          // Only fetch output specs that we actually need (saves time/cost)
          if (label === "output_message" && !wantMessage) return [label, ""];
          if (label === "output_email" && !wantEmail) return [label, ""];
          if (label === "output_analysis" && !wantAnalysis) return [label, ""];

          const url = ghRaw(path);
          const key = cacheKey(PROMPTS_REPO, PROMPTS_REF, path);
          const text = await fetchTextWithCache(url, key, ttlMs);
          return [label, text];
        })
      );

      const map = Object.fromEntries(fetched);

      normalizePrompt = map.normalize || "";
      intentPrompt = map.intent || "";
      assemblePrompt = map.assemble || "";
      outputMessagePrompt = map.output_message || "";
      outputEmailPrompt = map.output_email || "";
      outputAnalysisPrompt = map.output_analysis || "";
    } catch (e) {
      return fail(502, "prompt_fetch", { error: String(e?.message || e) });
    }

    if (!normalizePrompt.trim()) return fail(502, "prompt_fetch", { error: "normalize prompt empty" });
    if (!intentPrompt.trim()) return fail(502, "prompt_fetch", { error: "intent prompt empty" });
    if (!assemblePrompt.trim()) return fail(502, "prompt_fetch", { error: "assemble prompt empty" });

    // System assembly (vNext):
    // normalize → intent → assemble → output specs (message/email/analysis as needed)
    const system = [
      "Return ONLY the final output. No commentary, no JSON, no extra sections unless the output spec asks for them.",
      "",
      normalizePrompt,
      "",
      intentPrompt,
      "",
      assemblePrompt,
      "",
      wantAnalysis ? outputAnalysisPrompt : "",
      "",
      wantMessage ? outputMessagePrompt : "",
      "",
      wantEmail ? outputEmailPrompt : "",
    ]
      .filter((x) => typeof x === "string")
      .join("\n");

    // User content: send the raw state (frontend-fixed) + a tiny derived hint block
    // (The normalize prompt can use this; harmless if ignored.)
    const derivedHint = {
      vnext_ids: {
        relationship_axis: ids.relationship_axis,
        impact: ids.impact,
        continuity: ids.continuity,
        situation_type: ids.situation_type,
        intent: ids.intent,
        tone: ids.tone,
        depth: ids.depth,
        format: ids.format,
        paywall: {
          package: ids.paywallPkg || null,
          include_analysis: wantAnalysis,
          output: ids.outputSel || null,
        },
      },
    };

    const user = [
      "INPUT_STATE (raw, frontend-fixed):",
      JSON.stringify(state, null, 2),
      "",
      "DERIVED_HINT (server-side, non-authoritative):",
      JSON.stringify(derivedHint, null, 2),
    ].join("\n");

    // Model selection (base vs premium)
    const retryOnce = String(pickEnv("OPENAI_RETRY_ONCE", "1")) === "1";
    const { model, risk_score, threshold } = selectModelFromHeuristic(ids, user);

    // Token limits (can be tuned via env)
    const maxOut =
      Number(pickEnv("MAX_OUTPUT_TOKENS", wantBoth || wantAnalysis ? "1200" : "700")) ||
      (wantBoth || wantAnalysis ? 1200 : 700);

    const payload = {
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: Number(pickEnv("OPENAI_TEMPERATURE", "0.4")) || 0.4,
      max_output_tokens: maxOut,
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
        meta: { model, risk_score, threshold },
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
        meta: { model, risk_score, threshold },
      });
    }

    return res.status(200).json({
      ok: true,
      result_text: resultText,
      meta: { model, risk_score, threshold },
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
