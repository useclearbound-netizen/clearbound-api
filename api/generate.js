export default async function handler(req, res) {
  const allowOrigin = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 작은 헬퍼: 에러를 단계별로 식별
  const fail = (status, stage, extra = {}) =>
    res.status(status).json({ ok: false, stage, ...extra });

  try {
    const { state } = req.body || {};
    if (!state || typeof state !== "object") {
      return fail(400, "validate_body", { error: "Missing or invalid `state` object" });
    }

    const required = ["relationship", "target", "intent", "tone", "format", "context"];
    const missing = required.filter((k) => !(k in state));
    if (missing.length) {
      return fail(400, "validate_state", { error: `Missing fields: ${missing.join(", ")}` });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const PROMPTS_REPO = process.env.PROMPTS_REPO;
    const PROMPTS_REF = process.env.PROMPTS_REF || "main";

    if (!OPENAI_API_KEY) {
      return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    }
    if (!PROMPTS_REPO) {
      return fail(500, "env", { error: "PROMPTS_REPO missing" });
    }

    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    async function fetchText(url, label) {
      const r = await fetch(url);
      const text = await r.text().catch(() => "");
      if (!r.ok) {
        // 어디 파일이 터졌는지 바로 노출
        throw new Error(`PROMPT_FETCH_FAIL:${label}:${r.status}:${url}:${text.slice(0, 200)}`);
      }
      return text;
    }

    const toneId = String(state.tone?.value || "").toLowerCase();
    const formatId = String(state.format?.value || "").toLowerCase();
    const intentId = String(state.intent?.value || "").toLowerCase();

    if (!toneId || !formatId || !intentId) {
      return fail(400, "validate_ids", {
        error: "Invalid tone / format / intent value",
        details: { toneId, formatId, intentId },
      });
    }

    let tonePrompt, formatPrompt, intentPrompt, normalizePrompt, targetRulesPrompt, assemblePrompt;
    try {
      [
        tonePrompt,
        formatPrompt,
        intentPrompt,
        normalizePrompt,
        targetRulesPrompt,
        assemblePrompt,
      ] = await Promise.all([
        fetchText(ghRaw(`tone/tone.${toneId}.v1.md`), "tone"),
        fetchText(ghRaw(`format/format.${formatId}.v1.md`), "format"),
        fetchText(ghRaw(`intent/intent.${intentId}.v1.md`), "intent"),
        fetchText(ghRaw(`rules/context.normalize.v1.md`), "normalize"),
        fetchText(ghRaw(`rules/target.rules.v1.md`), "target_rules"),
        fetchText(ghRaw(`assemble/assemble.generate.v1.md`), "assemble"),
      ]);
    } catch (e) {
      return fail(502, "prompt_fetch", { error: String(e?.message || e) });
    }

    const system = [
      "Return ONLY the final message.",
      "",
      tonePrompt,
      "",
      formatPrompt,
      "",
      intentPrompt,
      "",
      normalizePrompt,
      "",
      targetRulesPrompt,
      "",
      assemblePrompt,
    ].join("\n");

    const user = JSON.stringify(state, null, 2);

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
        max_output_tokens: 700,
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      return fail(502, "openai", { error: "OpenAI failed", details: data });
    }

    const resultText = data?.output_text || "";
    if (!resultText.trim()) {
      return fail(502, "openai_output", { error: "Empty result", details: data });
    }

    return res.status(200).json({ ok: true, result_text: resultText.trim() });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      stage: "server_error",
      error: "Server error",
      details: String(e?.message || e),
    });
  }
}
