// api/engine/compute.js
// ClearBound Engine Logic v3.0 (LOCK-aligned, deterministic)
// - Backward-compatible with current V2 front shape
// - Forward-compatible with V3-native fields (continuity / happened_before / exposure[])

function clampStr(v) {
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function normToken(v) {
  const s = clampStr(v);
  return s ? s.toLowerCase() : null;
}

function normTokens(arr) {
  return asArray(arr).map(normToken).filter(Boolean);
}

/**
 * Normalization Policy
 * Accept BOTH:
 * A) Current front (V2-ish):
 *  - risk_scan.impact: high|low
 *  - risk_scan.continuity: high|mid|low
 *  - main_concerns: ["repeat","impact_work","document",...]
 *  - situation_type: say_no|push_back|clarify_correct|set_boundary|official_documented
 *
 * B) V3-native (future-proof):
 *  - continuity: one_time|short_term|ongoing
 *  - happened_before: boolean
 *  - exposure: ["emotional_fallout","reputation_impact","documentation_sensitivity","they_have_leverage"]
 *  - leverage_flag: boolean (optional)
 */
function normalizeFlags(input) {
  const risk_scan = input?.risk_scan || {};
  const impact = normToken(risk_scan.impact);         // high|low
  const contRaw = normToken(risk_scan.continuity);    // high|mid|low

  const situation_type = normToken(input?.situation_type);

  const concerns = normTokens(input?.main_concerns);
  const constraints = normTokens(input?.constraints);

  // V3-native fields (optional)
  const continuityV3 = normToken(input?.continuity); // one_time|short_term|ongoing
  const happened_before = (typeof input?.happened_before === "boolean") ? input.happened_before : null;
  const exposureV3 = normTokens(input?.exposure);    // array of exposure keys (v3)
  const leverage_flag_v3 = (typeof input?.leverage_flag === "boolean") ? input.leverage_flag : null;

  // continuity mapping:
  // - Prefer V3-native continuity if present
  // - Else map from current UI continuity: high->ongoing, mid->short_term, low->one_time
  const continuity_bucket =
    (continuityV3 === "ongoing" || continuityV3 === "short_term" || continuityV3 === "one_time")
      ? continuityV3
      : (contRaw === "high" ? "ongoing" :
         contRaw === "mid"  ? "short_term" :
         contRaw === "low"  ? "one_time" : null);

  const ongoing_flag = continuity_bucket === "ongoing";

  // repeat_flag:
  // - Prefer happened_before boolean if present
  // - Else fall back to concerns
  const repeat_flag =
    (happened_before === true) ? true :
    (happened_before === false) ? false :
    concerns.includes("repeat");

  // leverage flag:
  // - Prefer explicit leverage_flag
  // - Else map from concerns (future UI may add)
  const leverage_flag =
    (leverage_flag_v3 === true) ? true :
    (leverage_flag_v3 === false) ? false :
    concerns.includes("leverage") || concerns.includes("they_have_leverage");

  // exposure flags:
  // Prefer explicit V3 exposure[] if present; otherwise approximate from current UI.
  const exposureKeys = new Set(exposureV3);

  const documentation_sensitivity =
    exposureKeys.has("documentation_sensitivity") ||
    concerns.includes("document") ||
    situation_type === "official_documented";

  const reputation_impact =
    exposureKeys.has("reputation_impact") ||
    concerns.includes("reputation") ||
    // v2 proxy (대표님 주석 그대로 유지)
    concerns.includes("impact_work");

  const emotional_fallout =
    exposureKeys.has("emotional_fallout") ||
    // v2 proxy
    impact === "high";

  const they_have_leverage =
    exposureKeys.has("they_have_leverage") ||
    leverage_flag;

  const exposure = {
    emotional_fallout,
    reputation_impact,
    documentation_sensitivity,
    they_have_leverage
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
  // Weights MUST match v3.0 spec
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
    flags.continuity_bucket ? (weights[flags.continuity_bucket] || 0) : 0;

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
  // v3.0 spec
  if (flags.documentation_sensitivity) return 2;
  if (flags.reputation_impact) return 1;
  return 0;
}

function calcDirectionSuggestion({ risk_level, record_safe_level, flags }) {
  // v3.0 spec baseline logic
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
  // v3.0 spec
  if (record_safe_level === 2) return "formal";
  if (risk_level === "high") return "neutral";
  if (risk_level === "moderate") return "neutral";
  return "calm";
}

function calcDetail({ risk_level, record_safe_level, flags }) {
  // v3.0 spec
  if (record_safe_level === 2) return "detailed";
  if (risk_level === "moderate" || risk_level === "high" || flags.ongoing_flag) return "standard";
  return "concise";
}

function calcCandor(risk_level) {
  // v3.0 spec
  if (risk_level === "high") return "high";
  if (risk_level === "moderate") return "moderate";
  return "low";
}

function buildConstraints(risk_level, record_safe_level) {
  // v3.0 spec
  return {
    tone_soften_if_high_risk: risk_level === "high",
    record_safe_mode: record_safe_level === 2,
    forbidden_patterns_enabled: true
  };
}

/**
 * Main compute() exported.
 * Signature is backward-compatible:
 * - computeEngineDecisions(input) works as before
 * - Optional opts can be used later without changing callers.
 */
function computeEngineDecisions(input, opts = {}) {
  const flags = normalizeFlags(input);
  const risk_score = calcRiskScore(flags);
  const risk_level = mapRiskLevel(risk_score);
  const record_safe_level = calcRecordSafeLevel(flags);

  const tone_recommendation = calcTone({ risk_level, record_safe_level });
  const detail_recommendation = calcDetail({ risk_level, record_safe_level, flags });
  const insight_candor_level = calcCandor(risk_level);

  const constraints = buildConstraints(risk_level, record_safe_level);

  // v3.0 doc says: only show when user selects "I'm not sure".
  // BUT current API uses it to stabilize prompt posture ("direction").
  // Default keeps compatibility; later you can pass { include_direction_suggestion:false } if needed.
  const includeDir =
    (typeof opts.include_direction_suggestion === "boolean")
      ? opts.include_direction_suggestion
      : true;

  const direction_suggestion = includeDir
    ? calcDirectionSuggestion({ risk_level, record_safe_level, flags })
    : null;

  return {
    risk_level,
    record_safe_level,
    direction_suggestion,
    tone_recommendation,
    detail_recommendation,
    insight_candor_level,
    constraints,

    // debug-friendly (still deterministic). If you later want to hide in prod response,
    // remove in api/generate output instead of here.
    _debug: {
      risk_score,
      continuity_bucket: flags.continuity_bucket,
      repeat_flag: flags.repeat_flag,
      leverage_flag: flags.leverage_flag,
      exposure: flags.exposure
    }
  };
}

module.exports = { computeEngineDecisions };
