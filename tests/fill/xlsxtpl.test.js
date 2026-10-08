/* =========================================================================
 * Yang-analyze web — tests/fill/xlsxtpl.test.js
 * js/fill/xlsxtpl.js 的 Node 測試（只用內建模組 + repo 內的 lib/xlsx.full.min.js）：
 *   node tests/fill/xlsxtpl.test.js
 * load（區塊切分、標題列、合併、公式、CSV/HTML/.xls）與數值判斷不需要 DOM，可在 Node 測；
 * .xlsx 填寫要 DOMParser，由瀏覽器測試（tests/fill/office_browser_test.html）負責。
 * ========================================================================= */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.resolve(__dirname, "..", "..");
globalThis.XLSX = require(path.join(ROOT, "lib/xlsx.full.min.js"));
require(path.join(ROOT, "js/fill/zip.js"));
require(path.join(ROOT, "js/fill/xlsxtpl.js"));
var YF = globalThis.YangFill, XL = globalThis.XLSX;

var passed = 0, failed = 0, queue = [];
function test(name, fn) { queue.push({ name: name, fn: fn }); }
async function run() {
  for (var i = 0; i < queue.length; i++) {
    try { await queue[i].fn(); passed++; }
    catch (e) { failed++; console.error("FAIL " + queue[i].name + "\n  " + (e && e.stack || e)); }
  }
  if (failed) { console.error("xlsxtpl.test.js: " + failed + " FAILED, " + passed + " passed"); process.exit(1); }
  console.log("xlsxtpl.test.js PASS (" + passed + " tests)");
}
function cellAt(t, r, c) { return t.cells.filter(function (x) { return x.r0 === r && x.c0 === c; })[0] || null; }
function wbBytes(sheets, opts) {
  var wb = XL.utils.book_new();
  sheets.forEach(function (s) {
    var ws = XL.utils.aoa_to_sheet(s.aoa);
    if (s.merges) ws["!merges"] = s.merges.map(function (m) { return XL.utils.decode_range(m); });
    if (s.extra) s.extra(ws);
    XL.utils.book_append_sheet(wb, ws, s.name);
  });
  return new Uint8Array(XL.write(wb, Object.assign({ bookType: "xlsx", type: "array" }, opts || {})));
}

test("數值判斷：只有標準十進位數字寫成數值，並決定小數位數格式", function () {
  var N = YF.xlsx._numericInfo;
  assert.deepStrictEqual([N("0.001").code, N("0.001").v, N("0.001").decimals], ["0.000", "0.001", 3]);
  assert.deepStrictEqual([N("2.20").code, N("2.20").v], ["0.00", "2.2"]);
  assert.deepStrictEqual([N("19").code, N("-3.5").code, N("0").code], ["0", "0.0", "0"]);
  ["<10", "ND", "-", "", ".5", "1e3", "007", "1,200", "-0", "-0.00", "12345678901234567", "0x10", " 1"].forEach(function (s) {
    if (s === " 1") assert.ok(N(s), "前後空白可接受"); else assert.strictEqual(N(s), null, s);
  });
  assert.strictEqual(YF.xlsx._addr(0, 0), "A1");
  assert.strictEqual(YF.xlsx._addr(9, 27), "AB10");
  assert.deepStrictEqual(YF.xlsx._parseAddr("$AB$10"), { r: 9, c: 27 });
});

test("合成範本 office_tpl.xlsx.bin：區塊、標題列、合併、空白格、公式", async function () {
  var m = await YF.xlsx.load(new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/office_tpl.xlsx.bin"))), "範本.xlsx");
  assert.strictEqual(m.format, "ooxml");
  assert.strictEqual(m.kind, "xlsx");
  assert.deepStrictEqual(m.tables.map(function (t) { return [t.id, t.title, t.nRows, t.nCols, t.range]; }), [
    ["s:空氣品質:b0", "表1 測試站甲空氣品質彙整", 5, 6, "A3:F7"],
    ["s:空氣品質:b1", "表2 測試站乙", 2, 3, "A11:C12"],
    ["s:噪音:b0", "噪音", 3, 3, "A1:C3"]]);
  var t = m.tables[0];
  assert.deepStrictEqual([cellAt(t, 0, 0).r1, cellAt(t, 0, 1).c1], [1, 2]);
  assert.strictEqual(cellAt(t, 4, 5).text, "=E7*2");
  assert.strictEqual(t.cells.filter(function (c) { return !c.text; }).length, 5);
  assert.ok(/2 張工作表、3 個表格區塊/.test(m.info), m.info);
});

test("區塊切分：≥2 空列 / ≥2 空欄分開、單一空列不分、全空列欄略過、跨列標題", async function () {
  var aoa = [
    ["表A 左邊", null, null, null, null, "右邊表頭", "X"],
    [null],
    ["季別", "SO2", "NO2", null, null, "1", "2"],
    ["115年第三季", null, null],
    [null],                                        // 單一空列：不分開，且略過
    ["114年第三季", 0.1, 0.2],
    [null], [null],                                // 兩列空白 → 新區塊
    ["第二區", "值"],
    ["a", 1]
  ];
  var bytes = wbBytes([{ name: "S", aoa: aoa }]);
  var m = await YF.xlsx.load(bytes, "t.xlsx");
  var ids = m.tables.map(function (t) { return t.range; });
  assert.deepStrictEqual(ids, ["A3:C6", "F1:G3", "A9:B10"], JSON.stringify(ids));
  var a = m.tables[0];
  assert.strictEqual(a.title, "表A 左邊", "表 開頭 → 標題");
  assert.strictEqual(a.nRows, 3, "第 5 列（空）略過");
  assert.strictEqual(cellAt(a, 2, 0).text, "114年第三季");
  assert.strictEqual(cellAt(a, 1, 1).text, "", "空白待填格存在");
  assert.strictEqual(cellAt(a, 1, 1).ref.addr, "B4");
  assert.strictEqual(m.tables[1].title, "S", "右側區塊無標題 → 工作表名");
  assert.strictEqual(m.tables[2].index, 2);
});

test("標題偵測：合併跨列的標題、非標題的單格表頭不誤判", async function () {
  var bytes = wbBytes([
    { name: "A", aoa: [["監測結果彙整表"], [null], ["項目", "值"], ["SO2", 1]], merges: ["A1:B2"] },
    { name: "B", aoa: [["項目", null], ["SO2", 1], ["NO2", 2]] },
    { name: "C", aoa: [["噪音dB(A)", null, null], ["Leq", "L日", "L夜"], [1, 2, 3]], merges: ["A1:C1"] }
  ]);
  var m = await YF.xlsx.load(bytes, "t.xlsx");
  var A = m.tables[0], B = m.tables[1], C = m.tables[2];
  assert.strictEqual(A.title, "監測結果彙整表"); assert.strictEqual(A.nRows, 2, "跨兩列的標題整個移除");
  assert.strictEqual(cellAt(A, 0, 0).text, "項目");
  assert.strictEqual(B.title, "B"); assert.strictEqual(cellAt(B, 0, 0).text, "項目", "短的單格表頭不當標題");
  assert.strictEqual(C.title, "C", "緊貼表格的合併表頭（非「表」開頭）保留為儲存格");
  assert.strictEqual(cellAt(C, 0, 0).c1, 2);
});

test("合併範圍 → 跨距（含被略過的空列）、隱藏工作表", async function () {
  var bytes = wbBytes([{ name: "M", aoa: [["項目", "SO2", null], ["站", "小時", "日"], ["甲", null, null], ["乙", 1, 2]],
    merges: ["B1:C1", "A3:A4"] }, { name: "H", aoa: [["x"]] }]);
  // 標記第二張為隱藏
  var wb = XL.read(bytes, { type: "array" });
  wb.Workbook = wb.Workbook || {}; wb.Workbook.Sheets = [{ Hidden: 0 }, { Hidden: 1 }];
  bytes = new Uint8Array(XL.write(wb, { bookType: "xlsx", type: "array" }));
  var m = await YF.xlsx.load(bytes, "m.xlsx");
  var t = m.tables[0];
  assert.deepStrictEqual([cellAt(t, 0, 1).c0, cellAt(t, 0, 1).c1], [1, 2]);
  assert.deepStrictEqual([cellAt(t, 2, 0).r0, cellAt(t, 2, 0).r1, cellAt(t, 2, 0).text], [2, 3, "甲"]);
  assert.strictEqual(cellAt(t, 3, 0), null, "合併範圍內非左上角");
  assert.ok(m.tables[1].hidden && m.sheets[1].hidden);
});

test("無快取值的公式不算空白；數字依格式顯示", async function () {
  var bytes = wbBytes([{ name: "F", aoa: [["a", "b"], [1.5, 2]], extra: function (ws) {
    ws.C2 = { t: "n", f: "A2+B2" };             // 無快取值
    ws.D2 = { t: "n", v: 0.0123, z: "0.000" };
    ws["!ref"] = "A1:D2";
  } }]);
  var m = await YF.xlsx.load(bytes, "f.xlsx");
  var t = m.tables[0];
  assert.strictEqual(cellAt(t, 1, 2).text, "=A2+B2");
  assert.strictEqual(cellAt(t, 1, 3).text, "0.012");
});

test("CSV（UTF-8 / Big5 / BOM）、HTML 表格、.xls 載入；CSV 填寫（不需 DOM）", async function () {
  var csv = new TextEncoder().encode("﻿季別,SO2\r\n115年第三季,\r\n");
  var m = await YF.xlsx.load(csv, "a.csv");
  assert.strictEqual(m.kind, "csv"); assert.strictEqual(cellAt(m.tables[0], 1, 0).text, "115年第三季");
  var big5 = new Uint8Array([0xA9, 0x75, 0xA7, 0x4F, 0x2C, 0x53, 0x4F, 0x32, 0x0D, 0x0A, 0x31, 0x2C, 0x32]); // 季別,SO2\r\n1,2
  var mb = await YF.xlsx.load(big5, "b.csv");
  assert.strictEqual(cellAt(mb.tables[0], 0, 0).text, "季別", "Big5 CSV");
  var res = await YF.xlsx.fill(m, [{ tableId: m.tables[0].id, r0: 1, c0: 1, value: " 0.001 " }]);
  assert.strictEqual(res.ext, "csv");
  var txt = new TextDecoder("utf-8", { ignoreBOM: true }).decode(res.bytes);
  assert.ok(txt.charCodeAt(0) === 0xFEFF && /115年第三季,0\.001/.test(txt), txt);
  var html = new TextEncoder().encode("<table><tr><td>季別</td><td>NO2</td></tr><tr><td>115年第三季</td><td></td></tr></table>");
  var mh = await YF.xlsx.load(html, "h.xls");
  assert.strictEqual(mh.kind, "html"); assert.strictEqual(cellAt(mh.tables[0], 0, 1).text, "NO2");
  var rh = await YF.xlsx.fill(mh, [{ tableId: mh.tables[0].id, r0: 1, c0: 1, value: "0.01" }]);
  assert.strictEqual(rh.ext, "xls");
  assert.strictEqual(XL.read(rh.bytes, { type: "array" }).Sheets[XL.read(rh.bytes, { type: "array" }).SheetNames[0]].B2.v, 0.01);
  var xlsPath = path.join(__dirname, "fixtures/office_tpl.xls.bin");
  if (fs.existsSync(xlsPath)) {
    var mx = await YF.xlsx.load(new Uint8Array(fs.readFileSync(xlsPath)), "x.xls");
    assert.strictEqual(mx.kind, "xls"); assert.strictEqual(mx.format, "sheetjs");
    assert.strictEqual(mx.tables[0].title, "表1 測試站甲空氣品質彙整");
    var w = [];
    var rx = await YF.xlsx.fill(mx, [{ tableId: mx.tables[0].id, r0: 2, c0: 1, value: "0.001" }, { tableId: mx.tables[0].id, r0: 2, c0: 4, value: "<10" }], { warnings: w });
    assert.strictEqual(rx.ext, "xls");
    assert.ok(w.some(function (x) { return /格式可能遺失/.test(x); }));
    var ws = XL.read(rx.bytes, { type: "array", cellNF: true }).Sheets["空氣品質"];
    assert.strictEqual(ws.B5.v, 0.001); assert.strictEqual(XL.utils.format_cell(ws.B5), "0.001"); assert.strictEqual(ws.E5.v, "<10");
  }
});

test("錯誤：沒有 DOMParser 時 .xlsx 填寫回報中文錯誤；找不到表格/儲存格 → 警告", async function () {
  var bytes = wbBytes([{ name: "S", aoa: [["a", "b"], ["c", null]] }]);
  var m = await YF.xlsx.load(bytes, "s.xlsx");
  var w = [];
  try { await YF.xlsx.fill(m, [{ tableId: m.tables[0].id, r0: 1, c0: 1, value: "1" }, { tableId: "nope", r0: 0, c0: 0, value: "1" },
    { tableId: m.tables[0].id, r0: 50, c0: 0, value: "1" }], { warnings: w }); assert.fail("應丟出錯誤"); }
  catch (e) { assert.ok(/DOMParser/.test(e.message) && /[一-鿿]/.test(e.message), e.message); }
  assert.ok(w.some(function (x) { return /找不到表格 nope/.test(x); }));
  assert.ok(w.some(function (x) { return /找不到第 51 列/.test(x); }));
  var saved = globalThis.XLSX; delete globalThis.XLSX;
  try { await YF.xlsx.load(bytes, "s.xlsx"); assert.fail("應丟出錯誤"); }
  catch (e) { assert.ok(/SheetJS/.test(e.message), e.message); }
  finally { globalThis.XLSX = saved; }
});

test("效能：5 萬格工作表 load < 3 s", async function () {
  var aoa = [];
  for (var r = 0; r < 2000; r++) { var row = []; for (var c = 0; c < 25; c++) row.push(r && c ? r * c : "h" + c); aoa.push(row); }
  var bytes = wbBytes([{ name: "大", aoa: aoa }]);
  var t0 = Date.now();
  var m = await YF.xlsx.load(bytes, "big.xlsx");
  assert.strictEqual(m.tables[0].cells.length, 50000);
  assert.ok(Date.now() - t0 < 3000, (Date.now() - t0) + " ms");
});

run();
