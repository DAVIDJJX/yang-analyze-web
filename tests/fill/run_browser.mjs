/* =========================================================================
 * Yang-analyze web — tests/fill/run_browser.mjs
 * 以 Playwright（Chromium headless）執行瀏覽器端測試頁，並把結果印到終端機。
 *   node tests/fill/run_browser.mjs [測試頁=tests/fill/office_browser_test.html] [--out 目錄] [--timeout 毫秒]
 * 會在本機起一個極簡 http 伺服器（隨機空埠）提供 repo 根目錄，開啟測試頁後等待
 * window.__TEST_DONE__，讀取 window.__TEST_RESULTS__ = [{name, ok, msg}]；
 * 有失敗 → exit 1。--out 會把測試頁產生的檔案（window.__OUTPUTS__ = {檔名: base64}）存到該目錄，
 * 方便再用 LibreOffice / python-docx / openpyxl 人工驗證（輸出可能含真實資料，切勿存進 repo）。
 * 找不到 Playwright 或瀏覽器時印出 SKIP 並以 0 結束。
 * ========================================================================= */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
let page = "tests/fill/office_browser_test.html", outDir = null, timeout = 180000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = path.resolve(args[++i]);
  else if (args[i] === "--timeout") timeout = parseInt(args[++i], 10) || timeout;
  else page = args[i];
}
page = path.relative(ROOT, path.resolve(ROOT, page)).split(path.sep).join("/");

/* ---------------- 找 Playwright（本地 → 全域） ---------------- */
async function loadPlaywright() {
  try { return await import("playwright"); } catch (e) { /* 試全域 */ }
  const roots = [];
  if (process.env.PLAYWRIGHT_MODULE) roots.push(process.env.PLAYWRIGHT_MODULE);
  try { roots.push(path.join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")); } catch (e) { /* 無 npm */ }
  roots.push("/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright");
  const req = createRequire(import.meta.url);
  for (const r of roots) {
    try { if (fs.existsSync(r)) return req(r); } catch (e) { /* 下一個 */ }
  }
  return null;
}

/* ---------------- 極簡靜態伺服器 ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".gz": "application/gzip" };
function serve() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.resolve(ROOT, "." + p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
                         "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw || !pw.chromium) { console.log("SKIP: 找不到 Playwright（npm i -g playwright 後再試）"); return 0; }
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) { console.log("SKIP: 無法啟動 Chromium（" + String(e.message).split("\n")[0] + "）"); return 0; }
  const srv = await serve();
  const url = "http://127.0.0.1:" + srv.address().port + "/" + page;
  let code = 0;
  try {
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    const pageErrors = [];
    tab.on("pageerror", (e) => pageErrors.push(String(e && e.stack || e)));
    tab.on("console", (m) => { if (m.type() === "error") console.log("[console] " + m.text()); });
    await tab.goto(url);
    await tab.waitForFunction(() => window.__TEST_DONE__ === true, null, { timeout });
    const results = await tab.evaluate(() => window.__TEST_RESULTS__ || []);
    let pass = 0, fail = 0;
    for (const r of results) {
      if (r.ok) { pass++; console.log("PASS " + r.name + (r.msg ? "  (" + r.msg + ")" : "")); }
      else { fail++; console.log("FAIL " + r.name + "\n     " + r.msg); }
    }
    for (const e of pageErrors) { fail++; console.log("FAIL 頁面錯誤: " + e); }
    if (outDir) {
      const outs = await tab.evaluate(() => window.__OUTPUTS__ || {});
      fs.mkdirSync(outDir, { recursive: true });
      for (const [name, b64] of Object.entries(outs)) fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, "base64"));
      console.log("輸出 " + Object.keys(outs).length + " 個檔案到 " + outDir);
    }
    if (!results.length) { fail++; console.log("FAIL 測試頁沒有回報任何結果"); }
    console.log(page + ": " + (fail ? fail + " FAILED, " : "") + pass + " passed");
    code = fail ? 1 : 0;
  } catch (e) {
    console.log("FAIL " + (e && e.message || e));
    code = 1;
  } finally {
    await browser.close();
    srv.close();
  }
  return code;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
