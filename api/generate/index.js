const { compute, fetchPrompt } = require("../engine");

function json(res, status, body, origin) {
  res.statusCode = status;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getAllowedOrigin(req) {
  const allow = process.env.ALLOW_ORIGIN;
  const origin = req.headers.origin;
  if (!allow || !origin) return null;
  return origin === allow ? origin : null;
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function selectModel(engineOut, wantAnalysis) {
  // You renamed env keys already:
  // MODEL_DEFAULT, MODEL_HIGH_RISK, MODEL_ANALYSIS
  const def = process.env.MODEL_DEFAULT || "gpt-4.1-mini";
  const hi = process.env.MODEL_HIGH_RISK || "gpt-4.1";
  const ana = process.env.MODEL_ANALYSIS || "gpt-4.1";

  if (wantAnalysis) return ana;
  if (engineOut?.risk_level === "high") return hi;
  return def;
}

function pickPromptPath(packageName, includeAnalysis) {
  // clearbound-prompts repo paths (you already started):
  // prompts/v1/message.prompt.md
  // prompts/v1/email.prompt.md
  // prompts/v1/insight.prompt.md
  if (packageName === "email") return "prompts/v1/email.prompt.md";
  if (packageName === "bundle") return "prompts/v1/email.prompt.md"; // primary = email; can produce both
  return "prompts/v1/message.prompt.md"; // default
}

async function callOpenAI({ model, system, user }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY env missing");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: user }] }
      ],
      // keep it stable + fast
      temperature: 0.6,
      max_output_tokens: 900
    })
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI error ${resp.status}: ${raw.slice(0, 400)}`);
  }

  const json = JSON.parse(raw);

  // responses API: try common places
  const text =
    json.output_text ||
    json?.output?.[0]?.content?.[0]?.text ||
    "";

  return { text, raw_json: json };
}

module.exports = async (req, res) => {
  const origin = getAllowedOrigin(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 403;
    return res.end("forbidden");
  }

  if (!origin) {
    return json(res, 403, { ok: false, error: "FORBIDDEN_ORIGIN" }, null);
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }, origin);
  }

  try {
    const body = await readJson(req);

    // Expecting: { state: <front-state> } OR body itself is state
    const state = body?.state || body || {};
    const pkg = state?.paywall?.package || "message";
    const includeAnalysis = !!state?.paywall?.include_analysis;

    // 1) Engine compute
    const engineOut = compute(state);

    // 2) Prompt load
    const promptPath = pickPromptPath(pkg, includeAnalysis);
    const prompt = await fetchPrompt(promptPath);

    // 3) Build inputs for prompt
    const userFacts = (state?.context_builder?.key_facts || "").trim();
    const situationType = state?.context_builder?.situation_type || null;
    const constraints = Array.isArray(state?.context_builder?.constraints) ? state.context_builder.constraints : [];
    const intent = state?.intent || null;
    const tone = state?.tone || null;
    const depth = state?.depth || null;

    if (!userFacts) {
      return json(res, 400, { ok: false, error: "MISSING_FACTS" }, origin);
    }

    const model = selectModel(engineOut, includeAnalysis);

    const system = [
      "You are ClearBound.",
      "Do not provide advice or predictions.",
      "Return only the requested output format.",
      "No legal language. No alarmist vocabulary."
    ].join("\n");

    // IMPORTANT: prompt file will decide exact output schema.
    // We pass a single JSON payload as user message.
    const user = JSON.stringify({
      package: pkg,
      include_analysis: includeAnalysis,
      input: {
        situation_type: situationType,
        facts: userFacts,
        intent,
        tone,
        depth,
        constraints
      },
      engine: engineOut
    }, null, 2);

    // 4) Call OpenAI with (system + prompt + payload)
    const mergedSystem = `${system}\n\n---\nPROMPT:\n${prompt}`;
    const out = await callOpenAI({ model, system: mergedSystem, user });

    // 5) Return (for now: raw text; later: parse into message/email/analysis keys)
    return json(res, 200, {
      ok: true,
      data: {
        model,
        engine: engineOut,
        result_text: out.text
      }
    }, origin);

  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: "GENERATION_FAILED",
      message: e?.message || String(e)
    }, origin);
  }
};
