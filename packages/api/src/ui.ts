/** Minimal dev/test UI served at GET /. Self-contained (inline CSS/JS, no build). */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ditto — clone studio</title>
<style>
  :root { color-scheme: dark; --accent: #2f6feb; --accent-glow: #5b8def44; --success: #3dd68c; --warn: #f5a623; --error: #ff7b72; --muted: #6b7280; --surface: #0f131a; --border: #1d2330; }
  * { box-sizing: border-box; }
  /* id-selector display rules below beat the UA's [hidden]{display:none} — restore it */
  [hidden] { display: none !important; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0 8px 0 0; font-weight: 600; color: #9ecbff; }
  #score { margin-left: auto; font: 13px ui-monospace, monospace; color: var(--success); display: none; }
  input[type=text] { flex: 1 1 320px; min-width: 240px; padding: 8px 10px; border-radius: 6px; border: 1px solid #2a3245; background: #121722; color: inherit; }
  button { padding: 8px 16px; border-radius: 6px; border: 0; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  label { display: flex; gap: 6px; align-items: center; color: #9aa4b2; user-select: none; font-size: 13px; }
  main { display: grid; grid-template-columns: 380px 1fr; height: calc(100vh - 61px); }
  #sidebar { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; background: #0a0d12; }
  #progress-panel { padding: 18px 16px 14px; border-bottom: 1px solid var(--border); background: var(--surface); }
  #progress-panel.idle { opacity: .5; }
  #progress-panel.running { opacity: 1; }
  .timer-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
  #big-timer { font: 700 28px/1 ui-monospace, monospace; color: #fff; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  #big-pct { font: 700 28px/1 ui-monospace, monospace; color: var(--accent); font-variant-numeric: tabular-nums; }
  .bar-track { height: 6px; background: #1a2030; border-radius: 99px; overflow: hidden; margin-bottom: 12px; }
  .bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent-dim, #1a3d7a), var(--accent)); border-radius: 99px; transition: width .4s ease; box-shadow: 0 0 12px var(--accent-glow); }
  #activity { font-size: 13px; color: #c9d4e3; line-height: 1.45; min-height: 2.9em; margin-bottom: 14px; }
  #activity .sub { display: block; font-size: 11px; color: var(--muted); margin-top: 3px; font-family: ui-monospace, monospace; }
  .stepper { display: flex; flex-direction: column; gap: 0; }
  .step { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12px; color: #4b5563; transition: color .25s; }
  .step.active { color: #9ecbff; }
  .step.done { color: #7ee787; }
  .step.fail { color: var(--error); }
  .step.fail .step-dot { background: var(--error); }
  .step-dot { width: 8px; height: 8px; border-radius: 50%; background: #2a3245; flex-shrink: 0; transition: background .25s, box-shadow .25s; }
  .step.active .step-dot { background: var(--accent); box-shadow: 0 0 8px var(--accent-glow); animation: pulse 1.4s ease infinite; }
  .step.done .step-dot { background: var(--success); box-shadow: none; animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
  .step-label { flex: 1; }
  .step-detail { font: 10px ui-monospace, monospace; color: var(--muted); }
  .step.active .step-detail { color: #6b8cce; }
  #log { flex: 1; overflow-y: auto; padding: 10px 14px; font: 10px/1.65 ui-monospace, monospace; min-height: 0; border-top: 1px solid var(--border); }
  #log .evt { color: #7ee787; } #log .err { color: var(--error); } #log .meta { color: #8b949e; }
  #view { display: flex; flex-direction: column; min-height: 0; position: relative; }
  #tabs { display: flex; gap: 2px; padding: 8px 12px 0; flex-shrink: 0; }
  #tabs a { padding: 6px 14px; border-radius: 6px 6px 0 0; background: #121722; color: #9aa4b2; text-decoration: none; font-size: 13px; }
  #tabs a.active { background: #1d2330; color: #e6e6e6; }
  iframe { flex: 1; border: 0; background: #fff; min-height: 0; }
  #loading { flex: 1; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 40px; background: radial-gradient(ellipse at 50% 30%, #121722 0%, #0b0e14 70%); text-align: center; }
  #loading.show { display: flex; }
  .loading-ring { width: 96px; height: 96px; transform: rotate(-90deg); }
  .loading-ring-bg { fill: none; stroke: #1d2330; stroke-width: 4; }
  .loading-ring-fill { fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round; transition: stroke-dashoffset .5s ease; }
  #loading-title { font-size: 18px; font-weight: 600; color: #e6e6e6; margin: 0; }
  #loading-activity { font-size: 14px; color: #9aa4b2; max-width: 420px; line-height: 1.5; margin: 0; }
  #loading-timer { font: 600 15px ui-monospace, monospace; color: var(--accent); margin: 0; }
  #empty { flex: 1; display: grid; place-items: center; color: #4b5563; text-align: center; padding: 24px; }
</style>
</head>
<body>
<header>
  <h1>ditto</h1>
  <input id="url" type="text" inputmode="url" placeholder="https://cropin.com/" value="" autocomplete="url">
  <label><input id="fast" type="checkbox"> fast (1280 only, no interactions/motion)</label>
  <label><input id="fresh" type="checkbox"> fresh (no cache)</label>
  <label><input id="validate" type="checkbox"> validate (witness gates)</label>
  <button id="go">Clone</button>
  <span id="score"></span>
</header>
<main>
  <div id="sidebar">
    <div id="progress-panel" class="idle">
      <div class="timer-row">
        <span id="big-timer">0:00</span>
        <span id="big-pct">—</span>
      </div>
      <div class="bar-track"><div class="bar-fill" id="bar-fill"></div></div>
      <div id="activity">Ready — enter a URL and hit Clone.</div>
      <div class="stepper" id="stepper">
        <div class="step" data-stage="navigate"><span class="step-dot"></span><span class="step-label">Navigate</span><span class="step-detail" id="sd-navigate"></span></div>
        <div class="step" data-stage="capture"><span class="step-dot"></span><span class="step-label">Capture</span><span class="step-detail" id="sd-capture"></span></div>
        <div class="step" data-stage="assets"><span class="step-dot"></span><span class="step-label">Assets</span><span class="step-detail" id="sd-assets"></span></div>
        <div class="step" data-stage="generate"><span class="step-dot"></span><span class="step-label">Generate</span><span class="step-detail" id="sd-generate"></span></div>
        <div class="step" data-stage="preview"><span class="step-dot"></span><span class="step-label">App preview</span><span class="step-detail" id="sd-preview"></span></div>
        <div class="step" data-stage="validate"><span class="step-dot"></span><span class="step-label">Validate</span><span class="step-detail" id="sd-validate"></span></div>
      </div>
    </div>
    <div id="log"><div class="meta">Event log</div></div>
  </div>
  <div id="view">
    <div id="tabs" hidden>
      <a id="tab-app" class="active" href="#">App preview</a>
      <a id="tab-json" href="#" target="_blank">result.json</a>
      <a id="tab-bundle" href="#" target="_blank">download .tgz</a>
    </div>
    <div id="loading">
      <svg class="loading-ring" viewBox="0 0 96 96" aria-hidden="true">
        <circle class="loading-ring-bg" cx="48" cy="48" r="42"/>
        <circle class="loading-ring-fill" id="loading-ring-fill" cx="48" cy="48" r="42" stroke-dasharray="263.89" stroke-dashoffset="263.89"/>
      </svg>
      <p id="loading-title">Cloning…</p>
      <p id="loading-activity">Starting</p>
      <p id="loading-timer">0:00 · 0%</p>
    </div>
    <div id="empty">no clone yet</div>
    <iframe id="frame" hidden></iframe>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const RING_C = 2 * Math.PI * 42;
const STAGES = ["navigate", "capture", "assets", "generate", "preview", "validate"];

const STAGE_FOR = {
  submitting: "navigate", queued: "navigate", clone_start: "navigate", crawl_start: "navigate", goto: "navigate",
  dismissed: "capture", captured: "capture", pseudo_states: "capture", motion_captured: "capture",
  capture_reuse: "capture", capture_done: "capture",
  css_text_parse_start: "assets", css_text_parse_done: "assets", refetch_pass: "assets", refetch_done: "assets",
  evidence_frozen: "assets", timing_summary: "assets",
  generate_start: "generate", ir_build_start: "generate", ir_built: "generate", inferred: "generate",
  app_generate_start: "generate", generated: "generate", patterns_resolved: "generate", clone_done: "generate",
  app_build_start: "preview", app_build_done: "preview", app_preview_failed: "preview",
  verify_start: "validate", build_start: "validate", build_done: "validate", verify_done: "validate", validated: "validate",
};

const BASE_PCT = {
  submitting: 1, goto: 6, captured: 10, capture_done: 22,
  refetch_done: 38, ir_built: 48, inferred: 55, generated: 68,
  app_build_start: 78, app_build_done: 86, clone_done: 88,
  verify_start: 90, validated: 98, clone_failed: 100, clone_error: 100,
};

let targetPct = 0;
let displayPct = 0;
let seenEvents = 0;
let t0 = 0;
let timerId = null;
let creepId = null;
let lastEventAt = 0;
let captureVpCount = 0;
let refetchPass = 0;
let activeStage = null;
let cloneUrl = "";
let previewOk = true;
let previewFiles = 0;

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return "0:" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

function describeEvent(ev, e) {
  if (ev === "goto") return { main: "Loading page in headless browser", sub: e.url || "" };
  if (ev === "captured") return { main: "Capturing layout at " + e.viewport + "px", sub: e.nodes + " DOM nodes · scroll " + (e.scrollHeight || "?") + "px" };
  if (ev === "dismissed") return { main: "Dismissing overlays & cookie banners", sub: (e.removed || 0) + " removed" };
  if (ev === "motion_captured") return { main: "Recording animations & Lottie", sub: "waapi " + (e.waapi||0) + " · lotties " + (e.lotties||0) + " · marquees " + (e.marquees||0) };
  if (ev === "pseudo_states") return { main: "Recovering hover/focus CSS", sub: (e.rules || 0) + " rules" };
  if (ev === "capture_done") return { main: "Capture complete — freezing evidence", sub: e.reused ? "cache hit" : "fresh capture" };
  if (ev === "refetch_pass") return { main: "Fetching cross-origin assets (pass " + ((e.pass||0)+1) + ")", sub: "" };
  if (ev === "refetch_done") return { main: "Asset recovery complete", sub: "" };
  if (ev === "css_text_parse_start") return { main: "Parsing stylesheets", sub: "" };
  if (ev === "ir_built") return { main: "Building intermediate representation", sub: (e.nodes || "") + " nodes" };
  if (ev === "inferred") return { main: "Inferring tokens, fonts & recipes", sub: (e.assets||0) + " assets · " + (e.fonts||0) + " fonts" };
  if (ev === "generated") return { main: "Generating Next.js app", sub: "" };
  if (ev === "app_build_start") return { main: "Building app preview (npm run build)", sub: "this can take a minute…" };
  if (ev === "app_build_done") return { main: e.ok ? "App preview ready" : "App preview build failed", sub: e.files ? e.files + " files · " + ((e.ms || 0)/1000).toFixed(1) + "s" : e.ms ? ((e.ms/1000).toFixed(1) + "s") : "" };
  if (ev === "app_preview_failed") return { main: "App preview failed", sub: String(e.error || "").slice(0, 80) };
  if (ev === "verify_start") return { main: "Running witness validation gates", sub: "" };
  if (ev === "validated") return { main: "Validation complete", sub: typeof e.score === "number" ? "score " + e.score.toFixed(1) : "" };
  if (ev === "clone_done") return { main: "Clone pipeline finished", sub: "" };
  const label = ev.replace(/_/g, " ");
  return { main: label.charAt(0).toUpperCase() + label.slice(1), sub: "" };
}

function pctForEvent(ev, e) {
  if (ev === "captured") {
    captureVpCount++;
    return Math.min(21, 8 + captureVpCount * 3);
  }
  if (ev === "refetch_pass") {
    refetchPass = (e.pass || 0) + 1;
    return Math.min(37, 28 + refetchPass * 2);
  }
  return BASE_PCT[ev];
}

function setStage(stage) {
  activeStage = stage;
  const idx = STAGES.indexOf(stage);
  document.querySelectorAll(".step").forEach((el) => {
    const s = el.getAttribute("data-stage");
    const si = STAGES.indexOf(s);
    el.classList.remove("active", "done");
    if (si < idx) el.classList.add("done");
    else if (si === idx) el.classList.add("active");
  });
}

function renderPct(pct) {
  const p = Math.round(Math.min(100, Math.max(0, pct)));
  $("big-pct").textContent = p + "%";
  $("bar-fill").style.width = p + "%";
  $("loading-ring-fill").style.strokeDashoffset = String(RING_C - (p / 100) * RING_C);
  $("loading-timer").textContent = fmtElapsed(Date.now() - t0) + " · " + p + "%";
}

function setActivity(desc) {
  $("activity").innerHTML = desc.main + (desc.sub ? '<span class="sub">' + desc.sub + '</span>' : "");
  $("loading-activity").textContent = desc.main + (desc.sub ? " — " + desc.sub : "");
}

function bumpEvent(ev, e) {
  lastEventAt = Date.now();
  if (ev === "app_build_done") { previewOk = !!e.ok; previewFiles = e.files || 0; }
  if (ev === "app_preview_failed") previewOk = false;
  const stage = STAGE_FOR[ev];
  if (stage) setStage(stage);
  const mapped = pctForEvent(ev, e);
  if (mapped != null) targetPct = Math.max(targetPct, mapped);
  const desc = describeEvent(ev, e);
  setActivity(desc);
  if (stage) {
    const sd = $("sd-" + stage);
    if (sd) sd.textContent = desc.sub || desc.main.slice(0, 32);
  }
}

function creepTick() {
  const idle = Date.now() - lastEventAt;
  const ceiling = Math.min(99, targetPct + (idle > 2000 ? 12 : 4));
  if (displayPct < targetPct) {
    displayPct += Math.max(0.4, (targetPct - displayPct) * 0.25);
  } else if (idle > 1500 && displayPct < ceiling) {
    displayPct += 0.08;
  }
  renderPct(displayPct);
}

function log(text, cls) {
  const div = document.createElement("div");
  div.className = cls || "meta";
  div.textContent = text;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
}

function shortHost(url) {
  let u = url;
  const lower = u.toLowerCase();
  if (lower.startsWith("https://")) u = u.slice(8);
  else if (lower.startsWith("http://")) u = u.slice(7);
  while (u.endsWith("/")) u = u.slice(0, -1);
  return u || url;
}

function resetUi(url) {
  cloneUrl = url;
  targetPct = 0; displayPct = 0; seenEvents = 0;
  captureVpCount = 0; refetchPass = 0; activeStage = null;
  previewOk = true; previewFiles = 0;
  $("log").innerHTML = "";
  $("score").style.display = "none";
  $("score").textContent = "";
  $("tabs").hidden = true;
  $("frame").hidden = true;
  $("empty").hidden = true;
  $("loading").classList.add("show");
  $("loading-title").textContent = "Cloning " + shortHost(url);
  document.querySelectorAll(".step").forEach((el) => { el.classList.remove("active", "done", "fail"); });
  document.querySelectorAll("[id^=sd-]").forEach((el) => { el.textContent = ""; });
  $("progress-panel").classList.remove("idle");
  $("progress-panel").classList.add("running");
  setStage("navigate");
  setActivity({ main: "Submitting clone job", sub: url });
  targetPct = 1; displayPct = 0;
  renderPct(0);
  if (timerId) clearInterval(timerId);
  if (creepId) clearInterval(creepId);
  t0 = Date.now();
  lastEventAt = t0;
  $("big-timer").textContent = "0:00";
  timerId = setInterval(() => { $("big-timer").textContent = fmtElapsed(Date.now() - t0); }, 200);
  creepId = setInterval(creepTick, 120);
}

function stopTimers() {
  if (timerId) { clearInterval(timerId); timerId = null; }
  if (creepId) { clearInterval(creepId); creepId = null; }
}

async function pollEvents(jobId) {
  try {
    const r = await fetch("/v1/clones/" + jobId + "/events?after=" + seenEvents);
    if (!r.ok) return;
    const d = await r.json();
    for (const e of d.events || []) {
      seenEvents++;
      const ev = String(e.event ?? "");
      bumpEvent(ev, e);
      const detail = Object.entries(e).filter(([k]) => !["t","event"].includes(k)).map(([k,v]) => k + "=" + JSON.stringify(v)).join(" ");
      log(ev + (detail ? " " + detail : ""), ev.includes("error") || ev.includes("failed") ? "err" : "evt");
    }
  } catch { /* transient */ }
}

async function findRunningJob(url) {
  try {
    const r = await fetch("/v1/clones");
    const d = await r.json();
    const job = (d.clones || []).find((j) => j.url === url && j.status === "running");
    return job ? job.jobId : null;
  } catch { return null; }
}

function normalizeUrl(raw) {
  let u = raw.trim();
  if (!u) return u;
  const lower = u.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return u;
  while (u.startsWith("/")) u = u.slice(1);
  return "https://" + u;
}

function finishSuccess(d, jobId) {
  targetPct = 100; displayPct = 100;
  renderPct(100);
  STAGES.forEach((s) => {
    const el = document.querySelector('.step[data-stage="' + s + '"]');
    if (el) {
      el.classList.remove("active");
      if (s === "preview" && !previewOk) el.classList.add("fail");
      else el.classList.add("done");
    }
  });
  setActivity({ main: previewOk ? "Done!" : "Done — preview unavailable", sub: fmtElapsed(Date.now() - t0) + " total" });
  const t = d.timings || {};
  log("done in " + fmtElapsed(Date.now() - t0) + " (capture " + ((t.captureMs||0)/1000).toFixed(1) + "s · generate " + ((t.generateMs||0)/1000).toFixed(1) + "s · preview " + ((t.previewMs||0)/1000).toFixed(1) + "s)" + (d.captureReused ? " [cache hit]" : ""), "evt");
  if (d.verify && typeof d.verify.score === "number") {
    $("score").textContent = "score " + d.verify.score.toFixed(1);
    $("score").style.display = "block";
  }
  const base = "/v1/clones/" + jobId;
  $("tab-app").href = base + "/app-preview/";
  $("tab-json").href = base + "/result";
  $("tab-bundle").href = base + "/bundle?format=tgz";
  $("tabs").hidden = false;
  $("loading").classList.remove("show");
  $("tab-app").onclick = (ev) => { ev.preventDefault(); $("frame").src = base + "/app-preview/"; };
  const showPreview = async () => {
    if (!previewOk || previewFiles <= 0) {
      $("frame").hidden = true;
      $("empty").hidden = false;
      $("empty").textContent = "Clone finished but app preview did not build — try fresh (no cache) or download .tgz";
      return;
    }
    try {
      const pr = await fetch(base + "/app-preview/index.html", { method: "HEAD" });
      if (!pr.ok) throw new Error(String(pr.status));
    } catch {
      $("frame").hidden = true;
      $("empty").hidden = false;
      $("empty").textContent = "App preview missing (404) — restart npm run dev:api and clone with fresh (no cache)";
      return;
    }
    $("frame").src = base + "/app-preview/";
    $("frame").hidden = false;
    $("empty").hidden = true;
  };
  void showPreview();
}

async function waitForJob(id) {
  for (;;) {
    const r = await fetch("/v1/clones/" + id);
    if (!r.ok) throw new Error("job not found (server may have restarted)");
    const d = await r.json();
    if (d.status === "succeeded") return d;
    if (d.status === "failed") throw new Error(d.error || "clone failed");
    await new Promise((res) => setTimeout(res, 400));
  }
}

$("go").onclick = async () => {
  const url = normalizeUrl($("url").value);
  if (!url) { log("Enter a URL first", "err"); return; }
  if (url !== $("url").value.trim()) $("url").value = url;
  $("go").disabled = true;
  resetUi(url);
  const fast = $("fast").checked;
  const fresh = $("fresh").checked;
  const validate = $("validate").checked;
  const options = {};
  if (fast) Object.assign(options, { viewports: [1280], interactions: false, components: false, motion: false });
  if (fresh) options.noCache = true;
  if (validate) options.verify = true;
  log("POST /v1/clones " + url);
  let jobId = null;
  let poller = setInterval(async () => {
    if (!jobId) jobId = await findRunningJob(url);
    if (jobId) await pollEvents(jobId);
  }, 250);
  const stopPoller = () => { clearInterval(poller); poller = null; };
  try {
    const r = await fetch("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, options }) });
    let d;
    try { d = await r.json(); } catch { throw new Error("API returned non-JSON (is the server running?)"); }
    if (!r.ok || d.error) {
      const detail = d.details?.fieldErrors?.url?.[0];
      throw new Error(detail || d.error || String(r.status));
    }
    jobId = d.jobId || jobId;
    if (r.status === 202 || d.status === "queued") {
      log("queued jobId=" + jobId + " — polling until done");
      if (!jobId) jobId = await findRunningJob(url);
    }
    if (!jobId) throw new Error("no job id returned");
    const summary = (r.status === 202 || d.status === "queued") ? await waitForJob(jobId) : d;
    await pollEvents(jobId);
    stopPoller();
    stopTimers();
    $("big-timer").textContent = fmtElapsed(Date.now() - t0);
    finishSuccess(summary, jobId);
  } catch (e) {
    const msg = String(e);
    if (jobId && (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("Load failed"))) {
      log("POST connection dropped — recovering via jobId=" + jobId, "meta");
      setActivity({ main: "Connection dropped — waiting for clone to finish", sub: jobId.slice(0, 8) });
      try {
        const summary = await waitForJob(jobId);
        await pollEvents(jobId);
        stopPoller();
        stopTimers();
        $("big-timer").textContent = fmtElapsed(Date.now() - t0);
        finishSuccess(summary, jobId);
        return;
      } catch (e2) {
        log("FAILED: " + e2, "err");
      }
    } else {
      log("FAILED: " + e, "err");
    }
    stopPoller();
    stopTimers();
    $("loading").classList.remove("show");
    $("empty").hidden = false;
    $("empty").textContent = "clone failed";
    setActivity({ main: "Failed", sub: msg.slice(0, 120) });
  } finally {
    stopPoller();
    $("go").disabled = false;
  }
};
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });
</script>
</body>
</html>`;
