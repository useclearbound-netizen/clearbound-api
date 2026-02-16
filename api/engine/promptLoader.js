// api/engine/promptLoader.js
// Loads prompts from GitHub raw with in-memory cache (Vercel best-effort)
// Ops hardening: timeout + bounded cache + ref safety + basic retry/backoff

const CACHE = new Map();
// key: `${repo}@${ref}:${path}` -> { at:number, text:string, etag?:string }
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Hard bounds to prevent unbounded memory growth on long-lived warm instances
const MAX_CACHE_ENTRIES = 60;
const MAX_PROMPT_BYTES = 200_000; // safety cap (prompts should be far smaller)

function env(name, fallback = null) {
  const v = process.env[name];
  return (typeof v === "string" && v.trim()) ? v.trim() : fallback;
}

function makeRawUrl({ repo, ref, path }) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
}

function assertSafeRef(ref) {
  // Allow common branch names, tags, and 40-char commit SHAs.
  // Disallow whitespace and suspicious chars.
  const r = String(ref || "").trim();
  if (!r) throw new Error("PROMPTS_REF missing");
  if (/\s/.test(r)) throw new Error("PROMPTS_REF invalid");
  if (!/^[A-Za-z0-9._\-\/]+$/.test(r)) throw new Error("PROMPTS_REF invalid");
  return r;
}

function assertSafePath(path) {
  const p = String(path || "").trim();
  if (!p) throw new Error("prompt path missing");
  if (p.includes("..")) throw new Error("prompt path invalid");
  if (p.startsWith("/") || p.startsWith("\\")) throw new Error("prompt path invalid");
  return p;
}

function boundedCacheSet(key, value) {
  // Simple LRU-ish: delete oldest by `at`
  if (CACHE.size >= MAX_CACHE_ENTRIES && !CACHE.has(key)) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of CACHE.entries()) {
      if (v?.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) CACHE.delete(oldestKey);
  }
  CACHE.set(key, value);
}

async function fetchTextWithTimeout(url, { timeoutMs = 4500, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "GET",
      signal: ac.signal,
      headers: {
        // Keep it simple; GitHub raw will cache on its side anyway.
        ...headers
      }
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) {
      throw new Error(`PROMPT_FETCH_FAILED ${r.status} ${raw.slice(0, 200)}`);
    }

    if (Buffer.byteLength(raw, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error("PROMPT_TOO_LARGE");
    }

    const etag = r.headers?.get?.("etag") || null;
    return { text: raw, etag };
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, { attempts = 2, timeoutMs = 4500, headers = {} } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchTextWithTimeout(url, { timeoutMs, headers });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const isAbort = msg.includes("aborted") || msg.includes("AbortError");
      const isRetryable = isAbort || msg.includes("429") || msg.includes("502") || msg.includes("503") || msg.includes("504");
      if (i < attempts - 1 && isRetryable) {
        // tiny backoff
        await sleep(120 + i * 180);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function loadPrompt(path, opts = {}) {
  const repo = opts.repo || env("PROMPTS_REPO");
  const ref = assertSafeRef(opts.ref || env("PROMPTS_REF", "main"));
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;

  if (!repo) throw new Error("PROMPTS_REPO missing");

  const safePath = assertSafePath(path);

  const key = `${repo}@${ref}:${safePath}`;
  const now = Date.now();

  const cached = CACHE.get(key);
  if (cached && (now - cached.at) < ttlMs) return cached.text;

  const url = makeRawUrl({ repo, ref, path: safePath });

  // Optional conditional request if we have an etag (saves bandwidth, faster on warm)
  const headers = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  // Note: raw.githubusercontent.com returns 304 with empty body when etag matches.
  // fetch().text() on 304 might be empty; we handle by reusing cache if 304 occurs.
  let fetched;
  try {
    fetched = await fetchWithRetry(url, { attempts: 2, timeoutMs: 4500, headers });
  } catch (e) {
    // If remote fetch fails but we have any cached value, return it (best-effort).
    if (cached?.text) return cached.text;
    throw e;
  }

  // If fetched text is empty but we had cached text, keep cached (rare edge)
  const text = (typeof fetched?.text === "string" && fetched.text.length)
    ? fetched.text
    : (cached?.text || "");

  if (!text) {
    // no cached fallback and empty fetch
    throw new Error("PROMPT_EMPTY");
  }

  boundedCacheSet(key, {
    at: now,
    text,
    etag: fetched?.etag || cached?.etag || null
  });

  return text;
}

module.exports = { loadPrompt };
