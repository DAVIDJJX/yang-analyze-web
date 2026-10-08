/* xdw.test.js — js/fill/xdw.js 單元測試（僅用 node 內建模組與合成資料）
 * 執行：node tests/fill/xdw.test.js
 * 以測試內建的 TLV 產生器組出合成 DocuWorks 檔（G4 頁、DIB 圖層、JPEG 物件、未知物件、
 * 重複 ID、過期物件、MRC 圖層、內嵌文件、截斷），再加上模糊測試。
 * 若 test_data/fill/A_data.xdw（真實樣本，不進 repo）存在，另驗證 26 頁逐像素一致與速度。
 */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "js/fill/ccitt.js"));
require(path.join(ROOT, "js/fill/xdw.js"));
var YF = globalThis.YangFill, X = YF.xdw, C = YF.ccitt;
var FX = path.join(__dirname, "fixtures");
var REAL = path.join(ROOT, "test_data", "fill");

var tests = [], nAssert = 0, NOTES = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function eq(a, b, msg) { nAssert++; assert.strictEqual(a, b, msg); }
function ok(v, msg) { nAssert++; assert.ok(v, msg); }

/* ---------------- 工具 ---------------- */
function readPbm(buf) {
  var i = 0, tok = [];
  function ws(c) { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09; }
  while (tok.length < 3) {
    while (ws(buf[i])) i++;
    if (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; continue; }
    var s = i;
    while (!ws(buf[i])) i++;
    tok.push(buf.toString("latin1", s, i));
  }
  i++;
  var W = +tok[1], H = +tok[2], rb = (W + 7) >> 3, d = new Uint8Array(W * H);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) d[y * W + x] = (buf[i + y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
  return { width: W, height: H, data: d };
}
function diffCount(a, b) {
  if (a.length !== b.length) return -1;
  var n = 0;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}
function rng(seed) {
  var s = seed >>> 0 || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function concat(list) {
  var n = 0, i;
  for (i = 0; i < list.length; i++) n += list[i].length;
  var out = new Uint8Array(n), p = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
  return out;
}
function bytes(arr) { return Uint8Array.from(arr); }
function be(n, size) { var a = []; for (var i = size - 1; i >= 0; i--) a.push(Math.floor(n / Math.pow(256, i)) & 255); return bytes(a); }
function le32(list) { var out = new Uint8Array(list.length * 4); list.forEach(function (v, i) { out[i * 4] = v & 255; out[i * 4 + 1] = (v >> 8) & 255; out[i * 4 + 2] = (v >> 16) & 255; out[i * 4 + 3] = (v >>> 24) & 255; }); return out; }

/* ---------------- 合成 DocuWorks 產生器 ---------------- */
function tlvHead(tag, len) {
  if (len < 0x80) return bytes([tag, len]);
  var b = [], l = len;
  while (l > 0) { b.unshift(l & 255); l = Math.floor(l / 256); }
  return bytes([tag, 0x80 | b.length].concat(b));
}
function tlv(tag, value) {
  var v = Array.isArray(value) ? concat(value) : value;
  return concat([tlvHead(tag, v.length), v]);
}
function header() { return tlv(0x60, [tlv(0x82, bytes([7])), tlv(0x80, bytes([0, 0xc0, 0x13])), tlv(0x83, bytes([1, 0x0d, 0x0a, 1]))]); }
function payload(fields) { return concat(fields.map(function (f) { return tlv(f[0], f[1]); })); }
function obj(idHex, fields) {
  var id = bytes(idHex.match(/../g).map(function (h) { return parseInt(h, 16); }));
  return tlv(0x64, [tlv(0x81, id), tlv(0x82, payload(fields))]);
}
function imgFields(code, w, h, data, o) {
  o = o || {};
  var f = [[0x80, bytes([code])], [0x84, be(o.physW || 21005, 2)], [0x85, be(o.physH || 29718, 2)]];
  if (w) { f.push([0x87, be(w, 2)]); f.push([0x88, be(h, 2)]); }
  if (o.dpm !== 0) { f.push([0x8b, be(o.dpm || 7874, 2)]); f.push([0x8c, be(o.dpm || 7874, 2)]); }
  f.push([0x89, be(o.declared || data.length, 4)]);
  f.push([0x86, data]);
  return f;
}
/** 組檔：blocks = [[obj bytes...]...]；每個區塊尾端加 [0x63] 雜湊目錄與 [0x65] 累積索引 */
function buildXdw(blocks, opts) {
  opts = opts || {};
  var parts = [header()], pos = parts[0].length, live = [], R = rng(5);
  blocks.forEach(function (objs, bi) {
    var dir = new Uint8Array(20 + bi); for (var i = 0; i < dir.length; i++) dir[i] = Math.floor(R() * 256);
    var dirT = tlv(0x63, dir);
    function indexFor(offs) { return tlv(0x65, [tlv(0x80, bytes([offs.length & 255])), tlv(0x81, le32(offs)), tlv(0x84, be(dir.length, 2))]); }
    var objBytes = concat(objs.map(function (o) { return o.bytes || o; }));
    var newLive = live.slice(), offs = [];
    var est = live.concat(objs.map(function () { return 0; }));
    var tmpLen = objBytes.length + dirT.length + indexFor(est.length ? est : [0]).length;
    var h = tlvHead(0x61, tmpLen).length, p = pos + h;
    objs.forEach(function (o) { var b = o.bytes || o; offs.push(p); if (!o.skipIndex) newLive.push(p); p += b.length; });
    if (opts.dropFromIndex) newLive = newLive.filter(function (x) { return opts.dropFromIndex.indexOf(x) < 0 && !opts.dropAll; });
    // 保持索引長度與暫估相同：被剔除的位置用重複的第一個位移補（重複不影響集合）
    while (newLive.length < live.length + objs.length) newLive.push(newLive[0]);
    var idx = indexFor(newLive.length ? newLive : [0]);
    var blk = tlv(0x61, [objBytes, dirT, idx]);
    eq(blk.length, h + tmpLen, "block length stable");
    parts.push(blk); pos += blk.length;
    live = newLive;
    if (opts.onOffsets) opts.onOffsets(bi, offs);
  });
  return concat(parts);
}
function fakeJpeg(w, h, extra) {
  var e = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00];
  for (var i = 0; i < (extra || 50); i++) e.push((i * 7) & 0x7F);
  e.push(0xFF, 0x00, 0x12, 0xFF, 0xD9);
  return bytes(e);
}
function dib4(w, h, dataLen) {   // 4 位元灰階 DIB 標頭 + 16 色調色盤 + 資料（模擬樣本中的低解析背景層）
  var hd = new Uint8Array(40 + 64 + dataLen), dv = new DataView(hd.buffer);
  dv.setUint32(0, 40, true); dv.setInt32(4, w, true); dv.setInt32(8, h, true); dv.setUint16(12, 1, true); dv.setUint16(14, 4, true);
  dv.setUint32(20, ((w * 4 + 31) >> 5) * 4 * h, true); dv.setUint32(32, 16, true);
  for (var i = 0; i < 16; i++) { hd[40 + i * 4] = hd[41 + i * 4] = hd[42 + i * 4] = i * 17; }
  for (var k = 104; k < hd.length; k++) hd[k] = (k * 13) & 255;
  return hd;
}
function dib1(img) {             // 1 位元未壓縮 DIB（由下而上），調色盤 0 = 白、1 = 黑
  var w = img.width, h = img.height, stride = ((w + 31) >> 5) * 4;
  var out = new Uint8Array(40 + 8 + stride * h), dv = new DataView(out.buffer);
  dv.setUint32(0, 40, true); dv.setInt32(4, w, true); dv.setInt32(8, h, true); dv.setUint16(12, 1, true); dv.setUint16(14, 1, true);
  dv.setUint32(32, 2, true);
  out[40] = out[41] = out[42] = 255;    // 索引 0：白
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (img.data[y * w + x]) out[48 + (h - 1 - y) * stride + (x >> 3)] |= 0x80 >> (x & 7);
  return out;
}
function g4Of(name) {
  var buf = new Uint8Array(fs.readFileSync(path.join(FX, name)));
  var info = C.tiffInfo(buf)[0];
  return { width: info.width, height: info.height, data: buf.subarray(info.blocks[0].offset, info.blocks[0].offset + info.blocks[0].length) };
}
var PAGE = readPbm(fs.readFileSync(path.join(FX, "ccitt_page.pbm")));
var RUNS = readPbm(fs.readFileSync(path.join(FX, "ccitt_runs.pbm")));
var G4P = g4Of("ccitt_page_g4.tif"), G4R = g4Of("ccitt_runs_g4.tif");

function sampleDoc() {
  return buildXdw([
    [],
    [obj("b9d19860", imgFields(9, G4P.width, G4P.height, G4P.data)), obj("0923d220", imgFields(7, 0, 0, dib4(103, 146, 300)).concat([[0x81, bytes([104])]]))],
    [obj("ba93da1d", imgFields(9, G4R.width, G4R.height, G4R.data))],
    [obj("7339a220", imgFields(8, 0, 0, fakeJpeg(800, 1000))), obj("aa", [[0x80, bytes([3])], [0x86, bytes([1, 2, 3, 4, 5, 6, 7, 8, 9])]]),
     obj("cafe", imgFields(9, 100, 80, G4P.data.subarray(0, 30)))],
    [obj("b9d19860", imgFields(9, G4P.width, G4P.height, G4P.data))]
  ]);
}

/* ================= 測試 ================= */

test("合成 XDW：頁面、圖層、JPEG、未知物件、重複 ID、摘要", function () {
  var f = sampleDoc();
  ok(X.isXdw(f), "isXdw");
  var r = X.parse(f);
  eq(r.format, "xdw"); eq(r.version, 7); eq(r.valid, true);
  eq(r.pages.length, 4, "pages");
  var p0 = r.pages[0];
  eq(p0.index, 0); eq(p0.kind, "g4"); eq(p0.width, 643); eq(p0.height, 400); eq(p0.dpi, 200); eq(p0.dpiX, 200); eq(p0.dpiY, 200);
  eq(p0.widthMm, 210.05); eq(p0.heightMm, 297.18);
  eq(p0.layers.length, 1); eq(p0.layers[0].kind, "dib"); eq(p0.layers[0].width, 103); eq(p0.layers[0].height, 146); eq(p0.layers[0].bitCount, 4);
  eq(p0.primary.id, "b9d19860"); eq(p0.primary.code, 9);
  var bm = p0.decode();
  eq(bm.width, 643); eq(bm.height, 400); eq(bm.dpi, 200); eq(diffCount(bm.data, PAGE.data), 0);
  eq(diffCount(r.pages[1].decode().data, RUNS.data), 0);
  // JPEG 頁：同步 decode 為 null；小 G4（100×80）成為該頁圖層
  var pj = r.pages[2];
  eq(pj.kind, "jpeg"); eq(pj.width, 800); eq(pj.height, 1000); eq(pj.primary.mime, "image/jpeg");
  eq(pj.decode(), null);
  eq(pj.layers.length, 1); eq(pj.layers[0].kind, "g4"); eq(pj.layers[0].width, 100);
  eq(pj.imageBytes()[0], 0xFF); eq(pj.imageBytes()[1], 0xD8);
  // 重複 ID
  eq(r.pages[3].duplicateOf, 0);
  ok(r.warnings.some(function (w) { return /重複/.test(w); }), "dup warning");
  ok(r.warnings.some(function (w) { return /無法辨識的物件（類型代碼 3）/.test(w); }), "unknown warning: " + r.warnings.join(" | "));
  eq(r.objects.length, 7);
  eq(r.objects.filter(function (o) { return o.role === "page"; }).length, 4);
  eq(r.info, "4 頁影像（掃描影像 G4 ×3、JPEG 影像 ×1，200 dpi）");
  eq(X.describe(f), "DocuWorks 文件：4 頁（掃描影像 G4 ×3、JPEG 影像 ×1，200 dpi）");
  eq(X.describe(f, "a.xbd").indexOf("DocuWorks Binder"), 0);
  eq(X.parse(f, { fileName: "x.XBD" }).format, "xbd");
  // 輸入型態：ArrayBuffer、Buffer、DataView 子區段
  eq(X.parse(f.buffer.slice(f.byteOffset, f.byteOffset + f.length)).pages.length, 4);
  eq(X.parse(Buffer.from(f)).pages.length, 4);
  var wrapped = new Uint8Array(f.length + 10); wrapped.set(f, 5);
  eq(X.parse(wrapped.subarray(5, 5 + f.length)).pages.length, 4);
});

test("單一類型摘要格式（如真實樣本：「N 頁掃描影像（G4 200dpi）」）", function () {
  var f = buildXdw([[obj("01020304", imgFields(9, G4P.width, G4P.height, G4P.data))], [obj("01020305", imgFields(9, G4R.width, G4R.height, G4R.data, { dpm: 11811 }))]]);
  var r = X.parse(f);
  eq(r.info, "2 頁掃描影像（G4 200/300dpi）");
  eq(X.describe(f), "DocuWorks 文件：2 頁（掃描影像 G4，200/300 dpi）");
  eq(r.pages[1].dpi, 300);
  eq(r.warnings.length, 0, r.warnings.join());
});

test("decodeAsync：無 raster 模組 → null + 警告；有 raster → 二值化 Bitmap；G4 直接同步結果", function () {
  var f = sampleDoc(), r = X.parse(f);
  var saved = YF.raster;
  delete YF.raster;
  return r.pages[2].decodeAsync().then(function (bm) {
    eq(bm, null);
    ok(r.pages[2].warnings.some(function (w) { return /raster/.test(w); }));
    var calls = [];
    YF.raster = {
      decodeImageBytes: function (b, mime) { calls.push(mime); return Promise.resolve({ width: 4, height: 2, data: new Uint8ClampedArray(32).fill(255) }); },
      binarize: function (rgba, w, h) { return { width: w, height: h, data: new Uint8Array(w * h) }; }
    };
    return r.pages[2].decodeAsync().then(function (bm2) {
      eq(bm2.width, 4); eq(bm2.height, 2); eq(calls[0], "image/jpeg"); eq(bm2.dpi, 200);
      return r.pages[0].decodeAsync();
    }).then(function (bm3) {
      eq(diffCount(bm3.data, PAGE.data), 0);
      YF.raster = { decodeImageBytes: function () { return Promise.reject(new Error("boom")); }, binarize: function () { return null; } };
      return r.pages[2].decodeAsync();
    }).then(function (bm4) {
      eq(bm4, null);
      ok(r.pages[2].warnings.some(function (w) { return /boom/.test(w); }));
    });
  }).finally(function () { if (saved) YF.raster = saved; else delete YF.raster; });
});

test("按需解碼、不快取；imageBytes 不複製", function () {
  var f = sampleDoc(), r = X.parse(f), p = r.pages[0];
  ok(p.imageBytes().buffer === f.buffer, "subarray of the original buffer");
  eq(p.imageBytes().length, G4P.data.length);
  var a = p.decode(), b = p.decode();
  ok(a.data !== b.data, "fresh buffer each time");
  ok(!("data" in p) && !("bitmap" in p), "no cached pixels on the page");
  eq(JSON.stringify(Object.keys(p).sort()), JSON.stringify(["decode", "decodeAsync", "dpi", "dpiX", "dpiY", "duplicateOf", "height",
    "heightMm", "imageBytes", "index", "kind", "layers", "primary", "warnings", "width", "widthMm"]));
});

test("最新索引外的舊物件被略過；索引對不上時不過濾", function () {
  var drop = [];
  var f = buildXdw([
    [obj("11111111", imgFields(9, G4P.width, G4P.height, G4P.data)), obj("22222222", imgFields(9, G4R.width, G4R.height, G4R.data))],
    [obj("33333333", imgFields(9, G4P.width, G4P.height, G4P.data))]
  ], { onOffsets: function (bi, offs) { if (bi === 0) drop.push(offs[1]); }, dropFromIndex: drop });
  var r = X.parse(f);
  eq(r.pages.length, 2);
  eq(r.pages[0].primary.id, "11111111"); eq(r.pages[1].primary.id, "33333333");
  ok(r.warnings.some(function (w) { return /不在最新的物件索引/.test(w); }), r.warnings.join());
  // 索引內容亂掉（指向不存在的位置）→ 全部保留
  var f2 = buildXdw([[obj("11111111", imgFields(9, G4P.width, G4P.height, G4P.data)), obj("22222222", imgFields(9, G4R.width, G4R.height, G4R.data))]]);
  var i81 = -1;
  for (var i = f2.length - 40; i < f2.length - 2; i++) if (f2[i] === 0x81 && f2[i + 1] === 8) { i81 = i; break; }
  ok(i81 > 0);
  f2[i81 + 2] ^= 0x55;
  var r2 = X.parse(f2);
  eq(r2.pages.length, 2); eq(r2.warnings.length, 0, r2.warnings.join());
});

test("MRC：同區塊、相同實體尺寸、低解析不同類型影像 → 合併為同一頁的圖層（兩種順序）", function () {
  var f = buildXdw([[obj("a1", imgFields(9, G4R.width, G4R.height, G4R.data)), obj("a2", imgFields(8, 0, 0, fakeJpeg(1200, 40)))],
    [obj("b1", imgFields(8, 0, 0, fakeJpeg(1200, 40))), obj("b2", imgFields(9, G4R.width, G4R.height, G4R.data))],
    [obj("c1", imgFields(9, G4R.width, G4R.height, G4R.data)), obj("c2", imgFields(8, 0, 0, fakeJpeg(2000, 60)))]]);
  var r = X.parse(f);
  eq(r.pages.length, 4, r.pages.map(function (p) { return p.kind; }).join());
  eq(r.pages[0].kind, "g4"); eq(r.pages[0].layers[0].kind, "jpeg");
  eq(r.pages[1].kind, "g4"); eq(r.pages[1].primary.id, "b2"); eq(r.pages[1].layers[0].kind, "jpeg");
  eq(r.pages[2].kind, "g4"); eq(r.pages[3].kind, "jpeg");   // 2000/2700 > 0.6：視為獨立頁
  eq(diffCount(r.pages[1].decode().data, RUNS.data), 0);
});

test("1 位元未壓縮 DIB 主影像可同步解碼；BMP / PNG / TIFF 魔術數字辨識", function () {
  var img = { width: 640, height: 9, data: new Uint8Array(640 * 9) };
  for (var i = 0; i < img.data.length; i++) img.data[i] = (i * 7919) % 5 === 0 ? 1 : 0;
  var f = buildXdw([[obj("d1", imgFields(7, 0, 0, dib1(img)))]]);
  var r = X.parse(f);
  eq(r.pages.length, 1); eq(r.pages[0].kind, "dib");
  eq(diffCount(r.pages[0].decode().data, img.data), 0);
  var png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0, 0, 0, 2, 0, 8, 0]);
  var sp = X._sniffImage(png, 0, png.length);
  eq(sp.kind, "png"); eq(sp.width, 768); eq(sp.height, 512);
  var tif = new Uint8Array(fs.readFileSync(path.join(FX, "ccitt_page_g4.tif")));
  var st = X._sniffImage(tif, 0, tif.length);
  eq(st.kind, "tiff"); eq(st.width, 643);
  var bmp = concat([bytes([0x42, 0x4D]), le32([14 + dib1(img).length]), bytes([0, 0, 0, 0]), le32([14 + 48]), dib1(img)]);
  var sb = X._sniffImage(bmp, 0, bmp.length);
  eq(sb.kind, "bmp"); eq(sb.width, 640);
  // TIFF 物件當作頁面
  var f2 = buildXdw([[obj("e1", imgFields(5, 0, 0, tif))]]);
  var r2 = X.parse(f2);
  eq(r2.pages.length, 1); eq(r2.pages[0].kind, "tiff");
  eq(diffCount(r2.pages[0].decode().data, PAGE.data), 0);
  // G4（類型碼 9）資料剛好像 DIB 標頭：仍以 G4 處理
  var dibLike = dib4(103, 146, 10);
  eq(X._sniffImage(dibLike, 0, dibLike.length).kind, "dib");
  var f3 = buildXdw([[obj("e2", imgFields(9, 700, 10, dibLike))]]);
  eq(X.parse(f3).pages[0].kind, "g4");
  // JPEG 偽陽性防護：FF D8 開頭但結構不對 → 不是 JPEG
  eq(X._sniffImage(bytes([0xFF, 0xD8, 0x12, 0x34, 0, 0, 0, 0, 0, 0]), 0, 10), null);
  eq(X._sniffImage(bytes([0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xFF, 0, 0, 0, 0]), 0, 10), null);
});

test("截斷的檔案：isXdw 仍為 true、可讀到的頁面照常、最後一頁部分解碼並警告", function () {
  var f = sampleDoc();
  var r0 = X.parse(f), lastObj = r0.pages[1].primary;   // runs 頁位於第 3 個區塊
  var cut = f.subarray(0, lastObj.offset + Math.floor(lastObj.length / 2));
  ok(X.isXdw(cut));
  var r = X.parse(cut);
  eq(r.pages.length, 2);
  eq(r.truncated, true);
  ok(r.pages[1].primary.truncated);
  ok(r.warnings.some(function (w) { return /中斷/.test(w); }), r.warnings.join());
  ok(r.warnings.some(function (w) { return /第 2 頁：影像資料不完整/.test(w); }), r.warnings.join());
  eq(diffCount(r.pages[0].decode().data, PAGE.data), 0);
  var bm = r.pages[1].decode();
  ok(bm.rowsDecoded < RUNS.height && bm.rowsDecoded >= 0);
  for (var y = 0; y < bm.rowsDecoded; y++) for (var x = 0; x < RUNS.width; x++) if (bm.data[y * RUNS.width + x] !== RUNS.data[y * RUNS.width + x]) { ok(false, "prefix rows"); y = 1e9; break; }
  ok(r.pages[1].warnings.length >= 1);
  // 每一種截斷長度都不可拋例外，頁數單調不減
  var prev = 0;
  for (var L = 0; L <= f.length; L += 97) {
    var rr = X.parse(f.subarray(0, L));
    ok(rr.pages.length >= prev || L < 64, "monotonic at " + L);
    prev = rr.pages.length;
    rr.pages.forEach(function (p) { p.decode(); });
    ok(rr.warnings.length > 0 || rr.pages.length === 4, "warnings when truncated at " + L);
  }
});

test("最上層區塊長度損毀：跳到下一個完整區塊繼續讀取", function () {
  var f = sampleDoc(), r0 = X.parse(f);
  // 找到第 3 個 [0x61] 區塊（runs 頁所在）的長度位元組並改小
  var p = 0, n = 0, L = f.length, target = -1;
  while (p < L) {
    var len = f[p + 1], hl = 2;
    if (len >= 0x80) { var k = len & 0x7F; len = 0; for (var q = 0; q < k; q++) len = len * 256 + f[p + 2 + q]; hl = 2 + k; }
    if (f[p] === 0x61 && ++n === 3) { target = p; break; }
    p += hl + len;
  }
  ok(target > 0);
  var m = new Uint8Array(f);
  m[target + 1] = 0x81; m[target + 2] = 0x05;   // 長度 → 5 bytes
  var r = X.parse(m);
  ok(r.warnings.some(function (w) { return /處損毀/.test(w); }), r.warnings.join());
  ok(r.pages.length >= r0.pages.length - 1, "lost at most the damaged block: " + r.pages.length);
  eq(r.pages[r.pages.length - 1].primary.id, "b9d19860");
  // 區塊之間插入垃圾
  var junk = new Uint8Array(37).fill(0xEE);
  var m2 = concat([f.subarray(0, target), junk, f.subarray(target)]);
  var r2 = X.parse(m2);
  eq(r2.pages.length, r0.pages.length, r2.warnings.join());
  ok(r2.warnings.some(function (w) { return /處損毀/.test(w); }));
  eq(diffCount(r2.pages[1].decode().data, RUNS.data), 0);
});

test("非 DocuWorks / 垃圾輸入：不拋例外、pages 為空、中文警告", function () {
  var cases = [null, undefined, 42, "abc", new Uint8Array(0), bytes([0x60]), bytes([0x60, 0x0e]), new Uint8Array(1000),
    new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n" + "x".repeat(200)),
    bytes([0x50, 0x4B, 0x03, 0x04].concat(new Array(200).fill(7)))];
  var R = rng(3);
  for (var k = 0; k < 50; k++) { var g = new Uint8Array(Math.floor(R() * 3000)); for (var i = 0; i < g.length; i++) g[i] = Math.floor(R() * 256); if (k % 2) g[0] = 0x60; cases.push(g); }
  cases.forEach(function (c, i) {
    var r = X.parse(c);
    eq(r.pages.length, 0, "case " + i);
    ok(r.warnings.length >= 1 && /[一-鿿]/.test(r.warnings[0]), "chinese warning " + i);
    ok(typeof X.describe(c) === "string");
    if (i >= 4 && c && c.length) eq(X.isXdw(c), false, "isXdw false " + i);
  });
  eq(X.isXdw(null), false);
  // 只有 0x60 開頭 + 全 0：不可被當成 TLV 鏈
  var z = new Uint8Array(500); z[0] = 0x60; z[1] = 0x0e;
  eq(X.isXdw(z), false);
});

test("模糊測試：隨機改動合成檔，parse + decode 永不拋例外", function () {
  var base = sampleDoc(), R = rng(11);
  for (var t = 0; t < 600; t++) {
    var m = new Uint8Array(base);
    var n = 1 + Math.floor(R() * 6);
    for (var k = 0; k < n; k++) {
      var p = Math.floor(R() * m.length);
      if (R() < 0.5) m[p] = Math.floor(R() * 256); else m[p] ^= 1 << Math.floor(R() * 8);
    }
    if (t % 5 === 0) m = m.subarray(0, Math.floor(R() * m.length));
    var r = X.parse(m);
    ok(Array.isArray(r.pages) && Array.isArray(r.warnings));
    r.pages.forEach(function (pg) { var bm = pg.decode(); if (bm) eq(bm.data.length, bm.width * bm.height); });
  }
});

test("找不到影像的有效 DocuWorks（文字／向量頁）→ 提示轉存 PDF", function () {
  var f = buildXdw([[obj("01", [[0x80, bytes([12])], [0x90, bytes([1, 2, 3])]]), tlv(0x64, [tlv(0x81, bytes([2])), tlv(0x8f, bytes([0, 0, 0]))])]]);
  ok(X.isXdw(f));
  var r = X.parse(f);
  eq(r.valid, true); eq(r.pages.length, 0);
  ok(r.warnings.some(function (w) { return /DocuWorks Printer/.test(w) && /另存為 PDF/.test(w); }), r.warnings.join());
  eq(r.info, "找不到可解碼的頁面影像");
  ok(/找不到可解碼的頁面影像/.test(X.describe(f)));
});

test("舊版 %XDW 檔頭：isXdw true、回報不支援；內嵌 JPEG 以掃描方式擷取", function () {
  var legacy = concat([new TextEncoder().encode("%XDW-1.0\r\n"), new Uint8Array(300).fill(1), fakeJpeg(1000, 1400, 500), new Uint8Array(50), fakeJpeg(100, 100)]);
  ok(X.isXdw(legacy));
  var r = X.parse(legacy);
  eq(r.legacy, true);
  eq(r.pages.length, 1);   // 100×100 的小圖不算頁面
  eq(r.pages[0].kind, "jpeg"); eq(r.pages[0].width, 1000); ok(r.pages[0].primary.scanned);
  ok(r.warnings.some(function (w) { return /舊版/.test(w); }) && r.warnings.some(function (w) { return /搜尋內嵌/.test(w); }));
  var r2 = X.parse(concat([new TextEncoder().encode("%XDW"), new Uint8Array(100)]));
  eq(r2.pages.length, 0); eq(r2.legacy, true);
  ok(/舊版/.test(X.describe(concat([new TextEncoder().encode("%XDW"), new Uint8Array(100)]))));
});

test("內嵌文件（Binder 類）：外層區塊中的原始值若是完整 XDW，會遞迴讀出其頁面", function () {
  var inner = buildXdw([[obj("c0ffee01", imgFields(9, G4P.width, G4P.height, G4P.data))], [obj("c0ffee02", imgFields(9, G4R.width, G4R.height, G4R.data))]]);
  var outer = concat([header(), tlv(0x61, [tlv(0x8A, inner), tlv(0x63, new Uint8Array(9))]), tlv(0x61, [obj("0badf00d", imgFields(9, G4P.width, G4P.height, G4P.data))])]);
  ok(X.isXdw(outer));
  var r = X.parse(outer, { fileName: "binder.xbd" });
  eq(r.format, "xbd");
  eq(r.pages.length, 3, r.warnings.join());
  eq(r.pages[0].primary.id, "c0ffee01"); eq(r.pages[1].primary.id, "c0ffee02"); eq(r.pages[2].primary.id, "0badf00d");
  eq(r.warnings.length, 0, r.warnings.join());
  eq(diffCount(r.pages[1].decode().data, RUNS.data), 0);
});

test("影像一開始就無法解碼（例如加密）→ 提示", function () {
  var junk = new Uint8Array(500); for (var i = 0; i < junk.length; i++) junk[i] = (i * 151 + 7) & 255;
  junk[0] = 0; junk[1] = 0; junk[2] = 0;
  var r = X.parse(buildXdw([[obj("01", imgFields(9, 1654, 2340, junk))]]));
  eq(r.pages.length, 1);
  ok(r.warnings.some(function (w) { return /密碼保護/.test(w); }), r.warnings.join());
  var bm = r.pages[0].decode();
  eq(bm.width, 1654);
  ok(r.pages[0].warnings.some(function (w) { return /密碼保護/.test(w); }));
});

test("G4 位元順序反轉（FillOrder 2）可自動救回；未知類型但像頁面的物件仍計為一頁", function () {
  var rev = C.reverseBits(G4P.data);
  var f = buildXdw([[obj("f1", imgFields(9, G4P.width, G4P.height, rev))],
    [obj("f2", imgFields(42, 1654, 2340, new Uint8Array(400).fill(0x5A)))],
    [obj("f3", [[0x80, bytes([42])], [0x86, new Uint8Array(100)]])]]);
  var r = X.parse(f);
  eq(r.pages.length, 2, r.warnings.join());
  ok(!r.warnings.some(function (w) { return /密碼/.test(w); }), "no encryption warning: " + r.warnings.join());
  var bm = r.pages[0].decode();
  eq(bm.variant, "rev"); eq(diffCount(bm.data, PAGE.data), 0); eq(bm.warnings.length, 0);
  eq(r.pages[1].kind, "unknown"); eq(r.pages[1].width, 1654); eq(r.pages[1].dpi, 200);
  eq(r.pages[1].decode(), null);
  ok(r.warnings.some(function (w) { return /第 2 頁：影像格式無法辨識（類型代碼 42）/.test(w); }), r.warnings.join());
  ok(r.warnings.some(function (w) { return /有 1 個無法辨識的物件（類型代碼 42）/.test(w); }));
  ok(r.warnings.some(function (w) { return /另存為 PDF/.test(w); }));
  eq(X.describe(f), "DocuWorks 文件：2 頁（掃描影像 G4 ×1、未知格式影像 ×1，200 dpi）");
  // 重複解碼不會累積重複警告
  r.pages[1].decode(); r.pages[1].decode();
  eq(r.pages[1].warnings.filter(function (w) { return /無法解碼/.test(w); }).length, 1);
  // 真的是雜訊：不會被「替代解法」誤判成影像
  var junk = new Uint8Array(3000); for (var i = 0; i < junk.length; i++) junk[i] = (i * 2654435761 >>> 24) & 255;
  var rj = X.parse(buildXdw([[obj("f4", imgFields(9, 900, 700, junk))]]));
  var bj = rj.pages[0].decode();
  ok(!bj.variant && bj.rowsDecoded < 700);
});

test("荒謬的頁面尺寸：decode() 回傳 null 與警告，不拋例外", function () {
  var r = X.parse(buildXdw([[obj("h1", imgFields(9, 65535, 65535, G4P.data))]]));
  eq(r.pages.length, 1);
  eq(r.pages[0].decode(), null);
  ok(r.pages[0].warnings.some(function (w) { return /尺寸不合理/.test(w); }), r.pages[0].warnings.join());
  return r.pages[0].decodeAsync().then(function (bm) { eq(bm, null); });
});

test("GIF / WebP / JPEG 2000 魔術數字", function () {
  var gif = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02, 0, 0]);
  var sg = X._sniffImage(gif, 0, gif.length); eq(sg.kind, "gif"); eq(sg.width, 800); eq(sg.height, 600);
  var webp = new Uint8Array(40); webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 0);
  webp[24] = 0x1F; webp[25] = 0x03; webp[27] = 0x57; webp[28] = 0x02;   // 800×600（存 w-1、h-1）
  var sw = X._sniffImage(webp, 0, webp.length); eq(sw.kind, "webp"); eq(sw.width, 800); eq(sw.height, 600);
  var j2k = new Uint8Array(40); j2k.set([0xFF, 0x4F, 0xFF, 0x51, 0, 0x29, 0, 0, 0, 0, 0x06, 0x76, 0, 0, 0x09, 0x24], 0);
  var sj = X._sniffImage(j2k, 0, j2k.length); eq(sj.kind, "jp2"); eq(sj.width, 1654); eq(sj.height, 2340);
  var jp2 = new Uint8Array(80); jp2.set([0, 0, 0, 0x0C, 0x6A, 0x50, 0x20, 0x20, 0x0D, 0x0A, 0x87, 0x0A], 0);
  jp2.set([0x69, 0x68, 0x64, 0x72, 0, 0, 0x09, 0x24, 0, 0, 0x06, 0x76], 40);
  var sp = X._sniffImage(jp2, 0, jp2.length); eq(sp.kind, "jp2"); eq(sp.width, 1654); eq(sp.height, 2340);
  var f = buildXdw([[obj("g1", imgFields(8, 0, 0, j2k))]]);
  var r = X.parse(f);
  eq(r.pages.length, 1); eq(r.pages[0].kind, "jp2");
  ok(r.warnings.some(function (w) { return /JPEG 2000/.test(w); }));
});

test("真實樣本（test_data/fill/A_data.xdw，若存在）：26 頁、逐像素一致、< 60 ms/頁", function () {
  var file = path.join(REAL, "A_data.xdw");
  if (!fs.existsSync(file)) return;   // 無真實樣本：靜默略過
  var b = new Uint8Array(fs.readFileSync(file));
  ok(X.isXdw(b));
  var t0 = Date.now(), r = X.parse(b), tParse = Date.now() - t0;
  eq(r.pages.length, 26); eq(r.version, 7); eq(r.warnings.length, 0, r.warnings.join());
  eq(r.info, "26 頁掃描影像（G4 200dpi）");
  eq(X.describe(b), "DocuWorks 文件：26 頁（掃描影像 G4，200 dpi）");
  ok(tParse < 200, "parse " + tParse + " ms");
  var layers = 0, times = [];
  r.pages.forEach(function (p, i) {
    eq(p.width, 1654); eq(p.height, 2340); eq(p.dpi, 200); eq(p.dpiX, 200); eq(p.dpiY, 200); eq(p.kind, "g4");
    eq(p.widthMm, 210.05); eq(p.heightMm, 297.18);
    layers += p.layers.length;
    var refFile = path.join(REAL, "pages", "adata_p" + String(i + 1).padStart(2, "0") + ".pbm");
    var t = process.hrtime.bigint();
    var bm = p.decode();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    eq(bm.warnings.length, 0);
    if (fs.existsSync(refFile)) {
      var ref = readPbm(fs.readFileSync(refFile));
      eq(ref.width, bm.width); eq(ref.height, bm.height);
      eq(diffCount(bm.data, ref.data), 0, "page " + (i + 1) + " pixel-exact");
    }
  });
  eq(layers, 23);
  var sorted = times.slice(1).sort(function (a, c) { return a - c; });
  var avg = times.reduce(function (s, x) { return s + x; }, 0) / times.length;
  ok(avg < 60, "avg " + avg.toFixed(1) + " ms");
  ok(sorted[sorted.length - 1] < 60, "max " + sorted[sorted.length - 1].toFixed(1) + " ms");
  NOTES.push("真實樣本 26 頁逐像素一致，G4 平均 " + avg.toFixed(1) + " ms/頁");
  // 截斷的真實檔案
  var rc = X.parse(b.subarray(0, 850000));
  eq(rc.pages.length, 26); ok(rc.pages[25].primary.truncated);
  var bc = rc.pages[25].decode();
  ok(bc.rowsDecoded > 0 && bc.rowsDecoded < 2340);
});

/* ---------------- 執行 ---------------- */
(async function () {
  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); }
    catch (e) { failed++; console.error("FAIL: " + tests[i].name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n  ") : e)); }
  }
  if (failed) { console.error("xdw.test.js: " + failed + "/" + tests.length + " 個測試失敗"); process.exit(1); }
  console.log("xdw.test.js: PASS（" + tests.length + " 個測試，" + nAssert + " 個斷言" + (NOTES.length ? "；" + NOTES.join("；") : "") + "）");
})();
