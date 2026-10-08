/* ccitt.test.js — js/fill/ccitt.js 單元測試（僅用 node 內建模組與合成資料）
 * 執行：node tests/fill/ccitt.test.js
 * 內容：碼表完整性、獨立編碼器來回測試（G4 / G3 1D / G3 2D / RLE）、libtiff 產生的合成 TIFF
 *       （tests/fill/fixtures/ccitt_*，由 ccitt_make_fixtures.py 產生）、損毀/截斷資料、TIFF 邊界情形、效能。
 */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "js/fill/ccitt.js"));
var C = globalThis.YangFill.ccitt;
var FX = path.join(__dirname, "fixtures");

var tests = [], nAssert = 0, NOTES = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function eq(a, b, msg) { nAssert++; assert.strictEqual(a, b, msg); }
function ok(v, msg) { nAssert++; assert.ok(v, msg); }

/* ---------------- 小工具 ---------------- */
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
  if (tok[0] !== "P4") throw new Error("not P4");
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
function sameRows(a, b, w, rows) {
  for (var i = 0; i < w * rows; i++) if (a[i] !== b[i]) return false;
  return true;
}
// 可重現的亂數
function rng(seed) {
  var s = seed >>> 0 || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/* ---------------- 獨立的 CCITT 編碼器（直接依 T.4/T.6 定義，不共用解碼器邏輯） ---------------- */
var CODES = C._codes;
function BitWriter() { this.bits = []; }
BitWriter.prototype.put = function (code) { for (var i = 0; i < code.length; i++) this.bits.push(code.charCodeAt(i) === 49 ? 1 : 0); };
BitWriter.prototype.align = function () { while (this.bits.length % 8) this.bits.push(0); };
BitWriter.prototype.bytes = function () {
  var n = Math.ceil(this.bits.length / 8), out = new Uint8Array(n);
  for (var i = 0; i < this.bits.length; i++) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
};
function putRun(bw, color, r) {
  var term = color ? CODES.BLACK_TERM : CODES.WHITE_TERM, mk = color ? CODES.BLACK_MAKEUP : CODES.WHITE_MAKEUP;
  while (r > 2560) { bw.put(CODES.EXT_MAKEUP[12]); r -= 2560; }
  if (r >= 1792) { bw.put(CODES.EXT_MAKEUP[(r >> 6) - 28]); r &= 63; }
  else if (r >= 64) { bw.put(mk[(r >> 6) - 1]); r &= 63; }
  bw.put(term[r]);
}
function modeCode(kind, d) {
  for (var i = 0; i < CODES.MODES.length; i++) if (CODES.MODES[i][1] === kind && CODES.MODES[i][2] === d) return CODES.MODES[i][0];
  throw new Error("no mode");
}
var P_CODE = "0001", H_CODE = "001";
function px(line, x) { return x < 0 ? 0 : line[x]; }
function encodeLine1D(bw, cur, w) {
  var color = 0, x = 0;
  while (x < w) {
    var s = x;
    while (x < w && cur[x] === color) x++;
    putRun(bw, color, x - s);
    color ^= 1;
  }
  // 結尾若為黑色行程已寫；若最後一個行程後剛好到寬度則結束
}
function encodeLine2D(bw, cur, ref, w) {
  var a0 = -1, color = 0, a1, a2, b1, b2, p;
  while (a0 < w) {
    for (a1 = a0 + 1; a1 < w && cur[a1] === color; a1++);
    if (a0 < 0) for (a1 = 0; a1 < w && cur[a1] === color; a1++);
    // b1：參考列上 a0 右側第一個「顏色與 color 相反」的變化點
    for (b1 = a0 + 1; b1 < w; b1++) if (ref[b1] !== px(ref, b1 - 1) && ref[b1] !== color) break;
    if (a0 < 0) for (b1 = 0; b1 < w; b1++) if (ref[b1] !== px(ref, b1 - 1) && ref[b1] !== color) break;
    for (b2 = b1 + 1; b2 < w; b2++) if (ref[b2] !== ref[b2 - 1]) break;
    if (b2 > w) b2 = w;
    if (b2 < a1) { bw.put(P_CODE); a0 = b2; continue; }
    if (Math.abs(a1 - b1) <= 3) { bw.put(modeCode(2, a1 - b1)); a0 = a1; color ^= 1; continue; }
    for (a2 = a1 + 1; a2 < w && cur[a2] !== color; a2++);
    if (a1 >= w) a2 = w;
    bw.put(H_CODE);
    putRun(bw, color, a1 - (a0 < 0 ? 0 : a0));
    putRun(bw, color ^ 1, a2 - a1);
    a0 = a2;
  }
  void p;
}
function rowsOf(img) {
  var r = [];
  for (var y = 0; y < img.height; y++) r.push(img.data.subarray(y * img.width, (y + 1) * img.width));
  return r;
}
function encodeG4(img, opts) {
  opts = opts || {};
  var bw = new BitWriter(), w = img.width, rows = rowsOf(img), ref = new Uint8Array(w), n = opts.rows === undefined ? img.height : opts.rows;
  for (var y = 0; y < n; y++) {
    if (opts.byteAlign && y > 0) bw.align();
    encodeLine2D(bw, rows[y], ref, w);
    ref = rows[y];
  }
  if (!opts.noEofb) { bw.put(CODES.EOL); bw.put(CODES.EOL); }
  return bw.bytes();
}
function encodeG3(img, opts) {
  opts = opts || {};
  var bw = new BitWriter(), w = img.width, rows = rowsOf(img), ref = null, K = opts.k || 2;
  for (var y = 0; y < img.height; y++) {
    var oneD = !opts.twoD || y % K === 0;
    if (opts.rle) { if (y > 0) bw.align(); }
    else if (!opts.noEol) {
      if (opts.fill) while ((bw.bits.length + 12 + (opts.twoD ? 1 : 0)) % 8) bw.bits.push(0);
      bw.put(CODES.EOL);
      if (opts.twoD) bw.put(oneD ? "1" : "0");
    }
    if (oneD) encodeLine1D(bw, rows[y], w); else encodeLine2D(bw, rows[y], ref, w);
    ref = rows[y];
  }
  if (opts.rtc) for (var k = 0; k < 6; k++) { bw.put(CODES.EOL); if (opts.twoD) bw.put("1"); }
  return bw.bytes();
}
function randomImage(w, h, seed) {
  var R = rng(seed), d = new Uint8Array(w * h), i, x, y;
  var style = Math.floor(R() * 5);
  if (style === 0) { for (i = 0; i < d.length; i++) d[i] = R() < 0.5 ? 1 : 0; }               // 雜訊
  else if (style === 1) { for (i = 0; i < d.length; i++) d[i] = R() < 0.03 ? 1 : 0; }          // 稀疏點
  else {
    var n = 1 + Math.floor(R() * 12);
    for (var k = 0; k < n; k++) {                                                                 // 矩形 / 線條
      var x0 = Math.floor(R() * w), y0 = Math.floor(R() * h), x1 = Math.min(w, x0 + 1 + Math.floor(R() * w)), y1 = Math.min(h, y0 + 1 + Math.floor(R() * h));
      var v = R() < 0.8 ? 1 : 0;
      for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) d[y * w + x] = v;
    }
    if (style === 3) for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (((x + y) & 1) && R() < 0.3) d[y * w + x] ^= 1;   // 局部棋盤
    if (style === 4) for (y = 0; y < h; y++) { var sh = Math.floor(R() * 7) - 3; for (x = 0; x < w; x++) if (x + sh >= 0 && x + sh < w && (x % 11) < 4) d[y * w + x] = 1; }
  }
  return { width: w, height: h, data: d };
}
function tiffStrip(buf, page) {
  var info = C.tiffInfo(new Uint8Array(buf))[page || 0];
  return { info: info, data: new Uint8Array(buf).subarray(info.blocks[0].offset, info.blocks[0].offset + info.blocks[0].length) };
}

/* ---------------- 合成 TIFF 寫入器（測試 decodeTiff 邊界情形） ---------------- */
function buildTiff(le, pages, extra) {
  extra = extra || {};
  var parts = [], off = 8, ifdOffsets = [], layout = [];
  pages.forEach(function (pg) {
    var strips = pg.strips.map(function (s) { var o = off; parts.push(s); off += s.length; if (off & 1) { parts.push(new Uint8Array(1)); off++; } return o; });
    layout.push({ pg: pg, strips: strips });
  });
  // 各 IFD 與其外部值
  layout.forEach(function (L, pi) {
    var tags = Object.assign({}, L.pg.tags);
    tags[273] = { type: 4, v: L.strips };
    tags[279] = { type: 4, v: L.pg.strips.map(function (s) { return s.length; }) };
    if (L.pg.omitCounts) delete tags[279];
    var keys = Object.keys(tags).map(Number).sort(function (a, b) { return a - b; });
    var ifdSize = 2 + keys.length * 12 + 4, ext = [], extOff = off + ifdSize;
    var ifd = new Uint8Array(ifdSize), dv = new DataView(ifd.buffer);
    dv.setUint16(0, keys.length, le);
    keys.forEach(function (k, i) {
      var t = tags[k], vals = Array.isArray(t.v) ? t.v : [t.v], type = t.type || 3, size = { 3: 2, 4: 4, 5: 8 }[type];
      var p = 2 + i * 12;
      dv.setUint16(p, k, le); dv.setUint16(p + 2, type, le); dv.setUint32(p + 4, vals.length, le);
      var bytes = new Uint8Array(size * vals.length), dv2 = new DataView(bytes.buffer);
      vals.forEach(function (v, j) {
        if (type === 3) dv2.setUint16(j * 2, v, le);
        else if (type === 4) dv2.setUint32(j * 4, v, le);
        else { dv2.setUint32(j * 8, Math.round(v * 1000), le); dv2.setUint32(j * 8 + 4, 1000, le); }
      });
      if (bytes.length <= 4) ifd.set(bytes, p + 8);
      else { dv.setUint32(p + 8, extOff, le); ext.push(bytes); extOff += bytes.length; }
    });
    ifdOffsets.push(off);
    parts.push(ifd); off += ifdSize;
    ext.forEach(function (e) { parts.push(e); off += e.length; });
    L.ifd = ifd; L.ifdSize = ifdSize; L.keysLen = keys.length;
  });
  // 串接 next IFD 指標
  layout.forEach(function (L, i) {
    var dv = new DataView(L.ifd.buffer);
    var next = i + 1 < layout.length ? ifdOffsets[i + 1] : 0;
    if (extra.loop && i === layout.length - 1) next = ifdOffsets[0];
    dv.setUint32(2 + L.keysLen * 12, next, le);
  });
  var head = new Uint8Array(8), hv = new DataView(head.buffer);
  head[0] = head[1] = le ? 0x49 : 0x4D;
  hv.setUint16(2, extra.magic || 42, le);
  hv.setUint32(4, ifdOffsets[0], le);
  var total = 8 + parts.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(total), q = 8;
  out.set(head, 0);
  parts.forEach(function (p) { out.set(p, q); q += p.length; });
  return out;
}
function packRows(img, invert, reverse) {
  var rb = (img.width + 7) >> 3, out = new Uint8Array(rb * img.height);
  for (var y = 0; y < img.height; y++) for (var x = 0; x < img.width; x++) {
    var v = img.data[y * img.width + x] ^ (invert ? 1 : 0);
    if (v) out[y * rb + (x >> 3)] |= reverse ? (1 << (x & 7)) : (0x80 >> (x & 7));
  }
  if (invert) for (var y2 = 0; y2 < img.height; y2++) { var pad = rb * 8 - img.width; if (pad) out[y2 * rb + rb - 1] |= reverse ? (0xFF << (8 - pad)) & 0xFF : (1 << pad) - 1; }
  return out;
}
function packBitsEncode(src) {
  var out = [], i = 0;
  while (i < src.length) {
    var j = i;
    while (j + 1 < src.length && src[j + 1] === src[i] && j - i < 127) j++;
    if (j > i) { out.push(257 - (j - i + 1), src[i]); i = j + 1; continue; }
    var s = i;
    while (i < src.length && i - s < 128 && !(i + 1 < src.length && src[i + 1] === src[i])) i++;
    if (i === s) i++;
    out.push(i - s - 1);
    for (var k = s; k < i; k++) out.push(src[k]);
  }
  out.push(128);   // no-op 結尾（應被忽略）
  return new Uint8Array(out);
}
function baseTags(img, comp, extraTags) {
  var t = { 256: { type: 4, v: img.width }, 257: { type: 4, v: img.height }, 258: { v: 1 }, 259: { v: comp }, 262: { v: 0 },
    277: { v: 1 }, 278: { type: 4, v: img.height }, 282: { type: 5, v: 300 }, 283: { type: 5, v: 300 }, 296: { v: 2 } };
  return Object.assign(t, extraTags || {});
}

/* ================= 測試 ================= */

test("碼表：數量、前綴唯一、Kraft 和", function () {
  eq(CODES.WHITE_TERM.length, 64); eq(CODES.BLACK_TERM.length, 64);
  eq(CODES.WHITE_MAKEUP.length, 27); eq(CODES.BLACK_MAKEUP.length, 27); eq(CODES.EXT_MAKEUP.length, 13);
  function check(list) {
    var kraft = 0;
    list.forEach(function (c, i) {
      ok(/^[01]+$/.test(c) && c.length <= 13, "bad code " + c);
      kraft += Math.pow(2, -c.length);
      list.forEach(function (d, j) { if (i !== j) ok(d.indexOf(c) !== 0, "prefix conflict " + c + " / " + d); });
    });
    ok(kraft <= 1 + 1e-12, "kraft " + kraft);
    return kraft;
  }
  var kw = check(CODES.WHITE_TERM.concat(CODES.WHITE_MAKEUP, CODES.EXT_MAKEUP, [CODES.EOL]));
  var kb = check(CODES.BLACK_TERM.concat(CODES.BLACK_MAKEUP, CODES.EXT_MAKEUP, [CODES.EOL]));
  ok(kw > 0.99 && kb > 0.99, "code space nearly complete");
  check(CODES.MODES.map(function (m) { return m[0]; }).concat(["0000000"]));
});

test("G4 來回測試：隨機影像（含寬度 1–3000、>2560 行程）", function () {
  var widths = [1, 2, 3, 5, 7, 8, 9, 15, 16, 17, 31, 63, 64, 65, 100, 255, 256, 1000, 1728, 2600, 3000];
  var count = 0;
  widths.forEach(function (w, wi) {
    for (var s = 0; s < (w > 1000 ? 4 : 25); s++) {
      var img = randomImage(w, 1 + ((s * 7 + wi) % 30), 1000 * wi + s + 1);
      var enc = encodeG4(img), o = { warnings: [] };
      var dec = C.decodeG4(enc, w, img.height, o);
      eq(diffCount(dec, img.data), 0, "G4 w=" + w + " seed=" + s);
      eq(o.warnings.length, 0, "no warnings: " + o.warnings.join());
      eq(o.rowsDecoded, img.height);
      count++;
    }
  });
  ok(count > 300);
});

test("G4：特定邊界（起點 VL、起點 pass、全黑、全白、單像素）", function () {
  function img(rows) { var w = rows[0].length, d = new Uint8Array(w * rows.length); rows.forEach(function (r, y) { for (var x = 0; x < w; x++) d[y * w + x] = r[x] === "#" ? 1 : 0; }); return { width: w, height: rows.length, data: d }; }
  var cases = [
    ["..####....", "##........", "..........", "#########.", "##########", ".........#", "#........#"],
    ["#", ".", "#", "#"],
    ["....##..##..##....", "..................", "#.#.#.#.#.#.#.#.#.", ".#.#.#.#.#.#.#.#.#", "##################"],
    ["...#######....", "######........", "...........###", "#.............", "..#...........", "#############."]
  ];
  cases.forEach(function (c, i) {
    var im = img(c), o = { warnings: [] };
    eq(diffCount(C.decodeG4(encodeG4(im), im.width, im.height, o), im.data), 0, "case " + i);
    eq(o.warnings.length, 0);
  });
});

test("G3 來回測試：1D、2D（K=2/4）、位元組對齊 EOL、RTC、無 EOL、RLE、自動判斷", function () {
  var variants = [
    { twoD: false }, { twoD: false, fill: true, rtc: true }, { twoD: true, k: 2 }, { twoD: true, k: 4, fill: true, rtc: true },
    { twoD: false, noEol: true }, { rle: true }
  ];
  for (var s = 0; s < 60; s++) {
    var w = [1, 7, 8, 9, 64, 100, 333, 1728, 2700][s % 9], img = randomImage(w, 1 + (s % 17), 777 + s);
    variants.forEach(function (v, vi) {
      var enc = encodeG3(img, v), o = { warnings: [], twoD: v.twoD, rle: v.rle };
      var dec = C.decodeG3(enc, w, img.height, o);
      eq(diffCount(dec, img.data), 0, "G3 variant " + vi + " w=" + w + " s=" + s + " " + o.warnings.join());
      eq(o.warnings.length, 0, "variant " + vi + ": " + o.warnings.join());
    });
    // 未指定 twoD：自動判斷
    var enc2 = encodeG3(img, { twoD: true, k: 3 }), o2 = { warnings: [] };
    eq(diffCount(C.decodeG3(enc2, w, img.height, o2), img.data), 0, "auto 2D");
    var enc1 = encodeG3(img, { twoD: false }), o1 = { warnings: [] };
    eq(diffCount(C.decodeG3(enc1, w, img.height, o1), img.data), 0, "auto 1D");
  }
});

test("G3：中間一列損毀 → 同步到下一個 EOL，之後的列正確", function () {
  var img = randomImage(200, 30, 4242);
  // 只保留稀疏內容以確保每列都有編碼
  var enc = encodeG3(img, { twoD: false });
  // 找第 10 列的 EOL 位置後面，塞入垃圾（把 EOL 後的 2 個位元組改成 0xFF 0xFF）
  var bits = [];
  for (var i = 0; i < enc.length * 8; i++) bits.push((enc[i >> 3] >> (7 - (i & 7))) & 1);
  var eols = [];
  for (var j = 0; j + 12 <= bits.length; j++) {
    var z = 0; for (var k = 0; k < 11; k++) z |= bits[j + k];
    if (!z && bits[j + 11] === 1) { eols.push(j); j += 11; }
  }
  eq(eols.length, 30);
  // 第 10 列（0 起算）EOL 之後改成 8 個 0 + 8 個 1：白色碼表中會變成超過列寬的延伸結合碼 → 無效
  var p = eols[10] + 12;
  for (var q = 0; q < 16; q++) bits[p + q] = q < 8 ? 0 : 1;
  var bad = new Uint8Array(enc.length);
  for (var b = 0; b < bits.length; b++) if (bits[b]) bad[b >> 3] |= 0x80 >> (b & 7);
  var o = { warnings: [], twoD: false };
  var dec = C.decodeG3(bad, 200, 30, o);
  ok(o.warnings.length === 1 && /列資料錯誤/.test(o.warnings[0]), o.warnings.join());
  ok(sameRows(dec, img.data, 200, 10), "rows before corruption");
  eq(o.rowsDecoded, 30);
  eq(diffCount(dec.subarray(200 * 11), img.data.subarray(200 * 11)), 0, "rows after resync");
});

test("G4 損毀資料：截斷、垃圾、非壓縮模式、提早 EOFB、尾端垃圾 — 不拋例外", function () {
  var page = readPbm(fs.readFileSync(path.join(FX, "ccitt_page.pbm")));
  var st = tiffStrip(fs.readFileSync(path.join(FX, "ccitt_page_g4.tif")));
  var full = st.data, W = page.width, H = page.height;
  // 截斷：已回報的列必須完全正確
  [0, 1, 2, 3, 10, 100, 1000, full.length >> 1, full.length - 3, full.length - 2].forEach(function (L) {
    var o = { warnings: [] };
    var dec = C.decodeG4(full.subarray(0, L), W, H, o);
    eq(dec.length, W * H);
    ok(o.rowsDecoded <= H);
    ok(sameRows(dec, page.data, W, o.rowsDecoded), "prefix rows exact at L=" + L);
    if (o.rowsDecoded < H) ok(o.warnings.length === 1 && /截斷|結束|無效/.test(o.warnings[0]), "warning at L=" + L + ": " + o.warnings);
  });
  // 只少了 EOFB：仍完整、無警告
  var o0 = { warnings: [] };
  var noEofb = encodeG4(page, { noEofb: true });
  eq(diffCount(C.decodeG4(noEofb, W, H, o0), page.data), 0); eq(o0.warnings.length, 0);
  // 尾端垃圾
  var junk = new Uint8Array(full.length + 50); junk.set(full); for (var i = full.length; i < junk.length; i++) junk[i] = (i * 37) & 255;
  var o1 = { warnings: [] };
  eq(diffCount(C.decodeG4(junk, W, H, o1), page.data), 0); eq(o1.warnings.length, 0);
  // 提早 EOFB
  var early = encodeG4(page, { rows: 50 }), o2 = { warnings: [] };
  var d2 = C.decodeG4(early, W, H, o2);
  eq(o2.rowsDecoded, 50); ok(sameRows(d2, page.data, W, 50)); ok(/第 50 列就結束/.test(o2.warnings[0]), o2.warnings[0]);
  for (var p = 50 * W; p < W * H; p++) if (d2[p]) { ok(false, "rows after EOFB must be white"); break; }
  // 非壓縮模式延伸碼（0000001111）插在第 5 列開頭
  var bw = new BitWriter(), rows = rowsOf(page), ref = new Uint8Array(W);
  for (var y = 0; y < 5; y++) { encodeLine2D(bw, rows[y], ref, W); ref = rows[y]; }
  bw.put("0000001111"); bw.put("111111111111");
  var o3 = { warnings: [] };
  var d3 = C.decodeG4(bw.bytes(), W, H, o3);
  eq(o3.rowsDecoded, 5); ok(/非壓縮模式/.test(o3.warnings[0]), o3.warnings[0]); ok(sameRows(d3, page.data, W, 5));
  // 隨機垃圾與各種尺寸：不拋例外
  var R = rng(99);
  for (var t = 0; t < 300; t++) {
    var n = Math.floor(R() * 400), g = new Uint8Array(n);
    for (var k = 0; k < n; k++) g[k] = Math.floor(R() * 256);
    var w = 1 + Math.floor(R() * 300), h = 1 + Math.floor(R() * 40), og = { warnings: [] };
    var r = C.decodeG4(g, w, h, og);
    eq(r.length, w * h);
    var r3 = C.decodeG3(g, w, h, { warnings: [] });
    eq(r3.length, w * h);
  }
  // 位元翻轉的真實結構資料
  for (var f = 0; f < 200; f++) {
    var m = new Uint8Array(full); m[Math.floor(R() * m.length)] ^= 1 << Math.floor(R() * 8);
    C.decodeG4(m, W, H, { warnings: [] });
  }
  // 不合理尺寸
  var ow = { warnings: [] };
  eq(C.decodeG4(full, 0, 10, ow).length, 0); ok(/尺寸/.test(ow.warnings[0]));
  eq(C.decodeG4(full, -5, 10, {}).length, 0);
  eq(C.decodeG4(null, 4, 4, {}).length, 16);
  eq(C.decodeG4(undefined, 4, 4).length, 16);
});

test("G4：byteAlign 與 out/outOffset", function () {
  var img = randomImage(77, 20, 5);
  var enc = encodeG4(img, { byteAlign: true });
  eq(diffCount(C.decodeG4(enc, 77, 20, { byteAlign: true }), img.data), 0);
  var big = new Uint8Array(77 * 25);
  var o = { out: big, outOffset: 77 * 3, warnings: [] };
  var r = C.decodeG4(encodeG4(img), 77, 20, o);
  ok(r === big);
  eq(diffCount(big.subarray(77 * 3, 77 * 23), img.data), 0);
  for (var i = 0; i < 77 * 3; i++) if (big[i]) { ok(false, "outside region untouched"); break; }
  assert.throws(function () { C.decodeG4(enc, 77, 20, { out: new Uint8Array(10) }); });
});

test("libtiff 合成 TIFF：所有壓縮變體逐像素一致", function () {
  var exp = { page: readPbm(fs.readFileSync(path.join(FX, "ccitt_page.pbm"))), runs: readPbm(fs.readFileSync(path.join(FX, "ccitt_runs.pbm"))) };
  var files = fs.readdirSync(FX).filter(function (n) { return /^ccitt_.*\.tif$/.test(n); }).sort();
  ok(files.length >= 11, "fixtures present");
  var expectComp = { g4: 4, g3: 3, rle: 2, packbits: 32773, lzw: 5 };
  files.forEach(function (f) {
    var w = [];
    var pages = C.decodeTiff(fs.readFileSync(path.join(FX, f)), { warnings: w });
    eq(w.length, 0, f + ": " + w.join());
    eq(pages.length, f === "ccitt_multi.tif" ? 2 : 1, f);
    pages.forEach(function (p, k) {
      var e = (/runs/.test(f) || (f === "ccitt_multi.tif" && k === 1)) ? exp.runs : exp.page;
      eq(p.width, e.width); eq(p.height, e.height);
      eq(diffCount(p.data, e.data), 0, f + " page " + k);
      eq(p.page, k);
    });
    var key = Object.keys(expectComp).filter(function (k) { return f.indexOf("_" + k) >= 0; })[0];
    if (key && f !== "ccitt_multi.tif") eq(pages[0].compression, expectComp[key], f);
  });
  var multi = C.decodeTiff(fs.readFileSync(path.join(FX, "ccitt_multi.tif")));
  eq(multi[0].dpiX, 300); eq(multi[1].dpiX, 200); eq(multi[0].compression, 4); eq(multi[1].compression, 3);
  var info = C.tiffInfo(fs.readFileSync(path.join(FX, "ccitt_page_g4_strips_pi1_lsb.tif")))[0];
  eq(info.photometric, 1); eq(info.fillOrder, 2); eq(info.rowsPerStrip, 37); eq(info.blocks.length, Math.ceil(400 / 37));
  var ti = C.tiffInfo(fs.readFileSync(path.join(FX, "ccitt_page_lzw_tiled.tif")))[0];
  ok(ti.tiled && ti.tileWidth === 128 && ti.tileHeight === 112);
});

test("libtiff 合成 G4 / G3 strip 直接解碼（decodeG4 / decodeG3）", function () {
  var runs = readPbm(fs.readFileSync(path.join(FX, "ccitt_runs.pbm")));
  var s4 = tiffStrip(fs.readFileSync(path.join(FX, "ccitt_runs_g4.tif")));
  eq(diffCount(C.decodeG4(s4.data, runs.width, runs.height), runs.data), 0);
  var s3 = tiffStrip(fs.readFileSync(path.join(FX, "ccitt_runs_g3_1d.tif")));
  eq(diffCount(C.decodeG3(s3.data, runs.width, runs.height, { twoD: false }), runs.data), 0);
  var s32 = tiffStrip(fs.readFileSync(path.join(FX, "ccitt_runs_g3_2d.tif")));
  eq(diffCount(C.decodeG3(s32.data, runs.width, runs.height, { twoD: true }), runs.data), 0);
  eq(diffCount(C.decodeG3(s32.data, runs.width, runs.height), runs.data), 0, "auto-detect 2D");
  // 我們的編碼器 vs libtiff 的解碼結果：同一張影像來回
  eq(diffCount(C.decodeG4(encodeG4(runs), runs.width, runs.height), runs.data), 0);
});

test("decodeTiff：大端序、PackBits+FillOrder 2、Photometric 1、多頁、縮圖、IFD 迴圈、截斷、不支援格式", function () {
  var img = randomImage(37, 23, 31), img2 = randomImage(64, 10, 32);
  // MM 大端序未壓縮，兩個 strip（RowsPerStrip 12）
  var raw = packRows(img), rb = 5;
  var t1 = buildTiff(false, [{ tags: baseTags(img, 1, { 278: { type: 4, v: 12 } }), strips: [raw.subarray(0, rb * 12), raw.subarray(rb * 12)] }]);
  var p1 = C.decodeTiff(t1);
  eq(p1.length, 1); eq(diffCount(p1[0].data, img.data), 0); eq(p1[0].dpiX, 300);
  // II PackBits + FillOrder 2 + Photometric 1（依 libtiff 慣例：FillOrder 作用在壓縮後的原始位元組）
  var raw2 = packRows(img, true, false);
  var t2 = buildTiff(true, [{ tags: baseTags(img, 32773, { 262: { v: 1 }, 266: { v: 2 } }), strips: [C.reverseBits(packBitsEncode(raw2))] }]);
  var p2 = C.decodeTiff(t2);
  eq(diffCount(p2[0].data, img.data), 0, "packbits lsb pi1");
  // 未壓縮 + FillOrder 2：每個位元組內左右反轉
  var t2b = buildTiff(true, [{ tags: baseTags(img, 1, { 266: { v: 2 } }), strips: [packRows(img, false, true)] }]);
  eq(diffCount(C.decodeTiff(t2b)[0].data, img.data), 0, "raw lsb");
  // 多頁：G4 頁 + 8 位元灰階頁（略過＋警告）+ 縮圖頁（略過）+ G3 頁
  var gray = baseTags(img2, 1, { 258: { v: 8 } });
  var thumb = baseTags(img2, 4, { 254: { type: 4, v: 1 } });
  var t3 = buildTiff(true, [
    { tags: baseTags(img, 4), strips: [encodeG4(img)] },
    { tags: gray, strips: [new Uint8Array(64 * 10)] },
    { tags: thumb, strips: [encodeG4(img2)] },
    { tags: baseTags(img2, 3, { 292: { type: 4, v: 1 } }), strips: [encodeG3(img2, { twoD: true, k: 2 })] }
  ]);
  var w3 = [], p3 = C.decodeTiff(t3, { warnings: w3 });
  eq(p3.length, 2); eq(p3[0].page, 0); eq(p3[1].page, 3);
  // 延遲解碼清單：縮圖頁不列出；不支援的頁 supported=false；maxPages
  var lazy = C.tiffPages(t3);
  eq(lazy.length, 3); eq(lazy[1].supported, false); eq(lazy[1].bitsPerSample, 8); eq(lazy[2].page, 3);
  ok(!("data" in lazy[0]));
  eq(diffCount(lazy[2].decode().data, img2.data), 0);
  var lw = []; eq(lazy[1].decode({ warnings: lw }), null); ok(/非黑白二值/.test(lw[0]));
  eq(C.decodeTiff(t3, { maxPages: 1 }).length, 1);
  eq(diffCount(p3[0].data, img.data), 0); eq(diffCount(p3[1].data, img2.data), 0);
  ok(w3.length === 1 && /非黑白二值/.test(w3[0]), w3.join());
  // IFD 迴圈（最後一頁指回第一頁）不可無窮迴圈
  var t4 = buildTiff(true, [{ tags: baseTags(img, 1), strips: [raw] }, { tags: baseTags(img, 1), strips: [raw] }], { loop: true });
  eq(C.decodeTiff(t4).length, 2);
  // 缺 StripByteCounts（單一 strip）→ 讀到檔尾
  var t5 = buildTiff(false, [{ tags: baseTags(img, 4), strips: [encodeG4(img)], omitCounts: true }]);
  eq(diffCount(C.decodeTiff(t5)[0].data, img.data), 0);
  // 截斷的 TIFF：strip 不完整 → 有警告、不拋例外
  var t6 = buildTiff(true, [{ tags: baseTags(img, 4), strips: [encodeG4(img)] }]);
  var info6 = C.tiffInfo(t6)[0];
  var cut = new Uint8Array(t6.length); cut.set(t6);
  for (var z = info6.blocks[0].offset + 10; z < info6.blocks[0].offset + info6.blocks[0].length; z++) cut[z] = 0;
  var w6 = [], p6 = C.decodeTiff(cut, { warnings: w6 });
  eq(p6.length, 1); ok(w6.length >= 1, "warn on corrupt strip");
  // 不支援：JPEG 壓縮、BigTIFF、非 TIFF、空輸入
  var w7 = [];
  eq(C.decodeTiff(buildTiff(true, [{ tags: baseTags(img, 7), strips: [raw] }]), { warnings: w7 }).length, 0);
  ok(/不支援的壓縮/.test(w7[0]));
  var w8 = [];
  eq(C.decodeTiff(buildTiff(true, [{ tags: baseTags(img, 1), strips: [raw] }], { magic: 43 }), { warnings: w8 }).length, 0);
  ok(/BigTIFF/.test(w8[0]));
  eq(C.decodeTiff(new Uint8Array([1, 2, 3])).length, 0);
  eq(C.decodeTiff(new Uint8Array(0)).length, 0);
  eq(C.decodeTiff(null).length, 0);
  eq(C.decodeTiff(new TextEncoder().encode("%PDF-1.7 not a tiff at all")).length, 0);
  // 隨機垃圾 / 截斷 / 位元翻轉：永不拋例外
  var R = rng(7), files = fs.readdirSync(FX).filter(function (n) { return /^ccitt_.*\.tif$/.test(n); });
  for (var t = 0; t < 400; t++) {
    var src = new Uint8Array(fs.readFileSync(path.join(FX, files[t % files.length])));
    var m = src.subarray(0, Math.floor(R() * src.length));
    if (t % 2) { m = new Uint8Array(src); for (var q = 0; q < 4; q++) m[Math.floor(R() * Math.min(200, m.length))] = Math.floor(R() * 256); }
    var res = C.decodeTiff(m, { warnings: [] });
    ok(Array.isArray(res));
  }
});

test("LZW / PackBits 小工具", function () {
  var u = C._unpackBits(new Uint8Array([2, 1, 2, 3, 0xFE, 9, 128, 0, 7]), 7);
  eq(Array.from(u.data).join(), "1,2,3,9,9,9,7"); eq(u.short, false);
  eq(C._unpackBits(new Uint8Array([5, 1]), 6).short, true);
  // LZW：Clear, 'A', 'B', 258('AB'), EOI（9 位元碼）
  var codes = [256, 65, 66, 258, 257], bits = "";
  codes.forEach(function (c) { bits += ("000000000" + c.toString(2)).slice(-9); });
  while (bits.length % 8) bits += "0";
  var src = new Uint8Array(bits.length / 8);
  for (var i = 0; i < bits.length; i++) if (bits[i] === "1") src[i >> 3] |= 0x80 >> (i & 7);
  var l = C._lzwDecode(src, 4);
  eq(String.fromCharCode.apply(null, l.data), "ABAB");
  ok(C._lzwDecode(new Uint8Array([0xFF, 0xFF, 0xFF]), 10).short);
});

test("效能：1654×2340 頁面級影像 G4 解碼 < 60 ms", function () {
  // 合成：把 643×400 測試頁重複鋪成 A4 200dpi 大小
  var page = readPbm(fs.readFileSync(path.join(FX, "ccitt_page.pbm")));
  var W = 1654, H = 2340, d = new Uint8Array(W * H);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) d[y * W + x] = page.data[(y % page.height) * page.width + (x % page.width)];
  var img = { width: W, height: H, data: d };
  var enc = encodeG4(img);
  var best = 1e9;
  for (var k = 0; k < 4; k++) {
    var t0 = process.hrtime.bigint();
    var dec = C.decodeG4(enc, W, H);
    var ms = Number(process.hrtime.bigint() - t0) / 1e6;
    best = Math.min(best, ms);
    if (k === 0) eq(diffCount(dec, d), 0);
  }
  ok(best < 60, "decode took " + best.toFixed(1) + " ms");
  NOTES.push("G4 1654×2340 " + best.toFixed(1) + " ms");
});

/* ---------------- 執行 ---------------- */
var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); }
  catch (e) { failed++; console.error("FAIL: " + t.name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); }
});
if (failed) { console.error("ccitt.test.js: " + failed + "/" + tests.length + " 個測試失敗"); process.exit(1); }
console.log("ccitt.test.js: PASS（" + tests.length + " 個測試，" + nAssert + " 個斷言" + (NOTES.length ? "；" + NOTES.join("；") : "") + "）");
