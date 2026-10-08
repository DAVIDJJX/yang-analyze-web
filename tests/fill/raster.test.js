/* =========================================================================
 * tests/fill/raster.test.js — YF.raster（二值化、PBM/PNG 編碼、縮放旋轉、影像解碼）單元測試
 * 執行：node tests/fill/raster.test.js
 * 只用 node 內建模組；PNG 驗證以 node:zlib 解壓（僅測試端使用）。
 * 若本機有 test_data/fill/pages（真實樣本，不進 repo）會額外比對真實頁面。
 * ========================================================================= */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");

var ROOT = path.join(__dirname, "..", "..");
require(path.join(ROOT, "js/fill/raster.js"));
var R = globalThis.YangFill.raster;

var results = [], pending = [];
function test(name, fn) { pending.push({ name: name, fn: fn }); }

/* ---------------- 測試工具 ---------------- */
function makeBin(w, h) { return { width: w, height: h, data: new Uint8Array(w * h) }; }
function rgbaImage(w, h, bg) {
  var d = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) { d[4 * i] = bg[0]; d[4 * i + 1] = bg[1]; d[4 * i + 2] = bg[2]; d[4 * i + 3] = bg.length > 3 ? bg[3] : 255; }
  return d;
}
function paint(d, w, x0, y0, x1, y1, c) {
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
    var q = 4 * (y * w + x); d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = c.length > 3 ? c[3] : 255;
  }
}
/** 迷你 PNG 解碼器（灰階/RGB/RGBA，1/8 位元，非交錯）— 只在測試端用 node:zlib */
function decodePNG(buf) {
  buf = Buffer.from(buf);
  assert.strictEqual(buf.toString("hex", 0, 8), "89504e470d0a1a0a", "PNG 簽章");
  var p = 8, w, h, bd, ct, idat = [], chunks = [];
  while (p < buf.length) {
    var len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (typeof zlib.crc32 === "function") {
      assert.strictEqual(buf.readUInt32BE(p + 8 + len), zlib.crc32(buf.subarray(p + 4, p + 8 + len)), type + " CRC");
    }
    chunks.push(type);
    p += 12 + len;
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  var raw = zlib.inflateSync(Buffer.concat(idat));
  var ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct], bpp = Math.max(1, (ch * bd) >> 3), stride = (w * ch * bd + 7) >> 3;
  assert.strictEqual(raw.length, (stride + 1) * h, "IDAT 長度");
  var out = Buffer.alloc(stride * h), prev = Buffer.alloc(stride);
  for (var y = 0; y < h; y++) {
    var f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = out.subarray(y * stride, (y + 1) * stride);
    for (var x = 0; x < stride; x++) {
      var a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { var pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { w: w, h: h, bd: bd, ct: ct, ch: ch, stride: stride, px: out, chunks: chunks };
}
function pngGet(png, x, y) {   // 回傳 0..255 灰階或 [r,g,b]
  if (png.bd === 1) return ((png.px[y * png.stride + (x >> 3)] >> (7 - (x & 7))) & 1) ? 255 : 0;
  if (png.ch === 1) return png.px[y * png.stride + x];
  var o = y * png.stride + x * png.ch;
  return [png.px[o], png.px[o + 1], png.px[o + 2]];
}
function pngToRGBA(png) {
  var o = new Uint8ClampedArray(png.w * png.h * 4);
  for (var y = 0; y < png.h; y++) for (var x = 0; x < png.w; x++) {
    var v = pngGet(png, x, y), q = 4 * (y * png.w + x);
    if (Array.isArray(v)) { o[q] = v[0]; o[q + 1] = v[1]; o[q + 2] = v[2]; } else { o[q] = o[q + 1] = o[q + 2] = v; }
    o[q + 3] = 255;
  }
  return o;
}
/** 產生 BMP（24 位元或 8 位元調色盤），可選 top-down */
function makeBMP(w, h, getRGB, bpp, topDown) {
  bpp = bpp || 24;
  var stride = ((w * bpp + 31) >> 5) << 2, pal = bpp === 8 ? 256 * 4 : 0, off = 54 + pal, size = off + stride * h;
  var b = Buffer.alloc(size);
  b.write("BM", 0, "ascii"); b.writeUInt32LE(size, 2); b.writeUInt32LE(off, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(topDown ? -h : h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(bpp, 28); b.writeUInt32LE(0, 30); b.writeUInt32LE(stride * h, 34);
  if (bpp === 8) { b.writeUInt32LE(256, 46); for (var k = 0; k < 256; k++) { b[54 + 4 * k] = k; b[55 + 4 * k] = k; b[56 + 4 * k] = k; } }
  for (var y = 0; y < h; y++) {
    var row = off + (topDown ? y : h - 1 - y) * stride;
    for (var x = 0; x < w; x++) {
      var c = getRGB(x, y);
      if (bpp === 24) { b[row + 3 * x] = c[2]; b[row + 3 * x + 1] = c[1]; b[row + 3 * x + 2] = c[0]; }
      else b[row + x] = c[0];
    }
  }
  return new Uint8Array(b);
}

/* ---------------- 二值化 ---------------- */
test("binarize（最大色版）：黑字為墨、紅/藍印章與彩色註記變紙、透明為紙", function () {
  var w = 120, h = 60, d = rgbaImage(w, h, [250, 248, 245]);
  paint(d, w, 10, 10, 30, 20, [20, 20, 20]);        // 黑字
  paint(d, w, 40, 10, 60, 20, [230, 30, 40]);       // 紅章
  paint(d, w, 70, 10, 90, 20, [40, 60, 220]);       // 藍章
  paint(d, w, 10, 30, 30, 40, [100, 100, 100]);     // 深灰字
  paint(d, w, 40, 30, 60, 40, [0, 0, 0, 0]);        // 透明
  paint(d, w, 70, 30, 90, 40, [0, 0, 0, 40]);       // 半透明黑（合成後偏白）
  var b = R.binarize(d, w, h);
  assert.strictEqual(b.width, w); assert.strictEqual(b.height, h);
  assert.ok(b.threshold >= 110 && b.threshold <= 185, "門檻 " + b.threshold);
  function at(x, y) { return b.data[y * w + x]; }
  assert.strictEqual(at(20, 15), 1, "黑字");
  assert.strictEqual(at(50, 15), 0, "紅章");
  assert.strictEqual(at(80, 15), 0, "藍章");
  assert.strictEqual(at(20, 35), 1, "深灰");
  assert.strictEqual(at(50, 35), 0, "透明");
  assert.strictEqual(at(80, 35), 0, "半透明");
  assert.strictEqual(at(5, 5), 0, "紙");
  // 其他模式
  var luma = R.binarize(d, w, h, { mode: "luma", threshold: 150 });
  assert.strictEqual(luma.data[15 * w + 50], 1, "亮度模式紅章為墨");
  var mn = R.binarize(d, w, h, { mode: "min", threshold: 150 });
  assert.strictEqual(mn.data[15 * w + 80], 1, "最小色版藍章為墨");
  // 指定門檻
  var t = R.binarize(d, w, h, { threshold: 90 });
  assert.strictEqual(t.threshold, 90);
  assert.strictEqual(t.data[35 * w + 20], 0, "門檻 90 時灰 100 為紙");
});

test("binarize：Otsu 夾在 [110,185]；全白頁、低對比頁不爆量；可用 min/max 改夾限", function () {
  var w = 200, h = 100;
  var white = R.binarize(rgbaImage(w, h, [255, 255, 255]), w, h);
  assert.strictEqual(white.data.reduce(function (s, v) { return s + v; }, 0), 0, "全白");
  assert.strictEqual(white.threshold, 110);
  // 灰底（200）上的深字（60）：門檻應落在兩者之間
  var d = rgbaImage(w, h, [200, 200, 200]);
  paint(d, w, 20, 20, 60, 40, [60, 60, 60]);
  var b = R.binarize(d, w, h);
  assert.ok(b.threshold > 60 && b.threshold <= 185);
  assert.strictEqual(b.data[30 * w + 30], 1); assert.strictEqual(b.data[5 * w + 5], 0);
  // 很亮的紙（254）+ 很淡的字（205）：Otsu 落在 205 以上 → 夾到 185（淡字視為紙）
  var d2 = rgbaImage(w, h, [254, 254, 254]);
  paint(d2, w, 20, 20, 60, 40, [205, 205, 205]);
  paint(d2, w, 100, 20, 140, 40, [150, 150, 150]);
  var b2 = R.binarize(d2, w, h);
  assert.strictEqual(b2.threshold, 185);
  assert.strictEqual(b2.data[30 * w + 30], 0);
  assert.strictEqual(b2.data[30 * w + 120], 1);
  assert.strictEqual(R.binarize(d2, w, h, { max: 140 }).threshold, 140);
  assert.strictEqual(R.binarize(d2, w, h, { max: 140 }).data[30 * w + 120], 0);
  assert.strictEqual(R.binarize(d2, w, h, { max: 230 }).data[30 * w + 30], 1, "放寬上限後淡字為墨");
  // 輸入檢查
  assert.throws(function () { R.binarize(new Uint8ClampedArray(10), 10, 10); }, /長度不足/);
  assert.throws(function () { R.binarize(new Uint8ClampedArray(0), 0, 0); }, /寬高/);
  // 大圖取樣直方圖（> 400 萬像素）結果與小圖一致
  var W = 2100, H = 2000, big = rgbaImage(W, H, [245, 245, 245]);
  paint(big, W, 100, 100, 900, 300, [30, 30, 30]);
  var bb = R.binarize(big, W, H);
  assert.strictEqual(bb.data[200 * W + 500], 1); assert.strictEqual(bb.data[1000 * W + 1000], 0);
});

test("otsu：雙峰直方圖的門檻在兩峰之間；空直方圖回傳 -1", function () {
  var hist = new Float64Array(256);
  for (var i = 0; i < 1000; i++) { hist[40 + (i % 10)]++; hist[220 + (i % 10)] += 3; }
  var t = R.otsu(hist);
  assert.ok(t >= 49 && t < 220, "t=" + t);
  assert.strictEqual(R.otsu(new Float64Array(256)), -1);
  var one = new Float64Array(256); one[255] = 100;
  assert.strictEqual(R.otsu(one), -1);
});

/* ---------------- PBM ---------------- */
test("encodePBM：P4 標頭、位元打包、bbox 裁切、白邊、遮罩去線；decodePBM 往返", function () {
  var b = makeBin(20, 10);
  b.data[0] = 1; b.data[9] = 1; b.data[19] = 1; b.data[5 * 20 + 10] = 1; b.data[9 * 20 + 19] = 1;
  var pbm = R.encodePBM(b);
  var head = Buffer.from(pbm.subarray(0, 9)).toString("ascii");
  assert.strictEqual(head, "P4\n20 10\n");
  assert.strictEqual(pbm.length, 9 + 3 * 10);
  assert.strictEqual(pbm[9], 0x80, "第一像素");
  assert.strictEqual(pbm[10], 0x40, "x=9");
  var back = R.decodePBM(pbm);
  assert.deepStrictEqual(Array.from(back.data), Array.from(b.data));
  // bbox + pad
  var crop = R.encodePBM(b, { x0: 8, y0: 4, x1: 12, y1: 6 }, 2);
  var cb = R.decodePBM(crop);
  assert.strictEqual(cb.width, 9); assert.strictEqual(cb.height, 7);
  assert.strictEqual(cb.data[(1 + 2) * 9 + (2 + 2)], 1, "(10,5) → (4,3)");
  assert.strictEqual(cb.data.reduce(function (s, v) { return s + v; }, 0), 1);
  // 遮罩：被遮的像素輸出為紙
  var mask = new Uint8Array(200); mask[0] = 1; mask[5 * 20 + 10] = 3;
  var mk = R.decodePBM(R.encodePBM(b, null, 0, mask));
  assert.strictEqual(mk.data[0], 0); assert.strictEqual(mk.data[5 * 20 + 10], 0); assert.strictEqual(mk.data[9], 1);
  // bbox 超出影像 → 裁到範圍；完全在外 → 只剩白邊
  assert.strictEqual(R.decodePBM(R.encodePBM(b, { x0: -5, y0: -5, x1: 100, y1: 100 })).width, 20);
  var out = R.decodePBM(R.encodePBM(b, { x0: 50, y0: 50, x1: 60, y1: 60 }, 3));
  assert.strictEqual(out.width, 6); assert.strictEqual(out.data.reduce(function (s, v) { return s + v; }, 0), 0);
  // 寬度非 8 的倍數
  var odd = makeBin(13, 3); odd.data[12] = 1; odd.data[13 + 12] = 1;
  assert.deepStrictEqual(Array.from(R.decodePBM(R.encodePBM(odd)).data), Array.from(odd.data));
});

test("decodePBM：P1 文字格式與註解、錯誤格式丟出例外", function () {
  var p1 = Buffer.from("P1\n# 註解\n4 2\n1 0 0 1\n0 1 1 0\n", "utf8");
  var b = R.decodePBM(new Uint8Array(p1));
  assert.deepStrictEqual(Array.from(b.data), [1, 0, 0, 1, 0, 1, 1, 0]);
  var p4c = Buffer.concat([Buffer.from("P4\n# c\n8 1\n"), Buffer.from([0xA5])]);
  assert.deepStrictEqual(Array.from(R.decodePBM(p4c).data), [1, 0, 1, 0, 0, 1, 0, 1]);
  assert.throws(function () { R.decodePBM(Buffer.from("P5\n1 1\n255\n\0")); }, /不支援/);
  assert.throws(function () { R.decodePBM(Buffer.from("P4\n0 0\n")); }, /尺寸/);
  // 截斷的 P4：讀得到的部分照讀
  var tr = R.decodePBM(Buffer.concat([Buffer.from("P4\n8 3\n"), Buffer.from([0xFF])]));
  assert.strictEqual(tr.data.reduce(function (s, v) { return s + v; }, 0), 8);
});

/* ---------------- PNG / data URL ---------------- */
test("encodePNG：1 位元 PNG 可被 zlib 解開且像素一致（含寬度非 8 倍數、重複列壓縮）", function () {
  var w = 333, h = 77, b = makeBin(w, h), seed = 5;
  for (var i = 0; i < w * h; i++) { seed = (seed * 1103515245 + 12345) >>> 0; if ((seed >>> 24) < 40) b.data[i] = 1; }
  for (var y = 40; y < 77; y++) for (var x = 0; x < w; x++) b.data[y * w + x] = (x % 7 === 0) ? 1 : 0;   // 重複列
  var png = R.encodePNG(b), dec = decodePNG(png);
  assert.deepStrictEqual(dec.chunks, ["IHDR", "IDAT", "IEND"]);
  assert.strictEqual(dec.w, w); assert.strictEqual(dec.h, h); assert.strictEqual(dec.bd, 1);
  var bad = 0;
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) if ((pngGet(dec, x, y) === 0 ? 1 : 0) !== b.data[y * w + x]) bad++;
  assert.strictEqual(bad, 0);
  // bbox 裁切
  var c = decodePNG(R.encodePNG(b, { x0: 10, y0: 5, x1: 30, y1: 9 }));
  assert.strictEqual(c.w, 21); assert.strictEqual(c.h, 5);
  assert.strictEqual(pngGet(c, 0, 0) === 0 ? 1 : 0, b.data[5 * w + 10]);
  // 整張空白頁壓縮後很小
  var blank = R.encodePNG(makeBin(1654, 2340));
  assert.ok(blank.length < 20000, "空白頁 PNG " + blank.length + " bytes");
  decodePNG(blank);
});

test("encodePNG（縮圖）：scale<1 輸出 8 位元灰階、面積平均", function () {
  var b = makeBin(40, 20);
  for (var y = 0; y < 20; y++) for (var x = 0; x < 20; x++) b.data[y * 40 + x] = 1;       // 左半全黑
  for (y = 0; y < 20; y++) for (x = 20; x < 40; x += 2) b.data[y * 40 + x] = 1;            // 右半 50%
  var dec = decodePNG(R.encodePNG(b, null, 0.25));
  assert.strictEqual(dec.bd, 8); assert.strictEqual(dec.w, 10); assert.strictEqual(dec.h, 5);
  assert.strictEqual(pngGet(dec, 1, 1), 0);
  assert.ok(Math.abs(pngGet(dec, 8, 2) - 128) <= 2, "50% 灰：" + pngGet(dec, 8, 2));
});

test("base64 與 Buffer 一致；bitmapToDataURL 在無 DOM 時輸出純 JS PNG", function () {
  for (var n = 0; n < 12; n++) {
    var a = new Uint8Array(n); for (var i = 0; i < n; i++) a[i] = (i * 37 + n) & 255;
    assert.strictEqual(R.base64(a), Buffer.from(a).toString("base64"), "n=" + n);
  }
  var big = new Uint8Array(70000); for (i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
  assert.strictEqual(R.base64(big), Buffer.from(big).toString("base64"));
  var b = makeBin(300, 100); for (i = 0; i < 300; i++) b.data[50 * 300 + i] = 1;
  assert.strictEqual(R.hasCanvas(), false);
  var url = R.bitmapToDataURL(b, { x0: 0, y0: 40, x1: 299, y1: 60 });
  assert.ok(/^data:image\/png;base64,/.test(url));
  var dec = decodePNG(Buffer.from(url.split(",")[1], "base64"));
  assert.strictEqual(dec.w, 300); assert.strictEqual(dec.h, 21);
  var small = decodePNG(Buffer.from(R.bitmapToDataURL(b, null, 150).split(",")[1], "base64"));
  assert.strictEqual(small.w, 150); assert.strictEqual(small.bd, 8);
  assert.strictEqual(R.bitmapToDataURL(b, { x0: 500, y0: 500, x1: 600, y1: 600 }), "", "bbox 在外");
});

test("setCanvasFactory：注入假 canvas，bitmapToCanvas / bitmapToDataURL 走 canvas 路徑", function () {
  var made = [];
  R.setCanvasFactory(function (w, h) {
    var cv = { width: w, height: h, put: null };
    cv.getContext = function () {
      return {
        createImageData: function (W, H) { return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }; },
        putImageData: function (id) { cv.put = id; }
      };
    };
    cv.toDataURL = function () { return "data:image/png;base64,FAKE" + w + "x" + h; };
    made.push(cv);
    return cv;
  });
  try {
    var b = makeBin(100, 50); b.data[0] = 1;
    var cv = R.bitmapToCanvas(b, null, 50);
    assert.strictEqual(cv.width, 50); assert.strictEqual(cv.height, 25);
    assert.ok(cv.put && cv.put.data[0] < 255, "左上角縮圖為灰/黑");
    assert.strictEqual(R.bitmapToDataURL(b), "data:image/png;base64,FAKE100x50");
    assert.strictEqual(R.hasCanvas(), true);
  } finally { R.setCanvasFactory(null); }
  assert.strictEqual(R.hasCanvas(), false);
});

/* ---------------- RGBA / 縮放 / 旋轉 / 裁切 ---------------- */
test("bitmapToRGBA：墨黑紙白、bbox、放大最近鄰、縮小平均", function () {
  var b = makeBin(4, 2); b.data[1] = 1; b.data[6] = 1;
  var r = R.bitmapToRGBA(b);
  assert.strictEqual(r.width, 4); assert.ok(r.data instanceof Uint8ClampedArray);
  assert.deepStrictEqual(Array.from(r.data.subarray(0, 8)), [255, 255, 255, 255, 0, 0, 0, 255]);
  var up = R.bitmapToRGBA(b, { x0: 1, y0: 0, x1: 2, y1: 1 }, 2);
  assert.strictEqual(up.width, 4); assert.strictEqual(up.height, 4);
  assert.strictEqual(up.data[0], 0); assert.strictEqual(up.data[4 * 2], 255);
  var down = R.bitmapToRGBA(b, null, 0.5);
  assert.strictEqual(down.width, 2); assert.strictEqual(down.height, 1);
  assert.strictEqual(down.data[0], 191); assert.strictEqual(down.data[4], 191);
});

test("scaleBitmap：縮小保留 1px 細線（2× / 3×）、放大最近鄰、倍率 1 回傳原物件、錯誤倍率丟例外", function () {
  var b = makeBin(600, 300);
  for (var x = 0; x < 600; x++) b.data[150 * 600 + x] = 1;        // 1px 水平線
  for (var y = 0; y < 300; y++) b.data[y * 600 + 301] = 1;         // 1px 垂直線
  [0.5, 1 / 3, 0.37].forEach(function (f) {
    var s = R.scaleBitmap(b, f), W = s.width, H = s.height;
    assert.strictEqual(W, Math.round(600 * f));
    var rowHit = false, colHit = false;
    for (var yy = 0; yy < H; yy++) { var cnt = 0; for (var xx = 0; xx < W; xx++) cnt += s.data[yy * W + xx]; if (cnt >= W - 2) rowHit = true; }
    for (xx = 0; xx < W; xx++) { var c2 = 0; for (yy = 0; yy < H; yy++) c2 += s.data[yy * W + xx]; if (c2 >= H - 2) colHit = true; }
    assert.ok(rowHit && colHit, "倍率 " + f + " 細線消失");
  });
  var up = R.scaleBitmap({ width: 2, height: 1, data: new Uint8Array([1, 0]) }, 2);
  assert.deepStrictEqual(Array.from(up.data), [1, 1, 0, 0, 1, 1, 0, 0]);
  assert.strictEqual(R.scaleBitmap(b, 1), b);
  assert.throws(function () { R.scaleBitmap(b, 0); });
  assert.throws(function () { R.scaleBitmap({ width: 2, height: 2, data: new Uint8Array(1) }, 0.5); });
});

test("normalize：600dpi → 300dpi；未知 dpi 的超大圖縮到 A4 300dpi；一般圖不動", function () {
  var b = makeBin(4960, 100);
  var n1 = R.normalize(b, 600);
  assert.strictEqual(n1.factor, 0.5); assert.strictEqual(n1.dpi, 300); assert.strictEqual(n1.bitmap.width, 2480);
  var n2 = R.normalize(makeBin(100, 7016));
  assert.ok(Math.abs(n2.factor - 0.5) < 1e-9 && n2.dpi === null);
  var small = makeBin(1654, 2340), n3 = R.normalize(small, 200);
  assert.strictEqual(n3.bitmap, small); assert.strictEqual(n3.factor, 1);
  assert.strictEqual(R.normalize(small, 310).factor, 1, "略高於 300 不縮");
});

test("rotateBitmap：與 grid.deskewAngle 同一角度定義，轉 -angle 後變水平", function () {
  require(path.join(ROOT, "js/fill/grid.js"));
  var G = globalThis.YangFill.grid;
  var b = makeBin(1400, 900);
  for (var k = 0; k < 6; k++) for (var x = 100; x < 1300; x++) { b.data[(150 + k * 120) * 1400 + x] = 1; b.data[(151 + k * 120) * 1400 + x] = 1; }
  for (var y = 150; y < 752; y++) { b.data[y * 1400 + 100] = 1; b.data[y * 1400 + 1299] = 1; }
  var rot = R.rotateBitmap(b, 1.2);
  var a = G.deskewAngle(rot, { dpi: 200 });
  assert.ok(Math.abs(a - 1.2) < 0.08, "估計角 " + a);
  var back = R.rotateBitmap(rot, -a);
  assert.ok(Math.abs(G.deskewAngle(back, { dpi: 200 })) < 0.08);
  // 右下傾：水平線右端 y 較大
  var yL = -1, yR = -1;
  for (y = 0; y < 900; y++) { if (yL < 0 && rot.data[y * 1400 + 200]) yL = y; if (yR < 0 && rot.data[y * 1400 + 1200]) yR = y; }
  assert.ok(yR > yL, "正角度 = 往右下傾");
  assert.strictEqual(R.rotateBitmap(b, 0), b);
  // 旋轉後總墨量大致保留
  var s0 = 0, s1 = 0; for (var i = 0; i < b.data.length; i++) { s0 += b.data[i]; s1 += rot.data[i]; }
  assert.ok(Math.abs(s1 - s0) / s0 < 0.05);
});

test("cropBitmap：裁切與越界", function () {
  var b = makeBin(10, 10); b.data[3 * 10 + 4] = 1;
  var c = R.cropBitmap(b, { x0: 2, y0: 2, x1: 6, y1: 5 });
  assert.strictEqual(c.width, 5); assert.strictEqual(c.height, 4); assert.strictEqual(c.data[1 * 5 + 2], 1);
  assert.strictEqual(R.cropBitmap(b, { x0: 20, y0: 20, x1: 30, y1: 30 }).width, 0);
  assert.strictEqual(R.cropBitmap(b, { x0: -3, y0: -3, x1: 3, y1: 3 }).width, 4);
});

/* ---------------- 影像解碼 ---------------- */
test("decodeBMP：24 位元 bottom-up、8 位元調色盤 top-down；非 BMP 回傳 null", function () {
  var bmp = makeBMP(5, 3, function (x, y) { return x === 1 && y === 2 ? [10, 20, 30] : [255, 255, 255]; }, 24, false);
  var d = R.decodeBMP(bmp);
  assert.strictEqual(d.width, 5); assert.strictEqual(d.height, 3);
  var q = 4 * (2 * 5 + 1);
  assert.deepStrictEqual(Array.from(d.data.subarray(q, q + 4)), [10, 20, 30, 255]);
  var b8 = R.decodeBMP(makeBMP(6, 2, function (x, y) { return [x === y ? 0 : 255]; }, 8, true));
  assert.strictEqual(b8.data[0], 0); assert.strictEqual(b8.data[4], 255); assert.strictEqual(b8.data[4 * (6 + 1)], 0);
  assert.strictEqual(R.decodeBMP(new Uint8Array([1, 2, 3])), null);
});

test("decodeImageBytes：PBM / BMP / TIFF（ccitt）在 Node 也能解；PNG 無 canvas 時給中文錯誤", function () {
  var b = makeBin(16, 4); b.data[5] = 1;
  var bmp = makeBMP(8, 8, function (x, y) { return (x + y) % 2 ? [0, 0, 0] : [255, 255, 255]; }, 24);
  // 最小未壓縮二值 TIFF：8×2，PhotometricInterpretation=0（0=白）
  var tif = (function () {
    var px = [0x0F, 0xF0], entries = [[256, 3, 1, 8], [257, 3, 1, 2], [258, 3, 1, 1], [259, 3, 1, 1], [262, 3, 1, 0], [273, 4, 1, 0], [278, 3, 1, 2], [279, 4, 1, 2]];
    var ifdOff = 8, n = entries.length, dataOff = ifdOff + 2 + n * 12 + 4, buf = Buffer.alloc(dataOff + 2);
    buf.write("II", 0, "ascii"); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdOff, 4); buf.writeUInt16LE(n, ifdOff);
    entries.forEach(function (e, i) {
      var o = ifdOff + 2 + i * 12; buf.writeUInt16LE(e[0], o); buf.writeUInt16LE(e[1], o + 2); buf.writeUInt32LE(e[2], o + 4);
      var v = e[0] === 273 ? dataOff : e[3];
      if (e[1] === 3) buf.writeUInt16LE(v, o + 8); else buf.writeUInt32LE(v, o + 8);
    });
    buf[dataOff] = px[0]; buf[dataOff + 1] = px[1];
    return new Uint8Array(buf);
  })();
  var ccittPath = path.join(ROOT, "js/fill/ccitt.js"), stubbed = false;
  if (fs.existsSync(ccittPath)) require(ccittPath);
  if (!globalThis.YangFill.ccitt) {
    stubbed = true;
    globalThis.YangFill.ccitt = { decodeTiff: function () { return [{ width: 8, height: 2, data: new Uint8Array([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]) }]; } };
  }
  return Promise.all([
    R.decodeImageBytes(R.encodePBM(b)).then(function (img) {
      assert.strictEqual(img.width, 16); assert.strictEqual(img.data.length, 16 * 4 * 4);
      assert.strictEqual(img.data[4 * 5], 0); assert.ok(img.bitmap && img.bitmap.data[5] === 1);
    }),
    R.decodeImageBytes(bmp, "image/bmp").then(function (img) {
      assert.strictEqual(img.width, 8); assert.strictEqual(img.data[0], 255); assert.strictEqual(img.data[4], 0);
      var bin = R.binarize(img.data, img.width, img.height);
      assert.strictEqual(bin.data[1], 1);
    }),
    R.decodeImageBytes(tif, "image/tiff").then(function (img) {
      assert.strictEqual(img.width, 8); assert.strictEqual(img.height, 2);
      assert.ok(img.bitmap, "二值 TIFF 附 bitmap");
      assert.strictEqual(img.bitmap.data[0], 0); assert.strictEqual(img.bitmap.data[4], 1); assert.strictEqual(img.bitmap.data[8], 1);
    }),
    R.decodeImageBytes(R.encodePNG(b), "image/png").then(function () { throw new Error("不應成功"); }, function (e) {
      assert.ok(/無法解碼影像/.test(e.message), e.message);
    }),
    R.decodeImageBytes("not bytes").then(function () { throw new Error("不應成功"); }, function (e) {
      assert.ok(/Uint8Array/.test(e.message));
    })
  ]).then(function () { if (stubbed) delete globalThis.YangFill.ccitt; });
});

test("sniff：常見影像魔數", function () {
  assert.strictEqual(R.sniff(new Uint8Array([0x89, 0x50, 0x4E, 0x47])), "png");
  assert.strictEqual(R.sniff(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), "jpeg");
  assert.strictEqual(R.sniff(new Uint8Array([0x49, 0x49, 0x2A, 0])), "tiff");
  assert.strictEqual(R.sniff(new Uint8Array([0x4D, 0x4D, 0, 0x2A])), "tiff");
  assert.strictEqual(R.sniff(new Uint8Array([0x42, 0x4D, 0, 0])), "bmp");
  assert.strictEqual(R.sniff(new Uint8Array(Buffer.from("GIF89a"))), "gif");
  assert.strictEqual(R.sniff(new Uint8Array(Buffer.from("RIFF\0\0\0\0WEBP"))), "webp");
  assert.strictEqual(R.sniff(new Uint8Array([1, 2, 3])), null);
});

/* ---------------- 真實樣本（僅本機有 test_data 時） ---------------- */
var PAGES = path.join(ROOT, "test_data", "fill", "pages");
if (fs.existsSync(path.join(PAGES, "odor_p01.png")) && fs.existsSync(path.join(PAGES, "odor_p01.pbm"))) {
  test("真實：異味報告灰階掃描 → Otsu 二值化與參考 PBM（門檻 150）格線偵測結果一致", function () {
    require(path.join(ROOT, "js/fill/grid.js"));
    var G = globalThis.YangFill.grid;
    var png = decodePNG(fs.readFileSync(path.join(PAGES, "odor_p01.png")));
    var rgba = pngToRGBA(png), t0 = Date.now();
    var bin = R.binarize(rgba, png.w, png.h);
    var ms = Date.now() - t0;
    var ref = R.decodePBM(fs.readFileSync(path.join(PAGES, "odor_p01.pbm")));
    assert.ok(bin.threshold >= 150 && bin.threshold <= 185, "門檻 " + bin.threshold);
    assert.ok(ms < 400, "binarize " + ms + "ms");
    // 與參考（max<150）相比只多出筆畫邊緣，不應多出大量雜訊
    var a = 0, bb = 0, both = 0;
    for (var i = 0; i < bin.data.length; i++) { a += bin.data[i]; bb += ref.data[i]; if (bin.data[i] && ref.data[i]) both++; }
    assert.strictEqual(both, bb, "參考墨點都應保留");
    assert.ok(a < bb * 1.8, "墨點 " + a + " vs " + bb);
    var r1 = G.detectTables(bin, { dpi: 200 }), r2 = G.detectTables(ref, { dpi: 200 });
    assert.strictEqual(r1.tables.length, r2.tables.length);
    assert.strictEqual(r1.tables[0].cells.length, r2.tables[0].cells.length);
    assert.strictEqual(r1.tables[0].nCols, r2.tables[0].nCols);
    assert.strictEqual(r1.tables[0].nRows, r2.tables[0].nRows);
    // 指定 150 應與參考完全一致
    var b150 = R.binarize(rgba, png.w, png.h, { threshold: 150 }), diff = 0;
    for (i = 0; i < b150.data.length; i++) if (b150.data[i] !== ref.data[i]) diff++;
    assert.strictEqual(diff, 0);
  });
}
if (fs.existsSync(path.join(PAGES, "adata_p03.png")) && fs.existsSync(path.join(PAGES, "adata_p03.pbm"))) {
  test("真實：A data 1 位元 PNG → binarize 與 PBM 完全相同；encodePNG 往返一致", function () {
    var png = decodePNG(fs.readFileSync(path.join(PAGES, "adata_p03.png")));
    var bin = R.binarize(pngToRGBA(png), png.w, png.h);
    var ref = R.decodePBM(fs.readFileSync(path.join(PAGES, "adata_p03.pbm")));
    var diff = 0, i;
    for (i = 0; i < ref.data.length; i++) if (bin.data[i] !== ref.data[i]) diff++;
    assert.strictEqual(diff, 0);
    var t0 = Date.now(), enc = R.encodePNG(ref), ms = Date.now() - t0;
    assert.ok(ms < 1500, "encodePNG " + ms + "ms");
    var dec = decodePNG(enc), bad = 0;
    for (var y = 0; y < dec.h; y++) for (var x = 0; x < dec.w; x++) if ((pngGet(dec, x, y) === 0 ? 1 : 0) !== ref.data[y * dec.w + x]) bad++;
    assert.strictEqual(bad, 0);
    assert.ok(enc.length < 200000, "整頁 PNG " + enc.length + " bytes");
  });
}

/* ---------------- 執行 ---------------- */
(function runAll() {
  var i = 0, passed = 0, failed = 0, fails = [];
  function next() {
    if (i >= pending.length) {
      if (failed) {
        console.error("FAIL raster.test.js：" + failed + " 失敗 / " + (passed + failed));
        fails.forEach(function (f) { console.error("  ✗ " + f); });
        process.exit(1);
      }
      console.log("PASS raster.test.js：" + passed + " 項通過" + (fs.existsSync(PAGES) ? "（含真實樣本）" : "（無真實樣本，略過）"));
      return;
    }
    var t = pending[i++];
    Promise.resolve().then(t.fn).then(function () { passed++; }, function (e) {
      failed++; fails.push(t.name + "：" + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e));
    }).then(next);
  }
  next();
})();
