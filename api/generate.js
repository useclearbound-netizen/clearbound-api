// clearbound-api/api/generate.js
// vNext Ops-Optimized (Final):
// - Remote GUIDELINE_MAP fetch (+ TTL cache)
// - Code-based control flags (record-safe, tone ceiling, max chars)
// - Model split:
//   * message/email (with note): gpt-4.1-mini (fast)
//   * analysis (only when needed): gpt-4.1
// - Strict JSON output gating (+ optional repair call)
// - MIN length enforcement via postprocess (no extra LLM call)
// - analysis_text forced to exactly 3 lines (prompt + postprocess)
// NOTE: Do NOT send temperature (some models reject non-default overrides).

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
  // packages (vNext)
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
  // MIN chars (locked)
  MIN_MESSAGE_CHARS: Number(process.env.CB_MIN_MESSAGE_CHARS || 380),
  MIN_EMAIL_CHARS: Number(process.env.CB_MIN_EMAIL_CHARS || 700),
  MIN_NOTE_CHARS: Number(process.env.CB_MIN_NOTE_CHARS || 240),

  // Analysis lines (locked)
  ANALYSIS_LINES: 3,
  ANALYSIS_TOTAL_MIN_CHARS: Number(process.env.CB_MIN_ANALYSIS_CHARS || 330),

  // MAX chars (sane caps)
  MAX_MESSAGE_CHARS: Number(process.env.CB_MAX_MESSAGE_CHARS || 700),
  MAX_EMAIL_CHARS: Number(process.env.CB_MAX_EMAIL_CHARS || 1100),
  MAX_NOTE_CHARS: Number(process.env.CB_MAX_NOTE_CHARS || 420),
  MAX_ANALYSIS_CHARS: Number(process.env.CB_MAX_ANALYSIS_CHARS || 520),
};

/* ---------------------------
 * Rule Engine (Pass 1/2 -> Code)
 * -------------------------- */
function computeControlFlags({ risk_scan, format, intent, tone }) {
  const isHighRisk = risk_scan.impact === "high" || risk_scan.continuity === "high";
  const isEmail = format === "email";
  const isOfficialIntent = intent === "make_it_official";

  // wording safety mode
  const record_safe_required = isHighRisk || isEmail || isOfficialIntent;

  // model escalation switch (analysis call)
  const analysis_required = isHighRisk || isOfficialIntent; // keep tight for cost

  const tone_floor = "calm";
  const tone_ceiling = record_safe_required ? "firm" : tone;

  // max chars for the MAIN output text (not note/analysis)
  const main_max_chars =
    format === "message"
      ? record_safe_required
        ? 520
        : 700
      : record_safe_required
        ? 1100
        : 1500;

  return { record_safe_required, analysis_required, tone_floor, tone_ceiling, main_max_chars };
}

/* ---------------------------
 * Package schema gating
 * (message/email include note_text)
 * -------------------------- */
function pkgSchemaFor(pkg) {
  switch (pkg) {
    case "message":
      return { required: ["message_text", "note_text"], keys: ["message_text", "note_text"] };
    case "email":
      return { required: ["email_text", "note_text"], keys: ["email_text", "note_text"] };
    case "analysis_email":
      return { required: ["email_text", "analysis_text"], keys: ["email_text", "analysis_text"] };
    case "total":
      return { required: ["message_text", "email_text", "analysis_text"], keys: ["message_text", "email_text", "analysis_text"] };
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

function buildNoteRules(pkg) {
  // Note is ONLY for user (not the recipient).
  if (pkg === "message" || pkg === "email") {
    return [
      "NOTE RULES (for note_text):",
      "- 2–3 short sentences.",
      "- Explain the intent + why the wording is safe/respectful.",
      "- Do NOT add new facts.",
      "- Do NOT give legal/medical advice.",
      "- Avoid heavy jargon; keep it practical.",
    ].join("\n");
  }
  return "NOTE RULES: (none)";
}

function buildAnalysisRules() {
  return [
    "ANALYSIS RULES (for analysis_text):",
    "- Must be EXACTLY 3 lines.",
    "- Each line is one sentence.",
    "- Focus on risk posture + why this is record-safe + what boundary/request is set.",
    "- Do NOT add new facts. Do NOT provide legal advice.",
  ].join("\n");
}

/* ---------------------------
 * Few-shot selection
 * -------------------------- */
function pickFewshot({ GUIDELINE_MAP, relationship, intent, control, format, pkg }) {
  // Priority: record-safe + make_it_official per relationship
  if (control.record_safe_required && intent === "make_it_official") {
    const f = GUIDELINE_MAP.fewshot_record_safe?.make_it_official?.[relationship];
    if (f) {
      if (pkg === "email") return { email_text: f.email_text, note_text: "Short note: record-safe, factual, clear request." };
      if (pkg === "message") return { message_text: f.message_text, note_text: "Short note: calm, respectful, specific request." };
      if (pkg === "analysis_email") return { email_text: f.email_text, analysis_text: "Record-safe. Facts only.\nClear request.\nNo blame." };
      if (pkg === "total") return { message_text: f.message_text, email_text: f.email_text, analysis_text: "Record-safe. Facts only.\nClear request.\nNo blame." };
    }
  }

  // record-safe default per relationship
  if (control.record_safe_required) {
    const f = GUIDELINE_MAP.fewshot_record_safe?.[relationship]?.["__default__"];
    if (f) {
      if (pkg === "email") return { email_text: f.email_text, note_text: "Short note: neutral tone, clarified ask, respectful." };
      if (pkg === "message") return { message_text: f.message_text, note_text: "Short note: calm tone, clear request, de-escalating." };
    }
  }

  // normal default per relationship
  const f = GUIDELINE_MAP.fewshot?.[relationship]?.["__default__"];
  if (f) {
    if (pkg === "email") return { email_text: f.email_text, note_text: "Short note: friendly clarity, direct next step." };
    if (pkg === "message") return { message_text: f.message_text, note_text: "Short note: polite, clear ask, minimal friction." };
  }

  // last-resort generic
  if (pkg === "email") {
    return {
      email_text:
        "Subject: Quick clarification\n\nHi —\n\nCould you confirm the correct time/details so I can plan accordingly?\n\nThanks,\n[Your Name]",
      note_text: "Short note: Keeps it neutral, asks one clear confirmation, avoids assumptions.",
    };
  }
  if (pkg === "message") {
    return {
      message_text: "Hi — quick check: could you confirm the correct details when you have a moment? Thanks.",
      note_text: "Short note: Simple, respectful, and low-pressure request for clarity.",
    };
  }
  if (pkg === "analysis_email") {
    return {
      email_text:
        "Subject: Record: Confirmation requested\n\nHello,\n\nFor record and clarity: please confirm the status and next steps by [deadline].\n\nRegards,\n[Your Name]",
      analysis_text: "Record-safe posture.\nFacts only; no speculation.\nClear request + deadline.",
    };
  }
  return {
    message_text: "Hi — could you confirm the next step when you have a moment? Thank you.",
    email_text:
      "Subject: Quick alignment\n\nHi —\n\nCould you confirm the next step by [deadline]?\n\nThank you,\n[Your Name]",
    analysis_text: "Record-safe posture.\nFacts only; no speculation.\nClear request + deadline.",
  };
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
  intentGuide,
  relationGuide,
  schemaStr,
  blocks,
  fewshotExample,
  mins,
  maxs,
}) {
  const noteRules = buildNoteRules(pkg);

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
- If package includes note_text: note_text MUST be at least ${mins.minNote} characters.
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

${buildAnalysisRules()}

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

function safeFallback(pkg) {
  if (pkg === "message") {
    return {
      message_text:
        "Hi — I wanted to bring up one point to help us stay aligned. I’ve noticed a pattern that’s making it harder to move smoothly. Could we adjust going forward so it’s clearer for both of us? Thank you.",
      note_text:
        "This keeps the tone calm and focuses on the observable pattern, not personal blame. It makes one clear request and leaves space for cooperation.",
    };
  }
  if (pkg === "email") {
    return {
      email_text:
        "Subject: Quick alignment\n\nHi —\n\nI wanted to clarify one point to keep things on track. I’ve noticed a pattern that’s impacting how smoothly we can move forward.\n\nCould you please confirm the next step (and timing) by [deadline]?\n\nThank you,\n[Your Name]",
      note_text:
        "This email stays factual and non-accusatory, while making a single clear request. It’s appropriate to keep a record without escalating tone.",
    };
  }
  if (pkg === "analysis_email") {
    return {
      email_text:
        "Subject: Record: Confirmation requested\n\nHello,\n\nFor record and clarity: this email documents the current status and requests confirmation.\n\nPlease confirm the processing date and next steps by [deadline].\n\nRegards,\n[Your Name]",
      analysis_text:
        "Record-safe posture with facts only.\nSingle clear request with deadline.\nNo blame, no speculation, suitable for documentation.",
    };
  }
  return {
    message_text:
      "Hi — I’d like to align on one point. Could you confirm the next step when you have a moment? Thank you.",
    email_text:
      "Subject: Quick alignment\n\nHi —\n\nCould you confirm the next step by [deadline]?\n\nThank you,\n[Your Name]",
    analysis_text:
      "Record-safe posture with facts only.\nSingle clear request with deadline.\nNo blame, no speculation, suitable for documentation.",
  };
}

/* ---------------------------
 * Postprocess: enforce MIN/MAX without extra LLM call
 * -------------------------- */
function ensureMinChars(text, minChars, addon) {
  let t = normalizeNewlines(text);
  if (t.length >= minChars) return t;
  const pad = normalizeNewlines(addon);
  // add with spacing
  t = t ? `${t}\n\n${pad}` : pad;
  // if still short, repeat a short safe clause once (still non-fluffy)
  if (t.length < minChars) {
    t = `${t}\n\nIf there’s a better way to handle this, I’m open to it.`;
  }
  return t;
}

function enforceMaxChars(text, maxChars) {
  const t = normalizeNewlines(text);
  return t.length > maxChars ? t.slice(0, maxChars).trim() : t;
}

function enforceAnalysis3Lines(analysisText) {
  let t = normalizeNewlines(analysisText);

  // If it's JSON-like accidentally, leave to validator/repair upstream.
  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);

  const out = [];
  for (let i = 0; i < Math.min(POLICY.ANALYSIS_LINES, lines.length); i++) out.push(lines[i]);

  // If fewer than 3 lines, add safe, non-factual fillers (no new facts)
  while (out.length < POLICY.ANALYSIS_LINES) {
    if (out.length === 0) out.push("Record-safe posture: factual, non-accusatory wording to reduce risk.");
    else if (out.length === 1) out.push("Structure: purpose + facts + one clear request to keep the record clean.");
    else out.push("Tone: calm, firm, and respectful; avoids speculation and emotional labeling.");
  }

  t = out.join("\n");

  // enforce overall min chars (expand with safe clarification—still no new facts)
  if (t.length < POLICY.ANALYSIS_TOTAL_MIN_CHARS) {
    t = `${t}\n`; // keep 3 lines only—so we expand by length within same lines
    // Expand each line slightly (still 3 lines)
    const fixed = t.split("\n").filter(Boolean).slice(0, 3).map((line, idx) => {
      if (idx === 0) return `${line} This framing focuses on what can be verified rather than intent or emotion.`;
      if (idx === 1) return `${line} It helps prevent misinterpretation and supports follow-up if needed.`;
      return `${line} The request is specific and bounded, which reduces escalation risk.`;
    });
    t = fixed.join("\n");
  }

  // hard cap
  t = enforceMaxChars(t, POLICY.MAX_ANALYSIS_CHARS);
  return t;
}

function postprocessByPackage(pkg, obj) {
  if (pkg === "message") {
    obj.message_text = ensureMinChars(
      enforceMaxChars(obj.message_text, POLICY.MAX_MESSAGE_CHARS),
      POLICY.MIN_MESSAGE_CHARS,
      "I’m bringing this up so we can stay aligned and avoid confusion going forward."
    );
    obj.note_text = ensureMinChars(
      enforceMaxChars(obj.note_text, POLICY.MAX_NOTE_CHARS),
      POLICY.MIN_NOTE_CHARS,
      "This keeps the tone calm and focuses on a clear request without blame. It’s designed to be easy to send and hard to misread."
    );
  }

  if (pkg === "email") {
    obj.email_text = ensureMinChars(
      enforceMaxChars(obj.email_text, POLICY.MAX_EMAIL_CHARS),
      POLICY.MIN_EMAIL_CHARS,
      "If you can confirm the details and timing, I can proceed correctly. Thank you for helping clarify."
    );
    obj.note_text = ensureMinChars(
      enforceMaxChars(obj.note_text, POLICY.MAX_NOTE_CHARS),
      POLICY.MIN_NOTE_CHARS,
      "This is written to be neutral and record-safe: it avoids assumptions and asks for one clear confirmation. It should reduce back-and-forth."
    );
  }

  if (pkg === "analysis_email") {
    obj.email_text = ensureMinChars(
      enforceMaxChars(obj.email_text, POLICY.MAX_EMAIL_CHARS),
      800, // high-risk email minimum (ops policy)
      "Please confirm the processing date, reference number (if any), and the next steps. Thank you."
    );
    obj.analysis_text = enforceAnalysis3Lines(obj.analysis_text);
  }

  if (pkg === "total") {
    obj.message_text = ensureMinChars(
      enforceMaxChars(obj.message_text, POLICY.MAX_MESSAGE_CHARS),
      420,
      "I’m sharing this clearly and respectfully so we can resolve it without misunderstandings."
    );
    obj.email_text = ensureMinChars(
      enforceMaxChars(obj.email_text, POLICY.MAX_EMAIL_CHARS),
      800,
      "Please confirm the next steps and timing so we can close this out. Thank you."
    );
    obj.analysis_text = enforceAnalysis3Lines(obj.analysis_text);
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

function pickMaxTokensFor(pkg, phase) {
  // phase: "gen" | "analysis"
  const n = (x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  if (phase === "analysis") return n(process.env.CB_MAXTOK_ANALYSIS || 180);

  // generation
  if (pkg === "message") return n(process.env.CB_MAXTOK_MESSAGE || 320);
  if (pkg === "email") return n(process.env.CB_MAXTOK_EMAIL || 520);
  if (pkg === "analysis_email") return n(process.env.CB_MAXTOK_EMAIL || 520);
  if (pkg === "total") return n(process.env.CB_MAXTOK_TOTAL_GEN || 900);

  return null;
}

/* ---------------------------
 * Request parsing
 * -------------------------- */
function parseState(req) {
  // WordPress proxy may send { state: "<json>" }.
  // Direct calls may send JSON object directly.
  if (req?.body?.state) return JSON.parse(req.body.state);
  return req.body || {};
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

    if (!relationGuide) throw new Error(`Missing relationship guide: ${relationship}`);

    /* ---------- Common prompt blocks ---------- */
    const blocks = {
      risk_overrides: buildRiskOverrides(control),
      format_rules: buildFormatRules(format),
      tone_micro: buildToneMicroStyle(control),
    };

    /* ---------- Package schema ---------- */
    const pkgSchema = pkgSchemaFor(pkg);
    const schemaStr = jsonSchemaString(pkgSchema);

    /* ---------- Debug snapshot ---------- */
    console.log("cb_policy_snapshot", {
      pkg,
      format,
      relationship,
      intent,
      record_safe_required: control.record_safe_required,
      analysis_required: control.analysis_required,
      models: {
        gen: pickModelDefault(),
        analysis: pickModelAnalysis(),
      },
    });

    /* =========================================================
     * FLOW A: message/email (1-call)  => *_text + note_text
     * ======================================================= */
    if (pkg === "message" || pkg === "email") {
      const fewshotExample = pickFewshot({ GUIDELINE_MAP, relationship, intent, control, format, pkg });

      const system = buildSystemPromptGeneration({
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
        hint: `Keep ${pkg === "message" ? "message_text" : "email_text"} within the MAX caps and meet MIN chars. note_text must be short and practical.`,
      });

      const model = pickModelDefault();
      const max_tokens = pickMaxTokensFor(pkg, "gen");

      const tCall0 = Date.now();
      let text = await callLLM({ model, system, user, max_tokens });
      const tCall1 = Date.now();
      console.log("cb_timing_llm_ms", tCall1 - tCall0);

      let obj;
      try {
        obj = JSON.parse(text);
        validateJsonResult(obj, pkgSchema);
      } catch {
        const repairSystem = buildRepairSystem({ schemaStr, allowedKeys: pkgSchema.keys });
        const repairUser = `Fix this into valid JSON only:\n\n${text}`;
        const repaired = await callLLM({ model, system: repairSystem, user: repairUser, max_tokens: 220 });

        try {
          obj = JSON.parse(repaired);
          validateJsonResult(obj, pkgSchema);
        } catch {
          obj = safeFallback(pkg);
        }
      }

      obj = postprocessByPackage(pkg, obj);

      console.log("cb_timing_total_ms", Date.now() - t0);
      return res.status(200).json({ ok: true, ...obj });
    }

    /* =========================================================
     * FLOW B: analysis_email / total (2-call)
     *  1) analysis (gpt-4.1)
     *  2) generation (gpt-4.1-mini)
     * ======================================================= */

    // (1) ANALYSIS CALL (always for analysis_email/total)
    const analysisModel = pickModelAnalysis();
    const analysisSchema = jsonSchemaString({
      required: ["analysis_text"],
      keys: ["analysis_text"],
    });

    const analysisFewshot = pickFewshot({
      GUIDELINE_MAP,
      relationship,
      intent,
      control: { ...control, record_safe_required: true },
      format,
      pkg: "analysis_email", // reuse
    });

    const analysisSystem = buildSystemPromptAnalysis({
      relationship,
      intent,
      tone,
      risk_scan,
      control: { ...control, record_safe_required: true },
      schemaStr: analysisSchema,
      fewshotExample: { analysis_text: (analysisFewshot.analysis_text || "Record-safe posture.\nFacts only.\nClear request + next step.") },
    });

    const analysisUser = buildUserPrompt({
      rawContext,
      hint: "Return analysis_text only. EXACTLY 3 lines.",
    });

    const tA0 = Date.now();
    let analysisRaw = await callLLM({
      model: analysisModel,
      system: analysisSystem,
      user: analysisUser,
      max_tokens: pickMaxTokensFor(pkg, "analysis"),
    });
    const tA1 = Date.now();
    console.log("cb_timing_analysis_llm_ms", tA1 - tA0);

    let analysisObj;
    try {
      analysisObj = JSON.parse(analysisRaw);
      if (typeof analysisObj?.analysis_text !== "string") throw new Error("analysis_text missing");
    } catch {
      // repair analysis JSON
      const repSys = buildRepairSystem({ schemaStr: analysisSchema, allowedKeys: ["analysis_text"] });
      const repUser = `Fix this into valid JSON only:\n\n${analysisRaw}`;
      const rep = await callLLM({ model: analysisModel, system: repSys, user: repUser, max_tokens: 220 });
      try {
        analysisObj = JSON.parse(rep);
        if (typeof analysisObj?.analysis_text !== "string") throw new Error("analysis_text missing");
      } catch {
        analysisObj = { analysis_text: safeFallback("analysis_email").analysis_text };
      }
    }

    analysisObj.analysis_text = enforceAnalysis3Lines(analysisObj.analysis_text);

    // (2) GENERATION CALL (mini) — generate message/email (and both for total)
    const genModel = pickModelDefault();
    const genPkgSchema = pkgSchemaFor(pkg);
    const genSchemaStr = jsonSchemaString(genPkgSchema);

    const fewshotExample = pickFewshot({ GUIDELINE_MAP, relationship, intent, control, format, pkg });

    const mins = {
      minMessage: POLICY.MIN_MESSAGE_CHARS,
      minEmail: POLICY.MIN_EMAIL_CHARS,
      minNote: POLICY.MIN_NOTE_CHARS,
    };
    const maxs = {
      maxMessage: POLICY.MAX_MESSAGE_CHARS,
      maxEmail: POLICY.MAX_EMAIL_CHARS,
      maxNote: POLICY.MAX_NOTE_CHARS,
    };

    const genSystem = buildSystemPromptGeneration({
      pkg,
      format,
      relationship,
      intent,
      tone,
      risk_scan,
      control,
      intentGuide,
      relationGuide,
      schemaStr: genSchemaStr,
      blocks,
      fewshotExample,
      mins,
      maxs,
    });

    // IMPORTANT: analysis does NOT feed the generation logic as “content”.
    // We only pass a minimal control hint (non-textual / non-factual).
    const genUser = safeJoin(
      buildUserPrompt({ rawContext, hint: "Generate the recipient-facing text(s) only." }),
      `\n\n<<<ANALYSIS_FOR_USER_ONLY>>>\n${analysisObj.analysis_text}\n<<<END_ANALYSIS_FOR_USER_ONLY>>>\n` +
        "Do NOT reference the analysis in the recipient text. It is for the user only."
    );

    const tG0 = Date.now();
    let genRaw = await callLLM({
      model: genModel,
      system: genSystem,
      user: genUser,
      max_tokens: pickMaxTokensFor(pkg, "gen"),
    });
    const tG1 = Date.now();
    console.log("cb_timing_generation_llm_ms", tG1 - tG0);

    let genObj;
    try {
      genObj = JSON.parse(genRaw);
      validateJsonResult(genObj, genPkgSchema);
    } catch {
      const repairSystem = buildRepairSystem({ schemaStr: genSchemaStr, allowedKeys: genPkgSchema.keys });
      const repairUser = `Fix this into valid JSON only:\n\n${genRaw}`;
      const repaired = await callLLM({ model: genModel, system: repairSystem, user: repairUser, max_tokens: 260 });

      try {
        genObj = JSON.parse(repaired);
        validateJsonResult(genObj, genPkgSchema);
      } catch {
        genObj = safeFallback(pkg);
      }
    }

    // Attach analysis_text (required in analysis_email/total)
    if (pkg === "analysis_email") {
      genObj.analysis_text = analysisObj.analysis_text;
    }
    if (pkg === "total") {
      genObj.analysis_text = analysisObj.analysis_text;
    }

    genObj = postprocessByPackage(pkg, genObj);

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
