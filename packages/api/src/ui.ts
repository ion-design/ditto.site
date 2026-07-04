/** Minimal dev/test UI served at GET /. Self-contained (inline CSS/JS, no build):
 *  URL in → POST /v1/clones → live phase log via /v1/clones/:id/events → iframe
 *  preview via /v1/clones/:id/app-preview/. The sync in-memory backend registers
 *  jobs before running them, so the UI discovers the running job by polling the
 *  list while the POST is still in flight. */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ditto — clone tester</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; }
  header { padding: 14px 20px; border-bottom: 1px solid #1d2330; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0 8px 0 0; font-weight: 600; color: #9ecbff; }
  input[type=url] { flex: 1 1 320px; min-width: 240px; padding: 8px 10px; border-radius: 6px; border: 1px solid #2a3245; background: #121722; color: inherit; }
  button { padding: 8px 16px; border-radius: 6px; border: 0; background: #2f6feb; color: #fff; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  label { display: flex; gap: 6px; align-items: center; color: #9aa4b2; user-select: none; }
  main { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 61px); }
  #log { border-right: 1px solid #1d2330; overflow-y: auto; padding: 12px 16px; font: 12px/1.7 ui-monospace, monospace; }
  #log .evt { color: #7ee787; } #log .err { color: #ff7b72; } #log .meta { color: #8b949e; }
  #view { display: flex; flex-direction: column; }
  #tabs { display: flex; gap: 2px; padding: 8px 12px 0; }
  #tabs a { padding: 6px 14px; border-radius: 6px 6px 0 0; background: #121722; color: #9aa4b2; text-decoration: none; font-size: 13px; }
  #tabs a.active { background: #1d2330; color: #e6e6e6; }
  iframe { flex: 1; border: 0; background: #fff; }
  #empty { flex: 1; display: grid; place-items: center; color: #4b5563; }
</style>
</head>
<body>
<header>
  <h1>ditto</h1>
  <input id="url" type="url" placeholder="https://example.com/" value="">
  <label><input id="fast" type="checkbox" checked> fast (1280 only, no interactions/motion)</label>
  <button id="go">Clone</button>
</header>
<main>
  <div id="log"><div class="meta">Enter a URL and hit Clone. Phases stream here.</div></div>
  <div id="view">
    <div id="tabs" hidden>
      <a id="tab-app" class="active" href="#">App preview</a>
      <a id="tab-json" href="#" target="_blank">result.json</a>
      <a id="tab-bundle" href="#" target="_blank">download .tgz</a>
    </div>
    <div id="empty">no clone yet</div>
    <iframe id="frame" hidden></iframe>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const log = (text, cls) => {
  const div = document.createElement("div");
  div.className = cls || "meta";
  div.textContent = text;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
};
let seenEvents = 0;
async function pollEvents(jobId) {
  try {
    const r = await fetch("/v1/clones/" + jobId + "/events");
    if (!r.ok) return;
    const d = await r.json();
    for (const e of d.events.slice(seenEvents)) {
      seenEvents++;
      log(e.event + " " + Object.entries(e).filter(([k]) => !["t","event"].includes(k)).map(([k,v]) => k + "=" + JSON.stringify(v)).join(" "), e.event.includes("error") || e.event.includes("failed") ? "err" : "evt");
    }
  } catch { /* transient */ }
}
async function findRunningJob(url) {
  try {
    const r = await fetch("/v1/clones");
    const d = await r.json();
    const job = (d.clones || []).find((j) => j.url === url && (j.status === "running" || j.status === "succeeded"));
    return job ? job.jobId : null;
  } catch { return null; }
}
$("go").onclick = async () => {
  const url = $("url").value.trim();
  if (!url) return;
  $("go").disabled = true;
  $("log").innerHTML = ""; seenEvents = 0;
  $("tabs").hidden = true; $("frame").hidden = true; $("empty").hidden = false; $("empty").textContent = "cloning…";
  const fast = $("fast").checked;
  const options = fast ? { viewports: [1280], interactions: false, components: false, motion: false } : {};
  log("POST /v1/clones " + url);
  const t0 = Date.now();
  let jobId = null;
  const poller = setInterval(async () => {
    if (!jobId) jobId = await findRunningJob(url);
    if (jobId) await pollEvents(jobId);
  }, 300);
  try {
    const r = await fetch("/v1/clones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, options }) });
    const d = await r.json();
    clearInterval(poller);
    if (!r.ok || d.error) { log("FAILED: " + (d.error || r.status), "err"); $("empty").textContent = "clone failed"; return; }
    jobId = d.jobId;
    await pollEvents(jobId);
    const t = d.timings || {};
    log("done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s (capture " + (t.captureMs/1000).toFixed(1) + "s, generate " + (t.generateMs/1000).toFixed(1) + "s, preview " + ((t.previewMs||0)/1000).toFixed(1) + "s)" + (d.captureReused ? " [capture cache hit]" : ""), "evt");
    const base = "/v1/clones/" + jobId;
    $("tab-app").href = base + "/app-preview/";
    $("tab-json").href = base + "/result";
    $("tab-bundle").href = base + "/bundle?format=tgz";
    $("tabs").hidden = false;
    $("frame").src = base + "/app-preview/";
    $("frame").hidden = false; $("empty").hidden = true;
    $("tab-app").onclick = (e) => { e.preventDefault(); $("frame").src = base + "/app-preview/"; };
  } catch (e) {
    clearInterval(poller);
    log("FAILED: " + e, "err");
    $("empty").textContent = "clone failed";
  } finally {
    $("go").disabled = false;
  }
};
</script>
</body>
</html>`;
