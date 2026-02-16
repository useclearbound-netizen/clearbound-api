/**
 * ClearBound Engine Logic v3.0 (LOCK)
 * - Deterministic decisions only (no advice, no prediction)
 * - Input: vNext backend state (from front)
 * - Output: fixed contract decisions
 */

const WEIGHTS = {
  continuity: {
    one_time: 0,
    short_term: 1,
    ongoing: 2,
  },
  repeat_yes: 1,

  exposure: {
    emotional_fallout: 1,
    reputation_impact: 2,
    documentation_sensitivity: 2,
    they_have_leverage: 3,
  },
};

function normalizeContinuity(v) {
  // Front v2 sends: high | mid | low
  // Engine v3 expects: one_time | short_term | ongoing
  if (v === "high") return "ongoing";
  if (v === "mid") return "short_term";
  if (v === "low") return "one_time";
  return null;
}

function clampRiskLevelFromScore(score) {
  if (score >= 6) return "high";
  if (score >= 3) return "moderate";
  return "low";
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Map current Front v2 signals -> Engine v3 flags
 * NOTE: We keep this mapping deterministic and conservative.
 */
function deriveInternalFlags(input) {
  const relationship = input?.relationship?.value || null;

  const riskScan = input?.context?.risk_scan || {};
  const continuityRaw = riskScan?.continuity || null; // high|mid|low
  const continuity = normalizeContinuity(continuityRaw);

  const mainConcerns = safeArray(input?.context?.main_concerns); // e.g. ["repeat","document",...]
  const constraints = safeArray(input?.context?.constraints);

  // v3 input flags (best-effort mapping from current UI)
  const repeat_flag = mainConcerns.includes("repeat"); // "It keeps happening"
  const doc_flag = mainConcerns.includes("document"); // "I want this documented"

  // leverage not collected in current UI => always false for now
  const leverage_flag = false;

  // ongoing_flag derived from continuity
  const ongoing_flag = continuity === "ongoing";

  /**
   * exposure[] mapping (v3 weights table)
   * - documentation_sensitivity: from "document"
   * - emotional_fallout: from "impact"=high OR relationship intimate/personal with "no_emotion"
   * - reputation_impact: deterministic rule for social/peripheral + impact=high (more record/public-facing)
   */
  const impactRaw = riskScan?.impact || null; // high|low
  const exposure = [];

  if (doc_flag) exposure.push("documentation_sensitivity");

  if (impactRaw === "high") exposure.push("emotional_fallout");

  if ((relationship === "social" || relationship === "peripheral") && impactRaw === "high") {
    exposure.push("reputation_impact");
  }

  // If user explicitly wants to avoid sounding emotional, treat as emotional-fallout sensitivity (no extra score)
  // We do NOT add a new weight for this; we only keep it as a constraint signal.
  const avoid_emotion = constraints.includes("no_emotion");

  return {
    relationship,
    continuity, // one_time|short_term|ongoing
    impactRaw,  // high|low
    exposure,   // array of v3 exposure flags
    repeat_flag,
    doc_flag,
    leverage_flag,
    ongoing_flag,
    avoid_emotion,
  };
}

function calcRiskScore(flags) {
  const c = flags.continuity;
  const continuity_weight = c ? (WEIGHTS.continuity[c] ?? 0) : 0;

  const repeat_weight = flags.repeat_flag ? WEIGHTS.repeat_yes : 0;

  const exposure_weight_sum = (flags.exposure || []).reduce((sum, key) => {
    return sum + (WEIGHTS.exposure[key] ?? 0);
  }, 0);

  return continuity_weight + repeat_weight + exposure_weight_sum;
}

function calcRecordSafeLevel(flags) {
  const hasDoc = (flags.exposure || []).includes("documentation_sensitivity");
  const hasReputation = (flags.exposure || []).includes("reputation_impact");

  if (hasDoc) return 2;
  if (hasReputation) return 1;
  return 0;
}

function pickDirectionSuggestion({ risk_level, record_safe_level, flags }) {
  // v3: shown ONLY when user selects "I'm not sure"
  // Front currently does not capture this explicitly, so we gate on input.context.direction_sure === false
  // (You can wire this from UI later)
  const unsure = flags?.direction_unsure === true;
  if (!unsure) return null;

  // Baseline logic (LOCK)
  if (risk_level === "low" && flags.continuity === "one_time" && !flags.repeat_flag) {
    return { value: "maintain", reason: "Based on interaction signals and continuity profile, maintain aligns with the present context." };
  }

  if (record_safe_level === 2 && flags.leverage_flag && flags.ongoing_flag && flags.repeat_flag) {
    return { value: "disengage", reason: "Based on ongoing interaction and documentation signals, disengage fits the present context." };
  }

  return { value: "reset", reason: "Based on interaction signals and documentation considerations, reset aligns with the present context." };
}

function pickTone({ risk_level, record_safe_level }) {
  // Baseline logic (LOCK)
  if (record_safe_level === 2) return { value: "formal", reason: "Based on documentation signals in the current interaction context." };
  if (risk_level === "high") return { value: "neutral", reason: "Based on higher-risk signals in the current interaction context." };
  if (risk_level === "moderate") return { value: "neutral", reason: "Based on moderate signals in the current interaction context." };
  return { value: "calm", reason: "Based on lower-risk signals in the current interaction context." };
}

function pickDetail({ risk_level, record_safe_level, flags }) {
  // Baseline logic (LOCK)
  if (record_safe_level === 2) return { value: "detailed", reason: "Based on documentation signals and continuity profile in this interaction context." };
  if (risk_level !== "low" || flags.ongoing_flag) return { value: "standard", reason: "Based on continuity signals and interaction context considerations." };
  return { value: "concise", reason: "Based on one-time signals and minimal continuity considerations in this context." };
}

function pickInsightCandor(risk_level) {
  if (risk_level === "high") return "high";
  if (risk_level === "moderate") return "moderate";
  return "low";
}

/**
 * Public compute
 * Output Contract (v3.0):
 * 1) risk_level
 * 2) record_safe_level
 * 3) direction_suggestion (only if user is unsure)
 * 4) tone_recommendation
 * 5) detail_recommendation
 * 6) insight_candor_level
 * 7) constraints
 */
function computeEngineDecision(input) {
  const flags = deriveInternalFlags(input);

  // Optional future hook (UI can set this later)
  flags.direction_unsure = input?.context?.direction_unsure === true;

  const risk_score = calcRiskScore(flags);
  const risk_level = clampRiskLevelFromScore(risk_score);

  const record_safe_level = calcRecordSafeLevel(flags);

  const direction_suggestion = pickDirectionSuggestion({ risk_level, record_safe_level, flags });

  const tone_recommendation = pickTone({ risk_level, record_safe_level });
  const detail_recommendation = pickDetail({ risk_level, record_safe_level, flags });

  const insight_candor_level = pickInsightCandor(risk_level);

  const constraints = {
    tone_soften_if_high_risk: risk_level === "high",
    record_safe_mode: record_safe_level === 2,
    forbidden_patterns_enabled: true,
  };

  return {
    // (fixed contract)
    risk_level,
    record_safe_level,
    direction_suggestion, // null or {value, reason}
    tone_recommendation,  // {value, reason}
    detail_recommendation,// {value, reason}
    insight_candor_level,
    constraints,

    // (debug extras - safe to keep internal; remove later if you want)
    _debug: {
      risk_score,
      flags,
    },
  };
}

module.exports = { computeEngineDecision };
