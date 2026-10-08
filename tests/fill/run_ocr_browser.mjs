#!/usr/bin/env node
/* =========================================================================
 * Yang-analyze web — tests/fill/run_ocr_browser.mjs
 * 以 Playwright（Chromium）執行 tests/fill/ocr_browser_test.html：
 *   - 內建小型靜態伺服器（127.0.0.1、隨機埠）提供 repo 根目錄
 *   - 封鎖所有非本機請求（proxy 指向無效埠 + route 攔截並記錄），證明 OCR/PDF 完全離線可用
 *   - 另以 file:// 開啟同一頁，確認 OCR 回報不可用、PDF 退回主執行緒仍可取文字
 * 沒有安裝 Playwright 時印出 SKIP 並以 0 結束。
 * 用法：node tests/fill/run_ocr_browser.mjs [--workers=3] [--bench] [--no-real] [--headed]
 *       [--query="dpi=0&langs=chi_tra"] [--timeout=600000]
 * ========================================================================= */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const cands = ["playwright", process.env.PLAYWRIGHT_MODULE, "/opt/node22/lib/node_modules/playwright"].filter(Boolean);
  for (const c of cands) { try { return req(c); } catch { /* 下一個 */ } }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".pdf": "application/pdf", ".gz": "application/gzip", ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream", ".pbm": "image/x-portable-bitmap", ".xdw": "application/octet-stream"
};

function startServer() {
  const stats = { requests: 0, bytes: 0, byPath: {} };
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
      stats.requests++; stats.bytes += st.size; stats.byPath[p] = (stats.byPath[p] || 0) + 1;
      // 模擬 GitHub Pages：.gz 以 application/gzip 原樣傳送（不加 Content-Encoding）
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size, "Cache-Control": "max-age=600" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats })));
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log("SKIP ocr_browser: 找不到 playwright 模組"); return 0; }
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
  const { server, port, stats } = await startServer();
  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: !args.headed,
      // 任何非本機連線都送到無效的 proxy → 必定失敗（Chromium 預設 loopback 不走 proxy）
      args: ["--proxy-server=http://127.0.0.1:9"]
    });
  } catch (e) {
    server.close();
    console.log("SKIP ocr_browser: 無法啟動 Chromium（" + e.message.split("\n")[0] + "）");
    return 0;
  }
  const external = [];
  const ctx = await browser.newContext();
  // 不用 route()（會停用 HTTP 快取，量不到真實的快取效果）；改為記錄所有請求，非本機的一律算失敗。
  // 實際上非本機連線已被無效 proxy 擋下，這裡是第二道證明。
  const isLocal = (href) => {
    try {
      const u = new URL(href);
      return ["blob:", "data:", "file:"].includes(u.protocol) || u.hostname === "127.0.0.1" || u.hostname === "localhost";
    } catch { return false; }
  };
  ctx.on("request", (req) => { if (!isLocal(req.url())) external.push(req.url()); });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") consoleErrors.push("worker: " + m.text()); }));

  const q = new URLSearchParams(String(args.query || ""));
  if (args.workers) q.set("workers", String(args.workers));
  if (args.bench) q.set("bench", "1");
  if (args["no-real"]) q.set("real", "0");
  const url = `http://127.0.0.1:${port}/tests/fill/ocr_browser_test.html?${q}`;
  const timeout = +args.timeout || 600000;
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__result && window.__result.done, null, { timeout, polling: 500 });
  const R = await page.evaluate(() => window.__result);
  const wall = Date.now() - t0;

  // ---- file:// 開啟：OCR 必須回報不可用（中文原因），PDF 退回主執行緒 ----
  const fpage = await ctx.newPage();
  await fpage.goto(pathToFileURL(path.join(ROOT, "tests/fill/ocr_browser_test.html")).href + "?auto=0");
  const pdfB64 = fs.readFileSync(path.join(ROOT, "tests/fill/fixtures/ocr_text.pdf")).toString("base64");
  const F = await fpage.evaluate(async (b64) => {
    const YF = window.YangFill;
    const out = { ocr: YF.ocr.available(), pdf: YF.pdf.available() };
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await YF.pdf.open(bytes);
      const pg = await doc.getPage(1);
      out.items = (await pg.textItems(200)).map((i) => i.str);
      const img = await pg.render(100);
      out.render = img.width + "x" + img.height;
    } catch (e) { out.err = e.message; }
    try { await YF.ocr.recognize(new Uint8Array([1, 2, 3])); out.rec = "resolved"; } catch (e) { out.rec = e.message; }
    return out;
  }, pdfB64);
  await fpage.close();
  const fileChecks = [
    ["file:// → ocr.available() 不可用（中文原因）", F.ocr.ok === false && /serve\.bat/.test(F.ocr.reason), JSON.stringify(F.ocr)],
    ["file:// → recognize() 以同一原因拒絕", /serve\.bat/.test(F.rec || ""), F.rec],
    ["file:// → pdf 退回主執行緒仍可取文字與繪製", F.pdf.ok && F.pdf.degraded && !!F.items && F.items.includes("0.034") && F.render === "827x1169",
      JSON.stringify({ pdf: F.pdf.degraded, items: F.items, render: F.render, err: F.err })]
  ];

  await browser.close();
  server.close();

  let fail = R.fail;
  for (const r of R.rows) console.log(`${r.status === "ok" ? "ok  " : r.status === "FAIL" ? "FAIL" : "skip"}  ${r.name} — ${r.detail}`);
  for (const [name, ok, det] of fileChecks) { console.log(`${ok ? "ok  " : "FAIL"}  ${name} — ${det}`); if (!ok) fail++; }
  const offline = external.length === 0;
  console.log(`${offline ? "ok  " : "FAIL"}  完全離線（非本機請求 ${external.length} 筆）${external.slice(0, 5).join(" ")}`);
  if (!offline) fail++;
  const coreOk = !!stats.byPath["/lib/tesseract/core/tesseract-core-simd-lstm.wasm.js"] && !!stats.byPath["/lib/tesseract/core/tesseract-core-lstm.wasm.js"];
  console.log(`${coreOk ? "ok  " : "FAIL"}  兩種 wasm 核心（simd-lstm / lstm）都由本機載入`);
  if (!coreOk) fail++;
  const libReq = Object.entries(stats.byPath).filter(([p]) => p.startsWith("/lib/")).map(([p, n]) => `${p}×${n}`);
  console.log("notes:", R.notes.join("\n       "));
  console.log("timings:", JSON.stringify(R.timings));
  console.log("info:", JSON.stringify(R.info));
  console.log(`server: ${stats.requests} requests, ${(stats.bytes / 1048576).toFixed(1)} MB; lib: ${libReq.join(", ")}`);
  if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 10).join(" | "));
  const total = R.pass + R.fail + fileChecks.length + 2;
  console.log(`${fail ? "FAIL" : "PASS"} ocr_browser: ${total - fail}/${total} checks ok, ${R.skip} skipped, ${(wall / 1000).toFixed(1)} s`);
  return fail ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error("FAIL ocr_browser:", e && e.stack || e); process.exit(1); });
