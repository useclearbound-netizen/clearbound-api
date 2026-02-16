// api/generate/index.js

const { computeEngineDecisions } = require("../engine/compute");
const { loadPrompt } = require("../engine/promptLoader");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function setCors(req, res) {
  const allow = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function pickModel(engine, include_analysis) {
  // Env names your latest screenshot uses:
  // MODEL_DEFAULT, MODEL_HIGH_RISK, MODEL_ANALYSIS
  const modelDefault = process.env.MODEL_DEFAULT || "gpt-4.1-mini";
  const modelHighRisk = process.env.MODEL_HIGH_RISK || "gpt-4.1";
  const modelAnalysis = process.env.MODEL_ANALYSIS || "gpt-4.1";

  if (include_analysis) return modelAnalysis;
  if (engine?.risk_level === "high") return modelHighRisk;
  return modelDefault;
}

async function openaiChat({ model, system, user }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const raw = await r.text();
  const data = safeParseJson(raw);

  if (!r.ok) {
    const msg = data?.error?.message || raw.slice(0, 300);
    throw new Error(`OPENAI_FAILED ${r.status} ${msg}`);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OPENAI_EMPTY");
  return text;
}

function buildPayload(state) {
  // Front sends a "state" that may already be backend-shaped.
  // We accept:
  // - direct: { context: { ... paywall ... risk_scan ... } , intent, tone, relationship ... }
  // - or v2 UI shape as-is (your wizard currently holds it)
  const s = state || {};

  const paywall = s?.context?.paywall || s?.paywall || {};
  const pkg = paywall.package || null;

  // Extract facts + signals for engine
  const ctx = s?.context || {};
  const risk_scan = ctx.risk_scan || s?.risk_scan || {};
  const situation_type = ctx.situation_type || (s?.context_builder?.situation_type) || null;

  const key_facts = ctx.key_facts || (s?.context_builder?.key_facts) || "";
  const main_concerns = ctx.main_concerns || (s?.context_builder?.main_concerns) || [];
  const constraints = ctx.constraints || (s?.context_builder?.constraints) || [];

  // user-selected (optional)
  const user_intent = s?.intent?.value || s?.intent || null;
  const user_tone = s?.tone?.value || s?.tone || null;
  const user_depth = ctx.depth || s?.depth || null;

  const include_analysis = !!paywall.include_analysis;

  return {
    package: pkg,                       // message|email|bundle
    include_analysis,
    input: {
      situation_type,
      risk_scan: {
        impact: risk_scan.impact || null,
        continuity: risk_scan.continuity || null
      },
      key_facts: String(key_facts || ""),
      main_concerns: Array.isArray(main_concerns) ? main_concerns : [],
      constraints: Array.isArray(constraints) ? constraints : [],
      user_intent,
      user_tone,
      user_depth
    }
  };
}

function resolveFinalControls(payload, engine) {
  // Engine is authoritative for tone/detail unless UI explicitly locks it later.
  // For now: engine recommendation wins for consistency.
  const tone = engine.tone_recommendation;
  const detail = engine.detail_recommendation;

  // Direction is only “shown” when “not sure” exists.
  // But we still include a direction field for prompts to stabilize posture.
  const direction = engine.direction_suggestion || "reset";

  return { tone, detail, direction };
}

function systemPreamble() {
  return [
    "You are ClearBound.",
    "You generate structured communication drafts.",
    "You do not provide advice, do not predict outcomes, do not use legal framing.",
    "Return JSON only."
  ].join("\n");
}

module.exports = async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // Parse body (Vercel may pass object or string depending on runtime)
  let body = req.body;
  if (typeof body === "string") body = safeParseJson(body);
  if (!body || typeof body !== "object") {
    return json(res, 400, { ok: false, error: "BAD_REQUEST", message: "Invalid JSON body" });
  }

  const state = body.state || body; // allow {state:{...}} or direct
  const payload = buildPayload(state);

  if (!payload.package) {
    return json(res, 400, { ok: false, error: "MISSING_PACKAGE" });
  }

  const facts = (payload.input.key_facts || "").trim();
  if (facts.length < 5) {
    return json(res, 400, { ok: false, error: "MISSING_FACTS" });
  }

  // 1) Engine compute (deterministic)
  const engine = computeEngineDecisions({
    risk_scan: payload.input.risk_scan,
    situation_type: payload.input.situation_type,
    main_concerns: payload.input.main_concerns,
    constraints: payload.input.constraints
  });

  const controls = resolveFinalControls(payload, engine);
  const model = pickModel(engine, payload.include_analysis);

  // 2) Load prompts
  const basePath = "prompts/v1";
  const promptPath =
    payload.package === "message" ? `${basePath}/message.prompt.md` :
    payload.package === "email"   ? `${basePath}/email.prompt.md` :
    payload.package === "bundle"  ? `${basePath}/email.prompt.md` :
    null;

  if (!promptPath) {
    return json(res, 400, { ok: false, error: "UNKNOWN_PACKAGE" });
  }

  let mainPrompt;
  try {
    mainPrompt = await loadPrompt(promptPath);
  } catch (e) {
    return json(res, 500, { ok: false, error: "PROMPT_LOAD_FAILED", message: String(e?.message || e) });
  }

  // 3) Build LLM input
  const llmInput = {
    package: payload.package,
    include_analysis: payload.include_analysis,
    input: {
      ...payload.input,
      // add “controls” so prompts don’t guess
      tone: controls.tone,
      detail: controls.detail,
      direction: controls.direction
    },
    engine
  };

  // 4) Main generation call
  let mainText;
  try {
    mainText = await openaiChat({
      model,
      system: systemPreamble(),
      user: `${mainPrompt}\n\n---\n\nPAYLOAD_JSON:\n${JSON.stringify(llmInput)}`
    });
  } catch (e) {
    return json(res, 502, { ok: false, error: "GENERATION_FAILED", message: String(e?.message || e) });
  }

  const mainObj = safeParseJson(mainText);
  if (!mainObj || typeof mainObj !== "object") {
    return json(res, 502, {
      ok: false,
      error: "MODEL_RETURNED_NON_JSON",
      message: "Model output was not valid JSON",
      raw: mainText.slice(0, 1200)
    });
  }

  // Normalize output
  let out = {
    message_text: mainObj.message_text || mainObj.bundle_message_text || null,
    email_text: mainObj.email_text || null,
    note_text: null,
    analysis_text: null
  };

  // 5) Optional Insight call (only if include_analysis)
  if (payload.include_analysis) {
    let insightPrompt;
    try {
      insightPrompt = await loadPrompt(`${basePath}/insight.prompt.md`);
    } catch (e) {
      return json(res, 500, { ok: false, error: "INSIGHT_PROMPT_LOAD_FAILED", message: String(e?.message || e) });
    }

    let insightText;
    try {
      insightText = await openaiChat({
        model: process.env.MODEL_ANALYSIS || model,
        system: systemPreamble(),
        user: `${insightPrompt}\n\n---\n\nPAYLOAD_JSON:\n${JSON.stringify(llmInput)}`
      });
    } catch (e) {
      return json(res, 502, { ok: false, error: "INSIGHT_FAILED", message: String(e?.message || e) });
    }

    const insightObj = safeParseJson(insightText);
    if (insightObj && typeof insightObj === "object") {
      // store as a single string block for now (front can render cards later)
      out.analysis_text = JSON.stringify(insightObj, null, 2);
    } else {
      out.analysis_text = insightText; // fallback
    }
  }

  // Bundle: ensure both message + email exist if possible
  if (payload.package === "bundle") {
    out.message_text = mainObj.bundle_message_text || out.message_text || null;
    out.email_text = mainObj.email_text || out.email_text || null;
  }

  return json(res, 200, { ok: true, data: out, engine });
};
