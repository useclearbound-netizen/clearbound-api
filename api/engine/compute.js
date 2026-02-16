// api/engine/compute.js
// ClearBound Engine Logic v3.0 (LOCK-aligned, deterministic)

function clampStr(v) {
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Map current front signals to v3.0 internal flags.
 * Front (current):
 * - risk_scan.impact: high|low
 * - risk_scan.continuity: high|mid|low
 * - context_builder.main_concerns: ["repeat","roles","impact_work","document","avoid_escalation"]
 * - context_builder.situation_type: say_no|push_back|clarify_correct|set_boundary|official_documented
 */
function normalizeFlags(input) {
  const risk_scan = input?.risk_scan || {};
  const impact = clampStr(risk_scan.impact);         // high|low
  const cont = clampStr(risk_scan.continuity);       // high|mid|low

  const situation_type = clampStr(input?.situation_type);
  const concerns = asArray(input?.main_concerns).map(String);
  const constraints = asArray(input?.constraints).map(String);

  // continuity mapping to v3.0 buckets
  // high -> ongoing (2), mid -> short_term (1), low -> one_time (0)
  const continuity_bucket =
    cont === "high" ? "ongoing" :
    cont === "mid"  ? "short_term" :
    cont === "low"  ? "one_time" : null;

  const ongoing_flag = continuity_bucket === "ongoing";
  const repeat_flag = concerns.includes("repeat");

  // v3.0 exposure flags (best-effort mapping from current UI)
  const documentation_sensitivity =
    concerns.includes("document") || situation_type === "official_documented";

  // reputation_impact is not explicitly collected in v2 UI.
  // We approximate using "impact_work" (work/time/responsibility) as a proxy for reputation/standing.
  const reputation_impact = concerns.includes("impact_work");

  // emotional_fallout is approximated by "impact: high" (consequences likely)
  const emotional_fallout = impact === "high";

  // leverage flag is not collected yet in v2 UI
  const leverage_flag = false;

  const exposure = {
    emotional_fallout,
    reputation_impact,
    documentation_sensitivity,
    they_have_leverage: leverage_flag
  };

  return {
    continuity_bucket,
    ongoing_flag,
    repeat_flag,
    leverage_flag,
    documentation_sensitivity,
    reputation_impact,
    emotional_fallout,
    exposure,
    constraints
  };
}

function calcRiskScore(flags) {
  const weights = {
    one_time: 0,
    short_term: 1,
    ongoing: 2,
    repeat: 1,
    emotional_fallout: 1,
    reputation_impact: 2,
    documentation_sensitivity: 2,
    they_have_leverage: 3
  };

  const continuity_weight =
    flags.continuity_bucket ? weights[flags.continuity_bucket] : 0;

  const repeat_weight = flags.repeat_flag ? weights.repeat : 0;

  const exposure_weight_sum =
    (flags.exposure.emotional_fallout ? weights.emotional_fallout : 0) +
    (flags.exposure.reputation_impact ? weights.reputation_impact : 0) +
    (flags.exposure.documentation_sensitivity ? weights.documentation_sensitivity : 0) +
    (flags.exposure.they_have_leverage ? weights.they_have_leverage : 0);

  return continuity_weight + repeat_weight + exposure_weight_sum;
}

function mapRiskLevel(score) {
  if (score >= 6) return "high";
  if (score >= 3) return "moderate";
  return "low";
}

function calcRecordSafeLevel(flags) {
  if (flags.documentation_sensitivity) return 2;
  if (flags.reputation_impact) return 1;
  return 0;
}

function calcDirectionSuggestion({ risk_level, record_safe_level, flags }) {
  // Only used if user chooses "I'm not sure" in the future.
  // For now: caller decides to display or not.
  if (
    risk_level === "low" &&
    flags.continuity_bucket === "one_time" &&
    !flags.repeat_flag
  ) return "maintain";

  if (
    record_safe_level === 2 &&
    flags.leverage_flag &&
    flags.ongoing_flag &&
    flags.repeat_flag
  ) return "disengage";

  return "reset";
}

function calcTone({ risk_level, record_safe_level }) {
  if (record_safe_level === 2) return "formal";
  if (risk_level === "high") return "neutral";
  if (risk_level === "moderate") return "neutral";
  return "calm";
}

function calcDetail({ risk_level, record_safe_level, flags }) {
  if (record_safe_level === 2) return "detailed";
  if (risk_level === "moderate" || risk_level === "high" || flags.ongoing_flag) return "standard";
  return "concise";
}

function calcCandor(risk_level) {
  if (risk_level === "high") return "high";
  if (risk_level === "moderate") return "moderate";
  return "low";
}

function buildConstraints(risk_level, record_safe_level) {
  return {
    tone_soften_if_high_risk: risk_level === "high",
    record_safe_mode: record_safe_level === 2,
    forbidden_patterns_enabled: true
  };
}

/**
 * Main compute() exported.
 * Expects a normalized input object (already extracted from request payload).
 */
function computeEngineDecisions(input) {
  const flags = normalizeFlags(input);
  const risk_score = calcRiskScore(flags);
  const risk_level = mapRiskLevel(risk_score);
  const record_safe_level = calcRecordSafeLevel(flags);

  const tone_recommendation = calcTone({ risk_level, record_safe_level });
  const detail_recommendation = calcDetail({ risk_level, record_safe_level, flags });
  const insight_candor_level = calcCandor(risk_level);

  const constraints = buildConstraints(risk_level, record_safe_level);

  // direction_suggestion is ONLY used when user selects "I'm not sure"
  const direction_suggestion = calcDirectionSuggestion({ risk_level, record_safe_level, flags });

  return {
    risk_level,
    record_safe_level,
    direction_suggestion,      // caller/UI decides whether to show
    tone_recommendation,
    detail_recommendation,
    insight_candor_level,
    constraints,

    // debug-friendly (still deterministic)
    _debug: {
      risk_score,
      continuity_bucket: flags.continuity_bucket,
      repeat_flag: flags.repeat_flag,
      exposure: flags.exposure
    }
  };
}

module.exports = { computeEngineDecisions };
