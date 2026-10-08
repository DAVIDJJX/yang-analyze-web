/* =========================================================================
 * Yang-analyze web — tests/fill/zip.test.js
 * js/fill/zip.js 單元測試（Node 22，只用內建模組）：
 *   node tests/fill/zip.test.js
 * 涵蓋：寫出→讀回、stored/deflate 混合、資料描述元、UTF-8 / Big5 / Info-ZIP Unicode 檔名、
 *       ZIP64 extra、前置資料（自解壓）、copyWithChanges 保留原壓縮位元組、CRC 正確性、
 *       損毀/截斷/非 ZIP 輸入的中文錯誤、無 CompressionStream 時的備援。
 * 另外：若 test_data/fill/template.docx 存在（真實樣本，不進 repo），做一次讀取與無變更複製檢查。
 * ========================================================================= */
"use strict";
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");

var ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "js/fill/zip.js"));
var Z = globalThis.YangFill.zip;
var ENC = new TextEncoder(), DEC = new TextDecoder();

var passed = 0, failed = 0, queue = [];
function test(name, fn) { queue.push({ name: name, fn: fn }); }
async function run() {
  for (var i = 0; i < queue.length; i++) {
    try { await queue[i].fn(); passed++; }
    catch (e) { failed++; console.error("FAIL " + queue[i].name + "\n  " + (e && e.stack || e)); }
  }
  if (failed) { console.error("zip.test.js: " + failed + " FAILED, " + passed + " passed"); process.exit(1); }
  console.log("zip.test.js PASS (" + passed + " tests)");
}

/* ---------------- 測試用：手工組 ZIP（模擬各家壓縮軟體的寫法） ---------------- */
function le16(n) { return [n & 255, (n >>> 8) & 255]; }
function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function cat(arrs) {
  var n = arrs.reduce(function (s, a) { return s + a.length; }, 0), out = new Uint8Array(n), p = 0;
  arrs.forEach(function (a) { out.set(a, p); p += a.length; });
  return out;
}
/**
 * items: [{name|nameBytes, data, method(0|8), descriptor?, utf8Flag?, localExtra?, centralExtra?,
 *          zip64?: bool（大小欄位寫 0xFFFFFFFF + ZIP64 extra）}]
 */
function handZip(items, opts) {
  opts = opts || {};
  var parts = [], central = [], off = (opts.prefix || new Uint8Array(0)).length;
  if (opts.prefix) parts.push(opts.prefix);
  items.forEach(function (it) {
    var nameB = it.nameBytes || ENC.encode(it.name);
    var data = typeof it.data === "string" ? ENC.encode(it.data) : it.data;
    var comp = it.method === 8 ? new Uint8Array(zlib.deflateRawSync(data)) : data;
    var crc = zlib.crc32(data) >>> 0;
    var flag = (it.descriptor ? 8 : 0) | (it.utf8Flag ? 0x800 : 0);
    var lx = it.localExtra || new Uint8Array(0);
    var cx = it.centralExtra || new Uint8Array(0);
    var csz = comp.length, usz = data.length;
    if (it.zip64) {
      var z64 = cat([new Uint8Array(le16(1)), new Uint8Array(le16(16)),
        new Uint8Array(le32(usz)), new Uint8Array(le32(0)), new Uint8Array(le32(csz)), new Uint8Array(le32(0))]);
      cx = cat([cx, z64]);
    }
    var lh = new Uint8Array([].concat(le32(0x04034b50), le16(20), le16(flag), le16(it.method),
      le16(0), le16(0x21), le32(it.descriptor ? 0 : crc), le32(it.descriptor ? 0 : csz),
      le32(it.descriptor ? 0 : usz), le16(nameB.length), le16(lx.length)));
    parts.push(lh, nameB, lx, comp);
    var dd = it.descriptor ? new Uint8Array([].concat(le32(0x08074b50), le32(crc), le32(csz), le32(usz))) : null;
    if (dd) parts.push(dd);
    var ch = new Uint8Array([].concat(le32(0x02014b50), le16(20), le16(20), le16(flag), le16(it.method),
      le16(0), le16(0x21), le32(crc), le32(it.zip64 ? 0xFFFFFFFF : csz), le32(it.zip64 ? 0xFFFFFFFF : usz),
      le16(nameB.length), le16(cx.length), le16(0), le16(0), le16(0), le32(0),
      le32(off - (opts.prefix && opts.offsetsRelative ? opts.prefix.length : 0))));
    central.push(ch, nameB, cx);
    off += lh.length + nameB.length + lx.length + comp.length + (dd ? dd.length : 0);
  });
  var cd = cat(central);
  var comment = opts.comment ? ENC.encode(opts.comment) : new Uint8Array(0);
  var cdOffset = off - (opts.prefix && opts.offsetsRelative ? opts.prefix.length : 0);
  var eocd = new Uint8Array([].concat(le32(0x06054b50), le16(0), le16(0), le16(items.length), le16(items.length),
    le32(cd.length), le32(cdOffset), le16(comment.length)));
  return cat(parts.concat([cd, eocd, comment]));
}

/** 用 Node zlib 獨立驗證我們寫出的 ZIP：逐項解壓並核對 CRC */
function verifyWithZlib(bytes) {
  var b = Buffer.from(bytes), out = {};
  var eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  assert.ok(eocd >= 0, "EOCD 存在");
  var n = b.readUInt16LE(eocd + 10), p = b.readUInt32LE(eocd + 16);
  assert.strictEqual(b.readUInt32LE(eocd + 12) + p, eocd, "中央目錄大小 + 位移 = EOCD 位置");
  for (var i = 0; i < n; i++) {
    assert.strictEqual(b.readUInt32LE(p), 0x02014b50);
    var flag = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16);
    var csz = b.readUInt32LE(p + 20), usz = b.readUInt32LE(p + 24);
    var nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    var lo = b.readUInt32LE(p + 42);
    var name = b.subarray(p + 46, p + 46 + nl).toString("utf8");
    assert.strictEqual(b.readUInt32LE(lo), 0x04034b50, "本機檔頭簽章 " + name);
    assert.strictEqual(b.readUInt32LE(lo + 14), crc, "本機/中央 CRC 一致 " + name);
    assert.strictEqual(b.readUInt32LE(lo + 18), csz, "本機/中央壓縮長度一致 " + name);
    var ds = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
    var comp = b.subarray(ds, ds + csz);
    var data = method === 8 ? zlib.inflateRawSync(comp) : comp;
    assert.strictEqual(data.length, usz, "長度 " + name);
    assert.strictEqual(zlib.crc32(data) >>> 0, crc, "CRC " + name);
    if (/[^\x00-\x7e]/.test(name)) assert.ok(flag & 0x800, "非 ASCII 檔名要設 UTF-8 旗標 " + name);
    out[name] = { method: method, data: new Uint8Array(data) };
    p += 46 + nl + xl + cl;
  }
  return out;
}

function bigText(n) {
  var s = "";
  for (var i = 0; i < n; i++) s += "<w:p><w:r><w:t>第" + i + "列 測試 value=" + (i * 7 % 13) + "</w:t></w:r></w:p>\n";
  return s;
}
function randomBytes(n, seed) {
  var out = new Uint8Array(n), x = seed || 12345;
  for (var i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >>> 16; }
  return out;
}
async function rejectsZh(promise, re) {
  try { await promise; } catch (e) {
    assert.ok(/[一-鿿]/.test(e.message), "錯誤訊息應為中文：" + e.message);
    if (re) assert.ok(re.test(e.message), "錯誤訊息不符：" + e.message);
    return e;
  }
  assert.fail("應該丟出錯誤");
}

/* ---------------- CRC32 ---------------- */
test("crc32 已知值與 zlib 一致", function () {
  assert.strictEqual(Z.crc32(ENC.encode("123456789")), 0xCBF43926);
  assert.strictEqual(Z.crc32(new Uint8Array(0)), 0);
  var r = randomBytes(100000, 7);
  assert.strictEqual(Z.crc32(r), zlib.crc32(r) >>> 0);
  // 分段累算
  assert.strictEqual(Z.crc32(r.subarray(5000), Z.crc32(r.subarray(0, 5000))), zlib.crc32(r) >>> 0);
});

/* ---------------- 寫出 → 讀回 ---------------- */
test("write → read 往返（stored + deflate、UTF-8 中文檔名、順序、目錄項目）", async function () {
  var xml = '<?xml version="1.0"?><root>' + bigText(300) + "</root>";
  var bin = randomBytes(5000, 3);
  var entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' },
    { name: "word/document.xml", data: xml },
    { name: "中文資料夾/中文.xml", data: "<a>測試＜10 &amp; ND</a>" },
    { name: "media/image1.bin", data: bin },
    { name: "stored.txt", data: bigText(50), compress: false },
    { name: "empty.txt", data: "" },
    { name: "dir/", data: "" }
  ];
  var out = await Z.write(entries, { date: new Date(2026, 9, 8, 13, 45, 30) });
  var ind = verifyWithZlib(out);
  assert.deepStrictEqual(Object.keys(ind), entries.map(function (e) { return e.name; }));
  assert.strictEqual(ind["word/document.xml"].method, 8, "大文字檔應壓縮");
  assert.strictEqual(ind["stored.txt"].method, 0, "compress:false 應 stored");
  assert.strictEqual(ind["media/image1.bin"].method, 0, "不可壓縮資料改存 stored");
  var zip = await Z.read(out);
  assert.deepStrictEqual(zip.names, entries.map(function (e) { return e.name; }));
  assert.strictEqual(zip.names[0], "[Content_Types].xml");
  assert.strictEqual(await zip.text("word/document.xml"), xml);
  assert.strictEqual(await zip.text("中文資料夾/中文.xml"), "<a>測試＜10 &amp; ND</a>");
  assert.deepStrictEqual(await zip.get("media/image1.bin"), bin);
  assert.strictEqual(await zip.text("empty.txt"), "");
  assert.ok(zip.has("dir/"));
  assert.ok(zip.has("WORD/Document.XML"), "不分大小寫查找");
  assert.ok(zip.has("/word/document.xml"), "容忍開頭斜線");
  assert.strictEqual(zip.find("WORD\\DOCUMENT.xml"), "word/document.xml");
  assert.ok(!zip.has("word/nothing.xml"));
  var raw = zip.raw("word/document.xml");
  assert.strictEqual(raw.method, 8);
  assert.strictEqual(raw.size, ENC.encode(xml).length);
  assert.strictEqual(raw.crc, zlib.crc32(ENC.encode(xml)) >>> 0);
  assert.strictEqual(raw.csize, raw.data.length);
  // DOS 時間戳
  assert.strictEqual(raw.date, ((2026 - 1980) << 9) | (10 << 5) | 8);
  assert.strictEqual(raw.time, (13 << 11) | (45 << 5) | 15);
  // 讀回的 Uint8Array 不得與原始位元組共用（呼叫端改寫不能弄壞 zip）
  var s1 = await zip.get("stored.txt"); s1[0] = 0;
  assert.strictEqual((await zip.text("stored.txt")).slice(0, 4), "<w:p");
});

test("讀取 Node Buffer：stored 項目回傳獨立副本", async function () {
  var out = await Z.write([{ name: "s.txt", data: "stored-data-0123456789", compress: false }]);
  var buf = Buffer.from(out);
  var zip = await Z.read(buf);
  var a = await zip.get("s.txt"); a[0] = 0x58;
  assert.strictEqual(await zip.text("s.txt"), "stored-data-0123456789");
  assert.strictEqual(buf[zip.entries[0].dataStart], 0x73, "原 Buffer 未被改動");
  var ab = await Z.read(out.buffer);
  assert.strictEqual(await ab.text("s.txt"), "stored-data-0123456789", "ArrayBuffer 輸入");
});

test("write 預設時間戳、重複名稱與空名稱錯誤", async function () {
  var out = await Z.write([{ name: "a.txt", data: "x" }]);
  var zip = Z.readSync(out);
  assert.ok(zip.raw("a.txt").date > 0x21, "預設為現在時間");
  await rejectsZh(Z.write([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /重複/);
  await rejectsZh(Z.write([{ name: "", data: "1" }]), /名稱/);
});

test("空 ZIP 可寫可讀", async function () {
  var out = await Z.write([]);
  assert.strictEqual(out.length, 22);
  var zip = await Z.read(out);
  assert.deepStrictEqual(zip.names, []);
});

/* ---------------- 讀取各種外部寫法 ---------------- */
test("讀取：資料描述元（flag bit 3，本機檔頭大小為 0）", async function () {
  var a = bigText(200), b = "short";
  var bytes = handZip([
    { name: "a.xml", data: a, method: 8, descriptor: true },
    { name: "b.txt", data: b, method: 0, descriptor: true },
    { name: "c.xml", data: a + a, method: 8 }
  ]);
  var zip = await Z.read(bytes);
  assert.deepStrictEqual(zip.names, ["a.xml", "b.txt", "c.xml"]);
  assert.strictEqual(await zip.text("a.xml"), a);
  assert.strictEqual(await zip.text("b.txt"), b);
  assert.strictEqual(await zip.text("c.xml"), a + a);
  // 複製時清掉 bit 3（大小改寫在本機檔頭），內容不變
  var copy = await Z.copyWithChanges(zip, {});
  var ind = verifyWithZlib(copy);
  assert.strictEqual(DEC.decode(ind["a.xml"].data), a);
  var z2 = await Z.read(copy);
  assert.strictEqual(z2.raw("a.xml").flag & 8, 0);
});

test("讀取：未設 UTF-8 旗標的 UTF-8 / Big5 檔名、Info-ZIP Unicode 路徑", async function () {
  var big5 = new Uint8Array([0xA4, 0xA4, 0xA4, 0xE5, 0x2E, 0x74, 0x78, 0x74]); // 「中文.txt」Big5
  var uniName = ENC.encode("監測報告.pdf");
  var legacy = new Uint8Array([0x3F, 0x3F, 0x2E, 0x70, 0x64, 0x66]);              // "??.pdf"
  var up = cat([new Uint8Array(le16(0x7075)), new Uint8Array(le16(5 + uniName.length)), new Uint8Array([1]),
    new Uint8Array(le32(zlib.crc32(legacy) >>> 0)), uniName]);
  var bytes = handZip([
    { nameBytes: ENC.encode("報告/異味.xml"), data: "<x/>", method: 0 },
    { nameBytes: big5, data: "big5", method: 0 },
    { nameBytes: legacy, data: "pdf", method: 0, centralExtra: up },
    { name: "utf8flag/示範.txt", data: "ok", method: 8, utf8Flag: true }
  ]);
  var zip = await Z.read(bytes);
  assert.deepStrictEqual(zip.names, ["報告/異味.xml", "中文.txt", "監測報告.pdf", "utf8flag/示範.txt"]);
  assert.strictEqual(await zip.text("中文.txt"), "big5");
  assert.strictEqual(await zip.text("監測報告.pdf"), "pdf");
  // 複製時保留原檔名位元組
  var copy = await Z.copyWithChanges(zip, { "中文.txt": "changed" });
  var z2 = await Z.read(copy);
  assert.deepStrictEqual(z2.names, zip.names);
  assert.strictEqual(await z2.text("中文.txt"), "changed");
});

test("讀取：ZIP64 extra 欄位（中央目錄大小 0xFFFFFFFF）", async function () {
  var d = bigText(100);
  var bytes = handZip([{ name: "z64.xml", data: d, method: 8, zip64: true }, { name: "n.txt", data: "n", method: 0 }]);
  var zip = await Z.read(bytes);
  assert.strictEqual(zip.raw("z64.xml").size, ENC.encode(d).length);
  assert.strictEqual(await zip.text("z64.xml"), d);
  assert.strictEqual(await zip.text("n.txt"), "n");
});

test("讀取：前置資料（自解壓檔）與檔尾註解", async function () {
  var prefix = randomBytes(777, 9);
  var bytes = handZip([{ name: "a.txt", data: "hello 世界", method: 8 }, { name: "b.txt", data: "b", method: 0 }],
    { prefix: prefix, offsetsRelative: true, comment: "zip comment 註解" });
  var zip = await Z.read(bytes);
  assert.strictEqual(await zip.text("a.txt"), "hello 世界");
  assert.strictEqual(await zip.text("b.txt"), "b");
  assert.strictEqual(DEC.decode(zip.comment), "zip comment 註解");
  // 絕對位移（不需校正）的情形
  var bytes2 = handZip([{ name: "a.txt", data: "abs", method: 0 }], { prefix: prefix });
  assert.strictEqual(await (await Z.read(bytes2)).text("a.txt"), "abs");
});

test("讀取：EOCD 筆數欄位錯誤（只當參考，以簽章讀完整個目錄）", async function () {
  var items = [];
  for (var i = 0; i < 5; i++) items.push({ name: "f" + i + ".txt", data: "data" + i, method: i % 2 ? 8 : 0 });
  var bytes = handZip(items);
  var eocd = bytes.length - 22;
  var bad = bytes.slice(); bad.set(le16(3), eocd + 8); bad.set(le16(3), eocd + 10);   // 筆數寫成 3
  var zip = await Z.read(bad);
  assert.strictEqual(zip.names.length, 5);
  assert.strictEqual(await zip.text("f4.txt"), "data4");
  var bad2 = bytes.slice(); bad2.set(le16(9), eocd + 8); bad2.set(le16(9), eocd + 10);  // 筆數寫成 9
  var z2 = await Z.read(bad2);
  assert.strictEqual(z2.names.length, 5);
  assert.ok(z2.warnings.some(function (w) { return /不完整/.test(w); }));
});

test("讀取：UTF-8 BOM / UTF-16 BOM 文字", async function () {
  var u16 = new Uint8Array([0xFF, 0xFE, 0x41, 0, 0x2D, 0x4E]); // "A中"
  var out = await Z.write([
    { name: "bom.xml", data: cat([new Uint8Array([0xEF, 0xBB, 0xBF]), ENC.encode("<a/>")]) },
    { name: "u16.xml", data: u16 }
  ]);
  var zip = await Z.read(out);
  assert.strictEqual(await zip.text("bom.xml"), "<a/>");
  assert.strictEqual(await zip.text("u16.xml"), "A中");
});

/* ---------------- copyWithChanges ---------------- */
test("copyWithChanges：取代/新增/刪除；未變更項目原壓縮位元組逐位元相同", async function () {
  var orig = [
    { name: "[Content_Types].xml", data: "<Types>" + bigText(5) + "</Types>" },
    { name: "_rels/.rels", data: "<Relationships/>" + bigText(3) },
    { name: "word/document.xml", data: "<doc>" + bigText(500) + "</doc>" },
    { name: "word/styles.xml", data: "<styles>" + bigText(80) + "</styles>" },
    { name: "mimetype", data: "application/vnd.test", compress: false },
    { name: "docProps/core.xml", data: "<core/>" }
  ];
  var src = await Z.write(orig, { date: new Date(2020, 0, 2, 3, 4, 6) });
  var zip = await Z.read(src);
  var newDoc = "<doc>新內容 &lt;10</doc>" + bigText(20);
  var out = await Z.copyWithChanges(zip, {
    "word/document.xml": newDoc,
    "Word/Styles.xml": null,                       // 不分大小寫刪除
    "mimetype": ENC.encode("application/changed"), // stored 項目取代後仍 stored
    "customXml/item1.xml": "<new/>",
    "xl/notthere.xml": null                        // 刪除不存在者：忽略
  });
  verifyWithZlib(out);
  var z2 = await Z.read(out);
  assert.deepStrictEqual(z2.names, ["[Content_Types].xml", "_rels/.rels", "word/document.xml",
    "mimetype", "docProps/core.xml", "customXml/item1.xml"]);
  assert.strictEqual(await z2.text("word/document.xml"), newDoc);
  assert.strictEqual(await z2.text("mimetype"), "application/changed");
  assert.strictEqual(z2.raw("mimetype").method, 0);
  assert.strictEqual(await z2.text("customXml/item1.xml"), "<new/>");
  ["[Content_Types].xml", "_rels/.rels", "docProps/core.xml"].forEach(function (n) {
    var a = zip.raw(n), b = z2.raw(n);
    assert.deepStrictEqual(b.data, a.data, "原壓縮位元組相同 " + n);
    assert.strictEqual(b.crc, a.crc); assert.strictEqual(b.method, a.method);
    assert.strictEqual(b.time, a.time); assert.strictEqual(b.date, a.date);
  });
  // 取代的項目保留原時間戳
  assert.strictEqual(z2.raw("word/document.xml").date, zip.raw("word/document.xml").date);
  // 無變更複製 → 與原檔逐位元組相同（本模組寫出的檔）
  var same = await Z.copyWithChanges(zip, {});
  assert.deepStrictEqual(same, src);
});

test("copyWithChanges：外部 ZIP（含資料描述元）無變更複製後內容一致", async function () {
  var items = [];
  for (var i = 0; i < 30; i++) items.push({ name: "p/" + i + ".xml", data: bigText(i * 3 + 1), method: i % 3 ? 8 : 0, descriptor: i % 2 === 0 });
  var zip = await Z.read(handZip(items));
  var out = await Z.copyWithChanges(zip, {});
  var z2 = await Z.read(out);
  for (var j = 0; j < items.length; j++) {
    assert.strictEqual(await z2.text(items[j].name), items[j].data);
    assert.deepStrictEqual(z2.raw(items[j].name).data, zip.raw(items[j].name).data);
  }
});

/* ---------------- 錯誤處理 ---------------- */
test("非 ZIP / 空白 / OLE2 → 中文錯誤", async function () {
  await rejectsZh(Z.read(new Uint8Array(0)), /太小|空白/);
  await rejectsZh(Z.read(ENC.encode("這不是壓縮檔，只是一段很長很長的文字內容而已。".repeat(5))), /ZIP/);
  var ole = new Uint8Array(512); ole.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  await rejectsZh(Z.read(ole), /OLE2|舊版/);
  assert.ok(!Z.isZip(ole));
  assert.ok(Z.isZip(await Z.write([{ name: "a", data: "b" }])));
  assert.ok(Z.isZip(new Uint8Array([0x50, 0x4B, 5, 6])));
});

test("壓縮資料損毀 → CRC / 解壓縮中文錯誤", async function () {
  var d = bigText(400);
  var out = await Z.write([{ name: "a.xml", data: d }, { name: "s.txt", data: bigText(10), compress: false }]);
  var zip = Z.readSync(out);
  var r = zip.raw("a.xml"), off = r.data.byteOffset;
  var bad = out.slice(); for (var i = 20; i < 60; i++) bad[off + i] ^= 0x5A;
  await rejectsZh(Z.readSync(bad).text("a.xml"), /損毀|CRC/);
  // stored 項目內容被改 → CRC 錯誤
  var bad2 = out.slice(); bad2[zip.raw("s.txt").data.byteOffset + 3] ^= 1;
  await rejectsZh(Z.readSync(bad2).text("s.txt"), /CRC/);
  // checkCrc:false 可略過
  assert.ok((await Z.readSync(bad2, { checkCrc: false }).text("s.txt")).length > 0);
  // 找不到項目
  await rejectsZh(zip.get("nope.xml"), /找不到/);
  assert.throws(function () { zip.raw("nope.xml"); }, /找不到/);
});

test("截斷檔案（中央目錄遺失）→ 掃描本機檔頭救援 + 警告", async function () {
  var a = bigText(50), b = bigText(60);
  var full = handZip([{ name: "a.xml", data: a, method: 8 }, { name: "b.xml", data: b, method: 8, descriptor: true },
    { name: "c.xml", data: bigText(70), method: 8 }]);
  var zip = Z.readSync(full);
  var cOff = zip.entries[2].offset;
  var cut = full.slice(0, cOff + 40);          // c.xml 只剩一點點，中央目錄遺失
  var z2 = await Z.read(cut);
  assert.deepStrictEqual(z2.names, ["a.xml", "b.xml"]);
  assert.strictEqual(await z2.text("a.xml"), a);
  assert.strictEqual(await z2.text("b.xml"), b);
  assert.ok(z2.warnings.some(function (w) { return /中央目錄遺失/.test(w); }));
});

test("中央目錄指向的資料超出檔尾 → 讀該項目時中文錯誤，其他項目照常", async function () {
  var full = handZip([{ name: "a.txt", data: "aaa", method: 0 }, { name: "b.txt", data: "bbbb", method: 0 }]);
  // 把 b.txt 的中央目錄壓縮長度改成極大
  var zip = Z.readSync(full), cdPos = -1;
  for (var p = full.length - 22; p >= 0; p--) if (full[p] === 0x50 && full[p + 1] === 0x4B && full[p + 2] === 1 && full[p + 3] === 2 && full[p + 46] === 0x62) { cdPos = p; break; }
  assert.ok(cdPos > 0 && zip.has("b.txt"));
  var bad = full.slice(); bad.set(le32(999999), cdPos + 20);
  var z2 = Z.readSync(bad);
  assert.strictEqual(await z2.text("a.txt"), "aaa");
  await rejectsZh(z2.get("b.txt"), /不完整/);
  assert.ok(z2.warnings.length > 0);
});

test("不支援的壓縮方式 / 加密項目 → 中文錯誤", async function () {
  var bytes = handZip([{ name: "a.txt", data: "abc", method: 0 }]);
  var z = Z.readSync(bytes);
  // 改壓縮方式為 12 (bzip2)
  var bad = bytes.slice(); var cd = bytes.length - 22 - (46 + 5);
  bad.set(le16(12), cd + 10);
  await rejectsZh(Z.readSync(bad).get("a.txt"), /不支援的壓縮方式/);
  var enc = bytes.slice(); enc.set(le16(1), cd + 8);
  await rejectsZh(Z.readSync(enc).get("a.txt"), /加密/);
  assert.ok(z.has("a.txt"));
});

/* ---------------- 備援路徑 ---------------- */
test("無 CompressionStream / DecompressionStream：寫出改 stored；gzip 包裝與 SheetJS 備援", async function () {
  var CS = globalThis.CompressionStream, DS = globalThis.DecompressionStream;
  var d = bigText(300);
  try {
    // 1) 只支援 gzip（模擬舊 Safari）
    globalThis.CompressionStream = function (fmt) { if (fmt !== "gzip") throw new TypeError("unsupported"); return new CS(fmt); };
    globalThis.DecompressionStream = function (fmt) { if (fmt !== "gzip") throw new TypeError("unsupported"); return new DS(fmt); };
    var out = await Z.write([{ name: "a.xml", data: d }]);
    var ind = verifyWithZlib(out);
    assert.strictEqual(ind["a.xml"].method, 8, "gzip 包裝仍可壓縮");
    assert.strictEqual(await (await Z.read(out)).text("a.xml"), d);
    // 2) 完全不支援 → stored，讀取 deflate 項目時中文錯誤
    globalThis.CompressionStream = undefined; globalThis.DecompressionStream = undefined;
    var out2 = await Z.write([{ name: "a.xml", data: d }]);
    assert.strictEqual(verifyWithZlib(out2)["a.xml"].method, 0);
    assert.strictEqual(await (await Z.read(out2)).text("a.xml"), d);
    await rejectsZh((await Z.read(out)).text("a.xml"), /不支援解壓縮/);
    // 3) SheetJS 備援（若 lib/xlsx.full.min.js 存在）
    var xlsxPath = path.join(ROOT, "lib/xlsx.full.min.js");
    if (fs.existsSync(xlsxPath)) {
      globalThis.XLSX = require(xlsxPath);
      assert.strictEqual(await (await Z.read(out)).text("a.xml"), d, "SheetJS inflate 備援");
      var out3 = await Z.write([{ name: "b.xml", data: d }]);
      var i3 = verifyWithZlib(out3);
      assert.strictEqual(i3["b.xml"].method, 8, "SheetJS deflate 備援");
      delete globalThis.XLSX;
    }
  } finally {
    globalThis.CompressionStream = CS; globalThis.DecompressionStream = DS;
  }
});

/* ---------------- 效能 ---------------- */
test("效能：5 MB 文字寫出+讀回 < 2 s", async function () {
  var big = bigText(60000);
  var t0 = Date.now();
  var out = await Z.write([{ name: "big.xml", data: big }]);
  var txt = await (await Z.read(out)).text("big.xml");
  assert.strictEqual(txt.length, big.length);
  assert.ok(Date.now() - t0 < 2000, "耗時 " + (Date.now() - t0) + " ms");
});

/* ---------------- 真實樣本（存在才跑，不進 repo） ---------------- */
var REAL = path.join(ROOT, "test_data/fill/template.docx");
if (fs.existsSync(REAL)) {
  test("真實樣本 template.docx：讀取、CRC、無變更複製與改寫單一項目", async function () {
    var bytes = new Uint8Array(fs.readFileSync(REAL));
    var zip = await Z.read(bytes);
    assert.strictEqual(zip.names[0], "[Content_Types].xml");
    assert.ok(zip.has("word/document.xml"));
    for (var i = 0; i < zip.names.length; i++) await zip.get(zip.names[i]);   // 全部 CRC 通過
    var doc = await zip.text("word/document.xml");
    assert.ok(doc.indexOf("<w:body>") > 0);
    var out = await Z.copyWithChanges(zip, { "word/document.xml": doc.replace("115年", "115年") });
    var z2 = await Z.read(out);
    assert.deepStrictEqual(z2.names, zip.names);
    zip.names.forEach(function (n) {
      if (n !== "word/document.xml") assert.deepStrictEqual(z2.raw(n).data, zip.raw(n).data, n);
    });
    assert.strictEqual(await z2.text("word/document.xml"), doc);
    verifyWithZlib(out);
  });
}

run();
