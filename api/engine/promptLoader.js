// api/engine/promptLoader.js
// Loads prompts from GitHub raw with in-memory cache (best-effort for Vercel)

const CACHE = new Map();
// key: `${repo}@${ref}:${path}` -> { at:number, text:string }
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function env(name, fallback = null) {
  const v = process.env[name];
  return (typeof v === "string" && v.trim()) ? v.trim() : fallback;
}

function makeRawUrl({ repo, ref, path }) {
  // repo: "owner/name"
  // ref: "main"
  // path: "prompts/v1/message.prompt.md"
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
}

async function fetchText(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache"
    }
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`PROMPT_FETCH_FAILED ${r.status} ${t.slice(0, 200)}`);
  }
  return await r.text();
}

async function loadPrompt(path, opts = {}) {
  const repo = opts.repo || env("PROMPTS_REPO");
  const ref = opts.ref || env("PROMPTS_REF", "main");
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;

  if (!repo) throw new Error("PROMPTS_REPO missing");
  if (!path) throw new Error("prompt path missing");

  const key = `${repo}@${ref}:${path}`;
  const now = Date.now();

  const cached = CACHE.get(key);
  if (cached && (now - cached.at) < ttlMs) return cached.text;

  const url = makeRawUrl({ repo, ref, path });
  const text = await fetchText(url);

  CACHE.set(key, { at: now, text });
  return text;
}

module.exports = { loadPrompt };
