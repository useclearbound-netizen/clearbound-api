// clearbound-api/api/generate.js
// vNext Ops-Optimized (Package + Upsell):
// - package: message | email | bundle
// - include_analysis: boolean (upsell)
// - Always includes note_text (value booster)
// - If include_analysis=true => 2-call:
//    1) analysis (heavier model)
//    2) generation (fast model)
// - Strict JSON gating (+ optional repair)
// - MIN/MAX enforcement via postprocess (no extra LLM call)
// - analysis_text forced to EXACTLY 3 lines (templated + postprocess)

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
  // NEW packages
  package: ["message", "email", "bundle"],
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

function normalizeNewlines(s) {
  return (s ?? "").toString().replace(/\r\n/g, "\n").trim();
}

function safeJoin(...parts) {
  return parts.filter(Boolean).join("\n");
}

/* ---------------------------
 * MIN/MAX Policy (Ops Locked)
 * -------------------------- */
const POLICY = {
  // MIN chars
  MIN_MESSAGE_CHARS: Number(process.env.CB_MIN_MESSAGE_CHARS || 380),
  MIN_EMAIL_CHARS: Number(process.env.CB_MIN_EMAIL_CHARS || 700),
  MIN_NOTE_CHARS: Number(process.env.CB_MIN_NOTE_CHARS || 240),

  // Analysis lines
  ANALYSIS_LINES: 3,
  ANALYSIS_TOTAL_MIN_CHARS: Number(process.env.CB_MIN_ANALYSIS_CHARS || 360),

  // MAX chars (sane caps)
  MAX_MESSAGE_CHARS: Number(process.env.CB_MAX_MESSAGE_CHARS || 700),
  MAX_EMAIL_CHARS: Number(process.env.CB_MAX_EMAIL_CHARS || 1100),
  MAX_NOTE_CHARS: Number(process.env.CB_MAX_NOTE_CHARS || 420),
  MAX_ANALYSIS_CHARS: Number(process.env.CB_MAX_ANALYSIS_CHARS || 560),
};

/* ---------------------------
 * Request parsing (NORMALIZED)
 * -------------------------- */
function safeJsonParse(input) {
  if (input == null) return null;
  if (typeof input === "object") return input;

  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  return null;
}

function parseState(req) {
  const body = req?.body ?? {};

  // WP AJAX: state가 string 또는 object 둘 다 올 수 있음
  if (body.state != null) {
    const parsed = safeJsonParse(body.state);
    if (!parsed) {
      const v = typeof body.state === "string" ? body.state : String(body.state);
      throw new Error(`Invalid state JSON: ${v.slice(0, 120)}`);
    }
    return parsed;
  }

  // Direct JSON POST
  if (typeof body === "object") return body;

  throw new Error("Invalid request body");
}

/* ---------------------------
 * Defensive normalization
 * -------------------------- */
const INTENT_ALIASES = {
  clarify_correct: "clarify_or_correct",
  clarify_or_correct: "clarify_or_correct",
  correct: "clarify_or_correct",

  official: "make_it_official",
  official_documented: "make_it_official",
  make_it_official: "make_it_official",

  close_loop: "close_the_loop",
  close_the_loop: "close_the_loop",

  boundary: "set_boundary",
  set_boundary: "set_boundary",

  pushback: "push_back",
  push_back: "push_back",

  reset: "reset_expectations",
  reset_expectations: "reset_expectations",

  address: "address_issue",
  address_issue: "address_issue",
};

const REL_AXIS_ALIASES = {
  family: "intimate",
  friends_personal: "personal",
  living_proximity: "social",
  work_professional: "social",
  orgs_services: "peripheral",
};

function normalizeEnum(value, aliasesMap) {
  const v = (value ?? "").toString().trim();
  if (!v) return v;
  return aliasesMap?.[v] || v;
}

function normalizePkg(pkgRaw) {
  const p = (pkgRaw ?? "").toString().trim();
  if (!p) return p;

  // legacy -> NEW
  if (p === "total") return "bundle";
  if (p === "analysis_email") return "email";

  // if UI still sends analysis_message: map to message (analysis is controlled by include_analysis)
  if (p === "analysis_message") return "message";

  // NEW valid: message/email/bundle
  return p;
}

function deriveFormatFromPkgAndState({ pkg, stateFormat, paywallOutput }) {
  const f = (stateFormat ?? "").toString().trim();
  if (f === "message" || f === "email") return f;

  const o = (paywallOutput ?? "").toString().trim();
  if (o === "message") return "message";
  if (o === "email") return "email";
  if (o === "both") return "email";

  if (pkg === "message") return "message";
  return "email";
}

function buildContextTextFromState(state) {
  const c = state?.context || {};
  const t = (c.text ?? "").toString().trim();
  if (t) return t;

  const keyFacts = (c.key_facts ?? "").toString().trim();
  const st = (c.situation_type ?? "").toString().trim();
  const prefix = st ? `[${st}] ` : "";
  return `${prefix}${keyFacts}`.trim();
}

function normalizeIncomingState(state) {
  const relationshipRaw =
    state?.relationship_axis?.value ??
    state?.relationship?.value ??
    state?.relationship;

  const relationship = normalizeEnum(relationshipRaw, REL_AXIS_ALIASES);

  const intentRaw = state?.intent?.value ?? state?.intent;
  const intent = normalizeEnum(intentRaw, INTENT_ALIASES);

  const toneRaw = state?.tone?.value ?? state?.tone;
  const tone = (toneRaw ?? "").toString().trim();

  const pkgRaw =
    state?.context?.paywall?.package ??
    state?.paywall?.package ??
    state?.context?.package ??
    state?.package;

  const pkg = normalizePkg(pkgRaw);

  const include_analysis =
    !!(state?.context?.paywall?.include_analysis ??
       state?.paywall?.include_analysis ??
       state?.include_analysis);

  const risk_scan = state?.risk_scan ?? state?.context?.risk_scan ?? {
    impact: undefined,
    continuity: undefined,
  };

  const format = deriveFormatFromPkgAndState({
    pkg,
    stateFormat: state?.format?.value ?? state?.format,
    paywallOutput: state?.context?.paywall?.output ?? state?.paywall?.output,
  });

  const rawContext = buildContextTextFromState(state);

  return { relationship, intent, tone, format, pkg, include_analysis, risk_scan, rawContext };
}

/* ---------------------------
 * Rule Engine (code flags)
 * -------------------------- */
function computeControlFlags({ risk_scan, format, intent, tone, include_analysis }) {
  const isHighRisk = risk_scan.impact === "high" || risk_scan.continuity === "high";
  const isEmail = format === "email";
  const isOfficialIntent = intent === "make_it_official";

  const record_safe_required = isHighRisk || isEmail || isOfficialIntent;

  // analysis is upsell-driven (and also useful for official/high risk)
  const analysis_required = !!include_analysis;

  const tone_floor = "calm";
  const tone_ceiling = record_safe_required ? "firm" : tone;

  const main_max_chars =
    format === "message"
      ? record_safe_required ? 520 : 700
      : record_safe_required ? 1100 : 1500;

  return { record_safe_required, analysis_required, tone_floor, tone_ceiling, main_max_chars };
}

/* ---------------------------
 * Package schema gating
 * Always includes note_text
 * analysis_text included only when include_analysis=true
 * -------------------------- */
function pkgSchemaFor(pkg, include_analysis) {
  const base = { required: [], keys: [] };

  if (pkg === "message") {
    base.required = ["message_text", "note_text"];
    base.keys = ["message_text", "note_text"];
  } else if (pkg === "email") {
    base.required = ["email_text", "note_text"];
    base.keys = ["email_text", "note_text"];
  } else if (pkg === "bundle") {
    base.required = ["message_text", "email_text", "note_text"];
    base.keys = ["message_text", "email_text", "note_text"];
  } else {
    throw new Error(`Unknown package: ${pkg}`);
  }

  if (include_analysis) {
    base.required = [...base.required, "analysis_text"];
    base.keys = [...base.keys, "analysis_text"];
  }

  return base;
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
    ? ["Message format:", "- 2–7 short sentences.", "- No subject line.", "- Keep it human and direct."].join("\n")
    : [
        "Email format:",
        "- Include a short Subject line inside email_text if appropriate.",
        "- Use 2–4 short paragraphs; use bullets only for facts if needed.",
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

function buildNoteRules() {
  return [
    "NOTE RULES (for note_text):",
    "- 2–3 short sentences.",
    "- Explain the intent + why the wording is safe/respectful.",
    "- Do NOT add new facts.",
    "- Do NOT give legal/medical advice.",
    "- Avoid heavy jargon; keep it practical.",
  ].join("\n");
}

function buildAnalysisRulesV2() {
  // stronger template for consistent value
  return [
    "ANALYSIS RULES (for analysis_text):",
    "- Must be EXACTLY 3 lines.",
    "- Each line is one sentence.",
    "- Line 1: Risk posture (why this is record-safe / low escalation).",
    "- Line 2: Communication strategy (what the wording does structurally).",
    "- Line 3: Next step boundary (what response/action is requested and why it’s bounded).",
    "- Do NOT add new facts. Do NOT provide legal advice.",
  ].join("\n");
}

/* ---------------------------
 * Few-shot selection
 * -------------------------- */
function pickFewshot({ GUIDELINE_MAP, relationship, intent, control, format, pkg, include_analysis }) {
  // Try record-safe + make_it_official per relationship
  if (control.record_safe_required && intent === "make_it_official") {
    const f = GUIDELINE_MAP.fewshot_record_safe?.make_it_official?.[relationship];
    if (f) {
      const out = {};
      if (pkg === "message" || pkg === "bundle") out.message_text = f.message_text;
      if (pkg === "email" || pkg === "bundle") out.email_text = f.email_text;
      out.note_text = "Short note: record-safe, factual, and one clear request.";
      if (include_analysis) out.analysis_text = "Record-safe posture.\nStructure-driven wording.\nBounded next step request.";
      return out;
    }
  }

  // record-safe default per relationship
  if (control.record_safe_required) {
    const f = GUIDELINE_MAP.fewshot_record_safe?.[relationship]?.["__default__"];
    if (f) {
      const out = {};
      if (pkg === "message" || pkg === "bundle") out.message_text = f.message_text;
      if (pkg === "email" || pkg === "bundle") out.email_text = f.email_text;
      out.note_text = "Short note: neutral tone, clarified ask, respectful wording.";
      if (include_analysis) out.analysis_text = "Record-safe posture.\nStructure-driven wording.\nBounded next step request.";
      return out;
    }
  }

  // normal default per relationship
  const f = GUIDELINE_MAP.fewshot?.[relationship]?.["__default__"];
  if (f) {
    const out = {};
    if (pkg === "message" || pkg === "bundle") out.message_text = f.message_text;
    if (pkg === "email" || pkg === "bundle") out.email_text = f.email_text;
    out.note_text = "Short note: clear intent, one request, easy to send.";
    if (include_analysis) out.analysis_text = "Record-safe posture.\nStructure-driven wording.\nBounded next step request.";
    return out;
  }

  // last-resort generic
  const out = {};
  if (pkg === "message" || pkg === "bundle") {
    out.message_text = "Hi — quick check: could you confirm the correct details when you have a moment? Thanks.";
  }
  if (pkg === "email" || pkg === "bundle") {
    out.email_text =
      "Subject: Quick clarification\n\nHi —\n\nCould you confirm the correct details so I can plan accordingly?\n\nThanks,\n[Your Name]";
  }
  out.note_text = "Short note: Neutral tone, one clear confirmation request, avoids assumptions.";
  if (include_analysis) out.analysis_text = "Record-safe posture.\nStructure-driven wording.\nBounded next step request.";
  return out;
}

/* ---------------------------
 * System prompts
 * -------------------------- */
function buildSystemPromptGeneration({
  pkg,
  format,
  relationship,
  intent,
  tone,
  risk_scan,
  control,
  include_analysis,
  intentGuide,
  relationGuide,
  schemaStr,
  blocks,
  fewshotExample,
  mins,
  maxs,
}) {
  const noteRules = buildNoteRules();

  return `
You are ClearBound vNext. Generate relationship-safe content under strict constraints.

<<<CONTROL_BLOCK>>>
package: ${pkg}
include_analysis: ${include_analysis}
format_primary: ${format}
relationship: ${relationship}
intent: ${intent}
tone_requested: ${tone}
risk_scan: impact=${risk_scan.impact}, continuity=${risk_scan.continuity}
record_safe_required: ${control.record_safe_required}
tone_floor: ${control.tone_floor} ; tone_ceiling: ${control.tone_ceiling}
MIN (chars): message=${mins.minMessage} email=${mins.minEmail} note=${mins.minNote}
MAX (chars): message=${maxs.maxMessage} email=${maxs.maxEmail} note=${maxs.maxNote}
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

${noteRules}

MIN LENGTH REQUIREMENTS (HARD):
- If package includes message_text: message_text MUST be at least ${mins.minMessage} characters.
- If package includes email_text: email_text MUST be at least ${mins.minEmail} characters.
- note_text MUST be at least ${mins.minNote} characters.
Do not pad with fluff; add useful, respectful clarity.

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

function buildSystemPromptAnalysis({
  relationship,
  intent,
  tone,
  risk_scan,
  control,
  schemaStr,
  fewshotExample,
}) {
  return `
You are ClearBound vNext ANALYSIS module. Produce ONLY analysis_text.

<<<CONTROL_BLOCK>>>
relationship: ${relationship}
intent: ${intent}
tone_requested: ${tone}
risk_scan: impact=${risk_scan.impact}, continuity=${risk_scan.continuity}
record_safe_required: ${control.record_safe_required}
analysis_lines: ${POLICY.ANALYSIS_LINES}
analysis_min_chars: ${POLICY.ANALYSIS_TOTAL_MIN_CHARS}
<<<END_CONTROL_BLOCK>>>

${buildAnalysisRulesV2()}

OUTPUT CONTRACT:
- Output MUST be valid JSON ONLY.
- JSON must match schema exactly.
- No markdown. No explanations.

MIN LENGTH (HARD):
- analysis_text total length MUST be at least ${POLICY.ANALYSIS_TOTAL_MIN_CHARS} characters.

FEW-SHOT:
${JSON.stringify(fewshotExample, null, 2)}

JSON SCHEMA:
${schemaStr}

FINAL OUTPUT REQUIREMENT:
Return ONLY the JSON object. No extra keys.
`.trim();
}

function buildUserPrompt({ rawContext, hint }) {
  return `<<<USER_CONTEXT>>>\n${rawContext}\n<<<END_USER_CONTEXT>>>\n${hint ? `(${hint})` : ""}`.trim();
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

async function callLLM({ model, system, user, max_tokens }) {
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (Number.isFinite(max_tokens) && max_tokens > 0) payload.max_tokens = max_tokens;

  const r = await client.chat.completions.create(payload);
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

function safeFallback(pkg, include_analysis) {
  const out = {};

  if (pkg === "message" || pkg === "bundle") {
    out.message_text =
      "Hi — I wanted to bring up one point to keep us aligned. Based on what happened, I’d like to confirm the correct expectation going forward. Could we handle it this way next time so it’s clear for both of us? Thank you.";
  }
  if (pkg === "email" || pkg === "bundle") {
    out.email_text =
      "Subject: Quick alignment\n\nHi —\n\nI’m writing to clarify one point so we can stay aligned going forward. Based on what happened, I’d like to confirm the correct expectation and next step.\n\nCould you please confirm the timing and next step by [deadline]?\n\nThank you,\n[Your Name]";
  }

  out.note_text =
    "This keeps the tone calm and focuses on observable facts, not blame. It makes one clear request and limits ambiguity, which reduces escalation risk.";

  if (include_analysis) {
    out.analysis_text =
      "Risk posture: record-safe wording focuses on verifiable facts and avoids blame or speculation.\n" +
      "Strategy: the structure states context, clarifies the expectation, and makes one concrete request.\n" +
      "Next step: the request is bounded (timing + confirmation) to reduce back-and-forth and escalation.";
  }

  return out;
}

/* ---------------------------
 * Postprocess: enforce MIN/MAX without extra LLM call
 * -------------------------- */
function ensureMinChars(text, minChars, addon) {
  let t = normalizeNewlines(text);
  if (t.length >= minChars) return t;
  const pad = normalizeNewlines(addon);
  t = t ? `${t}\n\n${pad}` : pad;
  if (t.length < minChars) {
    t = `${t}\n\nIf there’s a better way to handle this, I’m open to it.`;
  }
  return t;
}

function enforceMaxChars(text, maxChars) {
  const t = normalizeNewlines(text);
  return t.length > maxChars ? t.slice(0, maxChars).trim() : t;
}

function enforceAnalysis3LinesV2(analysisText) {
  let t = normalizeNewlines(analysisText);
  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);

  const out = [];
  for (let i = 0; i < Math.min(POLICY.ANALYSIS_LINES, lines.length); i++) out.push(lines[i]);

  while (out.length < POLICY.ANALYSIS_LINES) {
    if (out.length === 0) out.push("Risk posture: record-safe wording focuses on verifiable facts and avoids blame or speculation.");
    else if (out.length === 1) out.push("Strategy: the structure states context, clarifies the expectation, and makes one concrete request.");
    else out.push("Next step: the request is bounded (timing + confirmation) to reduce back-and-forth and escalation.");
  }

  t = out.slice(0, 3).join("\n");

  if (t.length < POLICY.ANALYSIS_TOTAL_MIN_CHARS) {
    const fixed = t.split("\n").slice(0, 3).map((line, idx) => {
      if (idx === 0) return `${line} This lowers risk by keeping the record clean and interpretation-free.`;
      if (idx === 1) return `${line} It prevents drift into emotion labels and keeps the recipient-facing text hard to misread.`;
      return `${line} The boundary is specific and reasonable, which helps keep the tone steady.`;
    });
    t = fixed.join("\n");
  }

  t = enforceMaxChars(t, POLICY.MAX_ANALYSIS_CHARS);
  return t;
}

function postprocessByPackage(pkg, include_analysis, obj) {
  if (pkg === "message" || pkg === "bundle") {
    obj.message_text = ensureMinChars(
      enforceMaxChars(obj.message_text, POLICY.MAX_MESSAGE_CHARS),
      POLICY.MIN_MESSAGE_CHARS,
      "I’m bringing this up so we can stay aligned and avoid confusion going forward."
    );
  }

  if (pkg === "email" || pkg === "bundle") {
    obj.email_text = ensureMinChars(
      enforceMaxChars(obj.email_text, POLICY.MAX_EMAIL_CHARS),
      POLICY.MIN_EMAIL_CHARS,
      "If you can confirm the details and timing, I can proceed correctly. Thank you for helping clarify."
    );
  }

  // always note
  obj.note_text = ensureMinChars(
    enforceMaxChars(obj.note_text, POLICY.MAX_NOTE_CHARS),
    POLICY.MIN_NOTE_CHARS,
    "This note explains the intent and why the wording is safe: it stays factual, avoids blame, and asks for one bounded next step."
  );

  if (include_analysis) {
    obj.analysis_text = enforceAnalysis3LinesV2(obj.analysis_text);
  } else {
    // ensure we don't accidentally leak analysis_text
    if ("analysis_text" in obj) delete obj.analysis_text;
  }

  return obj;
}

/* ---------------------------
 * Models + max_tokens (Ops)
 * -------------------------- */
function pickModelDefault() {
  return process.env.CB_MODEL_DEFAULT || "gpt-4.1-mini";
}

function pickModelAnalysis() {
  return process.env.CB_MODEL_ANALYSIS || process.env.CB_MODEL_HIGH_RISK || "gpt-4.1";
}

function pickMaxTokensFor({ pkg, include_analysis, phase }) {
  const n = (x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  if (phase === "analysis") return n(process.env.CB_MAXTOK_ANALYSIS || 220);

  if (pkg === "message") return n(process.env.CB_MAXTOK_MESSAGE || 340);
  if (pkg === "email") return n(process.env.CB_MAXTOK_EMAIL || 560);
  if (pkg === "bundle") return n(process.env.CB_MAXTOK_BUNDLE || 980);

  // fallback
  return include_analysis ? n(process.env.CB_MAXTOK_BUNDLE || 980) : null;
}

/* ---------------------------
 * Handler
 * -------------------------- */
module.exports = async function handler(req, res) {
  const t0 = Date.now();

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
    console.log("cb_timing_guideline_ms", Date.now() - t0);

    const state = parseState(req);

    /* ---------- Normalize incoming state ---------- */
    const norm = normalizeIncomingState(state);
    const relationship = norm.relationship;
    const intent = norm.intent;
    const tone = norm.tone;
    const format = norm.format;
    const pkg = norm.pkg;
    const include_analysis = !!norm.include_analysis;
    const risk_scan = norm.risk_scan || {};

    const CONTEXT_MAX = Number(process.env.CB_CONTEXT_MAX_CHARS || 1400);
    const rawContext = clampText(norm.rawContext ?? "", CONTEXT_MAX);

    /* ---------- Validation (after normalization) ---------- */
    assertEnum("relationship", relationship, ENUMS.relationship);
    assertEnum("intent", intent, ENUMS.intent);
    assertEnum("tone", tone, ENUMS.tone);
    assertEnum("format", format, ENUMS.format);
    assertEnum("package", pkg, ENUMS.package);
    assertEnum("risk_scan.impact", risk_scan?.impact, ENUMS.impact);
    assertEnum("risk_scan.continuity", risk_scan?.continuity, ENUMS.continuity);

    if (!rawContext) throw new Error("Missing context.text (or key_facts) after normalization");

    /* ---------- Control flags ---------- */
    const control = computeControlFlags({ risk_scan, format, intent, tone, include_analysis });

    /* ---------- Guideline resolution ---------- */
    const intentGuide = GUIDELINE_MAP.intent?.[intent];
    if (!intentGuide) throw new Error(`Missing intent guide: ${intent}`);

    const relationGuide = control.record_safe_required
      ? GUIDELINE_MAP.record_safe_variant?.[relationship]
      : GUIDELINE_MAP.relationship?.[relationship];

    if (!relationGuide) throw new Error(`Missing relationship guide: ${relationship}`);

    /* ---------- Common prompt blocks ---------- */
    const blocks = {
      risk_overrides: buildRiskOverrides(control),
      format_rules: buildFormatRules(format),
      tone_micro: buildToneMicroStyle(control),
    };

    /* ---------- Package schema ---------- */
    const pkgSchema = pkgSchemaFor(pkg, include_analysis);
    const schemaStr = jsonSchemaString(pkgSchema);

    console.log("cb_policy_snapshot", {
      pkg,
      include_analysis,
      format,
      relationship,
      intent,
      record_safe_required: control.record_safe_required,
      models: { gen: pickModelDefault(), analysis: pickModelAnalysis() },
    });

    /* =========================================================
     * FLOW 1: No analysis => single generation call
     * ======================================================= */
    if (!include_analysis) {
      const fewshotExample = pickFewshot({
        GUIDELINE_MAP,
        relationship,
        intent,
        control,
        format,
        pkg,
        include_analysis: false,
      });

      const system = buildSystemPromptGeneration({
        pkg,
        format,
        relationship,
        intent,
        tone,
        risk_scan,
        control,
        include_analysis: false,
        intentGuide,
        relationGuide,
        schemaStr,
        blocks,
        fewshotExample,
        mins: {
          minMessage: POLICY.MIN_MESSAGE_CHARS,
          minEmail: POLICY.MIN_EMAIL_CHARS,
          minNote: POLICY.MIN_NOTE_CHARS,
        },
        maxs: {
          maxMessage: POLICY.MAX_MESSAGE_CHARS,
          maxEmail: POLICY.MAX_EMAIL_CHARS,
          maxNote: POLICY.MAX_NOTE_CHARS,
        },
      });

      const user = buildUserPrompt({
        rawContext,
        hint: `Meet MIN chars; stay within MAX caps. note_text must be short and practical.`,
      });

      const model = pickModelDefault();
      const max_tokens = pickMaxTokensFor({ pkg, include_analysis: false, phase: "gen" });

      const tCall0 = Date.now();
      let text = await callLLM({ model, system, user, max_tokens });
      console.log("cb_timing_llm_ms", Date.now() - tCall0);

      let obj;
      try {
        obj = JSON.parse(text);
        validateJsonResult(obj, pkgSchema);
      } catch {
        const repairSystem = buildRepairSystem({ schemaStr, allowedKeys: pkgSchema.keys });
        const repairUser = `Fix this into valid JSON only:\n\n${text}`;
        const repaired = await callLLM({ model, system: repairSystem, user: repairUser, max_tokens: 260 });

        try {
          obj = JSON.parse(repaired);
          validateJsonResult(obj, pkgSchema);
        } catch {
          obj = safeFallback(pkg, false);
        }
      }

      obj = postprocessByPackage(pkg, false, obj);

      console.log("cb_timing_total_ms", Date.now() - t0);
      return res.status(200).json({ ok: true, ...obj });
    }

    /* =========================================================
     * FLOW 2: include_analysis=true => 2-call
     *  1) analysis (heavier model)
     *  2) generation (fast model) + attach analysis_text
     * ======================================================= */

    // (1) ANALYSIS CALL
    const analysisModel = pickModelAnalysis();
    const analysisSchema = jsonSchemaString({ required: ["analysis_text"], keys: ["analysis_text"] });

    const analysisFewshot = {
      analysis_text:
        "Risk posture: record-safe wording focuses on verifiable facts and avoids blame or speculation.\n" +
        "Strategy: the structure states context, clarifies the expectation, and makes one concrete request.\n" +
        "Next step: the request is bounded (timing + confirmation) to reduce back-and-forth and escalation.",
    };

    const analysisSystem = buildSystemPromptAnalysis({
      relationship,
      intent,
      tone,
      risk_scan,
      control: { ...control, record_safe_required: true },
      schemaStr: analysisSchema,
      fewshotExample: analysisFewshot,
    });

    const analysisUser = buildUserPrompt({
      rawContext,
      hint: "Return analysis_text only. EXACTLY 3 lines with the required line purposes.",
    });

    const tA0 = Date.now();
    let analysisRaw = await callLLM({
      model: analysisModel,
      system: analysisSystem,
      user: analysisUser,
      max_tokens: pickMaxTokensFor({ pkg, include_analysis: true, phase: "analysis" }),
    });
    console.log("cb_timing_analysis_llm_ms", Date.now() - tA0);

    let analysisObj;
    try {
      analysisObj = JSON.parse(analysisRaw);
      if (typeof analysisObj?.analysis_text !== "string") throw new Error("analysis_text missing");
    } catch {
      const repSys = buildRepairSystem({ schemaStr: analysisSchema, allowedKeys: ["analysis_text"] });
      const repUser = `Fix this into valid JSON only:\n\n${analysisRaw}`;
      const rep = await callLLM({ model: analysisModel, system: repSys, user: repUser, max_tokens: 260 });
      try {
        analysisObj = JSON.parse(rep);
        if (typeof analysisObj?.analysis_text !== "string") throw new Error("analysis_text missing");
      } catch {
        analysisObj = { analysis_text: safeFallback(pkg, true).analysis_text };
      }
    }
    analysisObj.analysis_text = enforceAnalysis3LinesV2(analysisObj.analysis_text);

    // (2) GENERATION CALL
    const genModel = pickModelDefault();
    const genPkgSchema = pkgSchemaFor(pkg, true);
    const genSchemaStr = jsonSchemaString(genPkgSchema);

    const fewshotExample = pickFewshot({
      GUIDELINE_MAP,
      relationship,
      intent,
      control,
      format,
      pkg,
      include_analysis: true,
    });

    const genSystem = buildSystemPromptGeneration({
      pkg,
      format,
      relationship,
      intent,
      tone,
      risk_scan,
      control,
      include_analysis: true,
      intentGuide,
      relationGuide,
      schemaStr: genSchemaStr,
      blocks,
      fewshotExample,
      mins: {
        minMessage: POLICY.MIN_MESSAGE_CHARS,
        minEmail: POLICY.MIN_EMAIL_CHARS,
        minNote: POLICY.MIN_NOTE_CHARS,
      },
      maxs: {
        maxMessage: POLICY.MAX_MESSAGE_CHARS,
        maxEmail: POLICY.MAX_EMAIL_CHARS,
        maxNote: POLICY.MAX_NOTE_CHARS,
      },
    });

    const genUser = safeJoin(
      buildUserPrompt({ rawContext, hint: "Generate recipient-facing text(s) + note_text only." }),
      `\n\n<<<ANALYSIS_FOR_USER_ONLY>>>\n${analysisObj.analysis_text}\n<<<END_ANALYSIS_FOR_USER_ONLY>>>\n` +
        "Do NOT reference the analysis in the recipient text. The analysis is for the user only."
    );

    const tG0 = Date.now();
    let genRaw = await callLLM({
      model: genModel,
      system: genSystem,
      user: genUser,
      max_tokens: pickMaxTokensFor({ pkg, include_analysis: true, phase: "gen" }),
    });
    console.log("cb_timing_generation_llm_ms", Date.now() - tG0);

    let genObj;
    try {
      genObj = JSON.parse(genRaw);
      validateJsonResult(genObj, genPkgSchema);
    } catch {
      const repairSystem = buildRepairSystem({ schemaStr: genSchemaStr, allowedKeys: genPkgSchema.keys });
      const repairUser = `Fix this into valid JSON only:\n\n${genRaw}`;
      const repaired = await callLLM({ model: genModel, system: repairSystem, user: repairUser, max_tokens: 320 });

      try {
        genObj = JSON.parse(repaired);
        validateJsonResult(genObj, genPkgSchema);
      } catch {
        genObj = safeFallback(pkg, true);
      }
    }

    // attach analysis_text (HARD)
    genObj.analysis_text = analysisObj.analysis_text;

    genObj = postprocessByPackage(pkg, true, genObj);

    console.log("cb_timing_total_ms", Date.now() - t0);
    return res.status(200).json({ ok: true, ...genObj });

  } catch (err) {
    console.log("cb_timing_total_ms_error", Date.now() - t0);
    return res.status(500).json({
      ok: false,
      error: "GENERATION_FAILED",
      message: err?.message || String(err),
    });
  }
};
