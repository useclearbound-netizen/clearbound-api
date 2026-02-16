// api/engine/index.js
// ClearBound Engine Endpoint

import { computeEngine } from "./compute.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const state = req.body;

    if (!state) {
      return res.status(400).json({ error: "Missing state payload" });
    }

    const engineOutput = computeEngine(state);

    return res.status(200).json({
      ok: true,
      engine: engineOutput
    });
  } catch (err) {
    console.error("ENGINE_ERROR", err);
    return res.status(500).json({
      ok: false,
      error: "ENGINE_FAILED"
    });
  }
}
