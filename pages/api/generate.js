// pages/api/generate.js
export default async function handler(req, res) {
  // --- CORS (preflight) ---
  const allowOrigin = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { state } = req.body || {};
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "Missing or invalid `state` object" });
    }

    // --- minimal required fields check (adjust later) ---
    const required = ["relationship", "target", "intent", "tone", "format", "context"];
    const missing = required.filter((k) => !(k in state));
    if (missing.length) {
      return res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const PROMPTS_REPO = process.env.PROMPTS_REPO;
    const PROMPTS_REF = process.env.PROMPTS_REF || "main";

    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Server misconfig: OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return res.status(500).json({ error: "Server misconfig: PROMPTS_REPO missing" });

    // --- helpers ---
    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    async function fetchText(url) {
      const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
      if (!r.ok) throw new Error(`Prompt fetch failed ${r.status}: ${url}`);
      return await r.text();
    }

    // --- map state to prompt files ---
    const toneId = String(state.tone || "").toLowerCase();       // soft|neutral|firm
    const formatId = String(state.format || "").toLowerCase();   // email|message
    const intentId = String(state.intent || "").toLowerCase();   // request|follow_up|...

    const tonePath = `tone/tone.${toneId}.v1.md`;
    const formatPath = `format/format.${formatId}.v1.md`;
    const intentPath = `intent/intent.${intentId}.v1.md`;

    const normalizePath = `rules/context.normalize.v1.md`;
    const targetRulesPath = `rules/target.rules.v1.md`;
    const assemblePath = `assemble/assemble.generate.v1.md`;

    // --- load prompt pieces from GitHub ---
    const [
      tonePrompt,
      formatPrompt,
      intentPrompt,
      normalizePrompt,
      targetRulesPrompt,
      assemblePrompt,
    ] = await Promise.all([
      fetchText(ghRaw(tonePath)),
      fetchText(ghRaw(formatPath)),
      fetchText(ghRaw(intentPath)),
      fetchText(ghRaw(normalizePath)),
      fetchText(ghRaw(targetRulesPath)),
      fetchText(ghRaw(assemblePath)),
    ]);

    // --- assemble final system/user message ---
    const system = [
      "You are ClearBound, a writing engine that produces one ready-to-send message.",
      "Return ONLY the final message. No headings, no analysis, no extra notes.",
      "",
      "== TONE ==",
      tonePrompt,
      "",
      "== FORMAT ==",
      formatPrompt,
      "",
      "== INTENT ==",
      intentPrompt,
      "",
      "== NORMALIZATION RULES ==",
      normalizePrompt,
      "",
      "== TARGET RULES ==",
      targetRulesPrompt,
      "",
      "== ASSEMBLY RULES ==",
      assemblePrompt,
    ].join("\n");

    const user = [
      "INPUT_STATE (JSON):",
      JSON.stringify(state, null, 2),
    ].join("\n");

    // --- OpenAI call (Responses API) ---
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // 안전한 기본: 모델은 나중에 바꿔도 됨
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
        max_output_tokens: 700,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return res.status(500).json({ error: "OpenAI request failed", details: errText.slice(0, 2000) });
    }

    const data = await resp.json();

    // Responses API output text extraction (robust)
    const resultText =
      data?.output_text ||
      data?.output?.map((o) => o?.content?.map((c) => c?.text).join("")).join("\n") ||
      "";

    if (!resultText.trim()) {
      return res.status(500).json({ error: "Empty result from model" });
    }

    return res.status(200).json({ result_text: resultText.trim() });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
}
