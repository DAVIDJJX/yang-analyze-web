/* =========================================================================
 * Yang-analyze web — fill/xdw.js
 * DocuWorks 文件（.xdw / .xbd）讀取器（純邏輯、不碰 DOM，可在 Node 測試）。
 * 結構由實際樣本（DocuWorks 7、富士全錄複合機掃描）逆向而得：
 *   整個檔案是一串 BER-TLV 元素（tag 1 byte、長度短式 <0x80 或長式 0x8N + N bytes 大端序）。
 *   最上層 = [0x60] 檔頭 + 多個 [0x61] 區塊（只增不改的「修訂」），區塊內含
 *   [0x64] 物件（0x81 物件 ID + 0x82 內容）、[0x63] 壓縮/加密目錄（略過）、[0x65] 物件位移索引。
 *   物件內容又是 TLV 串列：0x80 類型碼（9 = CCITT G4 二值頁影像、7 = Windows DIB 低解析背景層）、
 *   0x84/0x85 實體尺寸（1/100 mm）、0x87/0x88 像素寬高、0x8b/0x8c 解析度（dots/m）、0x89 資料長度、0x86 影像資料。
 * 解析採通用且防禦式的遞迴走訪：影像種類先看魔術數字（JPEG/PNG/TIFF/BMP/DIB），否則看類型碼；
 * 全解析度主影像各成一頁，低解析圖層附屬於所屬頁。parse() 對任何垃圾輸入都不拋例外。
 * 頁面影像按需解碼（decode()），不快取，以節省記憶體。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var MAX_DEPTH = 6;          // 遞迴走訪深度上限
  var PRIMARY_MIN = 600;      // 長邊 ≥ 600 px 的影像視為「頁面主影像」
  var TAG_HEADER = 0x60, TAG_DIR = 0x63, TAG_INDEX = 0x65;
  var KIND_LABEL = { g4: "掃描影像 G4", jpeg: "JPEG 影像", png: "PNG 影像", tiff: "TIFF 影像", bmp: "點陣圖", dib: "點陣圖",
    gif: "GIF 影像", webp: "WebP 影像", jp2: "JPEG 2000 影像", unknown: "未知格式影像" };
  var KIND_MIME = { g4: "image/x-ccitt-g4", jpeg: "image/jpeg", png: "image/png", tiff: "image/tiff", bmp: "image/bmp", dib: "image/bmp",
    gif: "image/gif", webp: "image/webp", jp2: "image/jp2" };
  var ASYNC_KINDS = { jpeg: 1, png: 1, bmp: 1, dib: 1, tiff: 1, gif: 1, webp: 1, jp2: 1, unknown: 1 };
  var PDF_HINT = "請在 DocuWorks Desk 開啟 →「檔案 → 匯出 / 另存為 PDF」（或用 DocuWorks PDF 印表機）後上傳 PDF。";

  function asBytes(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return new Uint8Array(0);
  }
  function hex(n) { return "0x" + n.toString(16).toUpperCase(); }

  /* ---------------- BER-TLV ---------------- */
  // 讀位置 i 的 TLV 標頭；長度欄位本身越界 → null。值區可能超出 end（由呼叫端判斷）。
  function tlvAt(b, i, end) {
    if (i + 2 > end) return null;
    var tag = b[i], l = b[i + 1], vs = i + 2, len;
    if (l < 0x80) len = l;
    else {
      var k = l & 0x7F;
      if (k === 0 || k > 4 || vs + k > end) return null;   // 不定長度 / 過長長度欄位
      len = 0;
      for (var q = 0; q < k; q++) len = len * 256 + b[vs + q];
      vs += k;
    }
    return { tag: tag, start: i, vs: vs, len: len, ve: vs + len, cons: (tag & 0x20) !== 0 };
  }
  // TLV 串列：ok = 剛好填滿 [s, e)；partial = 最後一個超出範圍（被截斷）的元素
  function tlvList(b, s, e, maxItems) {
    var items = [], i = s, t;
    while (i < e) {
      t = tlvAt(b, i, e);
      if (!t || t.ve > e) return { items: items, end: i, ok: false, partial: t && t.ve > e ? t : null };
      items.push(t);
      i = t.ve;
      if (items.length > maxItems) return { items: items, end: i, ok: false, partial: null };
    }
    return { items: items, end: i, ok: true, partial: null };
  }
  function uintAt(b, t) {
    if (!t || t.cons || t.len > 4) return null;
    var v = 0;
    for (var i = 0; i < t.len; i++) v = v * 256 + b[t.vs + i];
    return v;
  }
  function hexAt(b, t) {
    var s = "";
    for (var i = t.vs; i < t.ve && i < t.vs + 16; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  /* ---------------- 格式判斷 ---------------- */
  function isLegacy(b) {
    return b.length >= 4 && b[0] === 0x25 && b[1] === 0x58 && b[2] === 0x44 && b[3] === 0x57;   // "%XDW"
  }
  // 結構檢查：首元素為 [0x60] 檔頭、最上層全是建構式 TLV 且剛好鋪滿檔案（容許 ≤ 16 bytes 尾巴）。
  // allowCut：最後一個元素被截斷（檔案下載不完整）也算（回傳 "cut"）
  function structOk(b, allowCut) {
    if (b.length < 32 || b[0] !== TAG_HEADER) return false;
    var i = 0, n = 0, L = b.length, t;
    while (i < L) {
      t = tlvAt(b, i, L);
      if (!t || !t.cons) break;
      if (t.ve > L) {
        return allowCut && n >= 2 && t.tag === 0x61 ? "cut" : false;
      }
      if (n === 0) {
        if (t.len < 4 || t.len > 64 || !tlvList(b, t.vs, t.ve, 32).ok) return false;
      }
      i = t.ve;
      if (++n > 200000) return false;
    }
    return n >= 2 && L - i <= 16;
  }
  /** 是否為 DocuWorks 文件（結構檢查；舊版 "%XDW" 檔頭與尾端被截斷的檔案也回傳 true，由 parse 回報問題） */
  function isXdw(bytes) {
    var b = asBytes(bytes);
    return isLegacy(b) || !!structOk(b, true);
  }

  /* ---------------- 影像魔術數字辨識 ---------------- */
  function u16be(d, i) { return (d[i] << 8) | d[i + 1]; }
  function u32be(d, i) { return ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3]; }
  function u16le(d, i) { return d[i] | (d[i + 1] << 8); }
  function u32le(d, i) { return (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0; }
  function i32le(d, i) { return d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24); }

  // JPEG：FF D8 FF + 合法區段鏈直到 SOF（取得寬高）
  function sniffJpeg(d, s, e) {
    if (e - s < 4 || d[s] !== 0xFF || d[s + 1] !== 0xD8 || d[s + 2] !== 0xFF) return null;
    var i = s + 2, segs = 0;
    while (i + 4 <= e && segs++ < 400) {
      if (d[i] !== 0xFF) return null;
      while (i < e && d[i] === 0xFF) i++;        // 填充 FF
      if (i >= e) return null;
      var m = d[i++];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;
      if (m === 0xD9 || m === 0x00) return null;
      if (i + 2 > e) return null;
      var len = u16be(d, i);
      if (len < 2 || i + len > e) return null;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        if (len < 8) return null;
        var h = u16be(d, i + 3), w = u16be(d, i + 5), comps = d[i + 7];
        if (!w || comps < 1 || comps > 4) return null;
        return { kind: "jpeg", width: w, height: h, components: comps };
      }
      if (m === 0xDA) return { kind: "jpeg", width: 0, height: 0 };   // SOS 前沒有 SOF：結構怪但仍是 JPEG
      i += len;
    }
    return null;
  }
  function sniffImage(d, s, e) {
    var n = e - s;
    if (n < 8) return null;
    if (d[s] === 0xFF && d[s + 1] === 0xD8) return sniffJpeg(d, s, e);
    if (d[s] === 0x89 && d[s + 1] === 0x50 && d[s + 2] === 0x4E && d[s + 3] === 0x47 && d[s + 4] === 0x0D &&
        d[s + 5] === 0x0A && d[s + 6] === 0x1A && d[s + 7] === 0x0A) {
      if (n >= 24 && d[s + 12] === 0x49 && d[s + 13] === 0x48 && d[s + 14] === 0x44 && d[s + 15] === 0x52) {
        return { kind: "png", width: u32be(d, s + 16), height: u32be(d, s + 20) };
      }
      return null;
    }
    if ((d[s] === 0x49 && d[s + 1] === 0x49 && d[s + 2] === 0x2A && d[s + 3] === 0) ||
        (d[s] === 0x4D && d[s + 1] === 0x4D && d[s + 2] === 0 && d[s + 3] === 0x2A)) {
      var ti = null;
      if (YF.ccitt && YF.ccitt.tiffInfo) {
        try { ti = YF.ccitt.tiffInfo(d.subarray(s, e))[0] || null; } catch (err) { ti = null; }
      }
      return { kind: "tiff", width: ti ? ti.width : 0, height: ti ? ti.height : 0, bitCount: ti ? ti.bitsPerSample : 0 };
    }
    if (d[s] === 0x42 && d[s + 1] === 0x4D && n >= 30) {             // "BM"
      var fsz = u32le(d, s + 2), hs = u32le(d, s + 14);
      if ((hs === 12 || hs === 40 || hs === 52 || hs === 56 || hs === 108 || hs === 124) && fsz >= 26 && fsz <= n + 64) {
        var dib = dibHeader(d, s + 14, e);
        if (dib) { dib.kind = "bmp"; return dib; }
      }
      return null;
    }
    if (d[s + 1] === 0 && d[s + 2] === 0 && d[s + 3] === 0 && (d[s] === 40 || d[s] === 108 || d[s] === 124)) {
      var dh = dibHeader(d, s, e);
      if (dh) { dh.kind = "dib"; return dh; }
    }
    // GIF87a / GIF89a
    if (d[s] === 0x47 && d[s + 1] === 0x49 && d[s + 2] === 0x46 && d[s + 3] === 0x38 && (d[s + 4] === 0x37 || d[s + 4] === 0x39) && d[s + 5] === 0x61 && n >= 10) {
      return { kind: "gif", width: u16le(d, s + 6), height: u16le(d, s + 8) };
    }
    // WebP：RIFF....WEBP
    if (n >= 30 && d[s] === 0x52 && d[s + 1] === 0x49 && d[s + 2] === 0x46 && d[s + 3] === 0x46 &&
        d[s + 8] === 0x57 && d[s + 9] === 0x45 && d[s + 10] === 0x42 && d[s + 11] === 0x50) {
      var c4 = String.fromCharCode(d[s + 12], d[s + 13], d[s + 14], d[s + 15]), ww = 0, hh = 0;
      if (c4 === "VP8 ") { ww = u16le(d, s + 26) & 0x3FFF; hh = u16le(d, s + 28) & 0x3FFF; }
      else if (c4 === "VP8L") { var v = u32le(d, s + 21); ww = (v & 0x3FFF) + 1; hh = ((v >>> 14) & 0x3FFF) + 1; }
      else if (c4 === "VP8X") { ww = 1 + (d[s + 24] | (d[s + 25] << 8) | (d[s + 26] << 16)); hh = 1 + (d[s + 27] | (d[s + 28] << 8) | (d[s + 29] << 16)); }
      return { kind: "webp", width: ww, height: hh };
    }
    // JPEG 2000：JP2 檔（ihdr 盒）或裸碼流（SOC + SIZ）
    if (n >= 12 && d[s] === 0 && d[s + 1] === 0 && d[s + 2] === 0 && d[s + 3] === 0x0C && d[s + 4] === 0x6A && d[s + 5] === 0x50 &&
        d[s + 6] === 0x20 && d[s + 7] === 0x20) {
      for (var q = s + 12; q + 12 <= Math.min(e, s + 4096); q++) {
        if (d[q] === 0x69 && d[q + 1] === 0x68 && d[q + 2] === 0x64 && d[q + 3] === 0x72) return { kind: "jp2", width: u32be(d, q + 8), height: u32be(d, q + 4) };
      }
      return { kind: "jp2", width: 0, height: 0 };
    }
    if (n >= 24 && d[s] === 0xFF && d[s + 1] === 0x4F && d[s + 2] === 0xFF && d[s + 3] === 0x51) {
      return { kind: "jp2", width: u32be(d, s + 8) - u32be(d, s + 16), height: u32be(d, s + 12) - u32be(d, s + 20) };
    }
    return null;
  }
  function dibHeader(d, h, e) {
    if (h + 16 > e) return null;
    var size = u32le(d, h), w, ht, planes, bpp, comp = 0, clr = 0;
    if (size === 12) { w = u16le(d, h + 4); ht = u16le(d, h + 6); planes = u16le(d, h + 8); bpp = u16le(d, h + 10); }
    else {
      if (size < 40 || h + 40 > e) return null;
      w = i32le(d, h + 4); ht = i32le(d, h + 8); planes = u16le(d, h + 12); bpp = u16le(d, h + 14);
      comp = u32le(d, h + 16); clr = u32le(d, h + 32);
    }
    if (planes !== 1 || [1, 4, 8, 16, 24, 32].indexOf(bpp) < 0 || w <= 0 || w > 65535 || !ht || Math.abs(ht) > 65535) return null;
    return { width: w, height: Math.abs(ht), topDown: ht < 0, bitCount: bpp, compression: comp, headerSize: size, colorsUsed: clr };
  }

  /* ---------------- 主解析 ---------------- */
  function newCtx(b) {
    return { b: b, objects: [], indexes: [], scopes: [{ base: 0 }], broken: [], resynced: [], nested: 0, header: null, steps: 0 };
  }
  function readHeader(ctx, t) {
    var b = ctx.b, L = tlvList(b, t.vs, t.ve, 32);
    var h = { version: null };
    L.items.forEach(function (x) { if (x.tag === 0x82 && x.len <= 2) h.version = uintAt(b, x); });
    return h;
  }
  function readIndex(ctx, t, scope) {
    var b = ctx.b, L = tlvList(b, t.vs, t.ve, 64);
    if (!L.ok) return;
    var idx = { scope: scope, count: null, offsets: null, at: t.start };
    L.items.forEach(function (x) {
      if (x.tag === 0x80 && x.len <= 4) idx.count = uintAt(b, x);
      else if (x.tag === 0x81 && !x.cons && x.len % 4 === 0) {
        idx.offsets = [];
        for (var i = x.vs; i < x.ve; i += 4) idx.offsets.push(u32le(b, i));
      }
    });
    if (idx.offsets) ctx.indexes.push(idx);
  }
  // 嘗試把一個建構式元素解讀成「影像物件」：子元素含 0x82 內容，內容 TLV 串列含 0x86 影像資料
  function tryObject(ctx, t, scope, block) {
    var b = ctx.b, kids = tlvList(b, t.vs, t.ve, 64), cut = !!t.cut;
    var id = null, payload = null, i, x, items = kids.items.slice();
    // 被截斷的物件：最後一個（不完整的）內容元素也拿來用
    if (!kids.ok) {
      if (!cut || !kids.partial || (kids.partial.tag & 0xDF) !== 0x82) return false;
      items.push(kids.partial);
    }
    if (!items.length) return false;
    for (i = 0; i < items.length; i++) {
      x = items[i];
      if (x.tag === 0x81 && !x.cons && x.len > 0 && x.len <= 16 && id === null) id = hexAt(b, x);
      else if ((x.tag & 0xDF) === 0x82 && !payload) payload = x;
    }
    if (!payload) return false;
    if (payload.ve > t.ve) { payload = { tag: payload.tag, start: payload.start, vs: payload.vs, ve: t.ve, len: t.ve - payload.vs, cons: payload.cons, cut: true }; cut = true; }
    var f = tlvList(b, payload.vs, payload.ve, 64);
    if (!f.ok && !(f.partial && f.partial.tag === 0x86)) return false;
    var fields = {};
    f.items.forEach(function (y) { if (!fields[y.tag]) fields[y.tag] = y; });
    if (f.partial && !fields[0x86]) fields[0x86] = f.partial;
    var dat = fields[0x86];
    if (!dat || dat.cons) return false;
    var dEnd = Math.min(dat.ve, payload.ve);
    var o = {
      seq: ctx.objects.length, scope: scope, block: block, id: id, start: t.start,
      relStart: t.start - ctx.scopes[scope].base,
      code: uintAt(b, fields[0x80]), headerBytes: uintAt(b, fields[0x81]),
      physW: uintAt(b, fields[0x84]), physH: uintAt(b, fields[0x85]),
      pxW: uintAt(b, fields[0x87]), pxH: uintAt(b, fields[0x88]),
      dpmX: uintAt(b, fields[0x8b]), dpmY: uintAt(b, fields[0x8c]),
      declared: uintAt(b, fields[0x89]),
      offset: dat.vs, length: dEnd - dat.vs, truncated: cut || dat.ve > payload.ve || f.partial === dat
    };
    if (o.declared !== null && o.declared > o.length) o.truncated = true;
    var sn = sniffImage(b, o.offset, o.offset + o.length);
    // 類型碼 9 = G4：只有強魔術數字（JPEG/PNG/TIFF/GIF/WebP/JP2）才覆蓋類型碼
    if (sn && o.code === 9 && (sn.kind === "dib" || sn.kind === "bmp")) sn = null;
    if (sn && !sn.width && (o.pxW || o.pxH)) { sn.width = o.pxW || 0; sn.height = o.pxH || 0; }
    if (sn) {
      o.kind = sn.kind; o.width = sn.width; o.height = sn.height; o.bitCount = sn.bitCount || null;
      o.dibCompression = sn.compression || 0;
      o.dibHeaderSize = sn.headerSize || 0; o.colorsUsed = sn.colorsUsed || 0; o.topDown = !!sn.topDown;
    } else if (o.code === 9) {
      o.kind = "g4"; o.width = o.pxW || 0; o.height = o.pxH || 0;
      if ((!o.width || !o.height) && o.physW && o.physH && o.dpmX && o.dpmY) {
        o.width = Math.round(o.physW / 100000 * o.dpmX);
        o.height = Math.round(o.physH / 100000 * o.dpmY);
      }
    } else {
      o.kind = "unknown"; o.width = o.pxW || 0; o.height = o.pxH || 0;
    }
    ctx.objects.push(o);
    return true;
  }
  // 最上層結構損毀時，往後找下一個看起來完整的 [0x61] 區塊（內容以物件 / 目錄 / 索引開頭且能完整解析）
  function resyncTop(b, from, e) {
    for (var q = from; q + 2 < e; q++) {
      if (b[q] !== 0x61) continue;
      var t = tlvAt(b, q, e);
      if (!t || t.len < 4) continue;
      var c = b[t.vs];
      if (c !== 0x64 && c !== 0x63 && c !== 0x65) continue;
      if (t.ve <= e) { if (tlvList(b, t.vs, t.ve, 100000).ok) return q; }
      else {
        var L = tlvList(b, t.vs, e, 100000);       // 檔尾被截斷的最後一個區塊
        if (L.items.length && L.items[0].tag === 0x64) return q;
      }
    }
    return -1;
  }
  // 逐一走訪 [s, e) 內的 TLV（不建立清單，壞檔中大量的空元素也不會吃記憶體）
  function walk(ctx, s, e, depth, scope, block) {
    var b = ctx.b, p = s, i = 0, t, q;
    while (p < e) {
      t = tlvAt(b, p, e);
      if (!t || (t.ve > e && !t.cons) || (depth === 0 && i > 0 && t.tag !== 0x61 && e - p > 16)) {
        ctx.broken.push({ at: p, depth: depth });
        // 最上層：跳過損毀處，從下一個完整區塊繼續
        if (depth === 0 && ctx.resynced.length < 1000 && (q = resyncTop(b, p + 1, e)) > p) {
          ctx.resynced.push({ from: p, to: q });
          p = q;
          continue;
        }
        break;
      }
      if (t.ve > e) {
        ctx.broken.push({ at: p, depth: depth });
        // 被截斷的最後一個元素：仍盡量讀取其中完整的部分
        t = { tag: t.tag, start: t.start, vs: t.vs, ve: e, len: e - t.vs, cons: true, cut: true };
      }
      p = t.ve;
      walkItem(ctx, t, i++, depth, scope, block);
      if (ctx.steps++ > 20000000) { ctx.broken.push({ at: p, depth: depth }); break; }   // 防呆上限
    }
  }
  function walkItem(ctx, t, i, depth, scope, block) {
    var b = ctx.b;
    if (depth === 0 && t.tag === TAG_HEADER && i === 0) {
      if (!ctx.header) ctx.header = readHeader(ctx, t);
      return;
    }
    if (t.tag === TAG_DIR) return;                      // 壓縮 / 加密目錄：略過
    if (t.tag === TAG_INDEX) { readIndex(ctx, t, scope); return; }
    if (t.cons) {
      if (tryObject(ctx, t, scope, block)) return;
      if (depth < MAX_DEPTH) walk(ctx, t.vs, t.ve, depth + 1, scope, depth === 0 ? i : block);
    } else if (t.len >= 64 && b[t.vs] === TAG_HEADER && depth < MAX_DEPTH && ctx.nested < 64) {
      // 內嵌的 DocuWorks 文件（例如 Binder 內的文件）
      var sub = b.subarray(t.vs, t.ve);
      if (structOk(sub)) {
        ctx.nested++;
        ctx.scopes.push({ base: t.vs });
        walk(ctx, t.vs, t.ve, depth + 1, ctx.scopes.length - 1, block);
      }
    }
  }

  /* ---------------- 沒有結構時的備援：掃描內嵌 JPEG / PNG ---------------- */
  function jpegEnd(d, s, e) {
    var i = s + 2, segs = 0;
    while (i + 4 <= e && segs++ < 2000) {
      if (d[i] !== 0xFF) return -1;
      while (i < e && d[i] === 0xFF) i++;
      var m = d[i++];
      if (m === 0xD9) return i;
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;
      var len = u16be(d, i);
      if (len < 2) return -1;
      i += len;
      if (m === 0xDA) {
        // 熵編碼資料：找下一個非 00 / RSTn 的標記
        while (i + 1 < e) {
          if (d[i] === 0xFF && d[i + 1] !== 0 && !(d[i + 1] >= 0xD0 && d[i + 1] <= 0xD7) && d[i + 1] !== 0xFF) break;
          i++;
        }
      }
    }
    return -1;
  }
  function pngEnd(d, s, e) {
    var i = s + 8, n = 0;
    while (i + 12 <= e && n++ < 100000) {
      var len = u32be(d, i);
      if (len > e - i) return -1;
      if (d[i + 4] === 0x49 && d[i + 5] === 0x45 && d[i + 6] === 0x4E && d[i + 7] === 0x44) return i + 12 + len;
      i += 12 + len;
    }
    return -1;
  }
  function scanImages(ctx) {
    var d = ctx.b, e = d.length, i, found = 0, end, sn;
    for (i = 0; i + 8 < e && found < 2000; i++) {
      if (d[i] === 0xFF && d[i + 1] === 0xD8 && d[i + 2] === 0xFF) {
        sn = sniffJpeg(d, i, e);
        if (!sn || !sn.width) continue;
        end = jpegEnd(d, i, e);
        if (end < 0) continue;
      } else if (d[i] === 0x89 && d[i + 1] === 0x50 && d[i + 2] === 0x4E && d[i + 3] === 0x47) {
        sn = sniffImage(d, i, e);
        if (!sn) continue;
        end = pngEnd(d, i, e);
        if (end < 0) continue;
      } else continue;
      ctx.objects.push({ seq: ctx.objects.length, scope: 0, block: -1, id: null, start: i, relStart: i, code: null,
        physW: null, physH: null, dpmX: null, dpmY: null, offset: i, length: end - i, truncated: false,
        kind: sn.kind, width: sn.width, height: sn.height, scanned: true });
      found++;
      i = end - 1;
    }
    return found;
  }

  /* ---------------- 頁面組裝 ---------------- */
  function dpiOf(dpm) { return dpm ? Math.round(dpm * 0.0254 * 10) / 10 : null; }
  function longSide(o) { return Math.max(o.width || 0, o.height || 0); }
  function canBePrimary(o) {
    if (longSide(o) < PRIMARY_MIN) return false;
    if (o.kind === "g4" || o.kind === "jpeg" || o.kind === "png" || o.kind === "tiff" || o.kind === "gif" ||
        o.kind === "webp" || o.kind === "jp2") return true;
    if (o.kind === "dib" || o.kind === "bmp") return o.dibCompression === 0 && !o.truncated && dibDataOk(o);
    // 未知類型碼但帶有完整的像素尺寸與實體尺寸：很像頁面 → 仍算一頁（無法解碼，但頁碼不會錯位）
    if (o.kind === "unknown") return !!(o.pxW && o.pxH && o.physW && o.physH);
    return false;
  }
  function dibDataOk(o) {
    var stride = ((o.width * o.bitCount + 31) >> 5) * 4;
    return o.length >= stride * o.height;
  }
  function samePhys(a, b) {
    if (!a.physW || !a.physH || !b.physW || !b.physH) return false;
    return Math.abs(a.physW - b.physW) <= a.physW * 0.01 && Math.abs(a.physH - b.physH) <= a.physH * 0.01;
  }
  function layerInfo(o) {
    return { kind: o.kind, mime: KIND_MIME[o.kind] || "application/octet-stream", id: o.id, code: o.code,
      offset: o.offset, length: o.length, width: o.width || 0, height: o.height || 0, bitCount: o.bitCount || null,
      dpiX: dpiOf(o.dpmX), dpiY: dpiOf(o.dpmY) };
  }

  // 依物件索引（0x65 的位移清單）找出「目前有效」的物件；索引與物件對不上時不過濾
  function liveFilter(ctx) {
    var live = {}, any = false;
    for (var s = 0; s < ctx.scopes.length; s++) {
      var last = null;
      ctx.indexes.forEach(function (ix) { if (ix.scope === s) last = ix; });
      var objs = ctx.objects.filter(function (o) { return o.scope === s; });
      if (!last || !objs.length) { objs.forEach(function (o) { live[o.seq] = 1; }); continue; }
      var byRel = {};
      objs.forEach(function (o) { byRel[o.relStart] = o; });
      var ok = last.offsets.length > 0 && (last.count === null || last.count === last.offsets.length) &&
        last.offsets.every(function (off) { return !!byRel[off]; });
      if (!ok) { objs.forEach(function (o) { live[o.seq] = 1; }); continue; }
      last.offsets.forEach(function (off) { live[byRel[off].seq] = 1; });
      // 索引之後才寫入的物件（例如最後一個區塊的索引被截斷）比索引新，一律保留
      objs.forEach(function (o) { if (o.start > last.at) live[o.seq] = 1; });
      any = true;
    }
    return { live: live, used: any };
  }

  function buildPages(ctx, res) {
    var b = ctx.b, lf = liveFilter(ctx), pages = [], pending = [], stale = 0, i, o;
    var idCount = {}, idFirstPage = {};
    var lastPrimarySeq = -1;
    for (i = 0; i < ctx.objects.length; i++) {
      o = ctx.objects[i];
      if (!lf.live[o.seq]) { o.role = "stale"; stale++; continue; }
      if (!canBePrimary(o)) {
        o.role = o.kind === "unknown" ? "unknown" : "layer";
        if (o.kind === "unknown") { res._unknownSkipped[String(o.code)] = (res._unknownSkipped[String(o.code)] || 0) + 1; continue; }
        if (pages.length) pages[pages.length - 1].layers.push(layerInfo(o));
        else pending.push(layerInfo(o));
        continue;
      }
      var prev = pages.length ? pages[pages.length - 1] : null;
      // MRC（文字層 + 低解析背景層）：同區塊、相鄰、實體尺寸相同、種類不同、解析度差很多 → 合併為同一頁
      if (prev && prev._seq === lastPrimarySeq && prev._obj.block === o.block && o.block >= 0 &&
          samePhys(prev._obj, o) && prev._obj.kind !== o.kind) {
        var r = longSide(o) / longSide(prev._obj);
        if (r <= 0.6 || r >= 1 / 0.6) {
          if (r <= 0.6) { prev.layers.push(layerInfo(o)); o.role = "layer"; }
          else {
            // 新物件解析度高得多：改以它為主影像，舊主影像降為圖層
            prev.layers.push(layerInfo(prev._obj));
            prev._obj.role = "layer";
            setPrimary(prev, o, b);
            o.role = "page";
          }
          lastPrimarySeq = o.seq;
          continue;
        }
      }
      var pg = makePage(pages.length, o, b);
      pending.forEach(function (l) { pg.layers.push(l); });
      pending = [];
      o.role = "page";
      if (o.id) {
        idCount[o.id] = (idCount[o.id] || 0) + 1;
        if (idFirstPage[o.id] === undefined) idFirstPage[o.id] = pg.index;
        else pg.duplicateOf = idFirstPage[o.id];
      }
      pages.push(pg);
      lastPrimarySeq = o.seq;
    }
    if (pending.length && pages.length) pending.forEach(function (l) { pages[pages.length - 1].layers.push(l); });
    var dups = Object.keys(idCount).filter(function (k) { return idCount[k] > 1; }).length;
    if (stale) res.warnings.push("有 " + stale + " 個影像物件不在最新的物件索引中（可能是已刪除或被取代的舊版本），已略過。");
    if (dups) res.warnings.push("有 " + dups + " 個物件 ID 重複出現（可能是修訂版本），頁序以檔案順序為準，請核對頁數與內容。");
    pages.forEach(function (p) {
      delete p._seq;
      Object.defineProperty(p, "_obj", { enumerable: false, value: p._obj });
    });
    return pages;
  }

  function setPrimary(pg, o, b) {
    pg._obj = o; pg._seq = o.seq;
    pg.width = o.width || 0; pg.height = o.height || 0;
    pg.widthMm = o.physW ? o.physW / 100 : null;
    pg.heightMm = o.physH ? o.physH / 100 : null;
    var dx = dpiOf(o.dpmX), dy = dpiOf(o.dpmY);
    if (!dx && pg.widthMm && pg.width) dx = Math.round(pg.width / (pg.widthMm / 25.4) * 10) / 10;
    if (!dy && pg.heightMm && pg.height) dy = Math.round(pg.height / (pg.heightMm / 25.4) * 10) / 10;
    pg.dpiX = dx || null; pg.dpiY = dy || dx || null; if (!pg.dpiX) pg.dpiX = pg.dpiY;
    pg.dpi = pg.dpiX || pg.dpiY || null;
    if (!pg.widthMm && pg.dpiX && pg.width) pg.widthMm = Math.round(pg.width / pg.dpiX * 254) / 10;
    if (!pg.heightMm && pg.dpiY && pg.height) pg.heightMm = Math.round(pg.height / pg.dpiY * 254) / 10;
    pg.kind = o.kind;
    pg.primary = { kind: o.kind, mime: KIND_MIME[o.kind] || "application/octet-stream", id: o.id, code: o.code,
      offset: o.offset, length: o.length, objectOffset: o.start, truncated: !!o.truncated, scanned: !!o.scanned };
  }

  function makePage(index, o, b) {
    var pg = { index: index, width: 0, height: 0, dpiX: null, dpiY: null, dpi: null, widthMm: null, heightMm: null,
      kind: null, primary: null, layers: [], duplicateOf: null, warnings: [] };
    setPrimary(pg, o, b);
    /** 主影像原始位元組（subarray，不複製） */
    pg.imageBytes = function () { var p = pg.primary; return b.subarray(p.offset, p.offset + p.length); };
    /** 同步解碼為 Bitmap（G4 / 二值 TIFF / 未壓縮 DIB）；JPEG / PNG 回傳 null，請用 decodeAsync */
    pg.decode = function () { return decodeSync(pg, b); };
    /** 非同步解碼：JPEG / PNG / BMP 透過 YF.raster.decodeImageBytes + binarize */
    pg.decodeAsync = function () {
      var bm;
      try { bm = decodeSync(pg, b); } catch (e) { return Promise.resolve(null); }
      if (bm) return Promise.resolve(bm);
      var k = pg.primary.kind;
      if (!ASYNC_KINDS[k]) return Promise.resolve(null);
      var R = YF.raster;
      if (!R || !R.decodeImageBytes || !R.binarize) {
        addWarn(pg, "第 " + (pg.index + 1) + " 頁為 " + (KIND_LABEL[k] || k) + "，需要影像解碼模組（raster.js）才能讀取。");
        return Promise.resolve(null);
      }
      var bytes = pg.imageBytes(), mime = pg.primary.mime;
      if (k === "dib") { bytes = dibToBmp(bytes, pg._obj); mime = "image/bmp"; }
      return Promise.resolve().then(function () { return R.decodeImageBytes(bytes, mime); }).then(function (img) {
        if (!img || !img.data) return null;
        var bin = R.binarize(img.data, img.width, img.height);
        if (bin) {
          // raster 可能為了記憶體把大圖縮小（img.scale < 1）：解析度跟著換算
          var sc = img.scale > 0 ? img.scale : 1;
          bin.dpi = pg.dpi ? Math.round(pg.dpi * sc * 10) / 10 : null;
          bin.dpiX = pg.dpiX ? Math.round(pg.dpiX * sc * 10) / 10 : null;
          bin.dpiY = pg.dpiY ? Math.round(pg.dpiY * sc * 10) / 10 : null;
        }
        return bin;
      }).catch(function (e) {
        addWarn(pg, "第 " + (pg.index + 1) + " 頁影像解碼失敗：" + (e && e.message ? e.message : e));
        return null;
      });
    };
    return pg;
  }

  /* ---------------- 解碼 ---------------- */
  function addWarn(pg, w) { if (pg.warnings.indexOf(w) < 0) pg.warnings.push(w); }
  // G4 解碼；若一開始就遇到無效編碼（不是截斷），再試「位元反轉（FillOrder 2）」與「每列位元組對齊」，
  // 替代解法必須完整無誤地解出整頁才採用（避免把雜訊當成影像）
  function smartG4(data, w, h, ws) {
    var first = { warnings: [] }, px = YF.ccitt.decodeG4(data, w, h, first);
    var best = { px: px, rows: first.rowsDecoded, ws: first.warnings, how: "" };
    if (first.rowsDecoded < Math.min(32, h) && first.error && first.error !== "truncated") {
      var alts = [["rev", YF.ccitt.reverseBits(data), false], ["align", data, true]];
      for (var i = 0; i < alts.length; i++) {
        var o = { warnings: [], byteAlign: alts[i][2] }, q = YF.ccitt.decodeG4(alts[i][1], w, h, o);
        if (o.rowsDecoded >= h && !o.error && !o.warnings.length) { best = { px: q, rows: o.rowsDecoded, ws: [], how: alts[i][0] }; break; }
      }
    }
    best.ws.forEach(function (x) { ws.push(x); });
    return best;
  }
  function decodeSync(pg, b) {
    var p = pg.primary, o = pg._obj, data = b.subarray(p.offset, p.offset + p.length), ws = [], bm = null;
    var where = "第 " + (pg.index + 1) + " 頁";
    if (p.kind === "g4") {
      if (!YF.ccitt) { addWarn(pg, where + "：缺少 CCITT 解碼模組（ccitt.js）。"); return null; }
      if (!pg.width || !pg.height) { addWarn(pg, where + "：缺少影像尺寸資訊，無法解碼。"); return null; }
      var g = smartG4(data, pg.width, pg.height, ws);
      if (g.px.length !== pg.width * pg.height) { ws.forEach(function (w) { addWarn(pg, where + "：" + w); }); return null; }
      bm = { width: pg.width, height: pg.height, data: g.px, rowsDecoded: g.rows };
      if (g.how) bm.variant = g.how;
    } else if (p.kind === "tiff") {
      if (!YF.ccitt) { addWarn(pg, where + "：缺少 CCITT 解碼模組（ccitt.js）。"); return null; }
      var tp = (YF.ccitt.tiffPages ? YF.ccitt.tiffPages(data, { warnings: ws }) : []).filter(function (q) { return q.supported; })[0];
      bm = tp ? tp.decode({ warnings: ws }) : (YF.ccitt.decodeTiff(data, { warnings: ws, maxPages: 1 })[0] || null);
      if (bm) bm = { width: bm.width, height: bm.height, data: bm.data };
    } else if ((p.kind === "dib" || p.kind === "bmp") && o && o.bitCount === 1) {
      bm = decodeDib1(b, p.offset, p.length, o, p.kind === "bmp");
    }
    if (ws.length) ws.forEach(function (w) { addWarn(pg, where + "：" + w); });
    if (bm) {
      bm.dpi = pg.dpi; bm.dpiX = pg.dpiX; bm.dpiY = pg.dpiY;
      bm.warnings = ws.slice();
      // 解碼幾乎立即失敗：可能有密碼保護或格式不支援
      if (p.kind === "g4" && bm.rowsDecoded < Math.min(32, pg.height) && !p.truncated) {
        addWarn(pg, where + "：影像資料無法正常解碼（可能設有 DocuWorks 安全性 / 密碼保護，或為不支援的壓縮方式）。" + PDF_HINT);
      }
    } else if (p.kind === "unknown") {
      addWarn(pg, where + "：影像格式無法辨識（類型代碼 " + p.code + "），無法解碼。");
    }
    return bm;
  }
  // 1 位元未壓縮 DIB / BMP → Bitmap（依調色盤決定哪個索引是黑）
  function decodeDib1(b, off, len, o, isBmp) {
    var h0 = isBmp ? off + 14 : off, hs = o.dibHeaderSize || 40, w = o.width, h = o.height;
    var palOff = h0 + hs, nPal = o.colorsUsed || 2, entry = hs === 12 ? 3 : 4;
    var pix = isBmp ? off + u32le(b, off + 10) : palOff + nPal * entry;
    var stride = ((w + 31) >> 5) * 4;
    if (pix + stride * h > off + len) return null;
    var lum = function (k) { var q = palOff + k * entry; return q + 2 < off + len ? b[q] + b[q + 1] + b[q + 2] : (k ? 765 : 0); };
    var oneIsInk = lum(1) < lum(0);
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var sy = o.topDown ? y : h - 1 - y, s = pix + sy * stride, d = y * w;
      for (var x = 0; x < w; x++) {
        var bit = (b[s + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[d + x] = oneIsInk ? bit : bit ^ 1;
      }
    }
    return { width: w, height: h, data: out };
  }
  // DIB（無檔頭）→ BMP（補 14 bytes BITMAPFILEHEADER），給瀏覽器解碼用
  function dibToBmp(dib, o) {
    var hs = (o && o.dibHeaderSize) || u32le(dib, 0), bpp = (o && o.bitCount) || 24;
    var nPal = (o && o.colorsUsed) || (bpp <= 8 ? 1 << bpp : 0);
    var out = new Uint8Array(dib.length + 14);
    out[0] = 0x42; out[1] = 0x4D;
    var size = out.length, pix = 14 + hs + nPal * 4;
    out[2] = size & 255; out[3] = (size >> 8) & 255; out[4] = (size >> 16) & 255; out[5] = (size >>> 24) & 255;
    out[10] = pix & 255; out[11] = (pix >> 8) & 255; out[12] = (pix >> 16) & 255; out[13] = (pix >>> 24) & 255;
    out.set(dib, 14);
    return out;
  }

  /* ---------------- 摘要文字 ---------------- */
  function summarize(res) {
    var kinds = {}, dpis = {};
    res.pages.forEach(function (p) {
      kinds[p.kind] = (kinds[p.kind] || 0) + 1;
      if (p.dpi) dpis[Math.round(p.dpi)] = 1;
    });
    var ks = Object.keys(kinds), kindText;
    if (ks.length === 1) kindText = KIND_LABEL[ks[0]] || ks[0];
    else kindText = ks.map(function (k) { return (KIND_LABEL[k] || k) + " ×" + kinds[k]; }).join("、");
    var dl = Object.keys(dpis).map(Number).sort(function (a, b) { return a - b; });
    return { kindText: kindText, single: ks.length === 1, dpiText: dl.length ? dl.join("/") + " dpi" : "" };
  }
  function finalize(res) {
    var name = res.format === "xbd" ? "DocuWorks Binder" : "DocuWorks 文件";
    if (res.legacy && !res.pages.length) {
      res.info = "舊版 DocuWorks 格式，無法直接讀取";
      res.summary = name + "：舊版格式（%XDW），無法直接讀取，請轉存 PDF";
    } else if (!res.valid && !res.pages.length) {
      res.info = "不是有效的 DocuWorks 文件";
      res.summary = name + "：檔案結構無法辨識（可能已損毀或不是 DocuWorks 檔）";
    } else if (!res.pages.length) {
      res.info = "找不到可解碼的頁面影像";
      res.summary = name + "：找不到可解碼的頁面影像（可能是文字／向量頁，請轉存 PDF）";
    } else {
      var s = summarize(res);
      // 例：「26 頁掃描影像（G4 200dpi）」
      var kt = s.kindText, m = s.single ? /^(掃描影像) (.+)$/.exec(kt) : null;
      res.info = res.pages.length + " 頁" + (m ? m[1] + "（" + m[2] + (s.dpiText ? " " + s.dpiText.replace(" ", "") : "") + "）"
        : "影像（" + kt + (s.dpiText ? "，" + s.dpiText : "") + "）");
      res.summary = name + "：" + res.pages.length + " 頁（" + kt + (s.dpiText ? "，" + s.dpiText : "") + "）";
    }
    return res;
  }

  function isXbdName(n) { return typeof n === "string" && /\.xbd$/i.test(n); }

  /**
   * 解析 DocuWorks 文件。永不拋例外。
   * opts：{fileName?}（.xbd 會標示為 Binder）
   * 回傳 {format: "xdw"|"xbd", version, valid, legacy, pages: [XdwPage], objects: [...], warnings: [], info, summary}
   */
  function parse(bytes, opts) {
    opts = opts || {};
    var b = asBytes(bytes);
    var res = { format: isXbdName(opts.fileName) ? "xbd" : "xdw", version: null, valid: false, legacy: false,
      truncated: false, pages: [], objects: [], warnings: [], info: "", summary: "" };
    try {
      parseInto(b, res);
    } catch (e) {
      res.warnings.push("DocuWorks 解析發生未預期的錯誤：" + (e && e.message ? e.message : e));
    }
    if (!res.pages.length && !res.warnings.some(function (w) { return w.indexOf("PDF") >= 0 || w.indexOf("不完整") >= 0; })) {
      if (res.valid) {
        res.warnings.push("此 DocuWorks 檔案中找不到可解碼的頁面影像，可能是以 DocuWorks Printer 等方式產生的文字／向量頁，" +
          "瀏覽器無法直接顯示。" + PDF_HINT);
      } else if (!res.legacy) {
        res.warnings.push("無法辨識 DocuWorks 檔案結構（檔案可能已損毀、不完整，或不是 DocuWorks 格式）。" + PDF_HINT);
      }
    }
    try { finalize(res); } catch (e2) { res.info = res.info || ""; res.summary = res.summary || ""; }
    return res;
  }

  function parseInto(b, res) {
    if (b.length < 4) { res.warnings.push("檔案為空或過小，不是有效的 DocuWorks 文件。"); return; }
    var ctx = newCtx(b);
    if (isLegacy(b)) {
      res.legacy = true;
      res.warnings.push("這是舊版 DocuWorks 格式（%XDW 檔頭），無法直接解析其頁面結構。" + PDF_HINT);
      if (scanImages(ctx)) {
        res.warnings.push("已改以搜尋內嵌 JPEG / PNG 影像的方式擷取頁面，頁序與完整性請自行核對。");
      }
    } else if (b[0] === TAG_HEADER) {
      var so = structOk(b, true);
      res.valid = so === true;
      res.truncated = so === "cut";
      walk(ctx, 0, b.length, 0, 0, -1);
      if (ctx.header) res.version = ctx.header.version;
      if (!res.valid) {
        var at = ctx.broken.length ? ctx.broken[0].at : 0;
        if (ctx.objects.length) {
          res.valid = true;
          if (ctx.resynced.length) {
            res.warnings.push("檔案結構有 " + ctx.resynced.length + " 處損毀（第一處在位移 " + hex(ctx.resynced[0].from) +
              "），已跳過損毀部分繼續讀取；頁數或頁序可能不完整，請核對。");
          } else {
            res.warnings.push("檔案結構在位移 " + hex(at) + " 處中斷（檔案可能不完整或已損毀），僅讀取可辨識的部分。");
          }
        } else if (res.truncated) {
          res.warnings.push("DocuWorks 檔案不完整（只有 " + b.length + " bytes，可能下載或複製時中斷），找不到任何頁面影像，請重新取得完整檔案。");
        }
      }
    } else {
      // 未知檔頭（例如 Binder 的其他版本）：嘗試通用走訪，再退而搜尋內嵌影像
      walk(ctx, 0, b.length, 0, 0, -1);
      if (ctx.objects.length) res.valid = true;
      else if (scanImages(ctx)) {
        res.warnings.push("檔案結構無法辨識，已改以搜尋內嵌 JPEG / PNG 影像的方式擷取頁面，頁序與完整性請自行核對。");
      }
    }
    Object.defineProperty(res, "_unknownSkipped", { enumerable: false, writable: true, value: {} });
    var pages = buildPages(ctx, res);
    var unk = Object.keys(res._unknownSkipped);
    if (unk.length) {
      res.warnings.push("有 " + unk.reduce(function (s, k) { return s + res._unknownSkipped[k]; }, 0) +
        " 個無法辨識的物件（類型代碼 " + unk.join("、") + "），已略過。");
    }
    pages.forEach(function (p) {
      var where = "第 " + (p.index + 1) + " 頁";
      if (p.primary.truncated) {
        var w = where + "：影像資料不完整（檔案可能被截斷）。";
        p.warnings.push(w); res.warnings.push(w);
      }
      if (p.kind === "g4" && (!p.width || !p.height)) {
        var w2 = where + "：缺少影像尺寸資訊，無法解碼。";
        p.warnings.push(w2); res.warnings.push(w2);
      }
      if (p.kind === "unknown" || p.kind === "jp2") {
        var w3 = where + "：影像格式" + (p.kind === "jp2" ? "為 JPEG 2000" : "無法辨識（類型代碼 " + p.primary.code + "）") +
          "，瀏覽器可能無法顯示。";
        p.warnings.push(w3); res.warnings.push(w3);
      }
    });
    if (pages.some(function (p) { return p.kind === "unknown" || p.kind === "jp2"; })) res.warnings.push(PDF_HINT);
    // 試解第一個 G4 頁的前 32 列：一開始就失敗 → 多半是加密 / 密碼保護
    var probe = null;
    for (var i = 0; i < pages.length; i++) if (pages[i].kind === "g4" && pages[i].width && pages[i].height) { probe = pages[i]; break; }
    if (probe && YF.ccitt) {
      var rows = Math.min(32, probe.height);
      var pr = smartG4(probe.imageBytes(), probe.width, rows, []);
      if (pr.rows < rows && !probe.primary.truncated) {
        res.warnings.push("第 " + (probe.index + 1) + " 頁影像一開始就無法解碼（可能設有 DocuWorks 安全性 / 密碼保護，或為不支援的壓縮方式）。" + PDF_HINT);
      }
    }
    res.pages = pages;
    res.objects = ctx.objects.map(function (o) {
      return { id: o.id, code: o.code, kind: o.kind, role: o.role || "", offset: o.offset, length: o.length,
        width: o.width || 0, height: o.height || 0, block: o.block };
    });
  }

  /** 給 UI 的一行中文摘要，例：「DocuWorks 文件：26 頁（掃描影像 G4，200 dpi）」 */
  function describe(bytes, fileName) {
    return parse(bytes, { fileName: fileName }).summary;
  }

  YF.xdw = {
    isXdw: isXdw,
    parse: parse,
    describe: describe,
    /* 測試用 */
    _tlvList: tlvList,
    _sniffImage: sniffImage
  };
})(typeof window !== "undefined" ? window : globalThis);
