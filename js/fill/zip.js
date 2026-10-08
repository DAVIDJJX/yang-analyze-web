/* =========================================================================
 * Yang-analyze web — fill/zip.js
 * 純前端 ZIP 讀寫（Office Open XML 套件 .docx/.xlsx 與「全部下載」壓縮檔共用），零相依。
 * 讀取：以中央目錄定位各項目（支援資料描述元、UTF-8/Big5 檔名、ZIP64），
 *       解壓用瀏覽器內建 DecompressionStream('deflate-raw')，不支援時改走 gzip 包裝或 SheetJS。
 * 寫出：CompressionStream 壓縮（不支援則不壓縮）、正確 CRC32；
 *       copyWithChanges 只重寫有變更的項目，其餘項目沿用原壓縮位元組（快且不失真）。
 * 不碰 DOM，可在 Node 22 直接執行單元測試。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  /* ---------------- CRC32 ---------------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  /** crc32(bytes, 前次 crc?) → 無號 32 位元整數（可分段累算） */
  function crc32(bytes, prev) {
    var c = (prev === undefined ? 0 : prev) ^ -1;
    for (var i = 0, n = bytes.length; i < n; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  }

  var ENC = new TextEncoder();
  var DEC_UTF8 = new TextDecoder("utf-8", { fatal: true });
  var DEC_UTF8_LOOSE = new TextDecoder("utf-8");
  var DEC_BIG5 = null;
  try { DEC_BIG5 = new TextDecoder("big5", { fatal: true }); } catch (e) { DEC_BIG5 = null; }

  function zipError(msg) { var e = new Error(msg); e.name = "ZipError"; return e; }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === "string") return ENC.encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data === null || data === undefined) return new Uint8Array(0);
    throw zipError("ZIP 寫入失敗：不支援的資料型別");
  }

  /* ---------------- 位元組讀取 ---------------- */
  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function u64(b, p) { return u32(b, p) + u32(b, p + 4) * 4294967296; }

  /** 檔名解碼：UTF-8 旗標 → UTF-8；否則先試嚴格 UTF-8、再試 Big5（中文 Windows 壓縮檔）、最後 CP437 近似 */
  function decodeName(raw, utf8Flag) {
    if (utf8Flag) return DEC_UTF8_LOOSE.decode(raw);
    var ascii = true;
    for (var i = 0; i < raw.length; i++) if (raw[i] > 0x7E || raw[i] < 0x20) { ascii = false; break; }
    if (ascii) return String.fromCharCode.apply(null, raw);
    try { return DEC_UTF8.decode(raw); } catch (e) { /* 非 UTF-8 */ }
    if (DEC_BIG5) { try { return DEC_BIG5.decode(raw); } catch (e2) { /* 非 Big5 */ } }
    var s = "";
    for (var j = 0; j < raw.length; j++) s += String.fromCharCode(raw[j]);
    return s;
  }

  /** 名稱正規化（OPC 名稱不分大小寫；容忍反斜線與開頭斜線） */
  function normName(name) {
    return String(name).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  }

  /** 解析 extra 欄位：ZIP64 (0x0001)、Info-ZIP Unicode 路徑 (0x7075) */
  function parseExtra(b, start, len, ent, isCentral) {
    var p = start, end = start + len;
    while (p + 4 <= end) {
      var id = u16(b, p), sz = u16(b, p + 2), q = p + 4, next = p + 4 + sz;
      if (next > end) break;
      if (id === 0x0001) {
        if (ent.size === 0xFFFFFFFF && q + 8 <= next) { ent.size = u64(b, q); q += 8; }
        if (ent.csize === 0xFFFFFFFF && q + 8 <= next) { ent.csize = u64(b, q); q += 8; }
        if (isCentral && ent.offset === 0xFFFFFFFF && q + 8 <= next) { ent.offset = u64(b, q); q += 8; }
      } else if (id === 0x7075 && sz > 5 && b[q] === 1) {
        // 版本 1 + 原檔名 CRC32 + UTF-8 檔名；原檔名 CRC 相符才採用
        if (u32(b, q + 1) === crc32(ent.nameBytes)) {
          ent.name = DEC_UTF8_LOOSE.decode(b.subarray(q + 5, next));
          ent.nameBytes = ENC.encode(ent.name); ent.flag |= 0x0800;   // 複製時改以 UTF-8 檔名寫出
        }
      }
      p = next;
    }
  }

  /* ---------------- 讀取：中央目錄 ---------------- */
  function findEOCD(b) {
    var min = Math.max(0, b.length - 22 - 65535);
    for (var p = b.length - 22; p >= min; p--) {
      if (b[p] === 0x50 && b[p + 1] === 0x4B && b[p + 2] === 0x05 && b[p + 3] === 0x06) {
        var cl = u16(b, p + 20);
        if (p + 22 + cl <= b.length) return p;
      }
    }
    return -1;
  }

  function parseCentral(b, warnings) {
    var eocd = findEOCD(b);
    if (eocd < 0) return null;
    var count = u16(b, eocd + 10), cdSize = u32(b, eocd + 12), cdOff = u32(b, eocd + 16);
    var commentLen = u16(b, eocd + 20);
    var comment = b.subarray(eocd + 22, eocd + 22 + commentLen);
    // ZIP64 EOCD
    if ((count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) && eocd >= 20 &&
        u32(b, eocd - 20) === 0x07064b50) {
      var z64 = u64(b, eocd - 12);
      if (z64 + 56 <= b.length && u32(b, z64) === 0x06064b50) {
        count = u64(b, z64 + 32); cdSize = u64(b, z64 + 40); cdOff = u64(b, z64 + 48);
      }
    }
    // 前置資料（自解壓檔等）造成的位移校正
    var delta = 0;
    if (cdOff + cdSize > eocd || u32(b, cdOff) !== 0x02014b50) {
      var guess = eocd - cdSize;
      if (guess >= 0 && u32(b, guess) === 0x02014b50) delta = guess - cdOff;
      else if (count > 0) return null;
    }
    var entries = [], p = cdOff + delta;
    // 以簽章逐筆讀到目錄結束（EOCD 的筆數只當參考：超過 65535 筆時常被截斷）
    while (p + 46 <= eocd && u32(b, p) === 0x02014b50) {
      var flag = u16(b, p + 8), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
      var nameBytes = b.subarray(p + 46, p + 46 + nlen);
      var ent = {
        name: decodeName(nameBytes, flag & 0x0800), nameBytes: nameBytes,
        verMade: u16(b, p + 4), flag: flag, method: u16(b, p + 10),
        time: u16(b, p + 12), date: u16(b, p + 14), crc: u32(b, p + 16),
        csize: u32(b, p + 20), size: u32(b, p + 24),
        intAttr: u16(b, p + 36), extAttr: u32(b, p + 38), offset: u32(b, p + 42),
        dataStart: -1
      };
      parseExtra(b, p + 46 + nlen, xlen, ent, true);
      ent.offset += delta;
      entries.push(ent);
      p += 46 + nlen + xlen + clen;
    }
    if (entries.length < count) warnings.push("ZIP 中央目錄不完整（預期 " + count + " 個項目，只讀到 " + entries.length + " 個）");
    // 定位各項目的壓縮資料起點（本機檔頭長度可能與中央目錄不同）
    entries.forEach(function (e) {
      var o = e.offset;
      if (o + 30 <= b.length && u32(b, o) === 0x04034b50) {
        e.dataStart = o + 30 + u16(b, o + 26) + u16(b, o + 28);
      }
      if (e.dataStart < 0 || e.dataStart + e.csize > b.length) e.bad = true;
    });
    return { entries: entries, comment: comment };
  }

  /* ---------------- 讀取：中央目錄遺失時，逐段掃描本機檔頭（截斷檔案的救援） ---------------- */
  function scanLocal(b, warnings) {
    var entries = [], p = 0;
    while (p + 30 <= b.length && u32(b, p) === 0x04034b50) {
      var flag = u16(b, p + 6), method = u16(b, p + 8);
      var nlen = u16(b, p + 26), xlen = u16(b, p + 28);
      var nameBytes = b.subarray(p + 30, p + 30 + nlen);
      var ent = {
        name: decodeName(nameBytes, flag & 0x0800), nameBytes: nameBytes, verMade: 20,
        flag: flag, method: method, time: u16(b, p + 10), date: u16(b, p + 12),
        crc: u32(b, p + 14), csize: u32(b, p + 18), size: u32(b, p + 22),
        intAttr: 0, extAttr: 0, offset: p, dataStart: p + 30 + nlen + xlen
      };
      parseExtra(b, p + 30 + nlen, xlen, ent, false);
      if (flag & 0x0008) {
        // 資料描述元：往後找簽章 PK\x07\x08 且壓縮長度吻合者
        var q = ent.dataStart, found = false;
        while (q + 16 <= b.length) {
          if (b[q] === 0x50 && b[q + 1] === 0x4B && b[q + 2] === 0x07 && b[q + 3] === 0x08 &&
              u32(b, q + 8) === q - ent.dataStart) {
            ent.crc = u32(b, q + 4); ent.csize = u32(b, q + 8); ent.size = u32(b, q + 12);
            found = true; break;
          }
          q++;
        }
        if (!found) break;
        entries.push(ent);
        p = ent.dataStart + ent.csize + 16;
      } else {
        if (ent.dataStart + ent.csize > b.length) break;
        entries.push(ent);
        p = ent.dataStart + ent.csize;
        if (u32(b, p) === 0x08074b50) p += 16;
      }
    }
    if (entries.length) warnings.push("ZIP 中央目錄遺失，已逐段掃描復原 " + entries.length + " 個項目（檔案可能不完整）");
    return entries;
  }

  /* ---------------- 解壓縮 / 壓縮 ---------------- */
  function noop() {}
  function concatChunks(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    var out = new Uint8Array(total), pos = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], pos); pos += chunks[i].length; }
    return out;
  }
  var MAX_INFLATE = 200 * 1048576;     // 單一項目解壓後上限（防 ZIP 炸彈：小檔解成數 GB 會讓分頁當掉）
  function tooBig(limit) {
    if (limit < MAX_INFLATE) return zipError("ZIP 項目解壓縮後的資料比宣告的大小多（檔案可能已損毀）");
    return zipError("檔案內容過大（解壓縮後超過 " + Math.round(limit / 1048576) + " MB），可能已損毀或不是一般文件");
  }
  /** 讓資料流經 TransformStream（Compression/DecompressionStream），收集輸出；limit＝輸出位元組上限 */
  function pump(ts, data, limit) {
    var w = ts.writable.getWriter();
    w.write(data).catch(noop);
    w.close().catch(noop);
    var reader = ts.readable.getReader(), chunks = [], total = 0;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) return concatChunks(chunks, total);
        var c = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
        chunks.push(c); total += c.length;
        if (limit && total > limit) {
          chunks = [];
          try { reader.cancel().catch(noop); } catch (e) { /* 忽略 */ }
          throw tooBig(limit);
        }
        return step();
      });
    }
    return step();
  }
  function makeStream(Ctor, fmt) {
    if (typeof Ctor !== "function") return null;
    try { return new Ctor(fmt); } catch (e) { return null; }
  }
  function sheetjsCFB() {
    var X = root.XLSX;
    return (X && X.CFB && X.CFB.utils && typeof X.CFB.utils._inflateRaw === "function") ? X.CFB.utils : null;
  }

  /** 原始 deflate 解壓；size/crc 為預期值（gzip 包裝備援需要） */
  function inflateRaw(data, size, crc, limit) {
    var ts = makeStream(root.DecompressionStream, "deflate-raw");
    if (ts) return pump(ts, data, limit);
    // 舊版 Safari 只支援 gzip：補上 gzip 檔頭/檔尾（CRC 與長度由中央目錄得知）
    if (size !== undefined && crc !== undefined) {
      var gz = makeStream(root.DecompressionStream, "gzip");
      if (gz) {
        var wrap = new Uint8Array(10 + data.length + 8);
        wrap.set([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0xFF], 0);
        wrap.set(data, 10);
        var t = new DataView(wrap.buffer, 10 + data.length, 8);
        t.setUint32(0, crc >>> 0, true); t.setUint32(4, size >>> 0, true);
        return pump(gz, wrap, limit);
      }
    }
    var cfb = sheetjsCFB();
    if (cfb) {
      return new Promise(function (resolve) { resolve(cfb._inflateRaw(data, size || data.length * 4)); });
    }
    return Promise.reject(zipError("此瀏覽器不支援解壓縮（DecompressionStream），請改用新版 Chrome / Edge / Firefox / Safari"));
  }

  /** 原始 deflate 壓縮；不支援時回傳 null（呼叫端改為不壓縮） */
  function deflateRaw(data) {
    var ts = makeStream(root.CompressionStream, "deflate-raw");
    if (ts) return pump(ts, data);
    var gz = makeStream(root.CompressionStream, "gzip");
    if (gz) {
      return pump(gz, data).then(function (g) {
        // 去掉 gzip 檔頭（10 位元組 + 可能的選用欄位）與檔尾 8 位元組
        if (g.length < 18 || g[0] !== 0x1F || g[1] !== 0x8B) return null;
        var flg = g[3], p = 10;
        if (flg & 4) p += 2 + u16(g, p);
        if (flg & 8) { while (p < g.length && g[p]) p++; p++; }
        if (flg & 16) { while (p < g.length && g[p]) p++; p++; }
        if (flg & 2) p += 2;
        return g.subarray(p, g.length - 8);
      });
    }
    var cfb = sheetjsCFB();
    if (cfb && typeof cfb._deflateRaw === "function") {
      return new Promise(function (resolve) { resolve(cfb._deflateRaw(data)); });
    }
    return Promise.resolve(null);
  }

  /* ---------------- Zip 物件 ---------------- */
  function makeZip(bytes, entries, comment, warnings, opts) {
    var byName = Object.create(null), byNorm = Object.create(null);
    entries.forEach(function (e) {
      if (!(e.name in byName)) byName[e.name] = e;
      else warnings.push("ZIP 內有重複項目：" + e.name + "（以第一個為準）");
      var k = normName(e.name);
      if (!(k in byNorm)) byNorm[k] = e;
    });
    var checkCrc = !(opts && opts.checkCrc === false);

    function entry(name) {
      if (name in byName) return byName[name];
      var k = normName(name);
      return (k in byNorm) ? byNorm[k] : null;
    }
    function need(name) {
      var e = entry(name);
      if (!e) throw zipError("ZIP 內找不到「" + name + "」");
      return e;
    }
    function rawData(e) {
      if (e.bad) throw zipError("ZIP 項目「" + e.name + "」資料不完整（檔案可能已截斷或損毀）");
      return bytes.subarray(e.dataStart, e.dataStart + e.csize);
    }
    function get(name) {
      return new Promise(function (resolve) { resolve(need(name)); }).then(function (e) {
        if (e.flag & 1) throw zipError("ZIP 項目「" + e.name + "」已加密，無法讀取（請先移除密碼保護）");
        var data = rawData(e), p;
        if (e.size > MAX_INFLATE) throw tooBig(MAX_INFLATE);
        // 宣告大小可能造假：實際輸出超過宣告值（另留 1 MB）或上限即停止
        var limit = e.size > 0 ? Math.min(MAX_INFLATE, e.size + 1048576) : MAX_INFLATE;
        if (e.method === 0) p = Promise.resolve(data.slice());
        else if (e.method === 8) {
          p = inflateRaw(data, e.size, e.crc, limit).catch(function (err) {
            if (err && err.name === "ZipError") throw err;
            throw zipError("ZIP 項目「" + e.name + "」解壓縮失敗（檔案可能損毀）");
          });
        } else {
          throw zipError("ZIP 項目「" + e.name + "」使用不支援的壓縮方式（代碼 " + e.method + "）");
        }
        return p.then(function (out) {
          if (checkCrc && (out.length !== e.size || crc32(out) !== e.crc)) {
            throw zipError("ZIP 項目「" + e.name + "」校驗失敗（CRC 不符，檔案可能損毀）");
          }
          return out;
        });
      });
    }
    return {
      names: entries.map(function (e) { return e.name; }),
      entries: entries,
      bytes: bytes,
      comment: comment,
      warnings: warnings,
      /** 是否含此項目（先精確比對，再不分大小寫） */
      has: function (name) { return !!entry(name); },
      /** 實際項目名稱（不分大小寫查找）或 null */
      find: function (name) { var e = entry(name); return e ? e.name : null; },
      get: get,
      text: function (name) {
        return get(name).then(function (u8) {
          // 去掉 UTF-8 BOM；UTF-16 BOM 則依 BOM 解碼
          if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8.subarray(2));
          if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8.subarray(2));
          return DEC_UTF8_LOOSE.decode(u8);   // TextDecoder 預設會略過 UTF-8 BOM
        });
      },
      /** 原始（未解壓）資料：{method, data, crc, size, csize, flag, time, date} */
      raw: function (name) {
        var e = need(name);
        return { method: e.method, data: rawData(e), crc: e.crc, size: e.size, csize: e.csize,
                 flag: e.flag, time: e.time, date: e.date };
      }
    };
  }

  /** 同步解析（不解壓）：回傳 Zip；格式錯誤丟出中文錯誤 */
  function readSync(bytes, opts) {
    var b = toBytes(bytes), warnings = [];
    // Node Buffer 的 slice 不複製 → 統一轉成一般 Uint8Array 視圖
    if (b.constructor !== Uint8Array) b = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 22) throw zipError("不是有效的 ZIP / Office 檔案（檔案太小或空白）");
    var cd = parseCentral(b, warnings), entries, comment = new Uint8Array(0);
    if (cd) { entries = cd.entries; comment = cd.comment; }
    else {
      entries = scanLocal(b, warnings);
      if (!entries.length) {
        if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
          throw zipError("這是舊版 Office 格式（OLE2）或已加密的 Office 檔案，不是 ZIP 套件");
        }
        throw zipError("不是有效的 ZIP / Office 檔案（找不到 ZIP 目錄，檔案可能損毀或不完整）");
      }
    }
    var bad = entries.filter(function (e) { return e.bad; });
    if (bad.length) warnings.push("ZIP 有 " + bad.length + " 個項目資料不完整：" + bad.slice(0, 3).map(function (e) { return e.name; }).join("、"));
    return makeZip(b, entries, comment, warnings, opts);
  }

  /** read(bytes, opts?) → Promise<Zip>；opts.checkCrc=false 可略過 CRC 檢查 */
  function read(bytes, opts) {
    return new Promise(function (resolve) { resolve(readSync(bytes, opts)); });
  }

  /** 是否像 ZIP（只看開頭簽章） */
  function isZip(bytes) {
    var b = toBytes(bytes);
    return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B &&
      ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8));
  }

  /* ---------------- 寫出 ---------------- */
  function dosDateTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime()) || d.getFullYear() < 1980) return { time: 0, date: 0x21 };
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function hasNonAscii(s) { return /[^\x00-\x7E]/.test(s); }

  /** 單一項目：壓縮（必要時）→ 寫出用記錄 */
  function prepareEntry(name, data, compress, dt, base) {
    var u8 = toBytes(data);
    var isDir = /\/$/.test(name) && u8.length === 0;
    var same = !!(base && base.name === name);
    var rec = {
      // 取代既有項目時沿用原檔名位元組與 UTF-8 旗標（保持原樣）
      nameBytes: same ? base.nameBytes : ENC.encode(name),
      flag: same ? (base.flag & 0x0800) : (hasNonAscii(name) ? 0x0800 : 0),
      method: 0, data: u8, crc: crc32(u8), size: u8.length, csize: u8.length,
      time: dt.time, date: dt.date,
      verMade: base ? base.verMade : 20, extAttr: base ? base.extAttr : (isDir ? 0x10 : 0),
      intAttr: base ? base.intAttr : 0
    };
    if (!compress || isDir || u8.length < 64) return Promise.resolve(rec);
    return deflateRaw(u8).then(function (z) {
      if (z && z.length < u8.length) { rec.method = 8; rec.data = z; rec.csize = z.length; }
      return rec;
    }, function () { return rec; });
  }

  function assemble(recs) {
    var total = 22, cdSize = 0;
    recs.forEach(function (r) {
      total += 30 + r.nameBytes.length + r.csize + (r.descriptor ? 16 : 0);
      cdSize += 46 + r.nameBytes.length;
    });
    total += cdSize;
    if (recs.length > 0xFFFF || total > 0xFFFFFFFF) throw zipError("檔案過大，超出 ZIP 格式上限");
    var out = new Uint8Array(total), dv = new DataView(out.buffer), pos = 0;
    recs.forEach(function (r) {
      r.offset = pos;
      dv.setUint32(pos, 0x04034b50, true);
      dv.setUint16(pos + 4, r.method === 8 ? 20 : 10, true);
      dv.setUint16(pos + 6, r.flag, true);
      dv.setUint16(pos + 8, r.method, true);
      dv.setUint16(pos + 10, r.time, true);
      dv.setUint16(pos + 12, r.date, true);
      dv.setUint32(pos + 14, r.descriptor ? 0 : r.crc, true);
      dv.setUint32(pos + 18, r.descriptor ? 0 : r.csize, true);
      dv.setUint32(pos + 22, r.descriptor ? 0 : r.size, true);
      dv.setUint16(pos + 26, r.nameBytes.length, true);
      dv.setUint16(pos + 28, 0, true);
      out.set(r.nameBytes, pos + 30);
      pos += 30 + r.nameBytes.length;
      out.set(r.data, pos);
      pos += r.csize;
      if (r.descriptor) {
        dv.setUint32(pos, 0x08074b50, true); dv.setUint32(pos + 4, r.crc, true);
        dv.setUint32(pos + 8, r.csize, true); dv.setUint32(pos + 12, r.size, true);
        pos += 16;
      }
    });
    var cdStart = pos;
    recs.forEach(function (r) {
      dv.setUint32(pos, 0x02014b50, true);
      dv.setUint16(pos + 4, r.verMade || 20, true);
      dv.setUint16(pos + 6, r.method === 8 ? 20 : 10, true);
      dv.setUint16(pos + 8, r.flag, true);
      dv.setUint16(pos + 10, r.method, true);
      dv.setUint16(pos + 12, r.time, true);
      dv.setUint16(pos + 14, r.date, true);
      dv.setUint32(pos + 16, r.crc, true);
      dv.setUint32(pos + 20, r.csize, true);
      dv.setUint32(pos + 24, r.size, true);
      dv.setUint16(pos + 28, r.nameBytes.length, true);
      dv.setUint16(pos + 30, 0, true);
      dv.setUint16(pos + 32, 0, true);
      dv.setUint16(pos + 34, 0, true);
      dv.setUint16(pos + 36, r.intAttr || 0, true);
      dv.setUint32(pos + 38, r.extAttr || 0, true);
      dv.setUint32(pos + 42, r.offset, true);
      out.set(r.nameBytes, pos + 46);
      pos += 46 + r.nameBytes.length;
    });
    dv.setUint32(pos, 0x06054b50, true);
    dv.setUint16(pos + 8, recs.length, true);
    dv.setUint16(pos + 10, recs.length, true);
    dv.setUint32(pos + 12, pos - cdStart, true);
    dv.setUint32(pos + 16, cdStart, true);
    return out;
  }

  /**
   * write(entries, opts?) → Promise<Uint8Array>
   * entries: [{name, data: Uint8Array|string, compress?: bool(預設 true), date?: Date}]，依序寫出
   * opts.date：未逐項指定時的時間戳（預設現在時間）
   */
  function write(entries, opts) {
    opts = opts || {};
    var seen = Object.create(null);
    return Promise.resolve().then(function () {
      return Promise.all((entries || []).map(prep));
    }).then(assemble);
    function prep(e) {
      if (!e || typeof e.name !== "string" || !e.name) throw zipError("ZIP 寫入失敗：項目缺少名稱");
      if (seen[e.name]) throw zipError("ZIP 寫入失敗：項目名稱重複「" + e.name + "」");
      seen[e.name] = true;
      var dt = dosDateTime(e.date || opts.date || new Date());
      return prepareEntry(e.name, e.data, e.compress !== false, dt, null);
    }
  }

  /**
   * copyWithChanges(zip, changes, opts?) → Promise<Uint8Array>
   * changes: {名稱: Uint8Array|string（取代/新增）| null（刪除）}
   * 未變更項目直接沿用原壓縮位元組與 CRC；取代項目保留原位置與時間戳；新增項目附在最後。
   */
  function copyWithChanges(zip, changes, opts) {
    return Promise.resolve().then(function () { return copyTasks(zip, changes, opts); }).then(assemble);
  }
  function copyTasks(zip, changes, opts) {
    opts = opts || {};
    changes = changes || {};
    var keys = Object.keys(changes), used = Object.create(null);
    // changes 的名稱對應到實際項目名稱（不分大小寫）
    var resolved = Object.create(null);
    keys.forEach(function (k) {
      var actual = zip.find(k);
      if (actual !== null && !(actual in resolved)) { resolved[actual] = k; }
    });
    var tasks = [];
    zip.entries.forEach(function (e) {
      if (used[e.name]) return;          // 重複項目只保留第一個
      used[e.name] = true;
      var key = resolved[e.name];
      if (key !== undefined) {
        var v = changes[key];
        if (v === null || v === undefined) return;   // 刪除
        tasks.push(prepareEntry(e.name, v, e.method !== 0 || opts.compress === true,
          { time: e.time, date: e.date }, e));
        return;
      }
      if (e.bad) throw zipError("ZIP 項目「" + e.name + "」資料不完整，無法複製");
      var raw = zip.bytes.subarray(e.dataStart, e.dataStart + e.csize);
      var enc = (e.flag & 1) !== 0;
      tasks.push(Promise.resolve({
        nameBytes: e.nameBytes, flag: enc ? e.flag : (e.flag & ~0x0008), method: e.method,
        data: raw, crc: e.crc, size: e.size, csize: e.csize, time: e.time, date: e.date,
        verMade: e.verMade, extAttr: e.extAttr, intAttr: e.intAttr,
        descriptor: enc && (e.flag & 0x0008) !== 0
      }));
    });
    var now = dosDateTime(opts.date || new Date());
    keys.forEach(function (k) {
      if (zip.find(k) !== null) return;
      var v = changes[k];
      if (v === null || v === undefined) return;
      tasks.push(prepareEntry(k, v, opts.compress !== false, now, null));
    });
    return Promise.all(tasks);
  }

  YF.zip = {
    read: read,
    readSync: readSync,
    write: write,
    copyWithChanges: copyWithChanges,
    isZip: isZip,
    crc32: crc32,
    inflateRaw: inflateRaw,
    deflateRaw: deflateRaw
  };
})(typeof window !== "undefined" ? window : globalThis);
