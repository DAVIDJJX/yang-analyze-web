/* =========================================================================
 * Yang-analyze web — fill/filetype.js
 * 檔案格式辨識：先看「內容」（魔術位元組 / 容器結構），副檔名只作參考。
 *   - ZIP 容器：只掃中央目錄的項目名稱（不解壓）→ docx/docm/dotx、xlsx/xlsm/xltx/xlsb、
 *     pptx、odt/ods、xps 或一般 zip
 *   - OLE2/CFB 複合文件：自帶極簡目錄讀取器（表頭、FAT/DIFAT 鏈、512/4096 磁區）列出串流名稱
 *     → doc / xls / ppt / 加密的 Office 文件（EncryptedPackage）
 *   - DocuWorks：自行檢查最上層 BER-TLV 鏈（含下載不完整的截斷檔）；有載入 xdw.js 時也採用 YF.xdw.isXdw
 *   - 文字檔：BOM / UTF-8 / UTF-16 / Big5 判斷編碼，再分 HTML 表格、XML Spreadsheet 2003、
 *     Word XML、RTF、CSV（分隔符號）、純文字
 * 全部同步、只讀表頭與目錄，50 MB 的檔案也只需數毫秒。純邏輯，不碰 DOM。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  /* ---------------- 格式表（kind → 類別、標籤、處理路徑、可用角色、提示） ----------------
   * family : docuworks | pdf | word | excel | image | text | other（顯示分組用）
   * route  : 處理路徑 xdw | pdf | docx | sheet（SheetJS 可讀者）| image | null（不支援）
   * accept : raw（原始資料）| template（待填表格）| both
   * hint   : 不能使用（或不能當待填表格）時給使用者的中文建議
   * ---------------------------------------------------------------------- */
  var HINT_SAVE_DOCX = "請在 Word 另存為 .docx 後上傳";
  var HINT_PPT = "不支援 PowerPoint 簡報，請在 PowerPoint 另存為 PDF 後上傳";
  var HINT_PASSWORD = "檔案有密碼保護，請先移除密碼後再上傳（Office：檔案 → 資訊 → 保護 → 以密碼加密 → 清空密碼）";
  var HINT_UNZIP = "請先解壓縮，再上傳其中的檔案";
  var HINT_UNKNOWN = "無法辨識檔案格式，請確認檔案未損毀，或另存為 PDF／.docx／.xlsx 後上傳";

  function K(family, label, route, accept, ext, mime, hint) {
    return Object.freeze({
      family: family, label: label, route: route, accept: accept,
      supported: route !== null, ext: ext, mime: mime, hint: hint || ""
    });
  }
  var MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  var MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  var KINDS = Object.freeze({
    xdw:  K("docuworks", "DocuWorks 文件 (.xdw)", "xdw", "raw", "xdw", "application/vnd.fujixerox.docuworks"),
    xbd:  K("docuworks", "DocuWorks 文件夾 (.xbd)", "xdw", "raw", "xbd", "application/vnd.fujixerox.docuworks.binder"),
    pdf:  K("pdf", "PDF 文件", "pdf", "raw", "pdf", "application/pdf"),
    docx: K("word", "Word 文件 (.docx)", "docx", "both", "docx", MIME_DOCX),
    docm: K("word", "Word 含巨集文件 (.docm)", "docx", "both", "docm", "application/vnd.ms-word.document.macroEnabled.12"),
    dotx: K("word", "Word 範本 (.dotx)", "docx", "both", "dotx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template"),
    xlsx: K("excel", "Excel 活頁簿 (.xlsx)", "sheet", "both", "xlsx", MIME_XLSX),
    xlsm: K("excel", "Excel 含巨集活頁簿 (.xlsm)", "sheet", "both", "xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"),
    xltx: K("excel", "Excel 範本 (.xltx)", "sheet", "both", "xltx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template"),
    xlsb: K("excel", "Excel 二進位活頁簿 (.xlsb)", "sheet", "both", "xlsb", "application/vnd.ms-excel.sheet.binary.macroEnabled.12"),
    xls:  K("excel", "Excel 活頁簿 (.xls 舊格式)", "sheet", "both", "xls", "application/vnd.ms-excel"),
    ods:  K("excel", "OpenDocument 試算表 (.ods)", "sheet", "both", "ods", "application/vnd.oasis.opendocument.spreadsheet"),
    csv:  K("excel", "CSV 文字表格", "sheet", "both", "csv", "text/csv"),
    html: K("excel", "HTML 表格", "sheet", "both", "html", "text/html"),
    xmlss: K("excel", "Excel XML 試算表 (XML Spreadsheet 2003)", "sheet", "both", "xml", "application/xml"),
    doc:  K("word", "Word 文件 (.doc 舊格式)", null, "both", "doc", "application/msword", HINT_SAVE_DOCX),
    rtf:  K("word", "RTF 文件 (.rtf)", null, "both", "rtf", "application/rtf", HINT_SAVE_DOCX),
    odt:  K("word", "OpenDocument 文字 (.odt)", null, "both", "odt", "application/vnd.oasis.opendocument.text",
      "請另存為 .docx（Word 文件）後上傳"),
    wordxml: K("word", "Word XML 文件", null, "both", "xml", "application/xml", HINT_SAVE_DOCX),
    pptx: K("other", "PowerPoint 簡報 (.pptx)", null, "raw", "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation", HINT_PPT),
    ppt:  K("other", "PowerPoint 簡報 (.ppt 舊格式)", null, "raw", "ppt", "application/vnd.ms-powerpoint", HINT_PPT),
    txt:  K("text", "純文字檔", null, "raw", "txt", "text/plain",
      "純文字檔沒有表格可辨識，請改上傳原始報告（PDF、Word、Excel 或 DocuWorks）"),
    png:  K("image", "影像 (PNG)", "image", "raw", "png", "image/png"),
    jpg:  K("image", "影像 (JPEG)", "image", "raw", "jpg", "image/jpeg"),
    gif:  K("image", "影像 (GIF)", "image", "raw", "gif", "image/gif"),
    bmp:  K("image", "影像 (BMP)", "image", "raw", "bmp", "image/bmp"),
    tif:  K("image", "影像 (TIFF)", "image", "raw", "tif", "image/tiff"),
    webp: K("image", "影像 (WebP)", "image", "raw", "webp", "image/webp"),
    heic: K("image", "影像 (HEIC)", null, "raw", "heic", "image/heic",
      "瀏覽器無法讀取 HEIC 相片，請轉存為 JPG 或 PNG 後上傳（iPhone：設定 → 相機 → 格式 → 最相容）"),
    zip:  K("other", "ZIP 壓縮檔", null, "raw", "zip", "application/zip", HINT_UNZIP),
    xps:  K("other", "XPS 文件", null, "raw", "xps", "application/oxps",
      "瀏覽器無法讀取 XPS，請用「Microsoft Print to PDF」印成 PDF 後上傳"),
    encrypted: K("other", "加密的 Office 文件", null, "both", "", "application/octet-stream", HINT_PASSWORD),
    empty: K("other", "空檔案", null, "both", "", "application/octet-stream",
      "檔案是空的（0 位元組），請確認檔案已完整下載或複製後再上傳"),
    unknown: K("other", "無法辨識的檔案", null, "both", "", "application/octet-stream", HINT_UNKNOWN)
  });

  /* ---------------- 副檔名 → 預期格式；相容群組（不算副檔名不符） ---------------- */
  var EXT_KIND = {
    xdw: "xdw", xbd: "xbd", pdf: "pdf",
    docx: "docx", docm: "docm", dotx: "dotx", dotm: "docm",
    xlsx: "xlsx", xlsm: "xlsm", xltx: "xltx", xltm: "xlsm", xlsb: "xlsb",
    xls: "xls", xlt: "xls", doc: "doc", dot: "doc", rtf: "rtf",
    pptx: "pptx", pptm: "pptx", ppsx: "pptx", potx: "pptx", ppt: "ppt", pps: "ppt", pot: "ppt",
    odt: "odt", ott: "odt", ods: "ods", ots: "ods",
    csv: "csv", tsv: "csv", tab: "csv", txt: "txt", text: "txt", prn: "txt", log: "txt", json: "txt",
    htm: "html", html: "html", xhtml: "html", mht: "html", mhtml: "html", xml: "xmlss",
    png: "png", jpg: "jpg", jpeg: "jpg", jpe: "jpg", jfif: "jpg", gif: "gif", bmp: "bmp", dib: "bmp",
    tif: "tif", tiff: "tif", webp: "webp", heic: "heic", heif: "heic",
    zip: "zip", xps: "xps", oxps: "xps"
  };
  var GROUPS = [
    ["docx", "docm", "dotx"], ["xlsx", "xlsm", "xltx"], ["xdw", "xbd"], ["csv", "txt"]
  ];
  var XML_OK = { xmlss: 1, wordxml: 1, txt: 1, html: 1 };

  function compatible(ext, kind) {
    var ek = EXT_KIND[ext];
    if (!ek || ek === kind) return true;
    if (ext === "xml") return !!XML_OK[kind];
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].indexOf(ek) >= 0 && GROUPS[i].indexOf(kind) >= 0) return true;
    }
    return false;
  }

  /** 檔名 → 小寫副檔名（去路徑、去結尾空白與句點；異常字元回傳 ''） */
  function extOf(name) {
    if (name === null || name === undefined) return "";
    var base = String(name).replace(/[\s.]+$/, "").split(/[\\\/]/).pop();
    var i = base.lastIndexOf(".");
    if (i < 0 || i === base.length - 1) return "";
    var e = base.slice(i + 1).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(e) ? e : "";
  }
  function kindOfExt(nameOrExt) {
    var s = String(nameOrExt || "");
    var e = s.indexOf(".") >= 0 ? extOf(s) : s.toLowerCase();
    return EXT_KIND[e] || null;
  }

  /* ---------------- 位元組工具 ---------------- */
  function toBytes(x) {
    if (x === null || x === undefined) return new Uint8Array(0);
    if (x instanceof Uint8Array) return x;
    if (typeof ArrayBuffer !== "undefined") {
      if (x instanceof ArrayBuffer) return new Uint8Array(x);
      if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
    if (Array.isArray(x)) return new Uint8Array(x);
    throw new TypeError("filetype.detect：bytes 必須是 Uint8Array 或 ArrayBuffer");
  }
  function u16(b, o) { return o + 2 <= b.length ? (b[o] | (b[o + 1] << 8)) : -1; }
  function u32(b, o) {
    return o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : -1;
  }
  function u16be(b, o) { return o + 2 <= b.length ? ((b[o] << 8) | b[o + 1]) : -1; }
  function u32be(b, o) {
    return o + 4 <= b.length ? b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) : -1;
  }
  function startsWith(b, off, sig) {
    if (off + sig.length > b.length) return false;
    for (var i = 0; i < sig.length; i++) if (b[off + i] !== sig[i]) return false;
    return true;
  }
  function ascii(b, off, n) {
    var s = "", end = Math.min(b.length, off + n);
    for (var i = off; i < end; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  /** 在 b[from, to) 中找 ASCII 字串 needle，回傳位置或 -1 */
  function findAscii(b, needle, from, to) {
    from = Math.max(0, from || 0);
    to = Math.min(to === undefined ? b.length : to, b.length);
    if (to - from < needle.length) return -1;
    var w = b.subarray(from, to), n0 = needle.charCodeAt(0), L = needle.length, i = 0;   // 限定範圍內搜尋
    while (i <= w.length - L) {
      i = w.indexOf(n0, i);
      if (i < 0 || i > w.length - L) return -1;
      var ok = true;
      for (var k = 1; k < L; k++) if (w[i + k] !== needle.charCodeAt(k)) { ok = false; break; }
      if (ok) return from + i;
      i++;
    }
    return -1;
  }
  function latin1(b) {
    var s = "", CH = 8192;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return s;
  }
  function decodeText(b, enc) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder(enc || "utf-8").decode(b); } catch (e) { /* 不支援的編碼 → 下方退回 */ }
    }
    if (enc === "utf-16le" || enc === "utf-16be") {
      var s = "", le = enc === "utf-16le";
      for (var i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
      return s;
    }
    return latin1(b);
  }

  /* ======================================================================
   * ZIP：只讀中央目錄（EOCD → central directory），失敗時退回逐一掃本地檔頭
   * ====================================================================== */
  var MAX_ZIP_ENTRIES = 20000;
  function zipName(b, off, len, utf8) {
    var raw = b.subarray(off, Math.min(b.length, off + len));
    for (var i = 0; i < raw.length; i++) if (raw[i] >= 0x80) return utf8 ? decodeText(raw, "utf-8") : latin1(raw);
    return latin1(raw);
  }
  function zipEntries(bytes) {
    var b = toBytes(bytes), len = b.length;
    var res = { entries: [], partial: false, ok: false };
    // 1) EOCD（PK 05 06）：從尾端往前找，註解長度最長 65535
    var eocd = -1, loose = -1, stop = Math.max(0, len - 22 - 0xFFFF);
    for (var i = len - 22; i >= stop; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4B && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
        var clen = u16(b, i + 20);
        if (i + 22 + clen === len) { eocd = i; break; }
        if (loose < 0 && i + 22 + clen <= len) loose = i;
      }
    }
    if (eocd < 0) eocd = loose;
    if (eocd >= 0) {
      var total = u16(b, eocd + 10), cdSize = u32(b, eocd + 12), cdOff = u32(b, eocd + 16);
      // ZIP64：EOCD 欄位為 0xFFFF… 時讀 ZIP64 EOCD
      if ((cdOff === 0xFFFFFFFF || total === 0xFFFF || cdSize === 0xFFFFFFFF) &&
          eocd >= 20 && u32(b, eocd - 20) === 0x07064b50) {
        var z64 = u32(b, eocd - 12) + u32(b, eocd - 8) * 0x100000000;
        if (z64 >= 0 && z64 + 56 <= len && u32(b, z64) === 0x06064b50) {
          total = u32(b, z64 + 32); cdSize = u32(b, z64 + 40); cdOff = u32(b, z64 + 48);
        }
      }
      // 前置資料（自解壓檔等）造成的位移校正
      if (u32(b, cdOff) !== 0x02014b50 && eocd - cdSize >= 0 && u32(b, eocd - cdSize) === 0x02014b50) {
        cdOff = eocd - cdSize;
      }
      if (cdOff >= 0 && (u32(b, cdOff) === 0x02014b50 || total === 0)) {
        var p = cdOff;
        while (p + 46 <= len && u32(b, p) === 0x02014b50 && res.entries.length < MAX_ZIP_ENTRIES) {
          var flags = u16(b, p + 8), nlen = u16(b, p + 28), xlen = u16(b, p + 30), cmlen = u16(b, p + 32);
          res.entries.push({
            name: zipName(b, p + 46, nlen, (flags & 0x800) !== 0),
            method: u16(b, p + 10), csize: u32(b, p + 20), size: u32(b, p + 24), offset: u32(b, p + 42)
          });
          p += 46 + nlen + xlen + cmlen;
        }
        res.ok = true;
        if (res.entries.length < total && res.entries.length < MAX_ZIP_ENTRIES) res.partial = true;
        return res;
      }
    }
    // 2) 無有效中央目錄（檔案截斷/損毀）：掃本地檔頭（PK 03 04），最多掃前 8 MB
    var q = 0, limit = Math.min(len, 8 * 1024 * 1024);
    res.partial = true;
    while (q + 30 <= limit && res.entries.length < 2000) {
      if (u32(b, q) !== 0x04034b50) {
        q = findAscii(b, "PK\x03\x04", q + 1, limit);
        if (q < 0) break;
        continue;
      }
      var fl = u16(b, q + 6), nl = u16(b, q + 26), xl = u16(b, q + 28), cs = u32(b, q + 18);
      if (!plausibleName(b, q + 30, nl)) {                     // 檔名不合理 → 視為雜訊，往後找下一個簽章
        q = findAscii(b, "PK\x03\x04", q + 4, limit);
        if (q < 0) break;
        continue;
      }
      res.entries.push({
        name: zipName(b, q + 30, nl, (fl & 0x800) !== 0),
        method: u16(b, q + 8), csize: cs, size: u32(b, q + 22), offset: q
      });
      var data = q + 30 + nl + xl;
      q = ((fl & 8) && cs === 0) || cs < 0 ? data : data + cs;
    }
    res.ok = res.entries.length > 0;
    return res;
  }
  /** 本地檔頭的檔名：長度 1–1024、無控制字元 */
  function plausibleName(b, off, len) {
    if (len < 1 || len > 1024 || off + len > b.length) return false;
    for (var i = off; i < off + len; i++) if (b[i] < 0x20 || b[i] === 0x7F) return false;
    return true;
  }
  /** 讀未壓縮（stored）項目的前 n 位元組（ODF 的 mimetype 用） */
  function zipStoredHead(b, ent, n) {
    if (!ent || ent.method !== 0) return null;
    var p = ent.offset;
    if (u32(b, p) !== 0x04034b50) return null;
    var data = p + 30 + u16(b, p + 26) + u16(b, p + 28);
    var size = ent.size >= 0 ? ent.size : ent.csize;
    if (data > b.length) return null;
    return b.subarray(data, Math.min(b.length, data + Math.min(n, size)));
  }

  var ZIP_KINDS = ["docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "xlsb", "pptx", "odt", "ods", "xps"];
  var ODF_KIND = {
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.text-template": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.spreadsheet-template": "ods"
  };

  function classifyZip(b, ext, out) {
    var z = zipEntries(b);
    if (!z.ok) return false;
    var names = z.entries.map(function (e) { return e.name; });
    var low = {}, i;
    for (i = 0; i < names.length; i++) low[names[i].toLowerCase().replace(/^\//, "")] = z.entries[i];
    function has(n) { return Object.prototype.hasOwnProperty.call(low, n); }
    function hasPrefix(pre) {
      for (var k in low) if (k.indexOf(pre) === 0 && k.length > pre.length) return true;
      return false;
    }
    out.meta.entries = names.length;
    out.meta.names = names.slice(0, 200);
    if (z.partial) out.notes.push("ZIP 結構不完整（檔案可能已損毀或未下載完整）");
    var opc = has("[content_types].xml") || has("_rels/.rels");
    var ek = EXT_KIND[ext];

    // Word / Excel / PowerPoint（Office Open XML）
    if (has("word/document.xml") || (opc && hasPrefix("word/"))) {
      var macroW = has("word/vbaproject.bin");
      out.meta.macro = macroW;
      if (macroW) out.notes.push("含巨集 (VBA)");
      out.kind = (ek === "docx" || ek === "docm" || ek === "dotx") ? ek : (macroW ? "docm" : "docx");
      if (!has("word/document.xml")) out.notes.push("找不到 word/document.xml（文件可能不完整）");
      return true;
    }
    if (has("xl/workbook.xml") || has("xl/workbook.bin") || (opc && hasPrefix("xl/"))) {
      var macroX = has("xl/vbaproject.bin");
      out.meta.macro = macroX;
      if (macroX) out.notes.push("含巨集 (VBA)");
      if (has("xl/workbook.bin")) out.kind = "xlsb";
      else out.kind = (ek === "xlsx" || ek === "xlsm" || ek === "xltx") ? ek : (macroX ? "xlsm" : "xlsx");
      return true;
    }
    if (has("ppt/presentation.xml") || (opc && hasPrefix("ppt/"))) { out.kind = "pptx"; return true; }
    if (has("fixeddocumentsequence.fdseq") || has("fixeddocseq.fdseq") ||
        (opc && hasPrefix("documents/") && hasPrefix("metadata/"))) {
      out.kind = "xps"; return true;
    }
    // OpenDocument：mimetype 應為第一個且未壓縮
    if (has("mimetype") || (has("content.xml") && has("meta-inf/manifest.xml"))) {
      var mt = zipStoredHead(b, low.mimetype, 100);
      var mts = mt ? latin1(mt).trim() : "";
      if (ODF_KIND[mts]) { out.kind = ODF_KIND[mts]; return true; }
      if (/opendocument\.presentation/.test(mts)) {
        out.kind = "unknown"; out.notes.push("OpenDocument 簡報 (.odp)"); out.hint = HINT_PPT; return true;
      }
      if (!mts && (ek === "odt" || ek === "ods")) { out.kind = ek; return true; }
      if (mts) out.notes.push(mts.indexOf("opendocument") >= 0 ? "OpenDocument 文件（" + mts + "）" : "內容類型：" + mts);
    }
    // 結構損毀又認不出內容：副檔名若是 Office/ODF 類，交給副檔名判斷
    if (z.partial && ZIP_KINDS.indexOf(ek) >= 0) return false;
    // 一般壓縮檔：列出前幾個檔名
    out.kind = "zip";
    var files = names.filter(function (n) { return !/\/$/.test(n); });
    if (files.length) {
      out.notes.push("內含 " + files.length + " 個檔案：" +
        files.slice(0, 5).map(function (n) { return n.split("/").pop(); }).join("、") + (files.length > 5 ? "…" : ""));
    } else {
      out.notes.push("壓縮檔內沒有檔案");
    }
    return true;
  }

  /* ======================================================================
   * OLE2 / CFB 複合文件：極簡目錄讀取器（不讀串流內容，只讀名稱；必要時讀開頭幾個位元組）
   * ====================================================================== */
  var CFB_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  var MAXREG = 0xFFFFFFFA, NOSTREAM = 0xFFFFFFFF;

  function cfbOpen(bytes) {
    var b = toBytes(bytes);
    if (b.length < 512 || !startsWith(b, 0, CFB_SIG)) return null;
    var major = u16(b, 0x1A), shift = u16(b, 0x1E);
    if (shift !== 9 && shift !== 12) shift = major === 4 ? 12 : 9;
    var ssz = 1 << shift, per = ssz >>> 2;
    var nSect = Math.ceil(Math.max(0, b.length - ssz) / ssz);   // 檔案實際含有的磁區數
    var miniCutoff = u32(b, 0x38) || 4096;
    var c = {
      b: b, ssz: ssz, per: per, nSect: nSect, major: major, miniCutoff: miniCutoff,
      dirStart: u32(b, 0x30), miniFatStart: u32(b, 0x3C), warnings: []
    };
    // DIFAT：表頭 109 筆 + DIFAT 磁區鏈（延遲載入）
    var difat = [], k;
    for (k = 0; k < 109; k++) difat.push(u32(b, 0x4C + k * 4));
    var difatNext = u32(b, 0x44), difatSeen = 0;
    c.fatSector = function (idx) {
      while (idx >= difat.length && difatNext <= MAXREG && difatSeen <= nSect) {
        var off = (difatNext + 1) * ssz;
        if (off + ssz > b.length) { difatNext = NOSTREAM; break; }
        for (var j = 0; j < per - 1; j++) difat.push(u32(b, off + j * 4));
        difatNext = u32(b, off + (per - 1) * 4);
        difatSeen++;
      }
      return idx < difat.length ? difat[idx] : NOSTREAM;
    };
    c.next = function (n) {
      var fs = c.fatSector(Math.floor(n / per));
      if (fs > MAXREG) return NOSTREAM;
      var v = u32(b, (fs + 1) * ssz + (n % per) * 4);
      return v < 0 ? NOSTREAM : v;
    };
    c.offset = function (n) { return (n + 1) * ssz; };
    /** 依 FAT 走鏈；超過檔案磁區數視為循環 */
    c.chain = function (start, maxLen) {
      var out = [], n = start, cap = Math.min(maxLen || Infinity, nSect + 1);
      while (n <= MAXREG && out.length < cap) {
        if ((n + 1) * ssz >= b.length) { c.warnings.push("磁區超出檔案範圍"); break; }
        out.push(n);
        n = c.next(n);
      }
      if (out.length >= nSect + 1) c.warnings.push("FAT 鏈循環");
      return out;
    };
    return c;
  }

  function utf16name(b, off, nbytes) {
    var s = "", n = Math.min(64, Math.max(0, nbytes - 2));
    for (var i = 0; i + 1 < n; i += 2) {
      var ch = b[off + i] | (b[off + i + 1] << 8);
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  /** 列出 CFB 目錄：{entries:[{id,name,path,type,start,size,depth}], version, sectorSize, warnings} | null */
  function cfbEntries(bytes) {
    var c = cfbOpen(bytes);
    if (!c) return null;
    var b = c.b, raw = [], perDir = c.ssz / 128;
    var dirSecs = c.chain(c.dirStart, Math.ceil(65536 / perDir));   // 上限 65536 筆目錄項
    dirSecs.forEach(function (s) {
      var base = c.offset(s);
      for (var j = 0; j < perDir; j++) {
        var o = base + j * 128;
        if (o + 128 > b.length) break;
        raw.push({
          id: raw.length, name: utf16name(b, o, u16(b, o + 0x40)), type: b[o + 0x42],
          left: u32(b, o + 0x44), right: u32(b, o + 0x48), child: u32(b, o + 0x4C),
          start: u32(b, o + 0x74), size: u32(b, o + 0x78)
        });
      }
    });
    if (!raw.length) {
      return { entries: [], version: c.major, sectorSize: c.ssz, warnings: c.warnings.concat(["目錄讀取失敗"]), c: c };
    }
    var entries = [], seen = {};
    // 依紅黑樹（left/right/child）走出路徑；根目錄 = 第 0 筆（type 5）
    function walk(id, prefix, depth) {
      var stack = [id];
      while (stack.length) {
        var k = stack.pop();
        if (k === NOSTREAM || k < 0 || k >= raw.length || seen[k]) continue;
        seen[k] = true;
        var e = raw[k];
        if (e.type !== 1 && e.type !== 2) continue;
        stack.push(e.left, e.right);
        entries.push({ id: k, name: e.name, path: prefix + e.name, type: e.type === 1 ? "storage" : "stream",
          start: e.start, size: e.size, depth: depth });
        if (e.type === 1 && depth < 8) walk(e.child, prefix + e.name + "/", depth + 1);
      }
    }
    if (raw[0].type === 5) { seen[0] = true; walk(raw[0].child, "", 0); }
    if (!entries.length) {
      // 樹狀結構損毀 → 平面列出全部
      raw.forEach(function (e) {
        if (e.type === 1 || e.type === 2) {
          entries.push({ id: e.id, name: e.name, path: e.name, type: e.type === 1 ? "storage" : "stream",
            start: e.start, size: e.size, depth: 0 });
        }
      });
      if (entries.length) c.warnings.push("目錄樹損毀，改為平面列出");
    }
    return { entries: entries, root: raw[0], version: c.major, sectorSize: c.ssz, warnings: c.warnings, c: c };
  }

  /** 讀串流開頭 n 位元組（一般磁區或 mini stream） */
  function cfbReadHead(info, ent, n) {
    var c = info.c, b = c.b, size = Math.min(ent.size, n), out = new Uint8Array(Math.max(0, size)), got = 0, k;
    if (size <= 0) return out;
    if (ent.size < c.miniCutoff && info.root && info.root.type === 5) {
      // mini stream：64 位元組小磁區，容器 = 根目錄的串流
      var rootChain = c.chain(info.root.start, Math.ceil(info.root.size / c.ssz) + 1);
      var miniFat = c.chain(c.miniFatStart);
      var m = ent.start, guard = 0;
      while (got < size && m <= MAXREG && guard++ < 4096) {
        var mo = m * 64, rs = rootChain[Math.floor(mo / c.ssz)];
        if (rs === undefined) break;
        var src = c.offset(rs) + (mo % c.ssz);
        for (k = 0; k < 64 && got < size && src + k < b.length; k++) out[got++] = b[src + k];
        var fs = miniFat[Math.floor(m / c.per)];
        if (fs === undefined) break;
        m = u32(b, c.offset(fs) + (m % c.per) * 4);
        if (m < 0) break;
      }
    } else {
      var s = ent.start, guard2 = 0;
      while (got < size && s <= MAXREG && guard2++ < 64) {
        var off = c.offset(s);
        if (off >= b.length) break;
        for (k = 0; k < c.ssz && got < size && off + k < b.length; k++) out[got++] = b[off + k];
        s = c.next(s);
      }
    }
    return got < out.length ? out.subarray(0, got) : out;
  }

  function classifyCfb(b, ext, out) {
    var info = cfbEntries(b);
    if (!info || !info.entries.length) return false;
    var top = {};
    info.entries.forEach(function (e) { if (e.depth === 0) top[e.name.toLowerCase()] = e; });
    out.meta.names = info.entries.filter(function (e) { return e.depth === 0; })
      .map(function (e) { return e.name; }).slice(0, 200);
    out.meta.sectorSize = info.sectorSize;
    if (info.warnings.length) out.notes.push("OLE2 結構異常：" + info.warnings[0]);
    var ek = EXT_KIND[ext];

    // 加密的 OOXML（docx/xlsx 設密碼後外層包成 CFB：EncryptionInfo + EncryptedPackage）
    if (top.encryptedpackage || (top.encryptioninfo && top["\u0006dataspaces"])) {
      out.encrypted = true;
      out.kind = (ek && ["docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "xlsb", "pptx", "doc", "xls", "ppt"].indexOf(ek) >= 0)
        ? ek : "encrypted";
      out.notes.push("已加密（密碼保護）");
      return true;
    }
    if (top.worddocument) {
      out.kind = "doc";
      var fib = cfbReadHead(info, top.worddocument, 32);
      if (fib.length >= 12 && u16(fib, 0) === 0xA5EC) {
        var fl = u16(fib, 10);
        out.meta.nFib = u16(fib, 2);
        if (fl & 0x0100) { out.encrypted = true; out.notes.push("已加密（密碼保護）"); }
        out.notes.push((fl & 0x0001) ? "Word 97–2003 範本 (.dot)" : "Word 97–2003 格式");
      } else if (fib.length >= 2 && u16(fib, 0) === 0xA5DC) {
        out.notes.push("Word 6.0/95 格式");
      }
      return true;
    }
    var wb = top.workbook || top.book;
    if (wb) {
      out.kind = "xls";
      if (top._vba_project_cur) { out.meta.macro = true; out.notes.push("含巨集 (VBA)"); }
      var head = cfbReadHead(info, wb, 2048), ver = biffInfo(head);
      if (ver.version) out.meta.version = ver.version;
      out.notes.push(ver.label || (top.book && !top.workbook ? "Excel 5.0/95 格式" : "Excel 97–2003 格式"));
      if (ver.encrypted) { out.encrypted = true; out.notes.push("已加密（密碼保護）"); }
      return true;
    }
    if (top["powerpoint document"]) { out.kind = "ppt"; return true; }
    out.kind = "unknown";
    if (top["__properties_version1.0"] || Object.keys(top).some(function (k) { return k.indexOf("__substg1.0_") === 0; })) {
      out.notes.push("Outlook 郵件 (.msg)：請將附件另存到電腦後再上傳");
      out.hint = "請將郵件附件另存到電腦後再上傳附件檔案";
    } else if (top.visiodocument) {
      out.notes.push("Visio 繪圖");
    } else {
      out.notes.push("OLE2 複合文件（非 Word／Excel）" +
        (out.meta.names.length ? "：" + out.meta.names.slice(0, 4).join("、") : ""));
    }
    return true;
  }

  /** BIFF 開頭：BOF 版本 + 是否有 FILEPASS（加密） */
  function biffInfo(h) {
    var r = { version: null, label: "", encrypted: false };
    if (h.length < 8) return r;
    var bofType = u16(h, 0);
    if (bofType === 0x0809) {
      var v = u16(h, 4);
      r.version = v === 0x0600 ? 8 : v === 0x0500 ? 5 : null;
      r.label = v === 0x0600 ? "Excel 97–2003 格式 (BIFF8)" : v === 0x0500 ? "Excel 5.0/95 格式 (BIFF5)" : "";
    }
    // 掃前幾筆紀錄找 FILEPASS (0x002F)，遇到 EOF (0x000A) 停
    var p = 0, n = 0;
    while (p + 4 <= h.length && n++ < 64) {
      var t = u16(h, p), L = u16(h, p + 2);
      if (t === 0x002F) { r.encrypted = true; break; }
      if (t === 0x000A || L < 0) break;
      p += 4 + L;
    }
    return r;
  }

  /** 無外殼 BIFF：BOF 0x0009(len 4) / 0x0209 / 0x0409(len 6) / 0x0809(len 8|16)，dt 為已知子串流型別 */
  function biffBareBof(b) {
    var t = u16(b, 0), L = u16(b, 2), dt = u16(b, 6);
    var lenOk = (t === 0x0009 && L === 4) || ((t === 0x0209 || t === 0x0409) && L === 6) ||
      (t === 0x0809 && (L === 8 || L === 16));
    return lenOk && [0x0005, 0x0006, 0x0010, 0x0020, 0x0040, 0x0100].indexOf(dt) >= 0;
  }

  /* ======================================================================
   * DocuWorks：最上層 BER-TLV 鏈（[0x60] 表頭 + 一連串 [0x61] 區塊）須剛好涵蓋整個檔案
   * ====================================================================== */
  function berLen(b, p) {      // → {len, pos} | null（不接受不定長度 0x80）
    if (p >= b.length) return null;
    var l = b[p];
    if (l < 0x80) return { len: l, pos: p + 1 };
    var n = l & 0x7F;
    if (n === 0 || n > 6 || p + 1 + n > b.length) return null;
    var v = 0;
    for (var i = 0; i < n; i++) v = v * 256 + b[p + 1 + i];
    return { len: v, pos: p + 1 + n };
  }
  /** 表頭 [0x60] 內部須為 ≥ 2 個 context 類別（0x80–0x9F）TLV 且剛好填滿；回傳版本（tag 0x82 的值，無則 0）或 -1 */
  function xdwHeader(b) {
    if (b.length < 4 || b[0] !== 0x60) return -1;
    var h = berLen(b, 1);
    if (!h || h.len < 6 || h.len > 64 || h.pos + h.len > b.length) return -1;
    var p = h.pos, end = h.pos + h.len, ver = 0, n = 0;
    while (p < end) {
      var t = b[p], L = berLen(b, p + 1);
      if ((t & 0xC0) !== 0x80 || !L || L.pos + L.len > end) return -1;
      if (t === 0x82 && L.len === 1) ver = b[L.pos];
      p = L.pos + L.len; n++;
    }
    return n >= 2 ? ver : -1;
  }
  /** 截斷的 XDW：表頭合法、含 CR LF 防護位元組，且緊接 [0x61] 區塊、其內第一個元素也是建構型 */
  function looksXdwTruncated(b) {
    if (xdwHeader(b) < 0) return false;
    var h = berLen(b, 1), end = h.pos + h.len;
    if (findAscii(b, "\r\n", h.pos, end) < 0 || b[end] !== 0x61) return false;
    var L = berLen(b, end + 1);
    return !!L && L.len > 0 && (b[L.pos] & 0xE0) === 0x60 && !!berLen(b, L.pos + 1);
  }
  function looksXdw(b) {
    var n = b.length;
    if (n >= 4 && b[0] === 0x25 && b[1] === 0x58 && (ascii(b, 0, 4) === "%XDW" || ascii(b, 0, 4) === "%XBD")) return true;
    if (n < 16 || b[0] !== 0x60 || xdwHeader(b) < 0) return false;
    var p = 0, count = 0;
    while (p < n) {
      if (count >= 2 && n - p <= 16) return true;              // 容許 ≤ 16 位元組尾巴
      var t = b[p];
      if (count === 0 ? t !== 0x60 : (t & 0xE0) !== 0x60) return false;   // 應用類別、建構型
      var L = berLen(b, p + 1);
      if (!L || L.pos + L.len > n) return false;
      if (count === 0 && L.len > 255) return false;
      p = L.pos + L.len;
      if (++count > 200000) return false;
    }
    return count >= 2;
  }
  /** 有載入 xdw.js 時採用其 isXdw（例外視為否） */
  function delegatedIsXdw(b) {
    var x = YF.xdw;
    if (!x || typeof x.isXdw !== "function") return false;
    try { return !!x.isXdw(b); } catch (e) { return false; }
  }

  /* ======================================================================
   * PDF / 影像
   * ====================================================================== */
  function pdfInfo(b, out) {
    var at = findAscii(b, "%PDF-", 0, 1024);
    var m = /^%PDF-(\d\.\d)/.exec(ascii(b, at, 12));
    if (m) out.meta.version = m[1];
    if (at > 0) out.notes.push("PDF 檔頭前有 " + at + " 位元組多餘資料");
    var head = ascii(b, at, 2048), lin = /\/Linearized[\s\S]{0,200}?\/N\s+(\d+)/.exec(head);
    if (lin) out.meta.pages = parseInt(lin[1], 10);
    // 加密：線性化 PDF 的第一個 trailer 在開頭；一般 PDF 看最後一個 startxref 指向的 trailer / xref stream 字典
    var tailFrom = Math.max(0, b.length - 4096), sx = -1, mm, re = /startxref\s+(\d+)/g, tail = ascii(b, tailFrom, 4096);
    while ((mm = re.exec(tail))) sx = parseInt(mm[1], 10);
    var enc = findAscii(b, "/Encrypt", at, Math.min(b.length, at + 16384)) >= 0 || findAscii(b, "/Encrypt", tailFrom) >= 0 ||
      (sx > 0 && sx < b.length && findAscii(b, "/Encrypt", sx, sx + 8192) >= 0);
    if (enc) {
      out.encrypted = true;
      out.notes.push("PDF 已加密（若需開啟密碼將無法讀取）");
    }
    if (findAscii(b, "%%EOF", tailFrom) < 0) out.notes.push("找不到 %%EOF（檔案可能不完整）");
    out.notes.unshift("PDF" + (out.meta.version ? " " + out.meta.version : "") +
      (out.meta.pages ? "，" + out.meta.pages + " 頁" : ""));
  }

  function setDims(out, w, h, dpi) {
    if (w > 0 && h > 0) { out.meta.width = w; out.meta.height = h; }
    if (dpi > 0) out.meta.dpi = Math.round(dpi);
    if (w > 0 && h > 0) out.notes.push(w + "×" + h + " px" + (dpi > 0 ? "，" + Math.round(dpi) + " dpi" : ""));
  }
  function pngInfo(b, out) {
    var w = u32be(b, 16), h = u32be(b, 20), dpi = 0, p = 8, n = 0;
    while (p + 12 <= b.length && n++ < 64) {
      var L = u32be(b, p), t = ascii(b, p + 4, 4);
      if (t === "pHYs" && L >= 9 && b[p + 16] === 1) dpi = u32be(b, p + 8) * 0.0254;
      if (t === "IDAT" || t === "IEND" || L < 0) break;
      p += 12 + L;
    }
    setDims(out, w, h, dpi);
  }
  function jpegInfo(b, out) {
    var p = 2, n = 0, w = 0, h = 0, dpi = 0;
    while (p + 4 <= b.length && n++ < 2000) {
      if (b[p] !== 0xFF) { p++; continue; }
      var mk = b[p + 1];
      if (mk === 0xFF) { p++; continue; }
      if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { p += 2; continue; }
      if (mk === 0xD9 || mk === 0xDA) break;
      var L = u16be(b, p + 2);
      if (L < 2) break;
      if (mk === 0xE0 && ascii(b, p + 4, 5) === "JFIF\0") {
        var unit = b[p + 11], xd = u16be(b, p + 12);
        dpi = unit === 1 ? xd : unit === 2 ? xd * 2.54 : 0;
      }
      if ((mk >= 0xC0 && mk <= 0xCF) && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
        h = u16be(b, p + 5); w = u16be(b, p + 7);
        break;
      }
      p += 2 + L;
    }
    setDims(out, w, h, dpi);
  }
  function bmpInfo(b, out) {
    var hs = u32(b, 14), w, h, dpi = 0;
    if (hs === 12) { w = u16(b, 18); h = u16(b, 20); } else {
      w = u32(b, 18) | 0; h = Math.abs(u32(b, 22) | 0);
      var ppm = u32(b, 38);
      if (ppm > 0) dpi = ppm * 0.0254;
    }
    setDims(out, w, h, dpi);
  }
  var TIFF_COMP = { 1: "未壓縮", 2: "CCITT RLE", 3: "CCITT G3", 4: "CCITT G4", 5: "LZW", 6: "JPEG(舊)", 7: "JPEG",
    8: "Deflate", 32773: "PackBits", 32946: "Deflate" };
  function tiffInfo(b, out) {
    var le = b[0] === 0x49;
    function r16(o) { return le ? u16(b, o) : u16be(b, o); }
    function r32(o) { return le ? u32(b, o) : u32be(b, o); }
    if (r16(2) === 43) { out.notes.push("BigTIFF"); return; }
    var ifd = r32(4), pages = 0, seen = {}, first = null;
    while (ifd > 0 && ifd + 2 <= b.length && !seen[ifd] && pages < 5000) {
      seen[ifd] = true;
      var cnt = r16(ifd);
      if (cnt <= 0 || ifd + 2 + cnt * 12 > b.length) break;
      if (!first) {
        first = { w: 0, h: 0, bps: 1, spp: 1, comp: 1, xres: 0, unit: 2 };
        for (var i = 0; i < cnt; i++) {
          var e = ifd + 2 + i * 12, tag = r16(e), typ = r16(e + 2);
          var val = typ === 3 ? r16(e + 8) : r32(e + 8);
          if (tag === 256) first.w = val;
          else if (tag === 257) first.h = val;
          else if (tag === 258) first.bps = r32(e + 4) <= 2 ? r16(e + 8) : r16(r32(e + 8));
          else if (tag === 259) first.comp = val;
          else if (tag === 277) first.spp = val;
          else if (tag === 296) first.unit = val;
          else if (tag === 282 && typ === 5) { var den = r32(val + 4); first.xres = den > 0 ? r32(val) / den : 0; }
        }
      }
      pages++;
      ifd = r32(ifd + 2 + cnt * 12);
    }
    out.meta.pages = pages;
    if (!first) { out.notes.push("TIFF 結構損毀"); return; }
    var dpi = first.unit === 3 ? first.xres * 2.54 : first.unit === 2 ? first.xres : 0;
    out.meta.compression = TIFF_COMP[first.comp] || ("壓縮 " + first.comp);
    out.meta.bilevel = first.bps === 1 && first.spp === 1;
    setDims(out, first.w, first.h, dpi);
    out.notes.push((pages > 1 ? pages + " 頁，" : "") + out.meta.compression + (out.meta.bilevel ? "，黑白" : "，彩色／灰階"));
    if (!(out.meta.bilevel && (first.comp === 1 || first.comp === 3 || first.comp === 4))) {
      out.unsupported = "此 TIFF 為" + out.meta.compression + (out.meta.bilevel ? "" : "彩色／灰階") +
        "格式，瀏覽器無法直接讀取，請轉存為 PNG／JPG 或 PDF 後上傳（黑白 CCITT G3/G4 TIFF 可直接上傳）";
    }
  }
  function webpInfo(b, out) {
    var t = ascii(b, 12, 4), w = 0, h = 0;
    if (t === "VP8X") { w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
    else if (t === "VP8 ") { w = u16(b, 26) & 0x3FFF; h = u16(b, 28) & 0x3FFF; }
    else if (t === "VP8L" && b.length > 25) {
      var v = u32(b, 21);
      w = (v & 0x3FFF) + 1; h = (Math.floor(v / 16384) & 0x3FFF) + 1;
    }
    setDims(out, w, h, 0);
  }

  /* ======================================================================
   * 文字檔：編碼判斷 + 內容分類
   * ====================================================================== */
  var SAMPLE = 65536;
  function isUtf8(b) {
    var i = 0, n = b.length;
    while (i < n) {
      var c = b[i];
      if (c < 0x80) { i++; continue; }
      var k = c >= 0xF0 && c <= 0xF4 ? 3 : c >= 0xE0 ? 2 : c >= 0xC2 && c <= 0xDF ? 1 : -1;
      if (k < 0 || c > 0xF4) return false;
      if (i + k >= n) return true;                 // 取樣邊界截斷：視為合法
      for (var j = 1; j <= k; j++) if ((b[i + j] & 0xC0) !== 0x80) return false;
      i += k + 1;
    }
    return true;
  }
  /** 高位元組多數成對符合 Big5（lead 0x81–0xFE + trail 0x40–0x7E / 0xA1–0xFE） */
  function looksBig5(b) {
    var pairs = 0, bad = 0;
    for (var i = 0; i < b.length; i++) {
      var c = b[i];
      if (c < 0x80) continue;
      var t = b[i + 1];
      if (c >= 0x81 && c <= 0xFE && t !== undefined && ((t >= 0x40 && t <= 0x7E) || (t >= 0xA1 && t <= 0xFE))) { pairs++; i++; }
      else if (t !== undefined) bad++;
    }
    return pairs > 0 && bad <= pairs * 0.05;
  }
  /** → {enc, bom, start} | null（二進位） */
  function sniffEncoding(b) {
    if (startsWith(b, 0, [0xEF, 0xBB, 0xBF])) return { enc: "utf-8", bom: true, start: 3 };
    if (startsWith(b, 0, [0xFF, 0xFE])) return { enc: "utf-16le", bom: true, start: 2 };
    if (startsWith(b, 0, [0xFE, 0xFF])) return { enc: "utf-16be", bom: true, start: 2 };
    var s = b.subarray(0, Math.min(b.length, SAMPLE));
    // 無 BOM 的 UTF-16：奇數（或偶數）位置幾乎全是 0
    var n = Math.min(s.length & ~1, 1024), z0 = 0, z1 = 0;
    for (var i = 0; i < n; i += 2) { if (s[i] === 0) z0++; if (s[i + 1] === 0) z1++; }
    if (n >= 8) {
      if (z1 > n * 0.4 && z0 < n * 0.02) return { enc: "utf-16le", bom: false, start: 0 };
      if (z0 > n * 0.4 && z1 < n * 0.02) return { enc: "utf-16be", bom: false, start: 0 };
    }
    // 控制字元比例判斷二進位
    var ctrl = 0, high = 0;
    for (i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === 0) return null;
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) ctrl++;
      else if (c === 0x7F) ctrl++;
      else if (c >= 0x80) high++;
    }
    if (ctrl > s.length * 0.01 + 1) return null;
    if (!high) return { enc: "utf-8", bom: false, start: 0, ascii: true };
    if (isUtf8(s)) return { enc: "utf-8", bom: false, start: 0 };
    if (looksBig5(s)) return { enc: "big5", bom: false, start: 0 };
    return { enc: "windows-1252", bom: false, start: 0, guess: true };
  }
  var ENC_LABEL = { "utf-8": "UTF-8", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE", big5: "Big5",
    "windows-1252": "未知 8 位元編碼" };
  var DELIM_LABEL = { ",": "逗號分隔", "\t": "Tab 分隔", ";": "分號分隔", "|": "直線分隔" };

  function countOutside(line, d) {
    var n = 0, q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') q = !q;
      else if (ch === d && !q) n++;
    }
    return n;
  }
  /** 分隔符號偵測 → {delim, lines} | null */
  function sniffDelim(text, truncated) {
    var lines = text.split(/\r\n|\n|\r/);
    if (truncated && lines.length > 1) lines.pop();
    lines = lines.filter(function (l) { return /\S/.test(l); }).slice(0, 300);
    if (!lines.length) return null;
    var sep = /^\s*sep=(.)\s*$/i.exec(lines[0]);
    if (sep) return { delim: sep[1], lines: lines.length };
    var best = null;
    [",", "\t", ";", "|"].forEach(function (d) {
      var counts = lines.map(function (l) { return countOutside(d === "\t" ? l.replace(/^\s+/, "") : l, d); });
      var withD = 0, sum = 0, freq = {}, mode = 0, modeN = 0;
      counts.forEach(function (c) {
        if (c > 0) { withD++; sum += c; freq[c] = (freq[c] || 0) + 1; if (freq[c] > modeN) { modeN = freq[c]; mode = c; } }
      });
      if (!withD) return;
      var frac = withD / lines.length, modeFrac = modeN / withD, avg = sum / withD, ok;
      if (lines.length === 1) ok = (d === "," || d === "\t") && counts[0] >= 2;
      else if (d === ",") ok = frac >= 0.6 && (modeFrac >= 0.5 || avg >= 3);
      else if (d === "\t") ok = frac >= 0.5;
      else ok = frac >= 0.7 && modeFrac >= 0.6 && avg >= 1;
      var score = frac * modeFrac * Math.min(avg, 10);
      if (ok && (!best || score > best.score)) best = { delim: d, lines: lines.length, score: score };
    });
    return best;
  }

  function classifyText(b, ext, out) {
    var enc = sniffEncoding(b);
    if (!enc) return false;
    var end = Math.min(b.length, enc.start + SAMPLE), truncated = end < b.length;
    var text = decodeText(b.subarray(enc.start, end), enc.enc);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    out.meta.encoding = enc.enc;
    if (enc.bom) out.meta.bom = true;
    var encNote = (ENC_LABEL[enc.enc] || enc.enc) + (enc.bom ? "（含 BOM）" : "");
    var head = text.slice(0, 8192), lower = head.toLowerCase(), lead = lower.replace(/^\s+/, "");
    var ek = EXT_KIND[ext];

    if (/^\{\\rtf/.test(lead)) { out.kind = "rtf"; return true; }
    // MHTML（Excel/Word「單一檔案網頁」）
    if (/^(mime-version:|from:|subject:|date:|x-document-type:|content-type:)/.test(lead) &&
        /content-type:\s*multipart\/related/.test(lower)) {
      out.kind = "html";
      out.notes.push("MHTML 單一檔案網頁" + (/x-document-type:\s*workbook/.test(lower) ? "（Excel）" : ""));
      if (/x-document-type:\s*worddocument|urn:schemas-microsoft-com:office:word/.test(lower) ||
          ek === "doc" || ek === "docx") wordHtml(out);
      return true;
    }
    if (lead.charAt(0) === "<") {
      if (/urn:schemas-microsoft-com:office:spreadsheet|progid\s*=\s*"excel\.sheet"|<ss:workbook/.test(lower)) {
        out.kind = "xmlss"; out.notes.push(encNote); return true;
      }
      if (/progid\s*=\s*"word\.document"|schemas\.microsoft\.com\/office\/word\/2003\/wordml/.test(lower) ||
          /<w:worddocument|<pkg:package/.test(lower)) {
        out.kind = "wordxml"; return true;
      }
      if (/<html|<!doctype\s+html|<table|<head[\s>]|<body[\s>]|<meta[\s>]|<style[\s>]|<tr[\s>]|<td[\s>]/.test(lower)) {
        out.kind = "html";
        out.notes.push(encNote + (/<table/.test(text.toLowerCase()) ? "" : "，未見表格標籤"));
        if (/urn:schemas-microsoft-com:office:word/.test(lower) || ek === "doc" || ek === "docx") wordHtml(out);
        return true;
      }
      if (/^<\?xml/.test(lead) || /^<[a-z_][\w:.-]*[\s>\/]/.test(lead)) {
        out.kind = "txt"; out.notes.push("XML 文字檔，" + encNote); return true;
      }
    }
    // JSON（非表格）：完整樣本能 JSON.parse；超過取樣長度時看開頭
    if (ek !== "csv" && looksJson(text, truncated, lead)) {
      out.kind = "txt"; out.notes.push("JSON 文字檔，" + encNote); return true;
    }
    var d = sniffDelim(text, truncated);
    if (d || ek === "csv") {
      out.kind = "csv";
      if (d) out.meta.delimiter = d.delim;
      out.notes.push(encNote + (d ? "、" + (DELIM_LABEL[d.delim] || "分隔符號「" + d.delim + "」") : "、單欄"));
      return true;
    }
    out.kind = "txt";
    out.notes.push(/\S/.test(text) ? encNote : "內容空白");
    return true;
  }
  function looksJson(text, truncated, lead) {
    if (!/^[\[{]/.test(lead)) return false;
    if (truncated) return /^(\{\s*"[^"\n]*"\s*:|\[\s*[\[{"])/.test(lead);
    try { JSON.parse(text); return true; } catch (e) { return false; }
  }
  /** Word 另存的 HTML：SheetJS 仍可讀表格當原始資料，但不能當 Word 範本 */
  function wordHtml(out) {
    out.notes.push("Word 另存的網頁格式");
    out.accept = "raw";
    out.hint = "如要作為待填表格，" + HINT_SAVE_DOCX;
  }

  /* ======================================================================
   * 其他已知二進位格式（只為給出較清楚的說明）
   * ====================================================================== */
  var OTHER_SIGS = [
    { sig: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], note: "7-Zip 壓縮檔", hint: HINT_UNZIP },
    { sig: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07], note: "RAR 壓縮檔", hint: HINT_UNZIP },
    { sig: [0x1F, 0x8B], note: "GZIP 壓縮檔", hint: HINT_UNZIP },
    { sig: [0x4D, 0x5A], note: "Windows 執行檔", hint: "這是程式執行檔，不是報告檔案" },
    { sig: [0x4C, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], note: "Windows 捷徑 (.lnk)", hint: "這是捷徑，請上傳實際的報告檔案" },
    { sig: [0x25, 0x21, 0x50, 0x53], note: "PostScript 檔", hint: "請轉存為 PDF 後上傳" },
    { sig: [0x00, 0x00, 0x00, 0x0C, 0x6A, 0x50, 0x20, 0x20], note: "JPEG 2000 影像", hint: "瀏覽器無法讀取 JPEG 2000，請轉存為 PNG／JPG 後上傳" }
  ];

  /* ======================================================================
   * 主程式：detect(bytes, fileName) → 結果（同步）
   * ====================================================================== */
  function sniff(b, ext, out) {
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B &&
        ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8))) {
      if (classifyZip(b, ext, out)) return true;
      out.notes.push("ZIP 結構損毀");
    }
    if (startsWith(b, 0, CFB_SIG)) {
      if (classifyCfb(b, ext, out)) return true;
      out.notes.push("OLE2 複合文件結構損毀");
      return false;                     // 交給副檔名判斷
    }
    if (findAscii(b, "%PDF-", 0, 1024) >= 0) { out.kind = "pdf"; pdfInfo(b, out); return true; }
    if (startsWith(b, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) { out.kind = "png"; pngInfo(b, out); return true; }
    if (startsWith(b, 0, [0xFF, 0xD8, 0xFF])) { out.kind = "jpg"; jpegInfo(b, out); return true; }
    if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") {
      out.kind = "gif"; setDims(out, u16(b, 6), u16(b, 8), 0); return true;
    }
    if (startsWith(b, 0, [0x49, 0x49, 0x2A, 0x00]) || startsWith(b, 0, [0x4D, 0x4D, 0x00, 0x2A]) ||
        startsWith(b, 0, [0x49, 0x49, 0x2B, 0x00]) || startsWith(b, 0, [0x4D, 0x4D, 0x00, 0x2B])) {
      out.kind = "tif"; tiffInfo(b, out); return true;
    }
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") { out.kind = "webp"; webpInfo(b, out); return true; }
    if (ascii(b, 4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(ascii(b, 8, 4))) {
      out.kind = "heic"; return true;
    }
    if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4D) {
      var hs = u32(b, 14);
      if (hs === 12 || hs === 40 || hs === 52 || hs === 56 || hs === 64 || hs === 108 || hs === 124) {
        out.kind = "bmp"; bmpInfo(b, out); return true;
      }
    }
    // DocuWorks：自有完整結構檢查 → 截斷檢查 → xdw.js 的 isXdw（任一成立即是）
    var own = looksXdw(b), cut = !own && b.length > 16 && looksXdwTruncated(b);
    if (own || cut || delegatedIsXdw(b)) {
      out.kind = ext === "xbd" ? "xbd" : "xdw";
      if (b[0] === 0x25) { out.notes.push("舊版 DocuWorks 格式（可能無法讀取）"); out.meta.legacy = true; }
      else {
        var ver = xdwHeader(b);
        if (ver > 0) out.meta.version = ver;
        if (cut) {
          out.notes.push("DocuWorks 檔案結構不完整（可能未下載完整或已損毀）");
          out.meta.truncated = true;
        } else {
          out.notes.push("DocuWorks 二進位格式" + (ver > 0 ? "（版本 " + ver + "）" : ""));
        }
      }
      return true;
    }
    // 未包 OLE2 的 BIFF 串流（Excel 2.x–4.0 的 .xls，BOF 紀錄開頭）
    if (b.length >= 8 && b[0] === 0x09 && biffBareBof(b)) {
      out.kind = "xls"; out.notes.push(b[1] === 0x08 ? "Excel BIFF 串流（無 OLE2 外殼）" : "Excel 2.x–4.0 格式 (BIFF2–4)");
      return true;
    }
    for (var i = 0; i < OTHER_SIGS.length; i++) {
      if (startsWith(b, 0, OTHER_SIGS[i].sig)) {
        out.kind = "unknown"; out.notes.push(OTHER_SIGS[i].note); out.hint = OTHER_SIGS[i].hint; return true;
      }
    }
    return classifyText(b, ext, out);
  }

  function detect(bytes, fileName) {
    var b = toBytes(bytes), ext = extOf(fileName);
    var out = { kind: "unknown", notes: [], meta: {}, encrypted: false, by: "content",
      accept: null, hint: null, unsupported: null };
    if (!b.length) {
      out.kind = "empty";
    } else {
      var ok = false;
      try { ok = sniff(b, ext, out); } catch (e) {
        out.notes.push("格式解析錯誤：" + (e && e.message ? e.message : e));
        ok = false;
      }
      if (!ok) {
        // 內容無法判斷 → 依副檔名（仍標示信心不足）；文字類副檔名但內容為二進位 → 不採信
        var ek = EXT_KIND[ext];
        if (ek && ["csv", "txt", "html", "xmlss", "rtf"].indexOf(ek) < 0) {
          out.kind = ek; out.by = "ext";
          out.notes.push(ek === "xdw" || ek === "xbd"
            ? "未符合已知的 DocuWorks 結構，仍嘗試以 DocuWorks 解析"
            : "無法由內容確認為 " + KINDS[ek].label + "，依副檔名判斷（檔案可能損毀）");
        } else {
          out.kind = "unknown"; out.by = "none";
          out.notes.push(ek ? "副檔名為 ." + ext + "，但內容為二進位資料" : "二進位資料");
        }
      }
    }
    return finish(out, ext);
  }

  function finish(out, ext) {
    var kd = KINDS[out.kind] || KINDS.unknown, kind = KINDS[out.kind] ? out.kind : "unknown";
    var mismatch = out.by === "content" && !!ext && kind !== "empty" && !compatible(ext, kind) &&
      !(out.encrypted && kind === EXT_KIND[ext]);
    var label = kd.label, mtext = "";
    if (out.encrypted && kind !== "encrypted" && kind !== "pdf") label += "（已加密）";
    if (kind === "unknown") {
      if (ext) label += " (." + ext + ")";
      if (mismatch) mtext = "副檔名為 ." + ext + "，但內容不是 " + KINDS[EXT_KIND[ext]].label;
    } else if (mismatch) {
      label += "（副檔名為 ." + ext + "）";
      mtext = "副檔名為 ." + ext + "，實際為 " + kd.label;
    }
    var supported = kd.supported && !out.unsupported && !(out.encrypted && kind !== "pdf");
    var hint = out.unsupported || (out.encrypted && kind !== "pdf" ? HINT_PASSWORD : null) || out.hint || kd.hint;
    var notes = out.notes.filter(function (s, i, a) { return s && a.indexOf(s) === i; });
    return {
      kind: kind, family: kd.family, label: label, ext: ext, mismatch: mismatch,
      mismatchText: mtext,
      detail: notes.join("；"),
      route: supported ? kd.route : null, accept: out.accept || kd.accept, supported: supported,
      hint: hint || "", encrypted: !!out.encrypted, by: out.by,
      realExt: kd.ext || ext, mime: kd.mime, meta: out.meta
    };
  }

  /* ---------------- UI 輔助 ---------------- */
  var ACCEPT_RAW = [".xdw", ".xbd", ".pdf", ".docx", ".docm", ".doc", ".xlsx", ".xlsm", ".xls", ".xlsb", ".ods",
    ".csv", ".tsv", ".htm", ".html", ".xml", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp"];
  var ACCEPT_TPL = [".docx", ".docm", ".dotx", ".xlsx", ".xlsm", ".xltx", ".xls"];
  /** <input type=file accept="…">：role = "raw" | "template"（其他 → 兩者聯集） */
  function acceptAttr(role) {
    if (role === "raw") return ACCEPT_RAW.join(",");
    if (role === "template") return ACCEPT_TPL.join(",");
    return ACCEPT_RAW.concat(ACCEPT_TPL.filter(function (e) { return ACCEPT_RAW.indexOf(e) < 0; })).join(",");
  }
  /** 偵測結果能否用於指定角色 → {ok, reason}（reason 為中文說明；ok 時為副檔名不符提醒或 ''） */
  function canUse(res, role) {
    if (!res) return { ok: false, reason: "無檔案" };
    if (!res.supported) return { ok: false, reason: res.label + "：" + (res.hint || HINT_UNKNOWN) };
    if (role === "template" && res.accept === "raw") {
      return { ok: false, reason: res.label + " 不能作為待填表格；" +
        (res.hint || "待填表格請上傳 Word (.docx) 或 Excel (.xlsx / .xls) 檔") };
    }
    if (role === "raw" && res.accept === "template") return { ok: false, reason: res.label + " 只能作為待填表格" };
    return { ok: true, reason: res.mismatch ? res.mismatchText : "" };
  }

  YF.filetype = {
    detect: detect,
    KINDS: KINDS,
    acceptAttr: acceptAttr,
    canUse: canUse,
    extOf: extOf,
    kindOfExt: kindOfExt,
    // 以下供測試／其他模組使用
    zipEntries: function (bytes) { return zipEntries(toBytes(bytes)); },
    cfbEntries: function (bytes) {
      var r = cfbEntries(toBytes(bytes));
      return r ? { entries: r.entries, version: r.version, sectorSize: r.sectorSize, warnings: r.warnings } : null;
    },
    looksXdw: function (bytes) { return looksXdw(toBytes(bytes)); }
  };
})(typeof window !== "undefined" ? window : globalThis);
