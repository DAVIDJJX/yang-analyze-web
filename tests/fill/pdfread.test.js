/* =========================================================================
 * tests/fill/pdfread.test.js — js/fill/pdfread.js 單元測試（Node）
 *   1. 純函式：itemBox（各種頁面旋轉 / 文字旋轉 / 直書 / 異常字型資料）、effectiveDpi（超大頁面降 dpi）
 *   2. 整合：以 repo 內建的 lib/pdfjs/pdf.min.js 在 Node 開啟合成 PDF（tests/fill/fixtures/ocr_text.pdf），
 *      驗證 textItems 位置、非內嵌中文字型（需 cmaps）、textCharCount、密碼/損毀 PDF 錯誤碼、頁碼檢查。
 *      （繪製需要 canvas，於 tests/fill/run_ocr_browser.mjs 以 Chromium 驗證）
 * 執行：node tests/fill/pdfread.test.js
 * ========================================================================= */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");
const LIB = path.join(ROOT, "lib/pdfjs/pdf.min.js");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, (m || "") + " " + a + " ≈ " + b);

let finished = false;
const watchdog = setTimeout(() => { console.error("FAIL pdfread.test.js: 測試卡住"); process.exit(1); }, 30000);
process.on("exit", (code) => { if (!finished && code === 0) { console.error("FAIL pdfread.test.js: 未跑完就結束"); process.exitCode = 1; } });

const hasLib = fs.existsSync(LIB);
if (hasLib) globalThis.pdfjsLib = require(LIB);
require(path.join(ROOT, "js/fill/pdfread.js"));
const P = globalThis.YangFill.pdf;

function vt(rot, W, H, s) {   // 與 pdf.js PageViewport 相同的轉換矩陣（viewBox 0 0 W H）
  if (rot === 0) return [s, 0, 0, -s, 0, H * s];
  if (rot === 90) return [0, s, s, 0, 0, 0];
  if (rot === 180) return [-s, 0, 0, s, W * s, 0];
  if (rot === 270) return [0, -s, -s, 0, H * s, W * s];
  throw new Error("rot");
}

(async () => {
  /* ---------- itemBox ---------- */
  const s = 200 / 72, W = 595, H = 842;
  const it = { str: "0.034", transform: [12, 0, 0, 12, 100, 700], width: 30, height: 12 };
  const st = { ascent: 0.75, descent: -0.25, vertical: false };
  let b = P.itemBox(it, vt(0, W, H, s), st);
  near(b.x0, 100 * s, 0.01, "rot0 x0"); near(b.x1, 130 * s, 0.01, "rot0 x1");
  near(b.y0, (H - 700 - 9) * s, 0.01, "rot0 y0（基線上 ascent）"); near(b.y1, (H - 700 + 3) * s, 0.01, "rot0 y1（基線下 descent）");
  near(b.fontSize, 12 * s, 0.01, "fontSize px"); ok(b.angle === 0 && !b.vertical, "angle 0");

  b = P.itemBox(it, vt(90, W, H, s), st);           // 頁面順時針轉 90°：文字由上往下
  near(b.x0, (700 - 3) * s, 0.01, "rot90 x0"); near(b.x1, (700 + 9) * s, 0.01, "rot90 x1");
  near(b.y0, 100 * s, 0.01, "rot90 y0"); near(b.y1, 130 * s, 0.01, "rot90 y1"); ok(b.angle === 90, "angle 90");

  b = P.itemBox(it, vt(180, W, H, s), st);
  near(b.x0, (W - 130) * s, 0.01, "rot180 x0"); near(b.x1, (W - 100) * s, 0.01, "rot180 x1");
  near(b.y0, (700 - 3) * s, 0.01, "rot180 y0"); near(b.y1, (700 + 9) * s, 0.01, "rot180 y1");

  b = P.itemBox(it, vt(270, W, H, s), st);
  near(b.x0, (H - 700 - 9) * s, 0.01, "rot270 x0"); near(b.x1, (H - 700 + 3) * s, 0.01, "rot270 x1");
  near(b.y0, (W - 130) * s, 0.01, "rot270 y0"); near(b.y1, (W - 100) * s, 0.01, "rot270 y1");

  // 文字本身旋轉 90°（由下往上），頁面不轉
  const rotIt = { str: "VERT", transform: [0, 16, -16, 0, 500, 300], width: 40, height: 16 };
  b = P.itemBox(rotIt, vt(0, W, H, s), st);
  near(b.y0, (H - 340) * s, 0.01, "旋轉文字 y0"); near(b.y1, (H - 300) * s, 0.01, "旋轉文字 y1");
  near(b.x0, (500 - 12) * s, 0.01, "旋轉文字 x0"); near(b.x1, (500 + 4) * s, 0.01, "旋轉文字 x1"); ok(b.angle === -90, "angle -90");

  // 水平縮放（Tz）與字距：width 已含縮放，box 寬應等於 width
  const tz = { str: "AB", transform: [6, 0, 0, 12, 50, 50], width: 20, height: 12 };
  b = P.itemBox(tz, vt(0, W, H, 1), st);
  near(b.x1 - b.x0, 20, 0.01, "水平縮放寬度"); near(b.fontSize, 12, 0.01, "水平縮放字高");

  // 缺 style / 異常 ascent → 預設 0.8 / -0.2
  b = P.itemBox(it, vt(0, W, H, 1), undefined);
  near(b.y0, H - 700 - 9.6, 0.01, "預設 ascent"); near(b.y1, H - 700 + 2.4, 0.01, "預設 descent");
  b = P.itemBox(it, vt(0, W, H, 1), { ascent: 900, descent: -300 });
  near(b.y0, H - 700 - 9.6, 0.01, "異常字型資料改用預設");
  // 直書
  const vIt = { str: "直書", transform: [12, 0, 0, 12, 100, 700], width: 12, height: 24 };
  b = P.itemBox(vIt, vt(0, W, H, 1), { ascent: 0.8, descent: -0.2, vertical: true });
  ok(b.vertical && b.y1 - b.y0 > b.x1 - b.x0, "直書框為直長");
  near(b.y0, H - 700, 0.01, "直書由原點往下"); near(b.y1, H - 676, 0.01, "直書長度");
  // 沒有 transform / width 0：不得丟例外
  b = P.itemBox({ str: "x" }, vt(0, W, H, 1), st);
  ok(isFinite(b.x0) && b.x0 === b.x1, "缺 transform 不丟例外");

  /* ---------- effectiveDpi ---------- */
  ok(P.effectiveDpi(200, 595.28, 841.89) === 200, "A4 200dpi 不降");
  ok(P.effectiveDpi(300, 841.89, 1190.55) === 300, "A3 300dpi 不降（17.4M 像素）");
  ok(P.effectiveDpi(undefined, 595, 842) === 200 && P.effectiveDpi(-5, 595, 842) === 200, "預設 200");
  const big = P.effectiveDpi(200, 2384, 3370);       // A0
  ok(big < 200 && (2384 * big / 72) * (3370 * big / 72) <= 25e6 + 1, "A0 降 dpi → " + big);
  const banner = P.effectiveDpi(200, 14400, 300);    // 200 吋長條：單邊上限
  ok(14400 * banner / 72 <= 12000 + 1, "單邊上限 → " + banner);
  ok(P.effectiveDpi(200, 1e9, 1e9) >= 1, "極端尺寸 dpi ≥ 1");

  ok(typeof P.available === "function" && P.available().ok === hasLib, "available() 依 lib 是否載入");

  /* ---------- 整合（Node + 內建 pdf.js） ---------- */
  if (!hasLib) {
    console.log("（略過整合測試：找不到 lib/pdfjs/pdf.min.js）");
  } else {
    P.configure({ base: ROOT + "/", workerSrc: path.join(ROOT, "lib/pdfjs/pdf.worker.min.js") });
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/ocr_text.json"), "utf8"));
    const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/ocr_text.pdf")));
    const doc = await P.open(bytes);
    ok(bytes.byteLength > 0 && bytes[0] === 0x25, "open 不轉移呼叫端資料");
    ok(doc.numPages === 3, "numPages");
    const p1 = await doc.getPage(1);
    const exp = spec.pages[0];
    near(p1.widthPt, exp.w, 0.01, "widthPt"); near(p1.heightPt, exp.h, 0.01, "heightPt");
    ok(p1.textCharCount === exp.items.reduce((n, e) => n + e.str.replace(/\s+/g, "").length, 0), "textCharCount " + p1.textCharCount);
    ok(/示範新城/.test(p1.text) && /最大小時平均值/.test(p1.text), "非內嵌中文字型（UniCNS-UCS2-H，需 cmaps）取出文字：" + JSON.stringify(p1.text));
    const items = await p1.textItems(200);
    for (const e of exp.items) {
      const t = items.find((i) => i.str === e.str);
      ok(!!t, "找到「" + e.str + "」");
      ok(t.dpi === 200, "item.dpi");
      if (e.rot) {
        near(t.y0, (exp.h - e.y - e.w) * s, 1, e.str + " y0"); near(t.y1, (exp.h - e.y) * s, 1, e.str + " y1");
        ok(t.x0 < e.x * s && t.x1 > e.x * s, e.str + " 基線在框內");
      } else {
        near(t.x0, e.x * s, 1, e.str + " x0"); near(t.x1, (e.x + e.w) * s, 1, e.str + " x1");
        const base = (exp.h - e.y) * s;
        ok(t.y0 < base && t.y1 > base && base - t.y0 > e.size * s * 0.6, e.str + " 基線在框內");
        near(t.fontSize, e.size * s, 0.5, e.str + " fontSize");
      }
    }
    const p2 = await doc.getPage(2);
    ok(p2.rotate === 90 && Math.round(p2.widthPt) === 595 && Math.round(p2.heightPt) === 842, "/Rotate 90 → 顯示為直式");
    const it2 = (await p2.textItems(200))[0];
    ok(it2 && it2.str === "0.029" && it2.angle === 90 && it2.y1 - it2.y0 > it2.x1 - it2.x0, "旋轉頁文字框 " + JSON.stringify(it2));
    near(it2.y0, 100 * s, 1, "旋轉頁 y0"); near(it2.x1, (400 + 24 * 0.718) * s, 3, "旋轉頁 x1");
    const p3 = await doc.getPage(3);
    ok(Math.round(p3.widthPt) === 842 && p3.textCharCount === 8, "橫式頁");
    ok((await doc.getPage(1)) === p1, "getPage 快取");
    for (const bad of [0, 4, 1.5, "x", NaN]) {
      const e = await doc.getPage(bad).then(() => null, (x) => x);
      ok(e instanceof RangeError && /頁碼/.test(e.message), "getPage(" + bad + ") RangeError");
    }
    const re = await p1.render(200).then(() => null, (x) => x);
    ok(re && /canvas/.test(re.message), "Node 沒有 canvas → 中文錯誤：" + (re && re.message));
    const info = await doc.getInfo();
    ok(/ReportLab/.test(info.producer) && info.title === "ocr_text synthetic fixture", "getInfo");
    await doc.destroy();
    await doc.destroy();
    const ed = await doc.getPage(1).then(() => null, (x) => x);
    ok(ed && /已關閉/.test(ed.message), "destroy 後拒絕");

    // ArrayBuffer 輸入、subarray 輸入（只取視窗範圍）
    const padded = new Uint8Array(bytes.length + 20); padded.set(bytes, 10);
    const d2 = await P.open(padded.subarray(10, 10 + bytes.length));
    ok(d2.numPages === 3, "subarray 輸入");
    await d2.destroy();
    const d3 = await P.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    ok(d3.numPages === 3, "ArrayBuffer 輸入");
    await d3.destroy();

    const pw = await P.open(new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/ocr_pw.pdf")))).then(() => null, (x) => x);
    ok(pw && pw.code === "password" && /密碼/.test(pw.message), "密碼 PDF → code password");
    const pwOk = await P.open(new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/ocr_pw.pdf"))), { password: "secret" });
    const pwText = (await (await pwOk.getPage(1)).textItems(72)).map((i) => i.str).join("|");
    ok(pwText === "locked 1.23", "提供正確密碼可開啟：" + pwText);
    await pwOk.destroy();
    const inv = await P.open(new TextEncoder().encode("%PDF-1.4\ngarbage\n%%EOF")).then(() => null, (x) => x);
    ok(inv && inv.code === "invalid", "損毀 PDF → code invalid：" + (inv && inv.message));
    const trunc = await P.open(bytes.slice(0, 1200)).then((d) => d.getPage(1).then((pg) => pg.textItems()).then(() => "ok", () => "page-error"), (x) => x.code);
    ok(trunc === "invalid" || trunc === "error" || trunc === "page-error" || trunc === "ok", "截斷 PDF 不會卡住：" + trunc);
    const empty = await P.open(new Uint8Array(0)).then(() => null, (x) => x);
    ok(empty && empty.code === "invalid", "空檔案");
    const notBytes = await P.open("abc").then(() => null, (x) => x);
    ok(notBytes && /位元組/.test(notBytes.message), "非位元組輸入");
  }

  finished = true;
  clearTimeout(watchdog);
  console.log("PASS pdfread.test.js: " + checks + " checks" + (hasLib ? "" : "（整合略過）"));
})().catch((e) => {
  console.error("FAIL pdfread.test.js:", e && e.stack || e);
  process.exit(1);
});
