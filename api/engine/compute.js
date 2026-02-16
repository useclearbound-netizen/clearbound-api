// api/engine/compute.js
// ClearBound Engine Core — v1
// Deterministic decision layer (no generation)

export function computeEngine(state) {
  const situation = state?.situation || {};

  const offSignals = situation.off_signals || [];
  const scope = situation.relationship_scope || null;

  /* ----------------------------------------
     Flags
  ---------------------------------------- */
  const repeatFlag = offSignals.includes("keeps_repeating");
  const leverageFlag = offSignals.includes("power_uneven");
  const docFlag =
    offSignals.includes("reputation_impact") ||
    offSignals.includes("documentation_sensitivity");

  const ongoingFlag =
    scope === "very_important_ongoing" || scope === "important_ongoing";

  /* ----------------------------------------
     Risk Score
  ---------------------------------------- */
  let riskScore = 0;

  if (repeatFlag) riskScore += 1;
  if (leverageFlag) riskScore += 3;
  if (ongoingFlag) riskScore += 2;

  const risk_level =
    riskScore >= 6 ? "high" :
    riskScore >= 3 ? "moderate" :
    "low";

  /* ----------------------------------------
     Record Safe Level
  ---------------------------------------- */
  let record_safe_level = 0;

  if (docFlag) record_safe_level = 2;
  else if (leverageFlag) record_safe_level = 1;

  /* ----------------------------------------
     Direction Recommendation
  ---------------------------------------- */
  let direction_recommendation = { value: null, reason: null };

  if (risk_level === "low" && !repeatFlag) {
    direction_recommendation = {
      value: "maintain",
      reason:
        "Based on interaction signals and continuity profile, maintain aligns with the present context."
    };
  } else if (record_safe_level === 2 && leverageFlag && repeatFlag) {
    direction_recommendation = {
      value: "disengage",
      reason:
        "Based on documentation considerations and interaction signals, disengage aligns with the present context."
    };
  } else {
    direction_recommendation = {
      value: "reset",
      reason:
        "Based on interaction signals and continuity profile, reset aligns with the present context."
    };
  }

  /* ----------------------------------------
     Tone Recommendation
  ---------------------------------------- */
  let tone;

  if (record_safe_level === 2) tone = "formal";
  else if (risk_level === "high") tone = "neutral";
  else tone = "calm";

  const tone_recommendation = {
    value: tone,
    reason: "Based on interaction signals."
  };

  /* ----------------------------------------
     Detail Recommendation
  ---------------------------------------- */
  let detail;

  if (record_safe_level === 2) detail = "detailed";
  else if (risk_level !== "low" || ongoingFlag) detail = "standard";
  else detail = "concise";

  const detail_recommendation = {
    value: detail,
    reason: "Based on continuity signals."
  };

  /* ----------------------------------------
     Insight Candor Level
  ---------------------------------------- */
  const insight_candor_level = risk_level;

  /* ----------------------------------------
     Constraints
  ---------------------------------------- */
  const constraints = {
    tone_soften_if_high_risk: risk_level === "high",
    record_safe_mode: record_safe_level === 2,
    forbidden_patterns_enabled: true
  };

  return {
    risk_level,
    record_safe_level,
    direction_recommendation,
    tone_recommendation,
    detail_recommendation,
    insight_candor_level,
    constraints
  };
}
