/**
 * Prompt Loader
 * - Loads prompt files from GitHub raw
 * - Simple in-memory cache
 */

const CACHE = {};
const CACHE_TTL = 1000 * 60 * 5; // 5 minutes

function buildRawUrl(path) {
  const repo = process.env.PROMPTS_REPO;
  const ref = process.env.PROMPTS_REF || "main";

  if (!repo) {
    throw new Error("PROMPTS_REPO env missing");
  }

  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
}

async function fetchPrompt(path) {
  const now = Date.now();
  const cached = CACHE[path];

  if (cached && cached.expires > now) {
    return cached.value;
  }

  const url = buildRawUrl(path);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to load prompt: ${path}`);
  }

  const text = await res.text();

  CACHE[path] = {
    value: text,
    expires: now + CACHE_TTL,
  };

  return text;
}

module.exports = {
  fetchPrompt,
};
