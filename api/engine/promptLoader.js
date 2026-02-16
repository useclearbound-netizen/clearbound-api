// engine/promptLoader.js

const CACHE = {};
const TTL = 1000 * 60 * 5; // 5 minutes

function rawUrl(repo, branch, path) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

async function fetchPrompt({ repo, branch, path }) {
  const key = `${repo}:${branch}:${path}`;
  const now = Date.now();

  if (CACHE[key] && (now - CACHE[key].time < TTL)) {
    return CACHE[key].value;
  }

  const url = rawUrl(repo, branch, path);

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Prompt fetch failed: ${path}`);
  }

  const text = await res.text();

  CACHE[key] = {
    value: text,
    time: now
  };

  return text;
}

module.exports = { fetchPrompt };
