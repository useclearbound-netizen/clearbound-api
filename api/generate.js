/* =========================================================
   ClearBound vNext — generate.js (FINAL)
   Role: Execution Orchestrator (Single Authority)
   - paywall.package = execution switch
   - output filtering is SERVER-SIDE ONLY
   - NO legacy compatibility
   ========================================================= */

import fetch from "node-fetch";

/* =========================
   Config
   ========================= */
const PROMPTS_BASE =
  "https://raw.githubusercontent.com/useclearbound-netizen/clearbound-vnext/main/prompts";

const TIMEOUT_MS = 15000;

/* =========================
   Helpers
   ========================= */
function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promise.finally(() => clearTimeout(t));
}

async function fetchText(url) {
  const res = await withTimeout(fetch(url), TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`FETCH_FAIL:${res.status}:${url}`);
  }
  return res.text();
}

async function callLLM({ system, user }) {
  // 🔒 실제 LLM 호출부 (이미 기존 구현 있음)
  // 이 함수는 기존 OpenAI / provider wrapper를 그대로 사용
  return globalThis.callLLM({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
}

/* =========================
   Prompt Loaders
   ========================= */
async function loadLayer1Prompt() {
  return fetchText(`${PROMPTS_BASE}/layer1/layer1_control.prompt.md`);
}

async function loadMessagePrompt() {
  return fetchText(`${PROMPTS_BASE}/layer2/message.prompt.md`);
}

async function loadEmailPrompt() {
  return fetchText(`${PROMPTS_BASE}/layer2/email.prompt.md`);
}

async function loadAnalysisPrompt() {
  return fetchText(`${PROMPTS_BASE}/layer2/analysis.prompt.md`);
}

/* =========================
   Canonical Builder
   ========================= */
function buildCanonical(state) {
  if (!state?.context?.text) {
    throw new Error("INVALID_STATE:context.text required");
  }

  return {
    relationship_axis: state.relationship?.value ?? null,
    risk: {
      impact: state.context?.risk_scan?.impact ?? null,
      continuity: state.context?.risk_scan?.continuity ?? null
    },
    situation_type: state.context?.situation_type ?? null,
    facts: state.context?.key_facts ?? "",
    facts_clean: state.context?.key_facts ?? "",
    main_concerns: state.context?.main_concerns ?? [],
    constraints: state.context?.constraints ?? [],
    intent: state.intent?.value ?? null,
    tone: state.tone?.value ?? null,
    depth: state.context?.depth ?? "standard",
    package: state.context?.paywall?.package ?? null
  };
}

/* =========================
   Layer 1 (Internal Control)
   ========================= */
async function runLayer1(canonical) {
  const system = await loadLayer1Prompt();
  const raw = await callLLM({
    system,
    user: JSON.stringify({ canonical })
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LAYER1_OUTPUT_NOT_JSON");
  }

  if (!parsed.layer1) {
    throw new Error("LAYER1_MISSING_OBJECT");
  }

  return parsed.layer1;
}

/* =========================
   Execution Paths
   ========================= */
async function runMessage({ canonical, layer1 }) {
  const system = await loadMessagePrompt();
  const text = await callLLM({
    system,
    user: JSON.stringify({ canonical, layer1 })
  });

  return {
    package: "message",
    message_text: text
  };
}

async function runEmail({ canonical, layer1 }) {
  const system = await loadEmailPrompt();
  const text = await callLLM({
    system,
    user: JSON.stringify({ canonical, layer1 })
  });

  return {
    package: "email",
    email_text: text
  };
}

async function runAnalysis({ canonical, layer1 }) {
  const system = await loadAnalysisPrompt();
  const text = await callLLM({
    system,
    user: JSON.stringify({ canonical, layer1 })
  });

  return text;
}

/* =========================
   Main Handler
   ========================= */
export async function generate(state) {
  const pkg = state?.context?.paywall?.package;
  if (!pkg) {
    throw new Error("NO_PACKAGE_SELECTED");
  }

  const canonical = buildCanonical(state);
  const layer1 = await runLayer1(canonical);

  // 🔑 EXECUTION SWITCH (ONLY SOURCE OF TRUTH)
  switch (pkg) {
    case "message": {
      return await runMessage({ canonical, layer1 });
    }

    case "email": {
      return await runEmail({ canonical, layer1 });
    }

    case "analysis_message": {
      const analysis = await runAnalysis({ canonical, layer1 });
      const msg = await runMessage({ canonical, layer1 });
      return {
        package: "analysis_message",
        analysis_report: analysis,
        message_text: msg.message_text
      };
    }

    case "analysis_email": {
      const analysis = await runAnalysis({ canonical, layer1 });
      const email = await runEmail({ canonical, layer1 });
      return {
        package: "analysis_email",
        analysis_report: analysis,
        email_text: email.email_text
      };
    }

    case "total": {
      const analysis = await runAnalysis({ canonical, layer1 });
      const msg = await runMessage({ canonical, layer1 });
      const email = await runEmail({ canonical, layer1 });
      return {
        package: "total",
        analysis_report: analysis,
        message_text: msg.message_text,
        email_text: email.email_text
      };
    }

    default:
      throw new Error(`UNKNOWN_PACKAGE:${pkg}`);
  }
}
