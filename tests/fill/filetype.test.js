/* =========================================================================
 * tests/fill/filetype.test.js — YF.filetype 單元測試
 * 執行：node tests/fill/filetype.test.js（於 repo 根目錄）
 * 全部使用合成資料（測試內即時產生 ZIP / CFB / XDW / 影像 / 文字檔）；
 * 若 test_data/fill/ 存在真實樣本，另外驗證（不存在則略過）。
 * ========================================================================= */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");

var ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "js/fill/filetype.js"));
var YF = globalThis.YangFill;
var FT = YF.filetype;
var XLSX = require(path.join(ROOT, "lib/xlsx.full.min.js"));

var passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) {
    failed++;
    console.error("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e));
  }
}
function det(bytes, name) { return FT.detect(bytes, name); }
function expectKind(bytes, name, kind, extra) {
  var r = det(bytes, name);
  assert.strictEqual(r.kind, kind, (name || "(無檔名)") + " → " + r.kind + "（預期 " + kind + "）｜" + r.label + "｜" + r.detail);
  if (extra) Object.keys(extra).forEach(function (k) {
    assert.deepStrictEqual(r[k], extra[k], (name || "") + " ." + k + " = " + JSON.stringify(r[k]) + "（預期 " + JSON.stringify(extra[k]) + "）");
  });
  return r;
}

/* ---------------- 合成資料產生器 ---------------- */
var CRC = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(b) { var c = -1; for (var i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xFF]; return (c ^ -1) >>> 0; }
function B(x) { return Buffer.isBuffer(x) ? x : typeof x === "string" ? Buffer.from(x, "utf8") : Buffer.from(x); }

/** ZIP：entries [{name, data, method 0|8, nameBuf?}]；opts {comment, noCentral, prefix, utf8:false, descriptor} */
function makeZip(entries, opts) {
  opts = opts || {};
  var parts = [], central = [], off = opts.prefix ? opts.prefix.length : 0;
  if (opts.prefix) parts.push(opts.prefix);
  entries.forEach(function (e) {
    var raw = B(e.data || ""), method = e.method === undefined ? 8 : e.method;
    var comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    var nb = e.nameBuf || Buffer.from(e.name, "utf8"), crc = crc32(raw);
    var flags = (opts.utf8 === false ? 0 : 0x800) | (opts.descriptor ? 8 : 0);
    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(opts.descriptor ? 0 : crc, 14);
    lh.writeUInt32LE(opts.descriptor ? 0 : comp.length, 18); lh.writeUInt32LE(opts.descriptor ? 0 : raw.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, comp);
    var dlen = 0;
    if (opts.descriptor) {
      var dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(raw.length, 12);
      parts.push(dd); dlen = 16;
    }
    var ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + comp.length + dlen;
  });
  if (opts.noCentral) return Buffer.concat(parts);
  var cd = Buffer.concat(central), com = B(opts.comment || "");
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(opts.prefix && opts.badOffsets ? off - opts.prefix.length : off, 16);
  eocd.writeUInt16LE(com.length, 20);
  return Buffer.concat(parts.concat([cd, eocd, com]));
}
var CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
function ooxml(main, extra) {
  var list = [{ name: "[Content_Types].xml", data: CT }, { name: "_rels/.rels", data: "<Relationships/>" }];
  main.forEach(function (n) { list.push({ name: n, data: "<x/>" }); });
  (extra || []).forEach(function (e) { list.push(e); });
  return makeZip(list);
}

/** CFB（自製，v3=512 / v4=4096 磁區；全部串流放一般磁區，≥ 4096 位元組） */
function makeCfb(streams, opts) {
  opts = opts || {};
  var shift = opts.v4 ? 12 : 9, ssz = 1 << shift, per = ssz / 4;
  var ENDC = 0xFFFFFFFE, FREE = 0xFFFFFFFF, FATS = 0xFFFFFFFD, DIFS = 0xFFFFFFFC;
  function nsec(n) { return Math.max(1, Math.ceil(n / ssz)); }
  var dirEntries = 1 + streams.length, dirSecs = Math.ceil(dirEntries * 128 / ssz);
  var dataSecs = streams.reduce(function (s, st) { return s + nsec(st.data.length); }, 0);
  var filler = opts.filler || 0;
  var N = dirSecs + dataSecs + filler, nFat = 1, nDif = 0;
  for (var it = 0; it < 50; it++) {
    var T = N + nFat + nDif, f2 = Math.ceil(T / per), d2 = Math.max(0, Math.ceil((f2 - 109) / (per - 1)));
    if (f2 === nFat && d2 === nDif) break;
    nFat = f2; nDif = d2;
  }
  var total = N + nFat + nDif, fat = new Array(nFat * per).fill(FREE);
  var cur = 0, fatSecs = [], difSecs = [];
  for (var i = 0; i < nFat; i++) { fatSecs.push(cur); fat[cur++] = FATS; }
  for (i = 0; i < nDif; i++) { difSecs.push(cur); fat[cur++] = DIFS; }
  function alloc(n) { var s = cur; for (var k = 0; k < n; k++) fat[cur + k] = k === n - 1 ? ENDC : cur + k + 1; cur += n; return s; }
  var dirStart, starts = [];
  if (!opts.dirLast) { cur += filler; dirStart = alloc(dirSecs); }
  else { cur += filler; }
  streams.forEach(function (st) { starts.push(alloc(nsec(st.data.length))); });
  if (opts.dirLast) dirStart = alloc(dirSecs);
  if (opts.cycle) fat[dirStart] = dirStart;      // 目錄鏈指回自己
  var buf = Buffer.alloc((total + 1) * ssz);
  buf.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
  buf.writeUInt16LE(0x3E, 0x18); buf.writeUInt16LE(opts.v4 ? 4 : 3, 0x1A); buf.writeUInt16LE(0xFFFE, 0x1C);
  buf.writeUInt16LE(shift, 0x1E); buf.writeUInt16LE(6, 0x20);
  buf.writeUInt32LE(opts.v4 ? dirSecs : 0, 0x28); buf.writeUInt32LE(nFat, 0x2C); buf.writeUInt32LE(dirStart, 0x30);
  buf.writeUInt32LE(4096, 0x38); buf.writeUInt32LE(ENDC, 0x3C); buf.writeUInt32LE(0, 0x40);
  buf.writeUInt32LE(nDif ? difSecs[0] : ENDC, 0x44); buf.writeUInt32LE(nDif, 0x48);
  for (i = 0; i < 109; i++) buf.writeUInt32LE(i < nFat ? fatSecs[i] : FREE, 0x4C + i * 4);
  function so(n) { return (n + 1) * ssz; }
  var rest = fatSecs.slice(109);
  difSecs.forEach(function (ds, k) {
    var o = so(ds);
    for (var j = 0; j < per - 1; j++) buf.writeUInt32LE(j < rest.length - k * (per - 1) ? rest[k * (per - 1) + j] : FREE, o + j * 4);
    buf.writeUInt32LE(k + 1 < difSecs.length ? difSecs[k + 1] : ENDC, o + (per - 1) * 4);
  });
  fatSecs.forEach(function (fsn, k) {
    var o = so(fsn);
    for (var j = 0; j < per; j++) buf.writeUInt32LE(fat[k * per + j] >>> 0, o + j * 4);
  });
  function dirEnt(idx, name, type, start, size, right, child) {
    var o = so(dirStart) + idx * 128;  // 目錄磁區連續配置
    var nb = Buffer.from(name + "\0", "utf16le");
    nb.copy(buf, o, 0, Math.min(64, nb.length)); buf.writeUInt16LE(Math.min(64, nb.length), o + 0x40);
    buf[o + 0x42] = type; buf[o + 0x43] = 1;
    buf.writeUInt32LE(FREE, o + 0x44); buf.writeUInt32LE(right, o + 0x48); buf.writeUInt32LE(child, o + 0x4C);
    buf.writeUInt32LE(start >>> 0, o + 0x74); buf.writeUInt32LE(size, o + 0x78);
  }
  dirEnt(0, "Root Entry", 5, ENDC, 0, FREE, streams.length ? 1 : FREE);
  streams.forEach(function (st, k) {
    dirEnt(k + 1, st.name, 2, starts[k], st.data.length, k + 1 < streams.length ? k + 2 : FREE, FREE);
    st.data.copy ? st.data.copy(buf, so(starts[k])) : buf.set(st.data, so(starts[k]));
  });
  if (opts.truncate) return buf.subarray(0, opts.truncate);
  return buf;
}
function pad(buf, n) { var o = Buffer.alloc(Math.max(n, buf.length)); B(buf).copy(o); return o; }
function fib(flags) { var b = Buffer.alloc(4608); b.writeUInt16LE(0xA5EC, 0); b.writeUInt16LE(0x00C1, 2); b.writeUInt16LE(flags || 0, 10); return b; }
function biffWithFilepass(size) {
  var b = Buffer.alloc(size || 4608);
  b.writeUInt16LE(0x0809, 0); b.writeUInt16LE(16, 2); b.writeUInt16LE(0x0600, 4); b.writeUInt16LE(0x0005, 6);
  b.writeUInt16LE(0x00E1, 20); b.writeUInt16LE(2, 22);                     // INTERFACEHDR
  b.writeUInt16LE(0x002F, 26); b.writeUInt16LE(54, 28);                    // FILEPASS
  return b;
}
/** SheetJS CFB（小串流會進 mini stream） */
function sjsCfb(files) {
  var c = XLSX.CFB.utils.cfb_new();
  files.forEach(function (f) { XLSX.CFB.utils.cfb_add(c, "/" + f.name, f.data); });
  return Buffer.from(XLSX.CFB.write(c, { type: "array" }));
}
function sjsBook(bookType) {
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["測站", "SO2"], ["示範新城", 0.001]]), "S1");
  return Buffer.from(XLSX.write(wb, { bookType: bookType, type: "array" }));
}

/** BER-TLV（DocuWorks 結構） */
function tlv(tag, val) {
  val = B(val);
  var L = val.length, lenB;
  if (L < 0x80) lenB = [L];
  else { var bs = []; while (L > 0) { bs.unshift(L & 0xFF); L = Math.floor(L / 256); } lenB = [0x80 | bs.length].concat(bs); }
  return Buffer.concat([Buffer.from([tag].concat(lenB)), val]);
}
var XDW_HDR = Buffer.from("600e820107800300c01383040" + "10d0a01", "hex");
function makeXdw(nPages, opts) {
  opts = opts || {};
  var blocks = [XDW_HDR];
  for (var p = 0; p < nPages; p++) {
    var img = Buffer.alloc(opts.imgSize || 600, 0x29);
    var payload = Buffer.concat([tlv(0x80, [9]), tlv(0x87, [0x06, 0x76]), tlv(0x88, [0x09, 0x24]), tlv(0x86, img)]);
    var obj = tlv(0x64, Buffer.concat([tlv(0x81, [0, 0, 0, p + 1]), tlv(0x82, payload)]));
    blocks.push(tlv(0x61, Buffer.concat([obj, tlv(0x63, Buffer.alloc(20, 0x5A)), tlv(0x65, tlv(0x80, [1]))])));
  }
  return Buffer.concat(blocks);
}

/* 影像 */
function chunk(type, data) {
  var d = B(data), b = Buffer.alloc(12 + d.length);
  b.writeUInt32BE(d.length, 0); b.write(type, 4, "latin1"); d.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b;
}
function makePng(w, h, dpi) {
  var ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 0;
  var parts = [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ih)];
  if (dpi) { var ph = Buffer.alloc(9); var ppm = Math.round(dpi / 0.0254); ph.writeUInt32BE(ppm, 0); ph.writeUInt32BE(ppm, 4); ph[8] = 1; parts.push(chunk("pHYs", ph)); }
  parts.push(chunk("IDAT", zlib.deflateSync(Buffer.alloc(h * (w + 1)))), chunk("IEND", ""));
  return Buffer.concat(parts);
}
function makeJpeg(w, h, dpi) {
  var app0 = Buffer.from([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  var exif = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 10]), Buffer.from("Exif\0\0MM", "latin1")]);
  var sof = Buffer.from([0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, exif, sof, Buffer.from([0xFF, 0xDA, 0, 2, 1, 2, 3, 0xFF, 0xD9])]);
}
function makeBmp(w, h, dpi) {
  var b = Buffer.alloc(54 + 16); b.write("BM", 0, "latin1"); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(Math.round(dpi / 0.0254), 38); b.writeUInt32LE(Math.round(dpi / 0.0254), 42); return b;
}
function makeTiff(le, opts) {
  var w16 = le ? "writeUInt16LE" : "writeUInt16BE", w32 = le ? "writeUInt32LE" : "writeUInt32BE";
  var pages = opts.pages || 1, bufs = [], b = Buffer.alloc(8 + pages * 200);
  b.write(le ? "II" : "MM", 0, "latin1"); b[w16](42, 2); b[w32](8, 4);
  var ifd = 8;
  for (var p = 0; p < pages; p++) {
    var ent = [[256, 3, 1, opts.w], [257, 3, 1, opts.h], [259, 3, 1, opts.comp], [262, 3, 1, opts.spp === 3 ? 2 : 0],
      [277, 3, 1, opts.spp || 1], [282, 5, 1, ifd + 2 + 9 * 12 + 4 + 8], [296, 3, 1, 2]];
    if (opts.spp === 3) ent.push([258, 3, 3, ifd + 2 + 9 * 12 + 4]); else ent.push([258, 3, 1, 1]);
    ent.push([273, 4, 1, 0]);
    ent.sort(function (a, c) { return a[0] - c[0]; });
    b[w16](ent.length, ifd);
    ent.forEach(function (e, i) {
      var o = ifd + 2 + i * 12; b[w16](e[0], o); b[w16](e[1], o + 2); b[w32](e[2], o + 4);
      if (e[1] === 3 && e[2] === 1) b[w16](e[3], o + 8); else b[w32](e[3], o + 8);
    });
    var after = ifd + 2 + ent.length * 12;
    var next = p + 1 < pages ? after + 4 + 8 + 8 + 8 : 0;
    b[w32](next, after);
    b[w16](8, after + 4); b[w16](8, after + 6); b[w16](8, after + 8);    // BitsPerSample 陣列
    b[w32](opts.dpi, after + 12); b[w32](1, after + 16);                 // XResolution
    ifd = next;
  }
  return b;
}
function makeWebp(w, h) {
  var b = Buffer.alloc(30); b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBPVP8X", 8, "latin1");
  b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
}
function makeWebpLossless(w, h) {
  var b = Buffer.alloc(40); b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBPVP8L", 8, "latin1");
  b.writeUInt32LE(10, 16); b[20] = 0x2F; b.writeUInt32LE(((w - 1) & 0x3FFF) | (((h - 1) & 0x3FFF) << 14), 21); return b;
}
var rng = (function (seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(12345);
function randBytes(n, first) { var b = Buffer.alloc(n); for (var i = 0; i < n; i++) b[i] = (rng() * 256) | 0; if (first !== undefined) b[0] = first; return b; }

/* ======================================================================
 * 1. 格式表與 UI 輔助
 * ====================================================================== */
var SPEC_KINDS = ["xdw", "xbd", "pdf", "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "xlsb", "pptx", "xls", "doc", "ppt",
  "rtf", "odt", "ods", "csv", "txt", "html", "xmlss", "png", "jpg", "gif", "bmp", "tif", "webp", "zip", "unknown"];
var FAMILIES = ["docuworks", "pdf", "word", "excel", "image", "text", "other"];
test("KINDS 涵蓋規格中所有 kind，欄位完整且凍結", function () {
  SPEC_KINDS.forEach(function (k) { assert.ok(FT.KINDS[k], "缺 kind " + k); });
  Object.keys(FT.KINDS).forEach(function (k) {
    var d = FT.KINDS[k];
    assert.ok(FAMILIES.indexOf(d.family) >= 0, k + " family");
    assert.ok(d.label && typeof d.label === "string", k + " label");
    assert.ok(["raw", "template", "both"].indexOf(d.accept) >= 0, k + " accept");
    assert.strictEqual(typeof d.supported, "boolean", k + " supported");
    if (!d.supported) assert.ok(d.hint.length > 4, k + " 不支援者須有 hint");
    assert.strictEqual(d.supported, d.route !== null, k + " route");
    assert.ok(Object.isFrozen(d));
  });
  assert.ok(Object.isFrozen(FT.KINDS));
  assert.strictEqual(FT.KINDS.doc.hint, "請在 Word 另存為 .docx 後上傳");
  assert.ok(/密碼保護/.test(FT.KINDS.encrypted.hint) && /移除密碼/.test(FT.KINDS.encrypted.hint));
  assert.strictEqual(FT.KINDS.pptx.supported, false); assert.strictEqual(FT.KINDS.ppt.supported, false);
  assert.strictEqual(FT.KINDS.xdw.family, "docuworks"); assert.strictEqual(FT.KINDS.xdw.route, "xdw");
  assert.strictEqual(FT.KINDS.docx.accept, "both"); assert.strictEqual(FT.KINDS.pdf.accept, "raw");
});
test("acceptAttr", function () {
  var raw = FT.acceptAttr("raw").split(","), tpl = FT.acceptAttr("template").split(",");
  ".xdw,.xbd,.pdf,.docx,.doc,.xlsx,.xlsm,.xls,.csv,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.gif,.webp".split(",").forEach(function (e) {
    assert.ok(raw.indexOf(e) >= 0, "raw 缺 " + e);
  });
  ".docx,.xlsx,.xlsm,.xls".split(",").forEach(function (e) { assert.ok(tpl.indexOf(e) >= 0, "template 缺 " + e); });
  assert.ok(tpl.indexOf(".pdf") < 0 && tpl.indexOf(".xdw") < 0);
  var all = FT.acceptAttr().split(",");
  assert.ok(all.indexOf(".xdw") >= 0 && all.indexOf(".dotx") >= 0);
  assert.strictEqual(new Set(all).size, all.length, "聯集不重複");
});
test("extOf / kindOfExt", function () {
  assert.strictEqual(FT.extOf("A_DATA.XDW"), "xdw");
  assert.strictEqual(FT.extOf("C:\\fakepath\\報告.v2.Pdf"), "pdf");
  assert.strictEqual(FT.extOf("dir/sub/x.xlsx "), "xlsx");
  assert.strictEqual(FT.extOf("x.xdw."), "xdw");
  assert.strictEqual(FT.extOf("noext"), "");
  assert.strictEqual(FT.extOf(".xdw"), "xdw");
  assert.strictEqual(FT.extOf("a.b/c"), "");
  assert.strictEqual(FT.extOf("weird.x y"), "");
  assert.strictEqual(FT.extOf(null), ""); assert.strictEqual(FT.extOf(undefined), "");
  assert.strictEqual(FT.kindOfExt("a.jpeg"), "jpg"); assert.strictEqual(FT.kindOfExt("TIFF"), "tif");
  assert.strictEqual(FT.kindOfExt("x.unknownext"), null);
});

/* ======================================================================
 * 2. DocuWorks
 * ====================================================================== */
var savedXdw = YF.xdw; delete YF.xdw;          // 先測自有結構檢查
test("XDW：合成 BER 結構（未載入 xdw.js）", function () {
  var x = makeXdw(3);
  var r = expectKind(x, "a.xdw", "xdw", { family: "docuworks", mismatch: false, supported: true, route: "xdw", by: "content" });
  assert.strictEqual(r.meta.version, 7);
  assert.ok(/DocuWorks/.test(r.label));
  expectKind(x, "a.xbd", "xbd", { mismatch: false });
  expectKind(x, "", "xdw", { mismatch: false });
  expectKind(x, "a.pdf", "xdw", { mismatch: true });
  r = expectKind(x, "a.xls", "xdw", { mismatch: true });
  assert.ok(/副檔名為 \.xls/.test(r.mismatchText) && /DocuWorks/.test(r.mismatchText));
  expectKind(Buffer.concat([x, Buffer.alloc(16)]), "a.xdw", "xdw");          // 容許 16 位元組尾巴
  assert.strictEqual(FT.looksXdw(Buffer.concat([x, Buffer.alloc(17)])), false);
  assert.strictEqual(FT.looksXdw(XDW_HDR), false);                           // 只有表頭（< 2 元素）
  assert.strictEqual(FT.looksXdw(makeXdw(1)), true);
});
test("XDW：截斷 / 舊版 / 偽陽性", function () {
  var x = makeXdw(4, { imgSize: 3000 });
  var r = expectKind(x.subarray(0, 5000), "a.xdw", "xdw");
  assert.ok(r.meta.truncated && /不完整/.test(r.detail));
  expectKind(x.subarray(0, 5000), "", "xdw");
  r = expectKind(Buffer.from("%XDW-1.0 legacy....................", "latin1"), "old.xdw", "xdw");
  assert.ok(r.meta.legacy);
  // 0x60 開頭的隨機資料不可誤判
  for (var i = 0; i < 300; i++) {
    var g = randBytes(50 + (rng() * 3000 | 0), 0x60);
    var k = det(g, "").kind;
    assert.notStrictEqual(k, "xdw", "隨機資料誤判為 xdw");
  }
  // 副檔名 .xdw 但內容無法確認 → 依副檔名（仍交給 xdw 解析器）
  r = expectKind(randBytes(500, 0x01), "scan.xdw", "xdw", { by: "ext", supported: true });
  assert.ok(/DocuWorks/.test(r.detail));
});
test("XDW：委派 YF.xdw.isXdw（存在時）", function () {
  var calls = 0;
  YF.xdw = { isXdw: function (b) { calls++; return b[0] === 0xAB && b[1] === 0xCD; } };
  expectKind(Buffer.from([0xAB, 0xCD, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), "x.bin", "xdw");
  assert.ok(calls > 0);
  expectKind(makeXdw(2), "a.xdw", "xdw");                     // isXdw 回 false 時仍以自有檢查判定
  YF.xdw = { isXdw: function () { throw new Error("boom"); } };
  expectKind(makeXdw(2), "a.xdw", "xdw");                     // isXdw 例外 → 不影響
  delete YF.xdw;
});

/* ======================================================================
 * 3. PDF
 * ====================================================================== */
test("PDF", function () {
  var pdf = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
  var r = expectKind(pdf, "odor.pdf", "pdf", { family: "pdf", mismatch: false, encrypted: false, route: "pdf" });
  assert.strictEqual(r.meta.version, "1.7");
  expectKind(pdf, "odor.xdw", "pdf", { mismatch: true });
  expectKind(pdf, "", "pdf", { mismatch: false });
  r = expectKind(Buffer.concat([Buffer.from("junk header from mail gateway\r\n"), pdf]), "x.pdf", "pdf");
  assert.ok(/多餘資料/.test(r.detail));
  r = expectKind(Buffer.from("%PDF-1.4\n1 0 obj<</Linearized 1/L 999/N 7/T 5>>endobj\n%%EOF", "latin1"), "x.pdf", "pdf");
  assert.strictEqual(r.meta.pages, 7);
  r = expectKind(Buffer.from("%PDF-1.6\n...\ntrailer<</Root 1 0 R/Encrypt 9 0 R>>\n%%EOF", "latin1"), "x.pdf", "pdf");
  assert.strictEqual(r.encrypted, true); assert.strictEqual(r.supported, true); assert.ok(/加密/.test(r.detail));
  // xref stream 的 /Encrypt 離檔尾 > 4 KB：由 startxref 找到
  var body = Buffer.from("%PDF-1.5\n" + "x".repeat(3000) + "\n", "latin1"), xoff = body.length;
  var xref = Buffer.from("9 0 obj<</Type/XRef/Size 9/Root 1 0 R/Encrypt 8 0 R/Length 9000>>stream\n", "latin1");
  r = expectKind(Buffer.concat([body, xref, Buffer.alloc(9000, 0x41), Buffer.from("\nendstream endobj\nstartxref\n" + xoff + "\n%%EOF\n", "latin1")]), "xs.pdf", "pdf");
  assert.strictEqual(r.encrypted, true);
  r = expectKind(Buffer.concat([body, Buffer.alloc(9000, 0x41), Buffer.from("\nstartxref\n" + xoff + "\n%%EOF\n", "latin1")]), "plain.pdf", "pdf");
  assert.strictEqual(r.encrypted, false);
  r = expectKind(Buffer.from("%PDF-1.3\n1 0 obj", "latin1"), "cut.pdf", "pdf");
  assert.ok(/%%EOF/.test(r.detail));
});

/* ======================================================================
 * 4. ZIP / Office Open XML / ODF
 * ====================================================================== */
test("OOXML Word：docx / docm / dotx / 副檔名不符", function () {
  var docx = ooxml(["word/document.xml", "word/styles.xml"]);
  var r = expectKind(docx, "總表.docx", "docx", { family: "word", mismatch: false, route: "docx", accept: "both", realExt: "docx" });
  assert.ok(r.meta.entries >= 4);
  r = expectKind(docx, "總表.doc", "docx", { mismatch: true, supported: true });
  assert.strictEqual(r.mismatchText, "副檔名為 .doc，實際為 Word 文件 (.docx)");
  assert.ok(/副檔名為 \.doc/.test(r.label));
  expectKind(docx, "總表.xlsx", "docx", { mismatch: true });
  expectKind(docx, "總表.zip", "docx", { mismatch: true });
  expectKind(docx, "總表", "docx", { mismatch: false });
  expectKind(docx, "總表.dotx", "dotx", { mismatch: false });
  expectKind(docx, "總表.docm", "docm", { mismatch: false });
  var docm = ooxml(["word/document.xml", "word/vbaProject.bin"]);
  r = expectKind(docm, "", "docm"); assert.strictEqual(r.meta.macro, true);
  r = expectKind(docm, "a.docx", "docx", { mismatch: false }); assert.ok(/巨集/.test(r.detail));
  expectKind(ooxml(["WORD/Document.XML"]), "a.docx", "docx");             // 大小寫不敏感
});
test("OOXML Excel / PowerPoint / XPS", function () {
  var x = ooxml(["xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  expectKind(x, "a.xlsx", "xlsx", { family: "excel", route: "sheet", mismatch: false });
  var r = expectKind(x, "a.xls", "xlsx", { mismatch: true, supported: true });
  assert.ok(/實際為 Excel 活頁簿 \(\.xlsx\)/.test(r.mismatchText));
  expectKind(x, "a.xltx", "xltx", { mismatch: false });
  expectKind(x, "a.xlsm", "xlsm", { mismatch: false });
  expectKind(ooxml(["xl/workbook.xml", "xl/vbaProject.bin"]), "m", "xlsm");
  expectKind(ooxml(["xl/workbook.bin"]), "a.xlsb", "xlsb", { mismatch: false });
  expectKind(ooxml(["xl/workbook.bin"]), "a.xlsx", "xlsb", { mismatch: true });
  r = expectKind(ooxml(["ppt/presentation.xml"]), "a.pptx", "pptx", { supported: false, route: null });
  assert.ok(/PDF/.test(r.hint));
  expectKind(ooxml(["FixedDocumentSequence.fdseq", "Documents/1/FixedDocument.fdoc"]), "a.xps", "xps", { supported: false });
  // SheetJS 實際輸出
  expectKind(sjsBook("xlsx"), "s.xlsx", "xlsx");
  expectKind(sjsBook("xlsb"), "s.xlsb", "xlsb");
  expectKind(sjsBook("xlsx"), "s.xls", "xlsx", { mismatch: true });
});
test("ODF：mimetype（未壓縮 / 壓縮）", function () {
  var odt = makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 },
    { name: "content.xml", data: "<x/>" }, { name: "META-INF/manifest.xml", data: "<m/>" }]);
  var r = expectKind(odt, "a.odt", "odt", { supported: false });
  assert.ok(/docx/.test(r.hint));
  expectKind(odt, "", "odt");
  expectKind(odt, "a.doc", "odt", { mismatch: true });
  var ods = makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet", method: 0 },
    { name: "content.xml", data: "<x/>" }]);
  expectKind(ods, "a.ods", "ods", { supported: true, route: "sheet" });
  expectKind(sjsBook("ods"), "s.ods", "ods");
  var odp = makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.presentation", method: 0 }]);
  r = expectKind(odp, "a.odp", "unknown", { supported: false }); assert.ok(/簡報/.test(r.detail));
  var odsDeflated = makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet", method: 8 },
    { name: "content.xml", data: "<x/>" }, { name: "META-INF/manifest.xml", data: "<m/>" }]);
  expectKind(odsDeflated, "a.ods", "ods");
});
test("一般 ZIP / 損毀 ZIP / 前置資料 / 註解 / 資料描述元", function () {
  var z = makeZip([{ name: "報告/A_data.xdw", data: "x" }, { name: "報告/odor.pdf", data: "y" }, { name: "報告/", data: "" }]);
  var r = expectKind(z, "raw.zip", "zip", { supported: false });
  assert.ok(/2 個檔案/.test(r.detail) && /A_data\.xdw/.test(r.detail), r.detail);
  assert.ok(/解壓縮/.test(r.hint));
  // 非 UTF-8 旗標的檔名（Big5 位元組）不致當機
  expectKind(makeZip([{ name: "x", nameBuf: Buffer.from([0xB4, 0xFA, 0xAF, 0xB8, 0x2E, 0x70, 0x64, 0x66]), data: "1" }], { utf8: false }), "b.zip", "zip");
  // 中央目錄被截掉 → 掃本地檔頭
  var docx = makeZip([{ name: "[Content_Types].xml", data: CT }, { name: "word/document.xml", data: "<w/>" }]);
  r = expectKind(docx.subarray(0, docx.length - 40), "cut.docx", "docx");
  assert.ok(/不完整/.test(r.detail));
  r = expectKind(makeZip([{ name: "[Content_Types].xml", data: CT }, { name: "word/document.xml", data: "<w/>" }], { noCentral: true, descriptor: true }), "dd.docx", "docx");
  // 有註解
  expectKind(makeZip([{ name: "xl/workbook.xml", data: "<w/>" }, { name: "[Content_Types].xml", data: CT }], { comment: "hello comment" }), "c.xlsx", "xlsx");
  // 前置資料且偏移未校正
  expectKind(makeZip([{ name: "word/document.xml", data: "<w/>" }, { name: "[Content_Types].xml", data: CT }],
    { prefix: Buffer.from("PK\x03\x04garbage-prefix-bytes"), badOffsets: true }), "p.docx", "docx");
  // 空 ZIP
  var empty = Buffer.alloc(22); empty.writeUInt32LE(0x06054b50, 0);
  r = expectKind(empty, "e.zip", "zip"); assert.ok(/沒有檔案/.test(r.detail));
  // 完全損毀（只有 PK 簽章）→ 依副檔名
  r = expectKind(Buffer.from("PK\x03\x04\x00\x00", "latin1"), "bad.docx", "docx", { by: "ext" });
  r = expectKind(Buffer.from("PK\x03\x04\x00\x00", "latin1"), "bad", "unknown");
});

/* ======================================================================
 * 5. OLE2 / CFB
 * ====================================================================== */
test("CFB（SheetJS）：xls biff8 / biff5 / biff2", function () {
  var r = expectKind(sjsBook("biff8"), "a.xls", "xls", { family: "excel", route: "sheet", mismatch: false, encrypted: false });
  assert.strictEqual(r.meta.version, 8); assert.ok(/BIFF8/.test(r.detail), r.detail);
  expectKind(sjsBook("biff8"), "a.xlsx", "xls", { mismatch: true });
  expectKind(sjsBook("biff8"), "", "xls");
  r = expectKind(sjsBook("biff5"), "a.xls", "xls"); assert.ok(/BIFF5|5\.0/.test(r.detail), r.detail);
  r = expectKind(sjsBook("biff2"), "a.xls", "xls"); assert.ok(/BIFF2/.test(r.detail), r.detail);
  // XML Spreadsheet 2003
  r = expectKind(sjsBook("xlml"), "a.xml", "xmlss", { mismatch: false, route: "sheet" });
  r = expectKind(sjsBook("xlml"), "a.xls", "xmlss", { mismatch: true });
  assert.strictEqual(r.mismatchText, "副檔名為 .xls，實際為 Excel XML 試算表 (XML Spreadsheet 2003)");
});
test("CFB（SheetJS mini stream）：doc / ppt / 加密 / msg", function () {
  var doc = sjsCfb([{ name: "WordDocument", data: fib(0).subarray(0, 600) }, { name: "1Table", data: Buffer.alloc(100) }]);
  var r = expectKind(doc, "a.doc", "doc", { family: "word", supported: false, encrypted: false });
  assert.strictEqual(r.hint, "請在 Word 另存為 .docx 後上傳");
  assert.ok(/Word 97/.test(r.detail), r.detail);
  expectKind(doc, "a.docx", "doc", { mismatch: true });
  r = expectKind(sjsCfb([{ name: "WordDocument", data: fib(0x0100).subarray(0, 600) }]), "e.doc", "doc", { encrypted: true });
  assert.ok(/密碼/.test(r.hint));
  r = expectKind(sjsCfb([{ name: "WordDocument", data: fib(0x0001).subarray(0, 600) }]), "t.dot", "doc");
  assert.ok(/範本/.test(r.detail));
  expectKind(sjsCfb([{ name: "PowerPoint Document", data: Buffer.alloc(50) }, { name: "Current User", data: Buffer.alloc(20) }]), "a.ppt", "ppt", { supported: false });
  var enc = sjsCfb([{ name: "EncryptionInfo", data: Buffer.alloc(200) }, { name: "EncryptedPackage", data: Buffer.alloc(300) }]);
  r = expectKind(enc, "總表.docx", "docx", { encrypted: true, supported: false, mismatch: false, route: null });
  assert.ok(/密碼保護/.test(r.hint) && /已加密/.test(r.label), r.label);
  expectKind(enc, "a.xlsx", "xlsx", { encrypted: true, supported: false });
  r = expectKind(enc, "", "encrypted", { supported: false }); assert.ok(/密碼保護/.test(r.hint));
  r = expectKind(enc, "a.pdf", "encrypted", { mismatch: true });
  r = expectKind(sjsCfb([{ name: "Workbook", data: biffWithFilepass(300) }]), "p.xls", "xls", { encrypted: true, supported: false });
  r = expectKind(sjsCfb([{ name: "__properties_version1.0", data: Buffer.alloc(32) }, { name: "__substg1.0_0037001F", data: Buffer.alloc(8) }]), "m.msg", "unknown");
  assert.ok(/Outlook/.test(r.detail) && /附件/.test(r.hint));
  r = expectKind(sjsCfb([{ name: "Foo", data: Buffer.alloc(8) }]), "x.xls", "unknown");
  assert.ok(/OLE2/.test(r.detail));
  // 內嵌 Workbook 於子儲存區的 Word 檔仍為 doc
  var c = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(c, "/ObjectPool/_123/Workbook", Buffer.alloc(100));
  XLSX.CFB.utils.cfb_add(c, "/WordDocument", fib(0).subarray(0, 600));
  expectKind(Buffer.from(XLSX.CFB.write(c, { type: "array" })), "embed.doc", "doc");
  var c2 = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(c2, "/ObjectPool/_123/Workbook", Buffer.alloc(100));
  var r2 = det(Buffer.from(XLSX.CFB.write(c2, { type: "array" })), "x.xls");
  assert.strictEqual(r2.kind, "unknown", "子儲存區內的 Workbook 不算 xls");
  var ent = FT.cfbEntries(Buffer.from(XLSX.CFB.write(c2, { type: "array" })));
  assert.ok(ent.entries.some(function (e) { return e.path === "ObjectPool/_123/Workbook"; }), JSON.stringify(ent.entries.map(function (e) { return e.path; })));
});
test("CFB（自製）：v3 / v4 4096 磁區 / 一般磁區讀串流開頭", function () {
  var r = expectKind(makeCfb([{ name: "WordDocument", data: fib(0x0100) }]), "big.doc", "doc", { encrypted: true });
  r = expectKind(makeCfb([{ name: "WordDocument", data: fib(0) }, { name: "1Table", data: Buffer.alloc(5000) }], { v4: true }), "v4.doc", "doc", { encrypted: false });
  assert.strictEqual(r.meta.sectorSize, 4096);
  r = expectKind(makeCfb([{ name: "Workbook", data: biffWithFilepass(5000) }], { v4: true }), "v4.xls", "xls", { encrypted: true });
  r = expectKind(makeCfb([{ name: "Book", data: pad(Buffer.from([0x09, 0x08, 0x08, 0, 0, 5, 5, 0]), 5000) }]), "old.xls", "xls");
  assert.ok(/BIFF5|5\.0/.test(r.detail), r.detail);
  expectKind(makeCfb([{ name: "EncryptionInfo", data: Buffer.alloc(4200) }, { name: "EncryptedPackage", data: Buffer.alloc(9000) }], { v4: true }), "e.xlsx", "xlsx", { encrypted: true });
});
test("CFB：DIFAT（目錄位於第 109×128 個磁區之後）", function () {
  var buf = makeCfb([{ name: "WordDocument", data: fib(0) }], { filler: 14100 });
  assert.ok(buf.length > 7e6);
  var r = expectKind(buf, "difat.doc", "doc");
  var info = FT.cfbEntries(buf);
  assert.strictEqual(info.entries[0].name, "WordDocument");
  buf = makeCfb([{ name: "Workbook", data: biffWithFilepass(5000) }], { filler: 14100, dirLast: true });
  expectKind(buf, "difat.xls", "xls", { encrypted: true });
});
test("CFB：損毀 / 截斷 / 循環 FAT", function () {
  var good = makeCfb([{ name: "WordDocument", data: fib(0) }]);
  var r = expectKind(good.subarray(0, 512), "cut.doc", "doc", { by: "ext" });         // 只剩表頭
  assert.ok(/OLE2/.test(r.detail));
  r = expectKind(good.subarray(0, 512), "cut", "unknown");
  r = det(makeCfb([{ name: "WordDocument", data: fib(0) }], { cycle: true }), "loop.doc");
  assert.strictEqual(r.kind, "doc");
  var bad = Buffer.from(good); bad.writeUInt32LE(0x7FFFFFF0, 0x30);                 // 目錄磁區超出範圍
  r = expectKind(bad, "bad.xls", "xls", { by: "ext" });
  bad = Buffer.from(good); bad.writeUInt16LE(0x0FFF, 0x1E);                          // 磁區大小欄位亂填
  det(bad, "x.doc");
});

/* ======================================================================
 * 6. 文字類：RTF / HTML / XML / CSV / TXT
 * ====================================================================== */
test("RTF", function () {
  var rtf = Buffer.from("{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times;}} hello}");
  expectKind(rtf, "a.rtf", "rtf", { supported: false, mismatch: false });
  var r = expectKind(rtf, "a.doc", "rtf", { mismatch: true });
  assert.strictEqual(r.hint, "請在 Word 另存為 .docx 後上傳");
});
test("HTML 表格（副檔名 .xls / .doc / MHTML）", function () {
  var xh = Buffer.from('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    "<head><meta charset=utf-8></head><body><table><tr><td>測站</td><td>SO2</td></tr></table></body></html>");
  var r = expectKind(xh, "export.xls", "html", { mismatch: true, supported: true, route: "sheet", accept: "both" });
  assert.strictEqual(r.label, "HTML 表格（副檔名為 .xls）");
  assert.strictEqual(r.mismatchText, "副檔名為 .xls，實際為 HTML 表格");
  expectKind(xh, "a.html", "html", { mismatch: false });
  expectKind(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("\r\n  <table border=1><tr><td>1</td></tr></table>")]), "t.xls", "html");
  expectKind(Buffer.from("<!DOCTYPE html><html><body>no table</body></html>"), "p.htm", "html");
  var wordHtml = Buffer.from('<html xmlns:w="urn:schemas-microsoft-com:office:word"><body><table><tr><td>x</td></tr></table></body></html>');
  r = expectKind(wordHtml, "report.doc", "html", { accept: "raw", mismatch: true, supported: true });
  assert.ok(/docx/.test(r.hint));
  assert.strictEqual(FT.canUse(r, "template").ok, false);
  assert.strictEqual(FT.canUse(r, "raw").ok, true);
  var mht = Buffer.from("MIME-Version: 1.0\r\nX-Document-Type: Workbook\r\nContent-Type: multipart/related; boundary=\"----=_NextPart\"\r\n\r\n");
  r = expectKind(mht, "a.mht", "html", { mismatch: false }); assert.ok(/MHTML/.test(r.detail));
  expectKind(mht, "a.xls", "html", { mismatch: true });
  // Big5 編碼的 HTML
  var big5Html = Buffer.concat([Buffer.from("<html><head><meta charset=big5></head><body><table><tr><td>"),
    Buffer.from([0xB4, 0xFA, 0xAF, 0xB8]), Buffer.from("</td></tr></table></body></html>")]);
  r = expectKind(big5Html, "b.xls", "html"); assert.strictEqual(r.meta.encoding, "big5");
});
test("XML：Word 2003 XML / 一般 XML", function () {
  var w = Buffer.from('<?xml version="1.0"?>\n<?mso-application progid="Word.Document"?>\n<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"/>');
  expectKind(w, "a.xml", "wordxml", { supported: false, mismatch: false });
  expectKind(w, "a.doc", "wordxml", { mismatch: true });
  var r = expectKind(Buffer.from('<?xml version="1.0"?><data><row a="1"/></data>'), "d.xml", "txt", { mismatch: false });
  assert.ok(/XML/.test(r.detail));
  expectKind(Buffer.from('<?xml version="1.0"?><data/>'), "d.xls", "txt", { mismatch: true });
});
var BIG5_ROW = Buffer.from([0xB4, 0xFA, 0xAF, 0xB8, 0x2C, 0xB9, 0xC5, 0xAB, 0xD7, 0x0D, 0x0A]);   // 「測站,溫度」
test("CSV：BOM / Big5 / UTF-16 / 分隔符號 / 單欄 / 偽裝成 .xls", function () {
  var csv = "測站,SO2,NO2\r\n示範新城,0.001,0.012\r\n甲乙社區,0.001,0.008\r\n";
  var r = expectKind(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csv)]), "a.csv", "csv", { mismatch: false, route: "sheet" });
  assert.strictEqual(r.meta.encoding, "utf-8"); assert.strictEqual(r.meta.bom, true); assert.strictEqual(r.meta.delimiter, ",");
  assert.ok(/BOM/.test(r.detail));
  r = expectKind(Buffer.from(csv), "a.csv", "csv"); assert.strictEqual(r.meta.bom, undefined);
  var big5 = Buffer.concat([BIG5_ROW, Buffer.from("A,1\r\n"), BIG5_ROW, Buffer.from("B,2\r\n")]);
  r = expectKind(big5, "b.csv", "csv"); assert.strictEqual(r.meta.encoding, "big5"); assert.ok(/Big5/.test(r.detail));
  r = expectKind(big5, "", "csv"); assert.strictEqual(r.meta.encoding, "big5");
  // Excel「Unicode 文字」：UTF-16LE + BOM + Tab
  var u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("測站\tSO2\r\n示範\t0.001\r\n甲乙\t0.002\r\n", "utf16le")]);
  r = expectKind(u16, "u.txt", "csv", { mismatch: false }); assert.strictEqual(r.meta.encoding, "utf-16le"); assert.strictEqual(r.meta.delimiter, "\t");
  var u16be = Buffer.from("A\tB\r\n1\t2\r\n3\t4\r\n", "utf16le").swap16();
  r = expectKind(u16be, "", "csv"); assert.strictEqual(r.meta.encoding, "utf-16be");
  r = expectKind(Buffer.from("A\tB\r\n1\t2\r\n3\t4\r\n", "utf16le"), "nobom.txt", "csv"); assert.strictEqual(r.meta.encoding, "utf-16le");
  r = expectKind(Buffer.from("a;b;c\n1;2;3\n4;5;6\n"), "s.csv", "csv"); assert.strictEqual(r.meta.delimiter, ";");
  r = expectKind(Buffer.from("sep=;\na;b\n1;2\n"), "s.csv", "csv"); assert.strictEqual(r.meta.delimiter, ";");
  r = expectKind(Buffer.from("a|b|c\n1|2|3\n4|5|6\n"), "p.txt", "csv"); assert.strictEqual(r.meta.delimiter, "|");
  r = expectKind(Buffer.from('"a,b",c\n"1,2",3\n'), "q.csv", "csv"); assert.strictEqual(r.meta.delimiter, ",");
  expectKind(Buffer.from("only\none\ncolumn\n"), "one.csv", "csv", { mismatch: false });
  r = expectKind(Buffer.from("A\tB\tC\n1\t2\t3\n"), "tsv.xls", "csv", { mismatch: true, supported: true });
  assert.ok(/副檔名為 \.xls/.test(r.mismatchText));
  expectKind(Buffer.from(csv), "a.xls", "csv", { mismatch: true });
  expectKind(Buffer.from("a,b,c"), "", "csv");                       // 單行 ≥ 3 欄
});
test("TXT / JSON / 空白文字", function () {
  var prose = "這是一份說明文件。\n第二行文字, 有一個逗號\n第三行沒有\n第四行也沒有\n";
  var r = expectKind(Buffer.from(prose), "readme.txt", "txt", { supported: false });
  assert.ok(r.hint.length > 0);
  expectKind(Buffer.from("Hello, world\n"), "a.txt", "txt");
  r = expectKind(Buffer.from('{"a":1,"b":[1,2]}\n'), "d.json", "txt", { mismatch: false }); assert.ok(/JSON/.test(r.detail));
  expectKind(Buffer.from('[{"a":1},{"a":2}]'), "", "txt");
  r = expectKind(Buffer.from("[1],[2],x\n[3],[4],y\n"), "", "csv");                // 看似 JSON 開頭的 CSV
  r = expectKind(Buffer.from("<10,20,ND\n<5,<5,3\n"), "lt.csv", "csv");             // 「<」開頭的數值不當 HTML/XML
  expectKind(Buffer.from("<10,20,ND\n<5,<5,3\n"), "", "csv");
  r = expectKind(Buffer.from("\r\n  \r\n"), "blank.txt", "txt"); assert.ok(/空白/.test(r.detail));
  expectKind(Buffer.from("\r\n  \r\n"), "blank.csv", "csv");
  expectKind(Buffer.from("\tindented line one\n\tindented line two\n\tthree\n"), "i.txt", "txt");   // 只有行首 Tab 縮排 → 非表格
});

/* ======================================================================
 * 7. 影像
 * ====================================================================== */
test("影像：PNG / JPEG / GIF / BMP / WebP / HEIC", function () {
  var r = expectKind(makePng(1654, 2340, 200), "p.png", "png", { family: "image", route: "image", accept: "raw" });
  assert.strictEqual(r.meta.width, 1654); assert.strictEqual(r.meta.height, 2340); assert.strictEqual(r.meta.dpi, 200);
  expectKind(makePng(10, 10), "p.jpg", "png", { mismatch: true });
  r = expectKind(makeJpeg(2480, 3508, 300), "scan.jpeg", "jpg", { mismatch: false });
  assert.strictEqual(r.meta.width, 2480); assert.strictEqual(r.meta.height, 3508); assert.strictEqual(r.meta.dpi, 300);
  r = expectKind(Buffer.from("GIF89a\x40\x01\xF0\x00\x00\x00\x00;", "latin1"), "g.gif", "gif");
  assert.strictEqual(r.meta.width, 320); assert.strictEqual(r.meta.height, 240);
  r = expectKind(makeBmp(100, 50, 150), "b.bmp", "bmp"); assert.strictEqual(r.meta.height, 50); assert.strictEqual(r.meta.dpi, 150);
  r = expectKind(makeWebp(800, 600), "w.webp", "webp"); assert.strictEqual(r.meta.width, 800); assert.strictEqual(r.meta.height, 600);
  r = expectKind(makeWebpLossless(321, 123), "w.webp", "webp"); assert.strictEqual(r.meta.width, 321); assert.strictEqual(r.meta.height, 123);
  var heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic\0\0\0\0mif1heic", "latin1")]);
  r = expectKind(heic, "IMG_0001.HEIC", "heic", { supported: false }); assert.ok(/JPG/.test(r.hint));
  // "BM" 開頭但不是 BMP
  expectKind(Buffer.from("BMW report,2024\nA,1\nB,2\n"), "x.csv", "csv");
});
test("影像：TIFF（G4 黑白可用、LZW 彩色不可用、多頁、MM 位元組序）", function () {
  var r = expectKind(makeTiff(true, { w: 1654, h: 2340, comp: 4, dpi: 200, pages: 3 }), "s.tif", "tif", { supported: true });
  assert.strictEqual(r.meta.pages, 3); assert.strictEqual(r.meta.width, 1654); assert.strictEqual(r.meta.dpi, 200);
  assert.strictEqual(r.meta.bilevel, true); assert.ok(/G4/.test(r.detail), r.detail);
  r = expectKind(makeTiff(false, { w: 800, h: 600, comp: 3, dpi: 300 }), "s.tiff", "tif", { supported: true });
  assert.strictEqual(r.meta.width, 800); assert.strictEqual(r.meta.dpi, 300);
  r = expectKind(makeTiff(true, { w: 800, h: 600, comp: 5, dpi: 300, spp: 3 }), "c.tif", "tif", { supported: false, route: null });
  assert.strictEqual(r.meta.bilevel, false); assert.ok(/PNG/.test(r.hint) && /LZW/.test(r.hint), r.hint);
  var loop = makeTiff(true, { w: 8, h: 8, comp: 4, dpi: 200, pages: 2 });
  loop.writeUInt32LE(8, 8 + 2 + 9 * 12);                                 // 第一個 IFD 指回自己
  r = det(loop, "l.tif"); assert.strictEqual(r.meta.pages, 1);
});

/* ======================================================================
 * 8. 空檔、垃圾、輸入型別、其他二進位
 * ====================================================================== */
test("空檔 / 垃圾 / 輸入型別", function () {
  var r = expectKind(new Uint8Array(0), "a.xdw", "empty", { supported: false, mismatch: false });
  assert.ok(/0 位元組/.test(r.hint));
  expectKind(null, "x", "empty");
  expectKind(new ArrayBuffer(0), "", "empty");
  expectKind(new Uint8Array(makePng(4, 4)).buffer, "", "png");                            // ArrayBuffer
  var pngBuf = makePng(4, 4), big = Buffer.alloc(pngBuf.length + 10); pngBuf.copy(big, 10);
  expectKind(new DataView(big.buffer, big.byteOffset + 10, pngBuf.length), "", "png");     // DataView
  expectKind(new Uint8Array(big.buffer, big.byteOffset + 10, pngBuf.length), "", "png");   // 子陣列
  assert.throws(function () { FT.detect("not bytes", "a.pdf"); }, TypeError);
  expectKind(Buffer.from([0x00]), "a", "unknown");
  assert.strictEqual(det(Buffer.from([0x60]), "").supported, false);            // 「`」一個字元 → 純文字（不支援）
  assert.strictEqual(det(Buffer.from([0x60, 0x0E]), "").supported, false);
  assert.strictEqual(det(Buffer.from([0x60, 0x0E, 0x82, 0x01, 0x07]), "a.xdw").kind, "xdw");   // 太短：依副檔名
  expectKind(Buffer.alloc(1000), "zeros.bin", "unknown", { supported: false });
  r = expectKind(Buffer.alloc(1000), "zeros.csv", "unknown"); assert.ok(/二進位/.test(r.detail));
  r = expectKind(Buffer.alloc(1000), "zeros.pdf", "pdf", { by: "ext" });
  r = expectKind(Buffer.from("7z\xBC\xAF\x27\x1C\x00\x04", "latin1"), "a.7z", "unknown"); assert.ok(/7-Zip/.test(r.detail) && /解壓縮/.test(r.hint));
  r = expectKind(Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), "setup.exe", "unknown"); assert.ok(/執行檔/.test(r.detail));
  r = expectKind(Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), "A_data.xdw", "unknown", { mismatch: true });
  assert.strictEqual(r.label, "無法辨識的檔案 (.xdw)");
  assert.strictEqual(r.mismatchText, "副檔名為 .xdw，但內容不是 DocuWorks 文件 (.xdw)");
  r = expectKind(Buffer.from([0x1F, 0x8B, 8, 0, 0, 0, 0, 0]), "a.gz", "unknown");
  for (var i = 0; i < 500; i++) {
    var g = randBytes(1 + (rng() * 64 | 0));
    var x = det(g, ["", "a.xdw", "a.pdf", "a.docx", "a.csv"][i % 5]);
    assert.ok(FT.KINDS[x.kind], "kind 須在 KINDS 中");
  }
});
test("canUse", function () {
  var docx = det(ooxml(["word/document.xml"]), "a.docx");
  assert.deepStrictEqual(FT.canUse(docx, "template"), { ok: true, reason: "" });
  assert.strictEqual(FT.canUse(docx, "raw").ok, true);
  var pdf = det(Buffer.from("%PDF-1.4\n%%EOF"), "a.pdf");
  var u = FT.canUse(pdf, "template");
  assert.strictEqual(u.ok, false); assert.ok(/待填表格/.test(u.reason), u.reason);
  assert.strictEqual(FT.canUse(pdf, "raw").ok, true);
  var doc = det(sjsCfb([{ name: "WordDocument", data: fib(0).subarray(0, 600) }]), "a.doc");
  u = FT.canUse(doc, "raw"); assert.strictEqual(u.ok, false); assert.ok(/另存為 \.docx/.test(u.reason));
  var mis = det(ooxml(["word/document.xml"]), "a.doc");
  u = FT.canUse(mis, "template"); assert.strictEqual(u.ok, true); assert.ok(/副檔名為 \.doc/.test(u.reason));
  assert.strictEqual(FT.canUse(null, "raw").ok, false);
});

/* ======================================================================
 * 9. 隨機變異（不可丟例外、kind 必在 KINDS 中）
 * ====================================================================== */
test("fuzz：截斷 / 位元翻轉", function () {
  var samples = [makeXdw(3), ooxml(["word/document.xml"]), sjsBook("biff8"), sjsBook("xlsx"), makePng(20, 20, 96), makeJpeg(20, 20, 72),
    makeTiff(true, { w: 8, h: 8, comp: 4, dpi: 200, pages: 2 }), makeCfb([{ name: "WordDocument", data: fib(0) }]),
    sjsCfb([{ name: "WordDocument", data: fib(0).subarray(0, 600) }]), Buffer.from("%PDF-1.4\n1 0 obj<</Linearized 1/N 3>>\n%%EOF"),
    sjsBook("xlml"), Buffer.from("a,b\n1,2\n")];
  var t0 = Date.now(), n = 0;
  samples.forEach(function (s) {
    for (var i = 0; i < 120; i++) {
      var m = Buffer.from(s);
      if (i % 3 === 0) m = m.subarray(0, (rng() * m.length) | 0);
      else for (var k = 0; k < 1 + (rng() * 12 | 0); k++) m[(rng() * m.length) | 0] = (rng() * 256) | 0;
      var r = FT.detect(m, ["a.doc", "a.xdw", "", "a.xlsx"][i % 4]);
      assert.ok(FT.KINDS[r.kind] && typeof r.label === "string" && typeof r.detail === "string");
      n++;
    }
  });
  assert.ok(Date.now() - t0 < 5000, "fuzz 太慢");
});

/* ======================================================================
 * 10. 效能：50 MB 緩衝區只讀表頭 / 目錄
 * ====================================================================== */
test("效能：50 MB", function () {
  var MB50 = 50 * 1024 * 1024, times = {};
  function timed(label, buf, name, kind) {
    var t = process.hrtime.bigint(), r = FT.detect(buf, name), ms = Number(process.hrtime.bigint() - t) / 1e6;
    times[label] = ms.toFixed(1);
    assert.strictEqual(r.kind, kind, label + " → " + r.kind);
    assert.ok(ms < 250, label + " 花了 " + ms.toFixed(1) + " ms");
  }
  var zeros = Buffer.alloc(MB50);
  timed("zeros", zeros, "z.bin", "unknown");
  var rnd = Buffer.alloc(MB50); for (var i = 0; i < MB50; i += 4) rnd.writeUInt32LE((rng() * 4294967296) >>> 0, i);
  timed("random", rnd, "r.xdw", "xdw");
  rnd[0] = 0x60; timed("random-0x60", rnd, "", "unknown");
  rnd[0] = 0x50; rnd[1] = 0x4B; rnd[2] = 3; rnd[3] = 4; timed("random-PK", rnd, "x.docx", "docx");
  var docx = makeZip([{ name: "[Content_Types].xml", data: CT }, { name: "word/media/image1.png", data: Buffer.alloc(MB50), method: 0 },
    { name: "word/document.xml", data: "<w/>" }]);
  timed("docx-50MB", docx, "big.docx", "docx");
  var pdf = Buffer.concat([Buffer.from("%PDF-1.5\n"), Buffer.alloc(MB50, 0x20), Buffer.from("\ntrailer<<>>\n%%EOF\n")]);
  timed("pdf", pdf, "big.pdf", "pdf");
  var xdwBig = Buffer.concat([XDW_HDR, tlv(0x61, tlv(0x64, Buffer.alloc(MB50, 1)))]);
  timed("xdw", xdwBig, "big.xdw", "xdw");
  var csv = Buffer.alloc(MB50); var row = Buffer.from("示範新城,0.001,0.012\r\n"); for (i = 0; i + row.length <= MB50; i += row.length) row.copy(csv, i);
  timed("csv", csv, "big.csv", "csv");
  var cfb = makeCfb([{ name: "WordDocument", data: pad(fib(0), MB50) }], { dirLast: true });
  timed("cfb-dirLast", cfb, "big.doc", "doc");
  console.log("  效能 (ms): " + JSON.stringify(times));
});

/* ======================================================================
 * 11. 真實樣本（test_data/fill/，不存在則略過）
 * ====================================================================== */
var TD = path.join(ROOT, "test_data", "fill");
function real(name) { var p = path.join(TD, name); return fs.existsSync(p) ? fs.readFileSync(p) : null; }
var xdwReal = real("A_data.xdw"), pdfReal = real("odor.pdf"), docxReal = real("template.docx");
function realTests(tag) {
  if (xdwReal) test("真實 A_data.xdw " + tag, function () {
    var r = expectKind(xdwReal, "A_data.xdw", "xdw", { family: "docuworks", mismatch: false, supported: true, by: "content" });
    assert.strictEqual(r.meta.version, 7);
    expectKind(xdwReal, "A_data.pdf", "xdw", { mismatch: true });
    expectKind(xdwReal, "A_data.xls", "xdw", { mismatch: true });
    expectKind(xdwReal, "A_data.docx", "xdw", { mismatch: true });
    expectKind(xdwReal, "A_data", "xdw", { mismatch: false });
    expectKind(xdwReal, "A_data.XDW", "xdw", { mismatch: false });
    expectKind(xdwReal, "A_data.xbd", "xbd", { mismatch: false });
    r = expectKind(xdwReal.subarray(0, 100000), "A_data.xdw", "xdw");
    assert.ok(r.meta.truncated);
  }); else skipped++;
  if (pdfReal) test("真實 odor.pdf " + tag, function () {
    var r = expectKind(pdfReal, "odor.pdf", "pdf", { mismatch: false, encrypted: false });
    assert.strictEqual(r.meta.pages, 5);
    expectKind(pdfReal, "odor.xdw", "pdf", { mismatch: true });
    expectKind(pdfReal, "odor", "pdf");
  }); else skipped++;
  if (docxReal) test("真實 template.docx " + tag, function () {
    expectKind(docxReal, "template.docx", "docx", { mismatch: false, route: "docx", accept: "both" });
    expectKind(docxReal, "template.doc", "docx", { mismatch: true, supported: true });
    expectKind(docxReal, "template.xlsx", "docx", { mismatch: true });
    expectKind(docxReal, "template.xls", "docx", { mismatch: true });
    expectKind(docxReal, "template", "docx", { mismatch: false });
    expectKind(docxReal, "template.zip", "docx", { mismatch: true });
    var names = FT.zipEntries(docxReal).entries.map(function (e) { return e.name; });
    assert.ok(names.indexOf("word/document.xml") >= 0);
  }); else skipped++;
}
realTests("（自有 XDW 檢查）");
// 若 xdw.js 已存在，載入後再跑一次（應走 YF.xdw.isXdw，結果相同）
var xdwJs = path.join(ROOT, "js/fill/xdw.js");
if (fs.existsSync(xdwJs)) {
  try {
    require(xdwJs);
    if (YF.xdw && typeof YF.xdw.isXdw === "function") {
      test("xdw.js 的 isXdw 與合成樣本", function () {
        expectKind(makeXdw(2), "a.xdw", "xdw");
        if (xdwReal) assert.strictEqual(YF.xdw.isXdw(xdwReal), true, "YF.xdw.isXdw(真實樣本) 應為 true");
      });
      realTests("（載入 xdw.js）");
    }
  } catch (e) { console.log("  （xdw.js 載入失敗，略過：" + e.message + "）"); skipped++; }
} else if (savedXdw) { YF.xdw = savedXdw; }

console.log((failed ? "FAIL" : "PASS") + " filetype.test.js — " + passed + " passed, " + failed + " failed" +
  (skipped ? ", " + skipped + " skipped" : ""));
process.exit(failed ? 1 : 0);
