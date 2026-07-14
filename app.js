// ============================================================
// state
// ============================================================
let channels = [];
let posts = [];
let activeChannel = null;

// ============================================================
// helpers
// ============================================================
function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "untitled";
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || "").replace(/\s+/g, " ").trim();
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not load ${path}`);
  return res.json();
}

// ============================================================
// rendering — channel sidebar
// ============================================================
function renderChannels() {
  const list = document.getElementById("channels-list");
  if (!list) return;
  list.innerHTML = "";

  channels.forEach((ch) => {
    const count = posts.filter((p) => p.channel === ch.slug).length;
    const card = document.createElement("button");
    card.className = "channel-card";
    card.setAttribute("aria-pressed", String(ch.slug === activeChannel));
    card.innerHTML = `
      <p class="channel-name">${ch.name}</p>
      <p class="channel-desc">${ch.description || ""}</p>
      <p class="channel-count">${count} card${count === 1 ? "" : "s"}</p>
    `;
    card.addEventListener("click", () => {
      activeChannel = ch.slug;
      renderChannels();
      renderFeed();
    });
    list.appendChild(card);
  });
}

// ============================================================
// rendering — post feed for the active channel
// ============================================================
function renderFeed() {
  const feed = document.getElementById("feed");
  const titleEl = document.getElementById("feed-title");
  const descEl = document.getElementById("feed-desc");
  if (!feed) return;

  const ch = channels.find((c) => c.slug === activeChannel);
  if (titleEl) titleEl.textContent = ch ? ch.name : activeChannel;
  if (descEl) descEl.textContent = ch ? ch.description : "";

  const items = posts
    .filter((p) => p.channel === activeChannel)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (items.length === 0) {
    feed.innerHTML = '<p class="empty-state">no cards in this channel yet — hit "+ write" to add one.</p>';
    return;
  }

  feed.innerHTML = items.map((p) => `
    <article class="post-card">
      <span class="stamp-mark">${formatDate(p.date)}</span>
      <h2 class="post-title"><a href="post.html?id=${encodeURIComponent(p.id)}">${p.title}</a></h2>
      <p class="post-excerpt">${p.excerpt}</p>
    </article>
  `).join("");
}

// ============================================================
// init — index page
// ============================================================
async function initApp() {
  const list = document.getElementById("channels-list");
  if (!list) return; // not on index.html

  try {
    [channels, posts] = await Promise.all([fetchJson("channels.json"), fetchJson("posts.json")]);
  } catch (e) {
    channels = [];
    posts = [];
  }

  activeChannel = (channels[0] && channels[0].slug) || null;
  renderChannels();
  renderFeed();
  wireIndexControls();
}

function wireIndexControls() {
  const writeOverlay = document.getElementById("write-overlay");
  const settingsOverlay = document.getElementById("settings-overlay");

  document.getElementById("open-write").addEventListener("click", () => openWrite());
  document.getElementById("cancel-write").addEventListener("click", () => { writeOverlay.hidden = true; });

  document.getElementById("open-settings").addEventListener("click", () => openSettings());
  document.getElementById("cancel-settings").addEventListener("click", () => { settingsOverlay.hidden = true; });
  document.getElementById("save-settings").addEventListener("click", saveSettings);

  document.getElementById("new-channel-btn").addEventListener("click", createChannel);
  document.getElementById("publish-btn").addEventListener("click", publishPost);

  document.querySelectorAll(".toolbar button[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.value || null;
      document.getElementById("editor-body").focus();
      if (cmd === "createLink") {
        const url = prompt("Link URL:");
        if (url) document.execCommand(cmd, false, url);
      } else {
        document.execCommand(cmd, false, val);
      }
    });
  });

  [writeOverlay, settingsOverlay].forEach((ov) => {
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; });
  });
}

// ============================================================
// write overlay
// ============================================================
function openWrite() {
  const sel = document.getElementById("post-channel");
  sel.innerHTML = channels.map((c) => `<option value="${c.slug}">${c.name}</option>`).join("");
  if (activeChannel) sel.value = activeChannel;

  document.getElementById("post-title").value = "";
  document.getElementById("editor-body").innerHTML = "";
  document.getElementById("write-status").textContent = "";
  document.getElementById("write-status").classList.remove("error");
  document.getElementById("write-overlay").hidden = false;
  document.getElementById("post-title").focus();
}

async function publishPost() {
  const statusEl = document.getElementById("write-status");
  const setStatus = (msg, isError) => {
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", !!isError);
  };

  if (!ghIsConfigured()) {
    setStatus("Connect GitHub in Settings first.", true);
    openSettings();
    return;
  }

  const title = document.getElementById("post-title").value.trim();
  const channel = document.getElementById("post-channel").value;
  const bodyHtml = document.getElementById("editor-body").innerHTML.trim();

  if (!title) return setStatus("Title can't be empty.", true);
  if (!bodyHtml) return setStatus("Write something first.", true);

  const id = `${slugify(title)}-${Date.now().toString(36)}`;
  const date = new Date().toISOString().slice(0, 10);
  const excerpt = stripHtml(bodyHtml).slice(0, 160);

  try {
    setStatus("Publishing… (1/3) writing post file");
    await ghPutFile(`posts/${id}.html`, bodyHtml, `Add post: ${title}`);

    setStatus("Publishing… (2/3) updating posts.json");
    const existing = await ghGetFile("posts.json");
    const list = existing ? JSON.parse(existing.content) : [];
    list.push({ id, title, channel, date, excerpt });
    await ghPutFile("posts.json", JSON.stringify(list, null, 2), `Update posts.json: ${title}`, existing ? existing.sha : undefined);

    setStatus("Publishing… (3/3) updating sitemap.xml");
    await updateSitemap(id);

    posts.push({ id, title, channel, date, excerpt });
    activeChannel = channel;
    renderChannels();
    renderFeed();

    const cfg = ghGetConfig();
    const liveUrl = `https://${cfg.owner}.github.io/${cfg.repo}/post.html?id=${encodeURIComponent(id)}`;
    setStatus(`Published. Live in ~30-60s at ${liveUrl}`);
  } catch (err) {
    setStatus(err.message || "Publish failed.", true);
  }
}

async function updateSitemap(id) {
  const existing = await ghGetFile("sitemap.xml");
  if (!existing) return; // no sitemap present, skip silently
  const cfg = ghGetConfig();
  const url = `https://${cfg.owner}.github.io/${cfg.repo}/post.html?id=${encodeURIComponent(id)}`;
  const entry = `  <url><loc>${url}</loc></url>\n`;
  const updated = existing.content.includes("</urlset>")
    ? existing.content.replace("</urlset>", `${entry}</urlset>`)
    : existing.content;
  if (updated !== existing.content) {
    await ghPutFile("sitemap.xml", updated, `Add ${id} to sitemap`, existing.sha);
  }
}

// ============================================================
// new channel
// ============================================================
async function createChannel() {
  if (!ghIsConfigured()) {
    openSettings();
    return;
  }
  const name = prompt("Channel name:");
  if (!name) return;
  const description = prompt("One-line description (optional):") || "";
  const slug = slugify(name);

  if (channels.some((c) => c.slug === slug)) {
    alert("A channel with that name already exists.");
    return;
  }

  try {
    const existing = await ghGetFile("channels.json");
    const list = existing ? JSON.parse(existing.content) : [];
    const newChannel = { slug, name, description, createdAt: new Date().toISOString().slice(0, 10) };
    list.push(newChannel);
    await ghPutFile("channels.json", JSON.stringify(list, null, 2), `Add channel: ${name}`, existing ? existing.sha : undefined);

    channels.push(newChannel);
    activeChannel = slug;
    renderChannels();
    renderFeed();
  } catch (err) {
    alert(`Could not create channel: ${err.message}`);
  }
}

// ============================================================
// settings modal
// ============================================================
function openSettings() {
  const cfg = ghGetConfig() || {};
  document.getElementById("cfg-owner").value = cfg.owner || "";
  document.getElementById("cfg-repo").value = cfg.repo || "";
  document.getElementById("cfg-branch").value = cfg.branch || "main";
  document.getElementById("cfg-token").value = cfg.token || "";
  document.getElementById("settings-status").textContent = "";
  document.getElementById("settings-overlay").hidden = false;
}

function saveSettings() {
  const owner = document.getElementById("cfg-owner").value.trim();
  const repo = document.getElementById("cfg-repo").value.trim();
  const branch = document.getElementById("cfg-branch").value.trim() || "main";
  const token = document.getElementById("cfg-token").value.trim();
  const statusEl = document.getElementById("settings-status");

  if (!owner || !repo || !token) {
    statusEl.textContent = "Fill in username, repo, and token.";
    statusEl.classList.add("error");
    return;
  }

  ghSetConfig({ owner, repo, branch, token });
  statusEl.classList.remove("error");
  statusEl.textContent = "Saved.";
  setTimeout(() => { document.getElementById("settings-overlay").hidden = true; }, 500);
}

// ============================================================
// single post page (post.html)
// ============================================================
async function renderSinglePost() {
  const root = document.getElementById("post-root");
  if (!root) return;

  const id = new URLSearchParams(window.location.search).get("id");
  try {
    const list = await fetchJson("posts.json");
    const post = list.find((p) => p.id === id);
    if (!post) {
      root.innerHTML = '<p class="empty-state">post not found.</p>';
      return;
    }

    document.title = `${post.title} — the stacks`;
    const descEl = document.getElementById("meta-desc");
    if (descEl) descEl.setAttribute("content", post.excerpt || "");

    const res = await fetch(`posts/${post.id}.html`, { cache: "no-store" });
    const bodyHtml = await res.text();

    root.innerHTML = `
      <header class="post-page-header">
        <span class="mono" style="color:var(--ink-dim); font-size:12px;">${post.channel}</span>
        <h1 class="post-page-title">${post.title}</h1>
        <p class="post-page-meta">${formatDate(post.date)}</p>
      </header>
      <div class="post-page-body">${bodyHtml}</div>
    `;
  } catch (e) {
    root.innerHTML = '<p class="empty-state">could not load this post.</p>';
  }
}

document.addEventListener("DOMContentLoaded", initApp);
