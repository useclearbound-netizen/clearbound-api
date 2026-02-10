// clearbound-api/api/generate.js
// vNext single-call pipeline (Ops-Optimized):
// - Remote GUIDELINE_MAP fetch (+ TTL cache)
// - Code-based control flags (record-safe, tone ceiling, max chars)
// - Model routing: DEFAULT vs HIGH_RISK (cost-optimized)
// - Strict JSON output gating (+ optional repair call if JSON parse fails)
//
// NOTE: Some models reject non-default temperature overrides.
// For stability, we DO NOT send temperature at all.

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------------------------
 * Remote GUIDELINE_MAP loader (cached)
 * -------------------------- */
let _guidelineCache = null;
let _guidelineCacheAt = 0;

async function loadGuidelineMap() {
  const url = process.env.CB_GUIDELINE_MAP_URL;
  if (!url) throw new Error("Missing env: CB_GUIDELINE_MAP_URL");

  const ttlSec = Number(process.env.CB_GUIDELINE_TTL_SEC || 300);
  const now = Date.now();

  if (_guidelineCache && now - _guidelineCacheAt < ttlSec * 1000) return _guidelineCache;

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) throw new Error(`Failed to fetch GUIDELINE_MAP (${resp.status})`);

  const json = await resp.json();
  if (!json?.relationship || !json?.intent) {
    throw new Error("Invalid GUIDELINE_MAP payload (missing relationship/intent)");
  }

  _guidelineCache = json;
  _guidelineCacheAt = now;
  return json;
}

/* ---------------------------
 * Enums & helpers
 * -------------------------- */
const ENUMS = {
  relationship: ["intimate", "personal", "social", "peripheral"],
  intent: [
    "push_back",
    "set_boundary",
    "clarify_or_correct",
    "address_issue",
    "reset_expectations",
    "make_it_official",
    "close_the_loop",
  ],
  tone: ["calm", "neutral", "firm", "formal"],
  format: ["message", "email"],
  package: ["message", "email", "analysis_email", "total"],
  impact: ["low", "high"],
  continuity: ["low", "mid", "high"],
};

function assertEnum(name, value, allowed) {
  if (!allowed.includes(value)) {
    const v = value === undefined ? "undefined" : JSON.stringify(value);
    throw new Error(`Invalid ${name}: ${v}`);
  }
}

function clampText(s, maxChars) {
  const t = (s ?? "").toString().trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function bulletLines(list) {
  return (list || []).map((x) => `- ${x}`).join("\n");
}

/* ---------------------------
 * Rule Engine (Pass 1/2 -> Code)
 * -------------------------- */
function computeControlFlags({ risk_scan, format, intent, tone }) {
  const isHighRisk = risk_scan.impact === "high" || risk_scan.continuity === "high";
  const isEmail = format === "email";
  const isOfficialIntent = intent === "make_it_official";

  // record_safe_required = "writing safety mode" (wording + constraints)
  // - Email can still be record-safe without forcing a high-cost model.
  const record_safe_required = isHighRisk || isEmail || isOfficialIntent;

  // high_risk_model_required = "model escalation switch" (cost control)
  // - Only escalate model when truly necessary.
  // - Keep make_it_official escalated by default (recommended for accuracy/record safety).
  const high_risk_model_required = isHighRisk || isOfficialIntent;

  const tone_floor = "calm";
  const tone_ceiling = record_safe_required ? "firm" : tone;

  const max_chars =
    format === "message"
      ? record_safe_required
        ? 520
        : 700
      : record_safe_required
        ? 1100
        : 1500;

  return { record_safe_required, high_risk_model_required, tone_floor, tone_ceiling, max_chars };
}

/* ---------------------------
 * Package schema gating
 * -------------------------- */
function pkgSchemaFor(pkg) {
  switch (pkg) {
    case "message":
      return { required: ["message_text"], keys: ["message_text"] };
    case "email":
      return { required: ["email_text"], keys: ["email_text"] };
    case "analysis_email":
      return { required: ["email_text", "analysis_text"], keys: ["email_text", "analysis_text"] };
    case "total":
      return {
        required: ["message_text", "email_text", "analysis_text"],
        keys: ["message_text", "email_text", "analysis_text"],
      };
    default:
      throw new Error(`Unknown package: ${pkg}`);
  }
}

function jsonSchemaString(pkgSchema) {
  return JSON.stringify(
    {
      type: "object",
      additionalProperties: false,
      required: pkgSchema.required,
      properties: Object.fromEntries(pkgSchema.keys.map((k) => [k, { type: "string" }])),
    },
    null,
    2
  );
}

/* ---------------------------
 * Prompt blocks
 * -------------------------- */
function buildRiskOverrides(control) {
  return control.record_safe_required
    ? [
        "Record-safe mode is REQUIRED:",
        "- Use observable facts, not interpretations.",
        "- No emotion labels, no blame, no speculation.",
        "- One clear request + optional deadline.",
      ].join("\n")
    : "Record-safe mode is optional, but still avoid insults, blame, and speculation.";
}

function buildFormatRules(format) {
  return format === "message"
    ? ["Message format:", "- 2–6 short sentences.", "- No subject line.", "- Keep it human and direct."].join("\n")
    : [
        "Email format:",
        "- Include a short Subject line inside email_text if appropriate.",
        "- Use 2–5 short paragraphs or bullets for facts (if official).",
        "- End with a clear next step.",
      ].join("\n");
}

function buildToneMicroStyle(control) {
  switch (control.tone_ceiling) {
    case "formal":
      return "- Formal, precise wording. Minimal softeners.";
    case "firm":
      return "- Calm but firm. Clear requests. No emotional framing.";
    case "neutral":
      return "- Neutral and straightforward. No extra warmth.";
    default:
      return "- Calm, respectful, de-escalating. Minimal emotion words.";
  }
}

function pickFewshot({ GUIDELINE_MAP, relationship, intent, control, format }) {
  if (control.record_safe_required && intent === "make_it_official") {
    const f = GUIDELINE_MAP.fewshot_record_safe?.make_it_official?.[relationship];
    if (f) return format === "email" ? { email_text: f.email_text } : { message_text: f.message_text };
  }

  if (control.record_safe_required) {
    const f = GUIDELINE_MAP.fewshot_record_safe?.[relationship]?.["__default__"];
    if (f) return format === "email" ? { email_text: f.email_text } : { message_text: f.message_text };
  }

  const f = GUIDELINE_MAP.fewshot?.[relationship]?.["__default__"];
  if (f) return format === "email" ? { email_text: f.email_text } : { message_text: f.message_text };

  return format === "email"
    ? { email_text: "Subject: Quick alignment\n\nHi —\n\nCould you confirm the next step by [deadline]?\n\nThanks,\n[Your Name]" }
    : { message_text: "Hi — could you confirm the next step when you have a moment? Thanks." };
}

function buildSystemPrompt({
  pkg,
  format,
  relationship,
  intent,
  tone,
  risk_scan,
  control,
  intentGuide,
  relationGuide,
  schemaStr,
  blocks,
  fewshotExample,
}) {
  return `
You are ClearBound vNext. Generate a relationship-safe message/email under strict constraints.

<<<CONTROL_BLOCK>>>
package: ${pkg}
format: ${format}
relationship: ${relationship}
intent: ${intent}
tone_requested: ${tone}
risk_scan: impact=${risk_scan.impact}, continuity=${risk_scan.continuity}
record_safe_required: ${control.record_safe_required}
tone_floor: ${control.tone_floor} ; tone_ceiling: ${control.tone_ceiling}
max_chars: ${control.max_chars}
<<<END_CONTROL_BLOCK>>>

OUTPUT CONTRACT:
- Output MUST be valid JSON ONLY.
- Output keys MUST match the allowed schema exactly.
- Never include markdown. Never include any explanation.

SAFETY RULES:
- Do not invent facts. Do not diagnose motives. Do not give legal/medical advice.
- No insults, no threats, no ultimatums unless explicitly required by record-safe rules.

PRIORITY & CONFLICT RULES:
- HARD RULES (output contract + safety + risk overrides) override everything.
- Follow Intent for STRUCTURE (what to include + order).
- Follow Relationship for WORDING (softening + phrasing style).
- If record-safe is required, ignore any guideline that introduces emotion, blame, or speculation.

RISK OVERRIDES:
${blocks.risk_overrides}

FORMAT RULES:
${blocks.format_rules}

INTENT GUIDELINE (STRUCTURE):
BRIEF: ${intentGuide.brief}
STRUCTURE:
${intentGuide.structure.map((s) => `- ${s}`).join("\n")}
MUST INCLUDE:
${bulletLines(intentGuide.must_include)}
AVOID:
${bulletLines(intentGuide.avoid)}

RELATIONSHIP GUIDELINE (WORDING):
BRIEF: ${relationGuide.brief}
DO:
${bulletLines(relationGuide.do)}
AVOID:
${bulletLines(relationGuide.avoid)}

TONE MICRO-STYLE:
${blocks.tone_micro}

FEW-SHOT (STYLE FLOOR):
Expected JSON example style (do not copy placeholders):
${JSON.stringify(fewshotExample, null, 2)}

JSON SCHEMA (STRICT):
${schemaStr}

FINAL OUTPUT REQUIREMENT (HARD RULE):
Return ONLY the JSON object. No preamble. No postscript. No markdown. No extra keys.
All generated text MUST strictly follow the "STRUCTURE" defined in the Intent Guideline.
If any guideline conflicts with this requirement, ignore the guideline and follow this requirement.
`.trim();
}

function buildUserPrompt({ rawContext, max_chars }) {
  return `<<<USER_CONTEXT>>>\n${rawContext}\n<<<END_USER_CONTEXT>>>\n(Keep the generated output within max_chars≈${max_chars} characters.)`;
}

/* ---------------------------
 * Validation + repair + fallback
 * -------------------------- */
function validateJsonResult(obj, pkgSchema) {
  if (!obj || typeof obj !== "object") throw new Error("Output is not an object");
  for (const k of Object.keys(obj)) {
    if (!pkgSchema.keys.includes(k)) throw new Error(`Extra key: ${k}`);
    if (typeof obj[k] !== "string") throw new Error(`Non-string field: ${k}`);
    if (!obj[k].trim()) throw new Error(`Empty field: ${k}`);
  }
  for (const req of pkgSchema.required) {
    if (!(req in obj)) throw new Error(`Missing required: ${req}`);
  }
  return true;
}

async function callLLM({ model, system, user }) {
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return r.choices?.[0]?.message?.content ?? "";
}

function buildRepairSystem({ schemaStr, allowedKeys }) {
  return `
You are a JSON repair tool.
Return ONLY a valid JSON object that matches this schema exactly:
${schemaStr}
Allowed keys: ${allowedKeys.join(", ")}
No extra keys. No markdown. No commentary.
`.trim();
}

function safeFallback(pkg) {
  if (pkg === "message") {
    return { message_text: "Hi — I’d like to align on one point. Could you confirm the next step when you have a moment? Thank you." };
  }
  if (pkg === "email") {
    return { email_text: "Subject: Quick alignment\n\nHi —\n\nI’d like to align on one point. Could you confirm the next step by [deadline]?\n\nThank you,\n[Your Name]" };
  }
  if (pkg === "analysis_email") {
    return {
      email_text: "Subject: Quick alignment\n\nHi —\n\nI’d like to align on one point. Could you confirm the next step by [deadline]?\n\nThank you,\n[Your Name]",
      analysis_text: "Fallback used due to formatting constraints. Neutral record-safe language applied.",
    };
  }
  return {
    message_text: "Hi — could you confirm the next step when you have a moment? Thank you.",
    email_text: "Subject: Quick alignment\n\nHi —\n\nCould you confirm the next step by [deadline]?\n\nThank you,\n[Your Name]",
    analysis_text: "Fallback used due to formatting constraints. Neutral record-safe language applied.",
  };
}

/* ---------------------------
 * Model routing (Ops-Optimized)
 * -------------------------- */
function pickModel(control) {
  return control.high_risk_model_required
    ? (process.env.CB_MODEL_HIGH_RISK || "gpt-5")
    : (process.env.CB_MODEL_DEFAULT || "gpt-4.1-mini");
}

/* ---------------------------
 * Request parsing
 * -------------------------- */
function parseState(req) {
  if (req?.body?.state) return JSON.parse(req.body.state);
  return req.body || {};
}

/* ---------------------------
 * Handler
 * -------------------------- */
module.exports = async function handler(req, res) {
  const t0 = Date.now(); // ⏱️ 전체 시작 시점

  try {
    const allowOrigin = process.env.ALLOW_ORIGIN || "*";
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    }

    /* ---------- Guideline load ---------- */
    const GUIDELINE_MAP = await loadGuidelineMap();
    const t1 = Date.now();
    console.log("cb_timing_guideline_ms", t1 - t0);

    const state = parseState(req);

    /* ---------- State extraction ---------- */
    const relationship = state.relationship_axis?.value ?? state.relationship?.value;
    const intent = state.intent?.value;
    const tone = state.tone?.value;
    const format = state.format?.value;

    const pkg =
      state.context?.paywall?.package ??
      state.paywall?.package ??
      state.context?.package;

    const risk_scan = state.risk_scan ?? state.context?.risk_scan;

    /* ---------- Validation ---------- */
    assertEnum("relationship", relationship, ENUMS.relationship);
    assertEnum("intent", intent, ENUMS.intent);
    assertEnum("tone", tone, ENUMS.tone);
    assertEnum("format", format, ENUMS.format);
    assertEnum("package", pkg, ENUMS.package);
    assertEnum("risk_scan.impact", risk_scan?.impact, ENUMS.impact);
    assertEnum("risk_scan.continuity", risk_scan?.continuity, ENUMS.continuity);

    /* ---------- Control flags ---------- */
    const control = computeControlFlags({ risk_scan, format, intent, tone });

    const CONTEXT_MAX = Number(process.env.CB_CONTEXT_MAX_CHARS || 1400);
    const rawContext = clampText(state.context?.text ?? "", CONTEXT_MAX);

    /* ---------- Guideline resolution ---------- */
    const intentGuide = GUIDELINE_MAP.intent?.[intent];
    if (!intentGuide) throw new Error(`Missing intent guide: ${intent}`);

    const relationGuide = control.record_safe_required
      ? GUIDELINE_MAP.record_safe_variant?.[relationship]
      : GUIDELINE_MAP.relationship?.[relationship];

    if (!relationGuide) {
      throw new Error(`Missing relationship guide: ${relationship}`);
    }

    /* ---------- Prompt assembly ---------- */
    const pkgSchema = pkgSchemaFor(pkg);
    const schemaStr = jsonSchemaString(pkgSchema);

    const blocks = {
      risk_overrides: buildRiskOverrides(control),
      format_rules: buildFormatRules(format),
      tone_micro: buildToneMicroStyle(control),
    };

    const fewshotExample = pickFewshot({
      GUIDELINE_MAP,
      relationship,
      intent,
      control,
      format,
    });

    const system = buildSystemPrompt({
      pkg,
      format,
      relationship,
      intent,
      tone,
      risk_scan,
      control,
      intentGuide,
      relationGuide,
      schemaStr,
      blocks,
      fewshotExample,
    });

    const user = buildUserPrompt({
      rawContext,
      max_chars: control.max_chars,
    });

    /* ---------- Model routing (no temperature) ---------- */
    const model = pickModel(control);

    // 🔍 운영 디버그 (비용/품질 확인용)
    console.log("cb_model_selected", {
      model,
      record_safe_required: control.record_safe_required,
      high_risk_model_required: control.high_risk_model_required,
      pkg,
      format,
      relationship,
      intent,
      risk_scan,
      temperature: "(omitted)",
    });

    /* ---------- LLM call ---------- */
    let text = await callLLM({ model, system, user });

    const t2 = Date.now();
    console.log("cb_timing_llm_ms", t2 - t1);

    /* ---------- Parse + validate ---------- */
    let obj;
    try {
      obj = JSON.parse(text);
      validateJsonResult(obj, pkgSchema);
    } catch {
      // Optional repair (rare)
      const repairSystem = buildRepairSystem({ schemaStr, allowedKeys: pkgSchema.keys });
      const repairUser = `Fix this into valid JSON only:\n\n${text}`;

      const repaired = await callLLM({
        model, // keep same model for consistency
        system: repairSystem,
        user: repairUser,
      });

      try {
        obj = JSON.parse(repaired);
        validateJsonResult(obj, pkgSchema);
      } catch {
        obj = safeFallback(pkg);
      }
    }

    console.log("cb_timing_total_ms", Date.now() - t0);
    return res.status(200).json({ ok: true, ...obj });

  } catch (err) {
    console.log("cb_timing_total_ms_error", Date.now() - t0);
    return res.status(500).json({
      ok: false,
      error: "GENERATION_FAILED",
      message: err?.message || String(err),
    });
  }
};
