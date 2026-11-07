// CourseWare embed smoke test (docs/courseware-bridge.md).
//
// Starts the dev server with a test origin, serves a stand-in CourseWare page that frames the editor with
// ?embed=courseware, and drives a throwaway headless Chrome (its own temporary profile) through the bridge:
// open, empty submit, submit, unchanged resubmit, reload, limits, hidden-tool keys and right-click menu.
// It also records a UI fingerprint (ribbon, shape panel, right-click menu at 1366x768 with the simple-mode
// defaults) and compares it with tests/courseware/ui-baseline.json, so an upstream merge that changes what
// the tutorials show is caught even when the changelog does not say so.
//
//   node tests/courseware/smoke.mjs [--out DIR] [--update-baseline]
//
// Exit code: 0 all functional checks passed (the UI may still differ: see result.json), 1 a check failed.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : mkdtempSync(join(tmpdir(), "cw-smoke-out-"));
const updateBaseline = args.includes("--update-baseline");
const baselinePath = join(root, "tests", "courseware", "ui-baseline.json");
mkdirSync(outDir, { recursive: true });

const W = 1366, H = 768;
const EDITOR_PORT = 3311, PAGE_PORT = 8788;
const EDITOR = `http://localhost:${EDITOR_PORT}`;
const PAGE = `http://localhost:${PAGE_PORT}`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ── The stand-in CourseWare page ──────────────────────────────────────────
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><title>CourseWare stand-in</title>
<style>html,body{margin:0;height:100%}#bar{height:36px;background:#1f3a5f}iframe{border:0;width:100%;height:calc(100% - 36px);display:block}</style></head>
<body><div id="bar"></div><iframe id="cad" src="${EDITOR}/?embed=courseware"></iframe><script>
const frame = document.getElementById("cad"); window.log = []; window.subs = [];
window.send = (msg, transfer = []) => frame.contentWindow.postMessage({ source: "courseware-cad", version: 1, ...msg }, ${JSON.stringify(EDITOR)}, transfer);
window.addEventListener("message", (e) => {
  if (e.origin !== ${JSON.stringify(EDITOR)} || e.source !== frame.contentWindow || !e.data || e.data.source !== "layerling-editor") return;
  const d = e.data, s = { type: d.type };
  for (const [k, v] of Object.entries(d)) if (!["source", "version", "type"].includes(k)) s[k] = v instanceof ArrayBuffer ? "bytes:" + v.byteLength : v;
  window.log.push(s); if (d.type === "submission") window.subs.push(d);
  if (d.type === "ready") window.send({ type: "init", lessonKey: new URLSearchParams(location.search).get("key") || "smoke:lesson", title: "Smoke test" });
});
</script></body></html>`;
let starterLyl = null;
const pageServer = createServer((req, res) => {
  if (req.url.startsWith("/starter.lyl") && starterLyl) { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(starterLyl); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(HARNESS);
}).listen(PAGE_PORT, "localhost");

// ── Dev server and Chrome ─────────────────────────────────────────────────
const dev = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "apps/web", "-p", String(EDITOR_PORT)], {
  cwd: root, env: { ...process.env, NEXT_PUBLIC_COURSEWARE_ORIGINS: PAGE, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"],
});
let devLog = "";
dev.stdout.on("data", (b) => { devLog += b; }); dev.stderr.on("data", (b) => { devLog += b; });
const profile = mkdtempSync(join(tmpdir(), "cw-smoke-chrome-"));
const debugPort = 9600 + Math.floor(Math.random() * 300);
let chrome = null, ws = null;
const cleanup = () => { try { ws?.close(); } catch {} chrome?.kill(); dev.kill(); pageServer.close(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };

async function waitFor(fn, ms, every = 500) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(every); } return null; }

let nextId = 1; const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const top = async (expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
let frameContext = null;
async function inFrame(expression) {
  // The editor frame is same-site (localhost), so it shares the page's process: evaluate in an isolated world of it.
  if (!frameContext) {
    const { frameTree } = await cdp("Page.getFrameTree");
    const child = (frameTree.childFrames || []).find((f) => f.frame.url.startsWith(EDITOR));
    if (!child) throw new Error("editor frame not found");
    frameContext = (await cdp("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "smoke" })).executionContextId;
  }
  return (await cdp("Runtime.evaluate", { expression, contextId: frameContext, awaitPromise: true, returnByValue: true })).result.value;
}
const shot = async (name) => { const { data } = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64")); };
let editorNumber;
const mcp = async (action, params = {}) => (await fetch(`${EDITOR}/api/layerling-mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "command", action, params, timeoutMs: 30000, editorNumber }) })).json();
// Waits for an editor to report itself, with a given number of shapes when that matters (after a reload the
// editor keeps its number but takes a moment to load the design).
async function findEditor(expectedShapes = null) {
  editorNumber = undefined;
  return waitFor(async () => {
    const l = await (await fetch(`${EDITOR}/api/layerling-mcp`)).json();
    const match = (l.editors ?? []).filter((e) => expectedShapes === null || e.shapeCount === expectedShapes).at(-1);
    if (match) { editorNumber = match.editorNumber; return true; }
    return false;
  }, 60000);
}
async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0), code = `Key${k.toUpperCase()}`, vk = k.toUpperCase().charCodeAt(0);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers, windowsVirtualKeyCode: vk });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers, windowsVirtualKeyCode: vk });
}
async function click(x, y, button = "left") {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : 2, clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
}
const kinds = async () => ((await mcp("list_objects")).data?.objects ?? []).map((o) => o.kind).join(",");
async function load(url) {
  frameContext = null;
  await top("window.log = []");
  await cdp("Page.navigate", { url });
  return waitFor(() => top("window.log && window.log.some((m) => m.type === 'opened' || m.type === 'error')"), 240000);
}
async function submit() {
  await top("window.log = []; window.send({ type: 'request-submission', requestId: 'r' + Date.now(), include3mf: true, checkPrint: true })");
  await waitFor(() => top("window.log.some((m) => m.type === 'submission' || m.type === 'submission-error')"), 90000);
  return top("window.log.find((m) => m.type === 'submission' || m.type === 'submission-error')");
}

// The UI fingerprint: what a student sees, as labels in order. Positions are left out on purpose (they jitter).
const FINGERPRINT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || "").trim().split("\\n")[0];
  const ribbon = [...document.querySelectorAll(".toolbar-section")].filter(vis).map((s) => ({
    group: s.dataset.group || "", tools: [...s.querySelectorAll("button")].filter(vis).map(label).filter(Boolean) }));
  const panel = document.querySelector(".shape-inspector");
  const inspector = panel ? {
    state: [...panel.querySelectorAll(".shape-state-card button, .shape-state-card label")].filter(vis).map(label),
    cards: [...panel.querySelectorAll(".property-card-header span:first-child")].filter(vis).map((e) => e.innerText.trim()),
    fields: [...panel.querySelectorAll(".range-property-name")].filter(vis).map((e) => e.innerText.trim()),
    sizeFieldsFit: [...panel.querySelectorAll(".range-property")].filter(vis).slice(0, 3).every((e) => e.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom),
  } : null;
  const menu = [...document.querySelectorAll("[role=menuitem]")].filter(vis).map((e) => e.innerText.trim().split("\\n")[0]);
  return { ribbon, inspector, menu };
})()`;

try {
  const ready = await waitFor(async () => (await fetch(`${EDITOR}/api/layerling-mcp?status=1`)).ok, 300000, 1500);
  check("dev server starts", ready, ready ? "" : devLog.slice(-400));
  if (!ready) throw new Error("dev server did not start");

  chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--disable-extensions", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--lang=en-US",
    `--window-size=${W},${H}`, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const targets = await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(), 20000, 200);
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await cdp("Page.enable"); await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  // 1. Open a blank design for a new lesson key.
  await load(`${PAGE}/?key=smoke:lesson`);
  const opened = await top("window.log");
  check("ready, then opened blank", opened.some((m) => m.type === "ready") && opened.some((m) => m.type === "opened" && m.from === "blank"), JSON.stringify(opened));
  check("found the editor for test commands", await findEditor());
  await sleep(4000);

  // 2. Nothing to hand in yet.
  const empty = await submit();
  check("empty design refused", empty?.type === "submission-error" && empty.code === "empty", JSON.stringify(empty));

  // 3. A box and a cylinder, handed in twice.
  await mcp("create_shape", { kind: "box", width: 40, depth: 40, height: 20 });
  await mcp("create_shape", { kind: "cylinder", width: 14, depth: 14, height: 30, x: 40 });
  await sleep(2000);
  const first = await submit();
  check("submission with project file, thumbnail and 3MF", first?.type === "submission" && /^bytes:\d+/.test(first.lyl) && /^bytes:\d+/.test(first.thumbnailPng ?? "") && /^bytes:\d+/.test(first.threeMf ?? "") && first.objectCount === 2, JSON.stringify({ ...first, printCheck: undefined }));
  check("print check included", Boolean(first?.printCheck && first.printCheck.pieces), "");
  const second = await submit();
  check("unchanged resubmission has the same design hash", first?.designHash && first.designHash === second?.designHash, `${first?.designHash} / ${second?.designHash}`);
  starterLyl = Buffer.from(await top("(() => { const u = new Uint8Array(window.subs.at(-1).lyl); let t = ''; for (let i = 0; i < u.length; i += 8192) t += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(t); })()"), "base64");

  // 4. Reload: the same lesson key reopens the same design.
  await load(`${PAGE}/?key=smoke:lesson`);
  check("reload reopens the local design", (await top("window.log")).some((m) => m.type === "opened" && m.from === "local"));
  await findEditor(2); await sleep(2000);
  const reopened = await waitFor(async () => ((await kinds()) === "box,cylinder" ? "box,cylinder" : null), 90000);
  check("design survived the reload", reopened, reopened ?? await kinds());

  // 5. UI fingerprint with the simple-mode defaults: ribbon, panel of a selected box, right-click menu.
  const box = ((await mcp("list_objects")).data?.objects ?? []).find((o) => o.kind === "box");
  await mcp("select_objects", { ids: [box.id] }); await sleep(2500);
  await shot("ui-panel");
  const uiPanel = await inFrame(FINGERPRINT);
  check("Length, Width and Height fit in the panel at 1366x768", uiPanel.inspector?.sizeFieldsFit, JSON.stringify(uiPanel.inspector?.fields));
  check("advanced cards hidden in the embed", uiPanel.inspector && !uiPanel.inspector.cards.some((c) => /wrap around|surface texture/i.test(c)), JSON.stringify(uiPanel.inspector?.cards));
  const picked = await inFrame(`(() => { const c = document.querySelector("canvas"); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  let menu = [];
  for (const [dx, dy] of [[0, 0], [-40, -30], [30, -50], [-80, 10]]) {
    await click(picked.x + dx, picked.y + 36 + dy, "right"); await sleep(1200);
    menu = (await inFrame(FINGERPRINT)).menu; if (menu.length) break;
  }
  await shot("ui-menu");
  await key("Escape");
  const fingerprint = { ribbon: uiPanel.ribbon, inspector: { ...uiPanel.inspector, sizeFieldsFit: undefined }, menu };
  writeFileSync(join(outDir, "ui-fingerprint.json"), JSON.stringify(fingerprint, null, 2));

  // 6. A lesson's limits: the ribbon, the keys and the right-click menu follow them.
  await top("window.send({ type: 'limits', tools: ['undo', 'redo', 'group'], shapes: ['box'] })"); await sleep(1500);
  const limited = await inFrame(FINGERPRINT);
  const shownTools = limited.ribbon.flatMap((s) => s.tools).join("|");
  check("limits hide mirror and align in the ribbon", !/mirror|align/i.test(shownTools), shownTools);
  const ids = ((await mcp("list_objects")).data?.objects ?? []).map((o) => o.id);
  await mcp("select_objects", { ids }); await sleep(800);
  await click(picked.x, picked.y + 300); await mcp("select_objects", { ids }); await sleep(800);
  await key("b", { ctrl: true }); await sleep(2500);
  check("hidden tool's key does nothing (Ctrl+B bundle)", (await kinds()) === "box,cylinder", await kinds());
  await mcp("select_objects", { ids }); await sleep(500);
  await key("g", { ctrl: true }); await sleep(4000);
  check("allowed tool's key works (Ctrl+G group)", (await kinds()) !== "box,cylinder", await kinds());

  // 7. Review copy, then fresh copy from the submission.
  await top("window.log = []; fetch('/starter.lyl').then((r) => r.arrayBuffer()).then((b) => window.send({ type: 'review', lyl: b }, [b]))");
  await waitFor(() => top("window.log.some((m) => m.type === 'opened')"), 60000);
  check("review copy opens", (await top("window.log")).some((m) => m.type === "opened" && m.from === "review"));

  // 8. Compare the UI with the approved one.
  let uiChanged = null, uiDiff = [];
  if (updateBaseline || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, JSON.stringify(fingerprint, null, 2) + "\n");
    console.log(`UI baseline written: ${baselinePath}`);
  } else {
    const base = JSON.parse(readFileSync(baselinePath, "utf8"));
    const flat = (o, p = "") => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k)) : [[p, JSON.stringify(o)]]);
    const a = new Map(flat(base)), b = new Map(flat(fingerprint));
    for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) uiDiff.push({ at: k, approved: a.get(k) ?? null, now: b.get(k) ?? null });
    uiChanged = uiDiff.length > 0;
    console.log(uiChanged ? `UI CHANGED in ${uiDiff.length} place(s); see result.json` : "UI unchanged from the approved baseline");
  }
  writeFileSync(join(outDir, "result.json"), JSON.stringify({ checks, uiChanged, uiDiff, outDir }, null, 2));
} catch (error) {
  check("smoke test ran to the end", false, String(error?.stack || error).slice(0, 600));
  writeFileSync(join(outDir, "result.json"), JSON.stringify({ checks, uiChanged: null, uiDiff: [], outDir }, null, 2));
} finally {
  cleanup();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Output: ${outDir}`);
process.exit(failed.length ? 1 : 0);
