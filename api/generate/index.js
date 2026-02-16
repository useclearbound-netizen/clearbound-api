// api/generate/index.js
// Full replace (ops-ready): strict CORS gate + body parsing fallback + timeout + JSON enforcement + strict validation
// ✅ Fix: Insight is returned as an OBJECT (data.insight), not JSON string.

const { computeEngineDecisions } = require("../engine/compute");
const { loadPrompt } = require("../engine/promptLoader");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(body));
}

function getAllowedOrigin() {
  // e.g. "https://useclearbound.com" or "https://useclearbound.com,https://clearbound.app"
  return String(process.env.ALLOW_ORIGIN || "*").trim();
}

function isOriginAllowed(reqOrigin, allow) {
  if (!reqOrigin) return true; // allow non-browser / server-to-server
  if (allow === "*") return true;
  const allowed = allow.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(reqOrigin);
}

function setCors(req, res) {
  const allow = getAllowedOrigin();
  const origin = req.headers?.origin;

  if (allow === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && isOriginAllowed(origin, allow)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

async function readRawBody(req, maxBytes = 200_000) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let buf = "";
    req.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      size += Buffer.byteLength(s, "utf8");
      if (size > maxBytes) return reject(new Error("BODY_TOO_LARGE"));
      buf += s;
    });
    req.on("end", () => resolve(buf));
    req.on("error", (e) => reject(e));
  });
}

function pickModel(engine, include_analysis) {
  const modelDefault = process.env.MODEL_DEFAULT || "gpt-4.1-mini";
  const modelHighRisk = process.env.MODEL_HIGH_RISK || "gpt-4.1";
  const modelAnalysis = process.env.MODEL_ANALYSIS || "gpt-4.1";

  if (include_analysis) return modelAnalysis;
  if (engine?.risk_level === "high") return modelHighRisk;
  return modelDefault;
}

async function openaiChat({ model, system, user, timeoutMs = 22_000, requestId = "" }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(requestId ? { "X-Request-Id": requestId } : {})
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
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
  } finally {
    clearTimeout(t);
  }
}

function buildPayload(state) {
  const s = state || {};

  const paywall = s?.context?.paywall || s?.paywall || {};
  const pkg = paywall.package || null;

  const ctx = s?.context || {};
  const risk_scan = ctx.risk_scan || s?.risk_scan || {};
  const situation_type = ctx.situation_type || (s?.context_builder?.situation_type) || null;

  const key_facts = ctx.key_facts || (s?.context_builder?.key_facts) || "";
  const main_concerns = ctx.main_concerns || (s?.context_builder?.main_concerns) || [];
  const constraints = ctx.constraints || (s?.context_builder?.constraints) || [];

  const user_intent = s?.intent?.value || s?.intent || null;
  const user_tone = s?.tone?.value || s?.tone || null;
  const user_depth = ctx.depth || s?.depth || null;

  const include_analysis = !!paywall.include_analysis;

  return {
    package: pkg, // message|email|bundle
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
  const tone = engine.tone_recommendation;
  const detail = engine.detail_recommendation;
  const direction = engine.direction_suggestion || "reset";
  return { tone, detail, direction };
}

function systemPreamble() {
  return [
    "You are ClearBound.",
    "You generate structured communication drafts.",
    "You do not provide advice, do not predict outcomes, do not use legal framing.",
    "Return ONE JSON object only. No markdown. No extra text."
  ].join("\n");
}

function shouldReturnEngine() {
  return String(process.env.RETURN_ENGINE || "").trim() === "1";
}

function isJsonRequest(req) {
  const ct = String(req.headers?.["content-type"] || "").toLowerCase();
  return ct.includes("application/json");
}

module.exports = async (req, res) => {
  setCors(req, res);

  // Hard origin gate when ALLOW_ORIGIN is not "*"
  const allow = getAllowedOrigin();
  const origin = req.headers?.origin;
  if (allow !== "*" && origin && !isOriginAllowed(origin, allow)) {
    return json(res, 403, { ok: false, error: "ORIGIN_NOT_ALLOWED" });
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  if (!isJsonRequest(req)) {
    return json(res, 415, { ok: false, error: "UNSUPPORTED_MEDIA_TYPE" });
  }

  // Parse body (covers: req.body object / req.body string / raw stream)
  let body = req.body;

  if (!body) {
    try {
      const raw = await readRawBody(req);
      body = safeParseJson(raw);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("BODY_TOO_LARGE")) return json(res, 413, { ok: false, error: "BODY_TOO_LARGE" });
      return json(res, 400, { ok: false, error: "BAD_REQUEST", message: "Invalid body" });
    }
  } else if (typeof body === "string") {
    body = safeParseJson(body);
  }

  if (!body || typeof body !== "object") {
    return json(res, 400, { ok: false, error: "BAD_REQUEST", message: "Invalid JSON body" });
  }

  const state = body.state || body;
  const payload = buildPayload(state);

  if (!payload.package) {
    return json(res, 400, { ok: false, error: "MISSING_PACKAGE" });
  }

  // Facts min gate
  const facts = (payload.input.key_facts || "").trim();
  if (facts.length < 20) {
    return json(res, 400, { ok: false, error: "MISSING_FACTS", message: "Facts too short" });
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
    payload.package === "bundle"  ? `${basePath}/bundle.prompt.md` :
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
      tone: controls.tone,
      detail: controls.detail,
      direction: controls.direction
    },
    engine
  };

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // 4) Main generation call
  let mainText;
  try {
    mainText = await openaiChat({
      model,
      system: systemPreamble(),
      user: `${mainPrompt}\n\n---\n\nPAYLOAD_JSON:\n${JSON.stringify(llmInput)}`,
      timeoutMs: 22_000,
      requestId
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = msg.includes("aborted") || msg.includes("AbortError");
    return json(res, 502, {
      ok: false,
      error: isTimeout ? "GENERATION_TIMEOUT" : "GENERATION_FAILED",
      message: msg
    });
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
  const out = {
    message_text: mainObj.message_text || mainObj.bundle_message_text || null,
    email_text: mainObj.email_text || null,
    note_text: mainObj.note_text || null,

    // ✅ Insight object will be attached as out.insight when include_analysis is true
    insight: null
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
        user: `${insightPrompt}\n\n---\n\nPAYLOAD_JSON:\n${JSON.stringify(llmInput)}`,
        timeoutMs: 16_000,
        requestId: `${requestId}-insight`
      });
    } catch (e) {
      const msg = String(e?.message || e);
      const isTimeout = msg.includes("aborted") || msg.includes("AbortError");
      return json(res, 502, {
        ok: false,
        error: isTimeout ? "INSIGHT_TIMEOUT" : "INSIGHT_FAILED",
        message: msg
      });
    }

    const insightObj = safeParseJson(insightText);
    if (insightObj && typeof insightObj === "object") {
      out.insight = insightObj; // ✅ object, not string
    } else {
      out.insight = {
        insight_title: "Strategic Insight",
        insight_sections: [],
        disclaimer_line: "This insight reflects interaction signals and structure choices, not outcomes or advice."
      };
    }
  }

  // Bundle: ensure both exist if provided
  if (payload.package === "bundle") {
    out.message_text = mainObj.bundle_message_text || out.message_text || null;
    out.email_text = mainObj.email_text || out.email_text || null;
  }

  const response = { ok: true, data: out };
  if (shouldReturnEngine()) response.engine = engine;

  return json(res, 200, response);
};
