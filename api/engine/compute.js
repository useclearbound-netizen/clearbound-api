/**
 * ClearBound Engine Compute (v3.0 baseline)
 * Deterministic decision logic.
 */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function mapContinuity(v) {
  // v2: high | mid | low  (Will you need to deal again?)
  // v3 expects: one_time | short_term | ongoing
  if (v === "high") return "ongoing";
  if (v === "mid") return "short_term";
  return "one_time";
}

function weightContinuity(c) {
  // v3 weights: one_time 0, short_term 1, ongoing 2
  if (c === "ongoing") return 2;
  if (c === "short_term") return 1;
  return 0;
}

function calcRiskLevel(score) {
  // v3 mapping: 0–2 low, 3–5 moderate, 6+ high
  if (score >= 6) return "high";
  if (score >= 3) return "moderate";
  return "low";
}

function calcRecordSafeLevel({ documentation_sensitivity, reputation_impact }) {
  // v3:
  // if documentation_sensitivity -> 2
  // elif reputation_impact -> 1
  // else -> 0
  if (documentation_sensitivity) return 2;
  if (reputation_impact) return 1;
  return 0;
}

function toneRecommendation({ risk_level, record_safe_level }) {
  // v3 baseline:
  // if record_safe_level == 2 -> formal
  // elif risk_level == high -> neutral
  // elif risk_level == moderate -> neutral
  // else -> calm
  if (record_safe_level === 2) return "formal";
  if (risk_level === "high") return "neutral";
  if (risk_level === "moderate") return "neutral";
  return "calm";
}

function detailRecommendation({ risk_level, record_safe_level, ongoing_flag }) {
  // v3 baseline:
  // if record_safe_level == 2 -> detailed
  // elif risk_level >= moderate or ongoing_flag -> standard
  // else -> concise
  if (record_safe_level === 2) return "detailed";
  if (risk_level === "high" || risk_level === "moderate" || ongoing_flag) return "standard";
  return "concise";
}

function candorLevel(risk_level) {
  // v3 table
  if (risk_level === "high") return "high";
  if (risk_level === "moderate") return "moderate";
  return "low";
}

function directionSuggestion({ risk_level, record_safe_level, continuity, repeat_flag, leverage_flag, ongoing_flag }) {
  // v3 baseline logic
  if (risk_level === "low" && continuity === "one_time" && !repeat_flag) return "maintain";
  if (record_safe_level === 2 && leverage_flag && ongoing_flag && repeat_flag) return "disengage";
  return "reset";
}

function buildReasonSignals(kind) {
  // LOCK lexicon: must include plural "signals"
  // Keep reasons short and context-only (we won’t enforce exact word counts here).
  if (kind === "direction") return "Based on continuity and documentation signals, this aligns with the present context.";
  if (kind === "tone") return "Selected from documentation and interaction signals.";
  if (kind === "detail") return "Selected from continuity and interaction signals.";
  return "Based on interaction signals.";
}

/**
 * compute(state)
 * Accepts front “wizard state” (your v2 structure).
 * Returns fixed engine output contract.
 */
function compute(state = {}) {
  const continuity_raw = state?.risk_scan?.continuity || null;
  const continuity = mapContinuity(continuity_raw);
  const continuity_weight = weightContinuity(continuity);

  // v2 “repeat” is in main_concerns
  const main_concerns = Array.isArray(state?.context_builder?.main_concerns)
    ? state.context_builder.main_concerns
    : [];

  const repeat_flag = main_concerns.includes("repeat"); // happened_before proxy
  const doc_flag = main_concerns.includes("document");  // documentation_sensitivity proxy

  // v2 “impact” = could have consequences later? high/low
  const impact_raw = state?.risk_scan?.impact || null;
  const reputation_impact = impact_raw === "high"; // proxy

  const ongoing_flag = continuity === "ongoing";
  const leverage_flag = false; // not collected in v2 yet (keep deterministic false)

  // exposure weights (v3 table)
  const repeat_weight = repeat_flag ? 1 : 0;
  const reputation_weight = reputation_impact ? 2 : 0;
  const documentation_weight = doc_flag ? 2 : 0;
  const leverage_weight = leverage_flag ? 3 : 0;

  const risk_score = continuity_weight + repeat_weight + reputation_weight + documentation_weight + leverage_weight;
  const risk_level = calcRiskLevel(risk_score);

  const record_safe_level = calcRecordSafeLevel({
    documentation_sensitivity: doc_flag,
    reputation_impact
  });

  const tone_recommendation = toneRecommendation({ risk_level, record_safe_level });
  const detail_recommendation = detailRecommendation({ risk_level, record_safe_level, ongoing_flag });
  const insight_candor_level = candorLevel(risk_level);

  const constraints = {
    tone_soften_if_high_risk: risk_level === "high",
    record_safe_mode: record_safe_level === 2,
    forbidden_patterns_enabled: true
  };

  // direction_suggestion shown only when user selects "I'm not sure"
  // v2 doesn’t collect that yet, so compute it but allow caller to hide it.
  const suggested_direction = directionSuggestion({
    risk_level,
    record_safe_level,
    continuity,
    repeat_flag,
    leverage_flag,
    ongoing_flag
  });

  return {
    risk_level,
    record_safe_level,
    direction_suggestion: suggested_direction,
    tone_recommendation,
    detail_recommendation,
    insight_candor_level,
    constraints,

    // debug-safe internals (optional; you can remove later)
    _debug: {
      continuity,
      risk_score: clamp(risk_score, 0, 99),
      flags: { ongoing_flag, repeat_flag, leverage_flag, doc_flag, reputation_impact }
    },

    reasons: {
      direction: buildReasonSignals("direction"),
      tone: buildReasonSignals("tone"),
      detail: buildReasonSignals("detail")
    }
  };
}

module.exports = { compute };
