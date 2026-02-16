// engine/compute.js
// ClearBound Engine Logic v3.0 (LOCK) — deterministic compute layer
//
// Input: backendState (from frontend adapter buildBackendState)
// Output (fixed contract):
// 1) risk_level
// 2) record_safe_level
// 3) direction_suggestion (only when user is not sure)
// 4) tone_recommendation
// 5) detail_recommendation
// 6) insight_candor_level
// 7) constraints

function clampInt(n, min, max) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function computeRiskScore({ continuity, repeat_flag, exposure }) {
  // continuity_weight: one_time(0) | short_term(1) | ongoing(2)
  // Front v2 currently uses: high | mid | low
  // We map:
  // - low  -> one_time
  // - mid  -> short_term
  // - high -> ongoing
  let continuity_weight = 0;
  if (continuity === "mid" || continuity === "short_term") continuity_weight = 1;
  if (continuity === "high" || continuity === "ongoing") continuity_weight = 2;

  const repeat_weight = repeat_flag ? 1 : 0;

  // exposure_weight_sum
  // We use either exposure[] (future) OR map from main_concerns (current front)
  const weights = {
    emotional_fallout: 1,
    reputation_impact: 2,
    documentation_sensitivity: 2,
    they_have_leverage: 3
  };

  const exposureArr = Array.isArray(exposure) ? exposure : [];
  const exposure_weight_sum = exposureArr.reduce((sum, key) => sum + (weights[key] || 0), 0);

  return continuity_weight + repeat_weight + exposure_weight_sum;
}

function mapRiskLevel(score) {
  // 0–2 low | 3–5 moderate | 6+ high
  const s = clampInt(score, 0, 999);
  if (s <= 2) return "low";
  if (s <= 5) return "moderate";
  return "high";
}

function computeRecordSafeLevel({ documentation_sensitivity, reputation_impact }) {
  // if documentation_sensitivity -> 2
  // elif reputation_impact -> 1
  // else -> 0
  if (documentation_sensitivity) return 2;
  if (reputation_impact) return 1;
  return 0;
}

function computeTone({ record_safe_level, risk_level }) {
  // if record_safe_level == 2 -> formal
  // elif risk_level == high -> neutral
  // elif risk_level == moderate -> neutral
  // else -> calm
  if (record_safe_level === 2) return "formal";
  if (risk_level === "high") return "neutral";
  if (risk_level === "moderate") return "neutral";
  return "calm";
}

function computeDetail({ record_safe_level, risk_level, ongoing_flag }) {
  // if record_safe_level == 2 -> detailed
  // elif risk_level >= moderate or ongoing_flag -> standard
  // else -> concise
  if (record_safe_level === 2) return "detailed";
  if (risk_level === "high" || risk_level === "moderate" || ongoing_flag) return "standard";
  return "concise";
}

function computeCandor(risk_level) {
  // low -> low | moderate -> moderate | high -> high (with ceiling guard)
  if (risk_level === "high") return "high";
  if (risk_level === "moderate") return "moderate";
  return "low";
}

function computeDirectionSuggestion({ enabled, risk_level, continuity_norm, repeat_flag, record_safe_level, leverage_flag, ongoing_flag }) {
  // Only if user selects "I'm not sure" (enabled == true)
  if (!enabled) return null;

  // Baseline Logic (LOCK)
  // if risk_level == low and continuity == one_time and not repeat_flag -> maintain
  // elif record_safe_level == 2 and leverage_flag and ongoing_flag and repeat_flag -> disengage
  // else -> reset
  const isOneTime = continuity_norm === "one_time";
  if (risk_level === "low" && isOneTime && !repeat_flag) return "maintain";
  if (record_safe_level === 2 && leverage_flag && ongoing_flag && repeat_flag) return "disengage";
  return "reset";
}

function normalizeContinuity(raw) {
  // target values: one_time | short_term | ongoing
  // current front: low | mid | high
  if (raw === "low" || raw === "one_time") return "one_time";
  if (raw === "mid" || raw === "short_term") return "short_term";
  if (raw === "high" || raw === "ongoing") return "ongoing";
  return null;
}

function deriveInternalFlagsFromFront(context) {
  // v3 wants:
  // ongoing_flag, repeat_flag, leverage_flag, doc_flag
  //
  // current front has:
  // - risk_scan.continuity (high/mid/low)
  // - main_concerns[] (cap 2): repeat, roles, impact_work, document, avoid_escalation
  // - constraints[]: no_emotion, no_aggressive, no_ambiguity, no_worse
  //
  // We map:
  // repeat_flag -> main_concerns includes "repeat"
  // doc_flag -> main_concerns includes "document"
  // leverage_flag -> (NOT in front yet) => false for now
  // ongoing_flag -> continuity_norm == ongoing
  const concerns = Array.isArray(context?.main_concerns) ? context.main_concerns : [];
  const continuityRaw = context?.risk_scan?.continuity ?? null;
  const continuity_norm = normalizeContinuity(continuityRaw);

  const repeat_flag = concerns.includes("repeat");
  const doc_flag = concerns.includes("document");
  const leverage_flag = false; // placeholder until UI adds explicit signal
  const ongoing_flag = continuity_norm === "ongoing";

  return { ongoing_flag, repeat_flag, leverage_flag, doc_flag, continuity_norm };
}

function deriveExposureFromFront(context, internalFlags) {
  // v3 exposure[] keys:
  // emotional_fallout, reputation_impact, documentation_sensitivity, they_have_leverage
  //
  // current front does not have these directly.
  // Minimal mapping (safe + deterministic):
  // - documentation_sensitivity: doc_flag
  // - reputation_impact: (not in current front) false
  // - emotional_fallout: (not in current front) false
  // - they_have_leverage: leverage_flag
  //
  // NOTE: risk_scan.impact exists (high/low) but it's not one of v3 exposure keys.
  // We'll keep it as an auxiliary signal for later prompt strategy, but not as exposure weight.
  const exposure = [];
  if (internalFlags.doc_flag) exposure.push("documentation_sensitivity");
  if (internalFlags.leverage_flag) exposure.push("they_have_leverage");
  return exposure;
}

function computeEngineDecisions(backendState) {
  const context = backendState?.context || {};
  const internal = deriveInternalFlagsFromFront(context);

  const exposure = deriveExposureFromFront(context, internal);

  // risk score + level
  const risk_score = computeRiskScore({
    continuity: (context?.risk_scan?.continuity ?? null),
    repeat_flag: internal.repeat_flag,
    exposure
  });

  const risk_level = mapRiskLevel(risk_score);

  // record_safe_level
  const documentation_sensitivity = internal.doc_flag; // current UI mapping
  const reputation_impact = false; // placeholder until UI adds it
  const record_safe_level = computeRecordSafeLevel({ documentation_sensitivity, reputation_impact });

  // tone/detail/candor
  const tone_recommendation = computeTone({ record_safe_level, risk_level });
  const detail_recommendation = computeDetail({ record_safe_level, risk_level, ongoing_flag: internal.ongoing_flag });
  const insight_candor_level = computeCandor(risk_level);

  // direction suggestion: only if user selected "I'm not sure"
  // (UI needs a boolean; for now read from context.direction_unsure if present)
  const directionEnabled = !!context?.direction_unsure;
  const direction_suggestion = computeDirectionSuggestion({
    enabled: directionEnabled,
    risk_level,
    continuity_norm: internal.continuity_norm,
    repeat_flag: internal.repeat_flag,
    record_safe_level,
    leverage_flag: internal.leverage_flag,
    ongoing_flag: internal.ongoing_flag
  });

  // constraints layer (LOCK)
  const constraints = {
    tone_soften_if_high_risk: risk_level === "high",
    record_safe_mode: record_safe_level === 2,
    forbidden_patterns_enabled: true
  };

  return {
    risk_level,
    record_safe_level,
    direction_suggestion,
    tone_recommendation,
    detail_recommendation,
    insight_candor_level,
    constraints,

    // optional debug (safe to remove later)
    _debug: {
      risk_score,
      continuity_norm: internal.continuity_norm,
      internal_flags: {
        ongoing_flag: internal.ongoing_flag,
        repeat_flag: internal.repeat_flag,
        leverage_flag: internal.leverage_flag,
        doc_flag: internal.doc_flag
      },
      exposure
    }
  };
}

module.exports = { computeEngineDecisions };
