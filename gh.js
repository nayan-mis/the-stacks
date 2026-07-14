// Minimal wrapper around the GitHub Contents API.
// Used so the editor can commit new posts / manifest updates directly to
// the same repo that GitHub Pages serves — no backend, no cost.

const GH_CONFIG_KEY = "stacks-gh-config";

function ghGetConfig() {
  try {
    return JSON.parse(localStorage.getItem(GH_CONFIG_KEY) || "null");
  } catch (e) {
    return null;
  }
}

function ghSetConfig(cfg) {
  localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(cfg));
}

function ghIsConfigured() {
  const c = ghGetConfig();
  return !!(c && c.owner && c.repo && c.token);
}

// UTF-8 safe base64 encode/decode (atob/btoa alone mangle non-ASCII text)
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function b64DecodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghApiFetch(path, options = {}) {
  const cfg = ghGetConfig();
  if (!cfg) throw new Error("GitHub not configured — open Settings first.");
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

// Returns { content: string, sha: string } or null if the file doesn't exist yet
async function ghGetFile(path) {
  const cfg = ghGetConfig();
  const branch = (cfg && cfg.branch) || "main";
  const res = await ghApiFetch(`${path}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}) for ${path}`);
  const data = await res.json();
  return { content: b64DecodeUtf8(data.content), sha: data.sha };
}

// Creates the file if it doesn't exist, or updates it if it does (sha optional —
// will be looked up automatically if not passed).
async function ghPutFile(path, contentString, message, knownSha) {
  const cfg = ghGetConfig();
  const branch = (cfg && cfg.branch) || "main";

  let sha = knownSha;
  if (sha === undefined) {
    const existing = await ghGetFile(path);
    sha = existing ? existing.sha : undefined;
  }

  const res = await ghApiFetch(path, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: b64EncodeUtf8(contentString),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${body}`);
  }
  return res.json();
}
