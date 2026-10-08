/* =========================================================================
 * tests/fill/grid.test.js — YF.grid（掃描頁表格結構偵測）單元測試
 * 執行：node tests/fill/grid.test.js
 * 全部使用程式畫出的合成影像；若本機有 test_data/fill/pages/*.pbm（真實樣本，不進 repo）
 * 會額外跑真實頁面驗證。
 * ========================================================================= */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

require("../../js/fill/grid.js");
var G = globalThis.YangFill.grid;

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; failures.push(name + "：" + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e)); }
}

/* ---------------- 合成影像工具 ---------------- */
function makeBin(w, h) { return { width: w, height: h, data: new Uint8Array(w * h) }; }
function setPx(b, x, y) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < b.width && y < b.height) b.data[y * b.width + x] = 1; }
function clearPx(b, x, y) { if (x >= 0 && y >= 0 && x < b.width && y < b.height) b.data[y * b.width + x] = 0; }
function fillRect(b, x0, y0, x1, y1) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) setPx(b, x, y); }
/** 任意方向粗線：沿主軸逐點、在次軸畫 t 個像素 */
function line(b, x0, y0, x1, y1, t) {
  t = t || 2;
  var dx = x1 - x0, dy = y1 - y0, n = Math.max(Math.abs(dx), Math.abs(dy)), k, j;
  var horiz = Math.abs(dx) >= Math.abs(dy);
  for (k = 0; k <= n; k++) {
    var x = x0 + dx * k / n, y = y0 + dy * k / n;
    for (j = 0; j < t; j++) {
      if (horiz) setPx(b, x, Math.floor(y) + j - (t >> 1)); else setPx(b, Math.floor(x) + j - (t >> 1), y);
    }
  }
}
/** 以 (cx,cy) 為中心旋轉 deg 度的座標轉換 */
function rot(deg, cx, cy) {
  var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return function (x, y) { return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]; };
}
/**
 * 畫表格：xs/ys 為邊界座標，cells = [[r0,c0,r1,c1],...]（需鋪滿整個格網）；逐格畫四邊。
 * opts: {t: 線寬, angle: 旋轉角, outer: 外框線寬}
 */
function drawTable(b, xs, ys, cells, opts) {
  opts = opts || {};
  var t = opts.t || 2, T = rot(opts.angle || 0, (xs[0] + xs[xs.length - 1]) / 2, (ys[0] + ys[ys.length - 1]) / 2);
  function seg(xa, ya, xb, yb, th) { var p = T(xa, ya), q = T(xb, yb); line(b, p[0], p[1], q[0], q[1], th); }
  cells.forEach(function (c) {
    var x0 = xs[c[1]], x1 = xs[c[3] + 1], y0 = ys[c[0]], y1 = ys[c[2] + 1];
    seg(x0, y0, x1, y0, t); seg(x0, y1, x1, y1, t); seg(x0, y0, x0, y1, t); seg(x1, y0, x1, y1, t);
  });
  if (opts.outer) {
    var X0 = xs[0], X1 = xs[xs.length - 1], Y0 = ys[0], Y1 = ys[ys.length - 1];
    seg(X0, Y0, X1, Y0, opts.outer); seg(X0, Y1, X1, Y1, opts.outer); seg(X0, Y0, X0, Y1, opts.outer); seg(X1, Y0, X1, Y1, opts.outer);
  }
  return T;
}
/** 規則格網的所有 1×1 格，扣掉被合併格覆蓋者，再加上合併格 */
function gridCells(nr, nc, merges) {
  var covered = {}, out = [];
  (merges || []).forEach(function (m) {
    for (var r = m[0]; r <= m[2]; r++) for (var c = m[1]; c <= m[3]; c++) covered[r + "," + c] = true;
    out.push(m);
  });
  for (var r = 0; r < nr; r++) for (var c = 0; c < nc; c++) if (!covered[r + "," + c]) out.push([r, c, r, c]);
  return out;
}
function seq(start, step, n) { var a = []; for (var i = 0; i < n; i++) a.push(start + step * i); return a; }
/** 假文字：在格內畫幾個 2px 筆畫組成的「字」（含封閉小框，模擬 0/8/口） */
function fakeText(b, x, y, nChars, ch, rng) {
  ch = ch || 18;
  var cw = Math.round(ch * 0.6);
  for (var i = 0; i < nChars; i++) {
    var X = x + i * (cw + 5);
    var kind = rng ? Math.floor(rng() * 3) : i % 3;
    if (kind === 0) { line(b, X, y, X + cw, y, 2); line(b, X, y + ch, X + cw, y + ch, 2); line(b, X, y, X, y + ch, 2); line(b, X + cw, y, X + cw, y + ch, 2); }
    else if (kind === 1) { line(b, X + cw / 2, y, X + cw / 2, y + ch, 2); line(b, X, y + ch / 2, X + cw, y + ch / 2, 2); }
    else { line(b, X, y, X + cw, y + ch, 2); line(b, X + cw, y, X, y + ch, 2); }
  }
}
function lcg(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function specks(b, n, rng, size) {
  for (var i = 0; i < n; i++) {
    var x = Math.floor(rng() * b.width), y = Math.floor(rng() * b.height), s = size || 1;
    fillRect(b, x, y, x + s - 1, y + s - 1);
  }
}
function spanSet(cells) { return cells.map(function (c) { return [c.r0, c.c0, c.r1, c.c1].join(","); }).sort(); }
function expSet(cells) { return cells.map(function (c) { return c.join(","); }).sort(); }
function assertSpans(t, cells, nr, nc, msg) {
  assert.deepStrictEqual(spanSet(t.cells), expSet(cells), (msg || "") + " 儲存格跨距不符");
  assert.strictEqual(t.nRows, nr, (msg || "") + " nRows");
  assert.strictEqual(t.nCols, nc, (msg || "") + " nCols");
}

/* ---------------- 基本格網 ---------------- */
test("3×4 規則格網：12 格、跨距正確、依 (r0,c0) 排序", function () {
  var b = makeBin(800, 500), xs = seq(100, 150, 5), ys = seq(100, 80, 4);
  var cells = gridCells(3, 4);
  drawTable(b, xs, ys, cells);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  var t = r.tables[0];
  assertSpans(t, cells, 3, 4);
  for (var i = 1; i < t.cells.length; i++) {
    var a = t.cells[i - 1], c = t.cells[i];
    assert.ok(a.r0 < c.r0 || (a.r0 === c.r0 && a.c0 < c.c0), "排序");
  }
  // 邊界座標接近畫線位置
  t.xs.forEach(function (x, i) { assert.ok(Math.abs(x - xs[i]) <= 2, "xs " + x + " vs " + xs[i]); });
  t.ys.forEach(function (y, i) { assert.ok(Math.abs(y - ys[i]) <= 2, "ys " + y + " vs " + ys[i]); });
  // bbox 在格線內側
  var c0 = t.cells[0].bbox;
  assert.ok(c0.x0 > 100 && c0.x0 < 110 && c0.x1 < 250 && c0.x1 > 240, JSON.stringify(c0));
  // 遮罩：線上的墨點有 bit
  assert.ok(r.mask[100 * 800 + 175] & G.BIT_H, "水平線 bit1");
  assert.ok(r.mask[140 * 800 + 100] & G.BIT_V, "垂直線 bit2");
  assert.ok(r.tables[0].bbox.x0 <= 100 && r.tables[0].bbox.x1 >= 700);
});

test("合併儲存格：表頭橫跨全欄、跨 2 列、2×2 合併、跨 24 列的長格", function () {
  var nr = 28, nc = 6, b = makeBin(1000, 1500);
  var xs = seq(80, 140, nc + 1), ys = seq(60, 46, nr + 1);
  var merges = [[0, 0, 0, 5], [1, 0, 2, 0], [3, 2, 4, 3], [2, 5, 25, 5]];
  var cells = gridCells(nr, nc, merges);
  drawTable(b, xs, ys, cells);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, nr, nc);
});

test("斷線：內部線缺口 8px、T 字缺口 4px、轉角缺口 → 仍正確分格", function () {
  var b = makeBin(900, 500), xs = seq(100, 170, 5), ys = seq(100, 90, 4);
  var cells = gridCells(3, 4);
  drawTable(b, xs, ys, cells);
  var y, x;
  // 內部水平線（y=190）在 x=300..307 斷開
  for (x = 300; x <= 307; x++) for (y = 187; y <= 192; y++) clearPx(b, x, y);
  // 內部垂直線（x=270）在接近上框處短 4px（T 字缺口）
  for (y = 98; y <= 104; y++) for (x = 267; x <= 272; x++) clearPx(b, x, y);
  // 右下轉角兩條線都不到位
  for (y = 365; y <= 375; y++) for (x = 772; x <= 785; x++) clearPx(b, x, y);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 3, 4);
});

test("粗外框（7px）與細內線（1px）並存", function () {
  var b = makeBin(900, 600), xs = seq(100, 160, 5), ys = seq(100, 70, 6);
  var cells = gridCells(5, 4, [[0, 0, 0, 3]]);
  drawTable(b, xs, ys, cells, { t: 1, outer: 7 });
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 5, 4);
});

[0.5, -0.5, 1.0, 1.6].forEach(function (deg) {
  test("歪斜 " + deg + "°：表格仍正確（含合併格），估計角度接近", function () {
    var nr = 20, nc = 8, b = makeBin(1654, 1400);
    var xs = seq(150, 165, nc + 1), ys = seq(120, 55, nr + 1);
    var cells = gridCells(nr, nc, [[0, 0, 0, 7], [1, 0, 3, 0], [5, 7, 18, 7], [6, 2, 7, 4]]);
    drawTable(b, xs, ys, cells, { t: 2, angle: deg });
    var r = G.detectTables(b, { dpi: 200 });
    assert.strictEqual(r.tables.length, 1, "表格數");
    assertSpans(r.tables[0], cells, nr, nc, deg + "°");
    assert.ok(Math.abs(r.angle - deg) < 0.15, "角度 " + r.angle);
    assert.ok(Math.abs(G.deskewAngle(b, { dpi: 200 }) - deg) < 0.15, "deskewAngle");
  });
});

test("雜點、格內假文字（含封閉小框）、斜線：不產生多餘儲存格", function () {
  var rng = lcg(7), b = makeBin(1200, 900);
  var xs = seq(100, 250, 5), ys = seq(100, 60, 11);
  var cells = gridCells(10, 4, [[0, 0, 0, 0]]);
  drawTable(b, xs, ys, cells);
  // 角落格畫對角斜線（如「項目/時間」）
  line(b, xs[0], ys[0], xs[1], ys[1], 2);
  // 每格放假文字
  cells.forEach(function (c) {
    if (c[0] === 0 && c[1] === 0) return;
    fakeText(b, xs[c[1]] + 20, ys[c[0]] + 18, 6, 22, rng);
  });
  specks(b, 3000, rng, 1);
  specks(b, 300, rng, 2);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 10, 4);
});

test("字間 ≤3px 的長串筆畫（易被誤判為橫線）不會切開儲存格，且不進遮罩", function () {
  var b = makeBin(1000, 400), xs = [100, 700, 900], ys = [100, 200, 300];
  var cells = gridCells(2, 2);
  drawTable(b, xs, ys, cells);
  // 第一格內一串「字」：每字頂端都有橫筆、字距 3px → 會串成 >58px 的橫段
  for (var i = 0; i < 20; i++) {
    var X = 112 + i * 29;
    line(b, X, 130, X + 25, 130, 2); line(b, X + 12, 130, X + 12, 165, 2); line(b, X, 165, X + 25, 165, 2);
  }
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 2, 2);
  // 遮罩不應抹掉格內文字筆畫
  var masked = 0;
  for (var y = 125; y <= 170; y++) for (var x = 115; x <= 690; x++) if (r.mask[y * 1000 + x]) masked++;
  assert.strictEqual(masked, 0, "格內文字被當成線：" + masked);
  var ink = G.cellInk(b, r.mask, r.tables[0].cells[0].bbox, 3);
  assert.ok(ink.count > 1000 && ink.bbox.x0 <= 113 && ink.bbox.x1 >= 660, JSON.stringify(ink));
});

test("上下兩表相距 30px → 2 個表；共用框線 → 1 個表", function () {
  var b = makeBin(900, 800);
  var c1 = gridCells(3, 3), c2 = gridCells(2, 4);
  drawTable(b, seq(100, 200, 4), seq(80, 60, 4), c1);
  drawTable(b, seq(100, 150, 5), seq(290, 60, 3), c2);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 2);
  assertSpans(r.tables[0], c1, 3, 3, "上表");
  assertSpans(r.tables[1], c2, 2, 4, "下表");
  assert.ok(r.tables[0].bbox.y1 < r.tables[1].bbox.y0, "由上而下排序");

  var b2 = makeBin(900, 800);
  drawTable(b2, seq(100, 200, 4), seq(80, 60, 4), c1);
  drawTable(b2, seq(100, 150, 5), seq(260, 60, 3), c2);   // 上表底線 = 下表頂線
  var r2 = G.detectTables(b2, { dpi: 200 });
  assert.strictEqual(r2.tables.length, 1);
  assert.strictEqual(r2.tables[0].cells.length, 9 + 8);
});

test("左右並排相距 20px → 2 個表", function () {
  var b = makeBin(1200, 500);
  var c1 = gridCells(3, 2), c2 = gridCells(4, 3);
  drawTable(b, seq(60, 200, 3), seq(80, 70, 4), c1);
  drawTable(b, seq(480, 200, 4), seq(80, 60, 5), c2);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 2);
  var byX = r.tables.slice().sort(function (a, c) { return a.bbox.x0 - c.bbox.x0; });
  assertSpans(byX[0], c1, 3, 2, "左表");
  assertSpans(byX[1], c2, 4, 3, "右表");
});

test("格內印章（自帶格線的小框）視為巢狀而略過，不影響外表結構", function () {
  var b = makeBin(1000, 700), xs = seq(100, 200, 5), ys = [100, 160, 220, 600];
  var cells = gridCells(3, 4, [[2, 0, 2, 3]]);
  drawTable(b, xs, ys, cells);
  // 大格（備註）內一個 3 格印章
  drawTable(b, [500, 640, 760], [300, 360, 450], gridCells(2, 2, [[0, 0, 0, 1]]), { t: 3 });
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1, "印章不應成為表格");
  assertSpans(r.tables[0], cells, 3, 4);
  assert.strictEqual(r.nested.length, 1, "記錄 1 個巢狀");
});

test("單一大框（<2 格）不算表格；頁框內的表格照常偵測", function () {
  var b = makeBin(900, 900);
  line(b, 50, 50, 850, 50, 3); line(b, 50, 850, 850, 850, 3); line(b, 50, 50, 50, 850, 3); line(b, 850, 50, 850, 850, 3);
  var r0 = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r0.tables.length, 0, "單框");
  var cells = gridCells(3, 3);
  drawTable(b, seq(200, 150, 4), seq(300, 80, 4), cells);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1, "頁框 + 表格");
  assertSpans(r.tables[0], cells, 3, 3);
});

test("表格貼著頁框（頁框與表格相連）：環狀空白區不被當成儲存格", function () {
  var b = makeBin(900, 900);
  var cells = gridCells(3, 3);
  drawTable(b, seq(200, 150, 4), seq(300, 80, 4), cells);
  line(b, 50, 50, 850, 50, 3); line(b, 50, 850, 850, 850, 3); line(b, 50, 50, 50, 850, 3); line(b, 850, 50, 850, 850, 3);
  line(b, 50, 300, 200, 300, 2);    // 一條線把表格接到頁框
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 3, 3);
});

test("表格下方相連的小框（如簽章日期框，與表格不相鄰）不併入表格", function () {
  var b = makeBin(900, 900), cells = gridCells(4, 3);
  drawTable(b, seq(100, 200, 4), seq(100, 60, 5), cells);
  line(b, 100, 340, 100, 600, 2);                 // 左框線往下延伸
  line(b, 100, 600, 700, 600, 2);                 // 底部一條長線
  drawTable(b, [420, 520], [560, 600], [[0, 0, 0, 0]]);   // 貼在長線上的小框
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 4, 3);
});

test("印章（小、墨點密）預設剔除；keepSeals 保留", function () {
  var b = makeBin(600, 600);
  drawTable(b, [200, 260, 320], [200, 260, 320], gridCells(2, 2), { t: 4 });
  for (var y = 205; y < 315; y += 4) for (var x = 205; x < 315; x += 3) if ((x + y) % 7 && Math.abs(x - 260) > 5 && Math.abs(y - 260) > 5) fillRect(b, x, y, x + 1, y + 2);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 0, "印章應剔除");
  assert.ok(r.dropped.some(function (d) { return d.reason === "seal"; }));
  var r2 = G.detectTables(b, { dpi: 200, keepSeals: true });
  assert.strictEqual(r2.tables.length, 1);
});

test("解析度：400 dpi 畫的表格（線、格、距離加倍）結果相同", function () {
  var b = makeBin(2400, 1600), xs = seq(200, 300, 7), ys = seq(200, 100, 11);
  var cells = gridCells(10, 6, [[0, 0, 0, 5], [4, 1, 6, 2]]);
  drawTable(b, xs, ys, cells, { t: 4 });
  var r = G.detectTables(b, { dpi: 400 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 10, 6);
  assert.strictEqual(r.dpi, 400);
  var p2 = G.params(2400, 1600, { dpi: 400 }), p1 = G.params(1200, 800, { dpi: 200 });
  assert.ok(p2.minV > p1.minV * 1.8 && p2.dil === p1.dil * 2, "門檻隨解析度縮放");
});

test("未給 dpi 時由 A4 頁面尺寸推估", function () {
  assert.ok(Math.abs(G.params(2480, 3508).dpi - 300) < 1);
  assert.ok(Math.abs(G.params(1654, 2339).dpi - 200) < 1);
  assert.strictEqual(G.params(500, 300).dpi, 200);
});

test("很小的表格（小字框 2 格）與極細列高（28px）", function () {
  var b = makeBin(600, 300);
  var cells = gridCells(1, 2);
  drawTable(b, [100, 200, 260], [100, 152], cells);
  var c2 = gridCells(2, 5);
  drawTable(b, seq(300, 50, 6), [180, 208, 236], c2, { t: 1 });
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 2, "表格數");
  assertSpans(r.tables[0], cells, 1, 2);
  assertSpans(r.tables[1], c2, 2, 5);
});

test("邊界條件：空白頁、極小影像、0/255 資料、資料長度不足", function () {
  assert.strictEqual(G.detectTables(makeBin(1654, 2340)).tables.length, 0);
  assert.strictEqual(G.detectTables(makeBin(3, 3)).tables.length, 0);
  assert.strictEqual(G.detectTables(makeBin(1, 1)).tables.length, 0);
  assert.strictEqual(G.detectTables({ width: 0, height: 0, data: new Uint8Array(0) }).tables.length, 0);
  var full = makeBin(200, 200); full.data.fill(1);
  assert.strictEqual(G.detectTables(full).tables.length, 0, "全黑");
  var b = makeBin(600, 400); drawTable(b, seq(100, 100, 4), seq(100, 80, 3), gridCells(2, 3));
  var b255 = { width: 600, height: 400, data: b.data.map(function (v) { return v * 255; }) };
  assert.strictEqual(G.detectTables(b255).tables[0].cells.length, 6, "0/255");
  var arr = { width: 600, height: 400, data: Array.prototype.slice.call(b.data) };
  assert.strictEqual(G.detectTables(arr).tables[0].cells.length, 6, "一般陣列");
  assert.throws(function () { G.detectTables({ width: 10, height: 10, data: new Uint8Array(5) }); }, /長度不足/);
  assert.throws(function () { G.detectTables(null); });
  // 碰到影像邊緣（未封閉）的格不算
  var e = makeBin(400, 300); drawTable(e, [-5, 150, 300], [50, 150, 250], gridCells(2, 2));
  var re = G.detectTables(e);
  assert.ok(re.tables.length === 0 || re.tables[0].cells.length === 2, "邊緣格");
});

test("大量儲存格（60×40 = 2400 格）速度與正確性", function () {
  var nr = 60, nc = 40, b = makeBin(2000, 2600);
  var xs = seq(40, 48, nc + 1), ys = seq(40, 42, nr + 1);
  var cells = gridCells(nr, nc);
  drawTable(b, xs, ys, cells, { t: 1 });
  var t0 = Date.now();
  var r = G.detectTables(b, { dpi: 200 });
  var ms = Date.now() - t0;
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, nr, nc);
  assert.ok(ms < 2000, "耗時 " + ms + "ms");
});

test("有分隔的頁框（頁首帶 + 內文區）內的表格不會被當成巢狀而遺失", function () {
  var b = makeBin(1000, 1200);
  line(b, 40, 40, 960, 40, 3); line(b, 40, 1160, 960, 1160, 3); line(b, 40, 40, 40, 1160, 3); line(b, 960, 40, 960, 1160, 3);
  line(b, 40, 160, 960, 160, 3);                  // 頁首帶
  line(b, 500, 40, 500, 160, 3);                  // 頁首再分兩格
  var cells = gridCells(6, 4, [[0, 0, 0, 3]]);
  drawTable(b, seq(150, 170, 5), seq(400, 60, 7), cells);
  var r = G.detectTables(b, { dpi: 200 });
  var main = r.tables.filter(function (t) { return t.cells.length === cells.length; });
  assert.strictEqual(main.length, 1, "內層表格應保留：" + r.tables.map(function (t) { return t.cells.length; }));
  assertSpans(main[0], cells, 6, 4);
});

test("印章框線碰到表格右框：印章仍視為巢狀，外表不受影響", function () {
  var b = makeBin(1000, 700), xs = seq(100, 200, 5), ys = [100, 160, 220, 600];
  var cells = gridCells(3, 4, [[2, 0, 2, 3]]);
  drawTable(b, xs, ys, cells);
  drawTable(b, [700, 800, 900], [380, 430, 520], gridCells(2, 2, [[0, 0, 0, 1]]), { t: 3 });   // 右邊貼在 x=900 的表框上
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 3, 4);
  var r2 = G.detectTables(b, { dpi: 200, keepNested: true });
  assert.strictEqual(r2.tables.length, 2, "keepNested 保留內層");
});

test("大表某格內獨立畫的子表（≥9 格）保留為另一個表格", function () {
  var b = makeBin(1400, 1200);
  var outer = gridCells(3, 5, [[2, 0, 2, 4]]);
  drawTable(b, seq(100, 240, 6), [100, 160, 220, 1000], outer);
  var inner = gridCells(4, 4);
  drawTable(b, seq(300, 150, 5), seq(400, 80, 5), inner);     // 位於大格（第 3 列）內、不碰大格邊框
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 2, r.tables.map(function (t) { return t.cells.length; }).join(","));
  assertSpans(r.tables[0], outer, 3, 5, "外表");
  assertSpans(r.tables[1], inner, 4, 4, "子表");
});

test("1px 細線 + 1° 歪斜 + 雜點", function () {
  var nr = 12, nc = 6, b = makeBin(1400, 1000), rng = lcg(21);
  var xs = seq(150, 180, nc + 1), ys = seq(150, 50, nr + 1);
  var cells = gridCells(nr, nc, [[0, 0, 0, 5], [2, 0, 5, 0]]);
  drawTable(b, xs, ys, cells, { t: 1, angle: 1.0 });
  specks(b, 1500, rng, 1);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, nr, nc);
});

test("網點底紋（半色調）表頭列與全頁 15% 雜訊：網點不會被當成格線", function () {
  [0.15, 0.3, 0.5].forEach(function (lvl) {
    var b = makeBin(1200, 700), rng = lcg(4), xs = seq(100, 200, 6), ys = seq(100, 60, 9), cells = gridCells(8, 5);
    drawTable(b, xs, ys, cells);
    for (var y = ys[0] + 3; y < ys[1] - 2; y++) for (var x = xs[0] + 3; x < xs[5] - 2; x++) if (rng() < lvl) b.data[y * 1200 + x] = 1;
    var r = G.detectTables(b, { dpi: 200 });
    assert.strictEqual(r.tables.length, 1, "底紋 " + lvl);
    assertSpans(r.tables[0], cells, 8, 5, "底紋 " + lvl);
  });
  var b2 = makeBin(1654, 1200), rng2 = lcg(9), c2 = gridCells(10, 5, [[0, 0, 0, 4]]);
  for (var i = 0; i < b2.data.length; i++) if (rng2() < 0.15) b2.data[i] = 1;
  drawTable(b2, seq(150, 260, 6), seq(200, 60, 11), c2, { t: 3 });
  var r2 = G.detectTables(b2, { dpi: 200 });
  assert.strictEqual(r2.tables.length, 1, "雜訊頁");
  assertSpans(r2.tables[0], c2, 10, 5, "雜訊頁");
});

test("格內大塊實心墨塊（塗黑、■）不會把格子切開", function () {
  var b = makeBin(900, 400), cells = gridCells(2, 3);
  drawTable(b, seq(100, 230, 4), seq(100, 120, 3), cells);
  fillRect(b, 130, 130, 260, 190);      // 第一格內 131×61 實心塊（會被判為線條），四周仍留白
  fillRect(b, 360, 150, 380, 170);      // 小方塊
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assertSpans(r.tables[0], cells, 2, 3);
});

/* ---------------- cellInk ---------------- */
test("cellInk：忽略格線、內縮、孤立雜點不撐大外框", function () {
  var b = makeBin(700, 300);
  var cells = gridCells(1, 2);
  drawTable(b, [50, 350, 650], [50, 250], cells, { t: 3 });
  fakeText(b, 150, 120, 4, 30);                     // 字：x 150..(150+3*23+18)=237, y 120..150
  setPx(b, 60, 240);                                // 角落雜點
  setPx(b, 340, 61); setPx(b, 341, 61);             // 另一個角落雜點（2px）
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  var cell = r.tables[0].cells[0], mask = r.mask;
  var ink = G.cellInk(b, mask, cell.bbox, 3);
  assert.ok(ink.bbox.x0 >= 148 && ink.bbox.x0 <= 151 && ink.bbox.x1 >= 236 && ink.bbox.x1 <= 240, JSON.stringify(ink));
  assert.ok(ink.bbox.y0 >= 118 && ink.bbox.y0 <= 121 && ink.bbox.y1 >= 149 && ink.bbox.y1 <= 152, JSON.stringify(ink));
  var withSpeck = G.cellInk(b, mask, cell.bbox, 3, { speck: 0 });
  assert.strictEqual(withSpeck.bbox.y1, 240, "speck:0 時雜點計入");
  assert.strictEqual(withSpeck.bbox.x1, 341);
  assert.strictEqual(withSpeck.count, ink.count + 3);
  // 空白格
  assert.deepStrictEqual(G.cellInk(b, mask, r.tables[0].cells[1].bbox, 3), { count: 0, bbox: null });
  // 內縮後無面積、無 bbox
  assert.deepStrictEqual(G.cellInk(b, mask, { x0: 10, y0: 10, x1: 12, y1: 12 }, 3), { count: 0, bbox: null });
  assert.deepStrictEqual(G.cellInk(b, mask, null), { count: 0, bbox: null });
  // 線上的墨點不計（mask），不給 mask 則計入
  var onLine = G.cellInk(b, mask, { x0: 40, y0: 40, x1: 660, y1: 60 }, 0);
  assert.ok(onLine.count <= 2, "線墨點應被忽略：" + onLine.count);
  assert.ok(G.cellInk(b, null, { x0: 40, y0: 40, x1: 660, y1: 60 }, 0).count > 1500);
  // 單一小點仍會回報（避免把只有一個「.」的格當空白交給呼叫端判斷）
  var b2 = makeBin(100, 100); setPx(b2, 50, 50);
  assert.strictEqual(G.cellInk(b2, null, { x0: 0, y0: 0, x1: 99, y1: 99 }, 0).count, 1);
});

test("歪斜 1.5° 的寬格：cellInk / encodePBM 不會吃到外框角落裡的鄰格文字", function () {
  require("../../js/fill/raster.js");
  var R = globalThis.YangFill.raster;
  var b = makeBin(1600, 700), xs = [100, 1500], ys = seq(100, 60, 8), cells = gridCells(7, 1);
  var T = drawTable(b, xs, ys, cells, { t: 2, angle: 1.5 });
  // 每列兩行「字」（隨表格一起旋轉），貼近該列上緣
  for (var r0 = 0; r0 < 7; r0++) for (var i = 0; i < 60; i++) {
    var X = 120 + i * 22;
    [12, 30].forEach(function (dy) { var p = T(X, ys[r0] + dy), q = T(X + 14, ys[r0] + dy); line(b, p[0], p[1], q[0], q[1], 2); });
  }
  var r = G.detectTables(b, { dpi: 200 }), t = r.tables[0];
  assert.strictEqual(t.cells.length, 7);
  assert.ok(t.cells[0].frame && Math.abs(t.cells[0].frame.s - Math.tan(1.5 * Math.PI / 180)) < 0.003, "cell.frame");
  assert.deepStrictEqual(Object.keys(t.cells[0].bbox), ["x0", "y0", "x1", "y1"], "bbox 仍只列舉四個欄位");
  var counts = t.cells.map(function (c) { return G.cellInk(b, r.mask, c.bbox, 3).count; });
  counts.forEach(function (n) { assert.strictEqual(n, counts[6], "各列墨點數應相同（未混入鄰列）：" + counts); });
  var plain = G.cellInk(b, r.mask, { x0: t.cells[1].bbox.x0, y0: t.cells[1].bbox.y0, x1: t.cells[1].bbox.x1, y1: t.cells[1].bbox.y1 }, 3);
  assert.ok(plain.count > counts[1] * 1.1, "不用 frame 時會混入鄰列（確認測試有效）");
  // encodePBM 依 cellInk 回傳 bbox 的 frame 排除鄰格墨點
  var ink = G.cellInk(b, r.mask, t.cells[2].bbox, 3);
  var pb = R.decodePBM(R.encodePBM(b, ink.bbox, 0, r.mask));
  var n = 0; for (var k = 0; k < pb.data.length; k++) n += pb.data[k];
  assert.strictEqual(n, ink.count + 0, "PBM 只含本格墨點");
});

/* ---------------- textLines ---------------- */
test("textLines：表格外文字列切割、排除表格、分欄、去雜點與底線", function () {
  var rng = lcg(3), b = makeBin(1654, 1200);
  // 標題列（大字）
  fakeText(b, 600, 60, 8, 34, rng);
  // 左右兩段的資訊列：「監測位置：xxxx」……「報告編號：xxxx」
  fakeText(b, 120, 160, 10, 22, rng); fakeText(b, 950, 160, 9, 22, rng);
  // 帶底線的一列
  fakeText(b, 120, 230, 12, 22, rng); line(b, 110, 262, 700, 262, 2);
  // 表格（內含文字，應被排除）
  var cells = gridCells(4, 4);
  drawTable(b, seq(120, 350, 5), seq(330, 70, 5), cells);
  cells.forEach(function (c) { fakeText(b, 140 + c[1] * 350, 350 + c[0] * 70, 5, 22, rng); });
  // 表格下方註腳 + 雜點
  fakeText(b, 120, 680, 15, 22, rng);
  specks(b, 400, rng, 1);
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  var lines = G.textLines(b, r.tables.map(function (t) { return t.bbox; }), { dpi: 200 });
  var boxes = lines.map(function (l) { return l.bbox; });
  assert.strictEqual(lines.length, 5, JSON.stringify(boxes));
  // 閱讀順序：標題 → 左段 → 右段 → 底線列 → 註腳
  assert.ok(boxes[0].y0 >= 55 && boxes[0].y1 <= 100 && boxes[0].x0 >= 595);
  assert.ok(boxes[1].x0 < 200 && boxes[1].x1 < 500 && boxes[2].x0 > 900, "左右分段");
  assert.ok(boxes[3].y1 < 262, "底線不併入文字框");
  assert.ok(boxes[4].y0 >= 675);
  boxes.forEach(function (bb) { assert.ok(bb.y1 < 330 || bb.y0 > 610, "表格內文字不應出現"); });
  // 使用 detectTables 的遮罩快取或明確傳入 mask，結果一致
  var lines2 = G.textLines(b, r.tables.map(function (t) { return t.bbox; }), { dpi: 200, mask: r.mask });
  assert.deepStrictEqual(lines2.map(function (l) { return l.bbox; }), boxes);
  assert.strictEqual(G.textLines(b, [], { maxLines: 2 }).length, 2, "maxLines");
  assert.deepStrictEqual(G.textLines(makeBin(300, 200), []), []);
});

test("textLines：歪斜表格只排除斜框內，表格斜角上方的標題文字保留", function () {
  var b = makeBin(1654, 900), cells = gridCells(4, 4);
  var T = drawTable(b, seq(150, 340, 5), seq(300, 70, 5), cells, { angle: 1.5 });
  // 右側標題：在表格右上角真正框線上方約 18px（但仍落在軸向 bbox 內）
  var p = T(1000, 282);
  fakeText(b, Math.round(p[0]), Math.round(p[1]) - 12, 10, 20, lcg(2));
  var r = G.detectTables(b, { dpi: 200 });
  assert.strictEqual(r.tables.length, 1);
  assert.ok(r.tables[0].frame, "歪斜表格附 frame");
  var tb = r.tables[0].bbox;
  var lines = G.textLines(b, [tb], { dpi: 200 });
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines[0].bbox.y1 > tb.y0, "此標題確實落在軸向 bbox 內");
  var plain = G.textLines(b, [{ x0: tb.x0, y0: tb.y0, x1: tb.x1, y1: tb.y1 }], { dpi: 200 });
  assert.ok(plain.length === 0 || plain[0].bbox.x1 - plain[0].bbox.x0 < lines[0].bbox.x1 - lines[0].bbox.x0, "無 frame 時被部分排除");
});

test("textLines：兩列文字間距小也不合併；下標與標點併入同列", function () {
  var b = makeBin(1000, 400), rng = lcg(11);
  fakeText(b, 100, 100, 12, 22, rng);
  fakeText(b, 100, 132, 12, 22, rng);              // 行距 10px
  fillRect(b, 315, 114, 322, 126);                 // 下標（較小、偏下）
  fillRect(b, 327, 119, 330, 122);                 // 句點
  var lines = G.textLines(b, [], { dpi: 200 });
  assert.strictEqual(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[0].bbox.x1 >= 330 && lines[0].bbox.y1 < 132, JSON.stringify(lines[0]));
});

/* ---------------- 真實樣本（僅本機有 test_data 時） ---------------- */
var PAGES = path.join(__dirname, "..", "..", "test_data", "fill", "pages");
function readPBM(file) {
  var buf = fs.readFileSync(file), i = 0, tok = [];
  function ws(c) { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09; }
  while (tok.length < 3) {
    while (ws(buf[i])) i++;
    if (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; continue; }
    var j = i; while (!ws(buf[j])) j++;
    tok.push(buf.slice(i, j).toString()); i = j;
  }
  i++;
  var w = +tok[1], h = +tok[2], rb = (w + 7) >> 3, d = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) d[y * w + x] = (buf[i + y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
  return { width: w, height: h, data: d };
}
var realChecked = 0, realWorst = 0;
if (fs.existsSync(PAGES)) {
  var pageFile = function (n) { return path.join(PAGES, n + ".pbm"); };
  var run = function (n) {
    var img = readPBM(pageFile(n));
    var t0 = process.hrtime.bigint();
    var r = G.detectTables(img, { dpi: 200 });
    var ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > realWorst) realWorst = ms;
    realChecked++;
    return { img: img, r: r, ms: ms };
  };
  var pad2 = function (k) { return (k < 10 ? "0" : "") + k; };
  // 暖機（JIT）
  if (fs.existsSync(pageFile("adata_p03"))) run("adata_p03");
  test("真實：A data 摘要頁 p03–p07 = 主表 5×18（68 格）+ 備註表（18 格）", function () {
    for (var k = 3; k <= 7; k++) {
      var n = "adata_p" + pad2(k);
      if (!fs.existsSync(pageFile(n))) continue;
      var r = run(n).r;
      assert.strictEqual(r.tables.length, 2, n);
      var t = r.tables[0];
      assert.strictEqual(t.cells.length, 68, n);
      assert.strictEqual(t.nCols, 5, n); assert.strictEqual(t.nRows, 18, n);
      assert.strictEqual(r.tables[1].cells.length, 18, n + " 備註表");
      // 「最大小時平均值 0.001」等數值格在第 3 欄（c=2），各佔一列
      var vals = t.cells.filter(function (c) { return c.c0 === 2 && c.c1 === 2 && c.r0 >= 3; });
      assert.strictEqual(vals.length, 15, n + " 數值格");
    }
  });
  test("真實：逐時頁 p09–p18 = 單一表格、全寬表頭、TSP 跨 24 列", function () {
    for (var k = 9; k <= 18; k++) {
      var n = "adata_p" + pad2(k);
      if (!fs.existsSync(pageFile(n))) continue;
      var r = run(n).r;
      var big = r.tables.filter(function (t) { return t.cells.length >= 50; });
      assert.strictEqual(big.length, 1, n);
      // 其餘只允許印章上的小日期框之類（≤ 4 格、≤ 30mm）
      r.tables.forEach(function (t) {
        if (t === big[0]) return;
        assert.ok(t.cells.length <= 4 && t.bbox.x1 - t.bbox.x0 < 240 && t.bbox.y0 > big[0].bbox.y1, n + " 多餘表格 " + JSON.stringify(t.bbox));
      });
      var t = big[0], odd = k % 2 === 1;
      assert.strictEqual(t.cells.length, odd ? 253 : 258, n + " 格數");
      assert.strictEqual(t.nCols, odd ? 9 : 10, n + " 欄數");
      assert.strictEqual(t.nRows, 29, n + " 列數");
      var head = t.cells.filter(function (c) { return c.r0 === 0 && c.c0 === 0 && c.c1 === t.nCols - 1; });
      assert.strictEqual(head.length, 1, n + " 全寬表頭");
      if (!odd) {
        var tsp = t.cells.filter(function (c) { return c.c0 === t.nCols - 1 && c.r1 - c.r0 + 1 === 24; });
        assert.strictEqual(tsp.length, 1, n + " TSP 長格");
      }
    }
  });
  test("真實：PM2.5 頁 p21–p25 = 2 個表（5×4 主表 14 格、氣象 9 格）", function () {
    for (var k = 21; k <= 25; k++) {
      var n = "adata_p" + pad2(k);
      if (!fs.existsSync(pageFile(n))) continue;
      var r = run(n).r;
      assert.strictEqual(r.tables.length, 2, n);
      assert.strictEqual(r.tables[0].cells.length, 14, n);
      assert.strictEqual(r.tables[0].nCols, 5, n);
      assert.strictEqual(r.tables[1].cells.length, 9, n);
    }
  });
  test("真實：封面／聲明頁（p01 p02 p08 p19 p20 p26）無表格（印章已剔除）", function () {
    [1, 2, 8, 19, 20, 26].forEach(function (k) {
      var n = "adata_p" + pad2(k);
      if (!fs.existsSync(pageFile(n))) return;
      assert.strictEqual(run(n).r.tables.length, 0, n);
    });
  });
  test("真實：異味報告 p1 結果表（112 格；①–④ 實測值 25/25/<10/20 各為跨 2 列的獨立格；印章為巢狀）", function () {
    if (!fs.existsSync(pageFile("odor_p01"))) return;
    var r = run("odor_p01").r;
    assert.strictEqual(r.tables.length, 1);
    var t = r.tables[0];
    assert.ok(t.cells.length >= 108 && t.cells.length <= 120, "格數 " + t.cells.length);
    assert.ok(t.nCols >= 17 && t.nCols <= 22, "欄數 " + t.nCols);
    // 實測值欄：x≈733..820
    var vcol = t.cells.filter(function (c) { return c.bbox.x0 > 720 && c.bbox.x1 < 830 && c.r1 - c.r0 === 1 && c.bbox.y0 > 940 && c.bbox.y1 < 1340; });
    assert.strictEqual(vcol.length, 5, "實測值欄 5 格（①–④ + 空白列）：" + vcol.length);
    assert.ok(vcol.every(function (c) { return c.c0 === vcol[0].c0 && c.c1 === c.c0; }), "同一欄");
    var head = t.cells.filter(function (c) { return c.c0 === vcol[0].c0 && c.r1 === vcol[0].r0 - 1; });
    assert.strictEqual(head.length, 1, "上方有「實測值」表頭格");
    assert.strictEqual(r.nested.length, 1, "報告專用章為巢狀");
  });
  test("真實：所有頁面皆可處理且單頁 < 400 ms", function () {
    fs.readdirSync(PAGES).filter(function (f) { return /\.pbm$/.test(f); }).forEach(function (f) {
      var x = run(f.replace(/\.pbm$/, ""));
      assert.ok(x.ms < 400, f + " " + x.ms.toFixed(0) + "ms");
      var lines = G.textLines(x.img, x.r.tables.map(function (t) { return t.bbox; }), { dpi: 200 });
      assert.ok(lines.length <= 60);
    });
  });
}

var extra = realChecked ? "；真實頁面 " + realChecked + " 次，最慢 " + realWorst.toFixed(0) + " ms" : "；（無真實樣本，略過）";
if (failed) {
  console.error("FAIL grid.test.js：" + failed + " 失敗 / " + (passed + failed));
  failures.forEach(function (f) { console.error("  ✗ " + f); });
  process.exit(1);
}
console.log("PASS grid.test.js：" + passed + " 項通過" + extra);
