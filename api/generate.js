// clearbound-api / api / generate.js
export default async function handler(req, res) {
  const allowOrigin = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-WP-Nonce"
  );

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ========= helpers =========
  const fail = (status, stage, extra = {}) =>
    res.status(status).json({ ok: false, stage, ...extra });

  const safeJson = async (r) => {
    const txt = await r.text().catch(() => "");
    try {
      return { json: JSON.parse(txt), text: txt };
    } catch {
      return { json: null, text: txt };
    }
  };

  const fetchWithTimeout = async (url, ms, opts = {}) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  };

  // Responses API는 output_text가 비어도 정상일 수 있어서,
  // output 배열(message.content[].type === "output_text")까지 안전하게 추출.
  function extractText(resp) {
    if (!resp || typeof resp !== "object") return "";

    const direct = typeof resp.output_text === "string" ? resp.output_text.trim() : "";
    if (direct) return direct;

    const out = Array.isArray(resp.output) ? resp.output : [];
    const texts = [];

    for (const item of out) {
      if (item && item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
            texts.push(c.text.trim());
          }
        }
      }
    }

    return texts.join("\n").trim();
  }

  // ========= main =========
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

    if (!OPENAI_API_KEY) return fail(500, "env", { error: "OPENAI_API_KEY missing" });
    if (!PROMPTS_REPO) return fail(500, "env", { error: "PROMPTS_REPO missing" });

    const ghRaw = (path) =>
      `https://raw.githubusercontent.com/${PROMPTS_REPO}/${PROMPTS_REF}/${path}`;

    async function fetchText(url, label) {
      // GH fetch는 짧게: 8s
      const r = await fetchWithTimeout(url, 8000, { method: "GET" });
      const text = await r.text().catch(() => "");
      if (!r.ok) {
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

    // ---- prompts (parallel) ----
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
      // 프론트가 HTML 502로 오인하지 않게 200 + ok:false 로도 가능하지만,
      // 기존 흐름 유지 위해 502 그대로 둠.
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

    // ---- OpenAI ----
    const openaiResp = await fetchWithTimeout("https://api.openai.com/v1/responses", 30000, {
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

    const { json: data, text: rawText } = await safeJson(openaiResp);

    if (!openaiResp.ok) {
      // OpenAI error body가 JSON이 아닐 때도 대비
      return fail(502, "openai", {
        error: "OpenAI failed",
        status: openaiResp.status,
        details: data || rawText?.slice(0, 1200) || null,
      });
    }

    const resultText = extractText(data);

    // ✅ 핵심: completed인데 output_text 비어있어도 output에서 뽑아냄.
    // 그래도 비면 "모델 결과 없음"으로 처리.
    if (!resultText) {
      // 추천: 502 대신 200으로 내려서 Edge HTML 502 래핑을 피하고 싶다면 status를 200으로 바꾸세요.
      return fail(502, "openai_output", {
        error: "No extractable text",
        // 너무 커지지 않게 최소만
        details: {
          id: data?.id || null,
          status: data?.status || null,
          model: data?.model || null,
          has_output_text: !!data?.output_text,
          output_types: Array.isArray(data?.output) ? data.output.map((x) => x?.type).filter(Boolean) : [],
        },
      });
    }

    return res.status(200).json({ ok: true, result_text: resultText });
  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "Upstream timeout"
        : String(e?.message || e || "Unknown error");

    return res.status(500).json({
      ok: false,
      stage: e?.name === "AbortError" ? "timeout" : "server_error",
      error: msg,
    });
  }
}
