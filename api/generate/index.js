// api/generate/index.js
// ClearBound Generate Endpoint (v1)

import OpenAI from "openai";
import { computeEngine } from "../engine/compute.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { state } = req.body;

    if (!state) {
      return res.status(400).json({ error: "Missing state" });
    }

    // 1. Run engine
    const engine = computeEngine(state);

    // 2. Resolve tone & detail
    const tone =
      state.tone || engine.tone_recommendation.value;

    const detail =
      state.detail || engine.detail_recommendation.value;

    // 3. Prompt (temporary inline)
    const prompt = `
You are generating a ${state.paywall?.package || "message"}.

Tone: ${tone}
Detail: ${detail}

User Situation:
${state.situation?.facts}

Strategic Direction: ${state.direction}
Strategic Move: ${state.strategic_move}

Constraints:
- Avoid accusatory language
- Avoid legal framing
- Keep calm, structured, and composed

Write the output accordingly.
`;

    // 4. Call OpenAI
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a professional communication assistant." },
        { role: "user", content: prompt }
      ]
    });

    const text = completion.choices[0].message.content;

    return res.status(200).json({
      ok: true,
      engine,
      output: {
        text
      }
    });
  } catch (err) {
    console.error("GENERATE_ERROR", err);
    return res.status(500).json({
      ok: false,
      error: "GENERATION_FAILED"
    });
  }
}
