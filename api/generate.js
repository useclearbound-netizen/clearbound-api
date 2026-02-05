export default async function handler(req, res) {
  const allowOrigin = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { state } = req.body || {};
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "Missing or invalid `state` object" });
    }

    const required = ["relationship", "target", "intent", "tone", "format", "context"];
    const missing = required.filter((k) => !(k in state));
    if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const PROMPTS_REPO = process.env.PROMPTS_REPO;
    const PROMPTS_REF = process.env.PROMPTS_REF || "main";

    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Server misconfig: OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return res.status(500).json({ error: "Server misconfig: PROMPTS_REPO missing" });

    const ghRaw = (path) => `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    async function fetchText(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Prompt fetch failed ${r.status}: ${url}`);
      return await r.text();
    }

    const toneId = String(state.tone).toLowerCase();
    const formatId = String(state.format).toLowerCase();
    const intentId = String(state.intent).toLowerCase();

    const [
      tonePrompt,
      formatPrompt,
      intentPrompt,
      normalizePrompt,
      targetRulesPrompt,
      assemblePrompt,
    ] = await Promise.all([
      fetchText(ghRaw(`tone/tone.${toneId}.v1.md`)),
      fetchText(ghRaw(`format/format.${formatId}.v1.md`)),
      fetchText(ghRaw(`intent/intent.${intentId}.v1.md`)),
      fetchText(ghRaw(`rules/context.normalize.v1.md`)),
      fetchText(ghRaw(`rules/target.rules.v1.md`)),
      fetchText(ghRaw(`assemble/assemble.generate.v1.md`)),
    ]);

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

    const data = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: "OpenAI failed", details: data });

    const resultText = data?.output_text || "";
    if (!resultText.trim()) return res.status(500).json({ error: "Empty result" });

    return res.status(200).json({ result_text: resultText.trim() });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
}
