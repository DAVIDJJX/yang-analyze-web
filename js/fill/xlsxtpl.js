/* =========================================================================
 * Yang-analyze web — fill/xlsxtpl.js
 * Excel 範本（.xlsx/.xlsm/.xls/.csv/.html/.xmlss…）表格讀取與填寫：
 *   load：以 SheetJS 讀值（格式化文字優先），每張工作表依「連續 ≥ 2 列全空」切成區塊，
 *         合併儲存格 → 跨距，轉成共用 FTable；ref = {sheet, addr}。
 *   fill：.xlsx/.xlsm 直接修補套件內的工作表 XML（不經 SheetJS 寫出，樣式完整保留）：
 *         數字寫成數值並套用「與回報小數位數相同」的數字格式，其他（<10、ND、-）寫成文字；
 *         覆蓋公式時同步處理共用公式與 calcChain。舊格式改用 SheetJS 重新寫出（格式可能遺失）。
 * DOMParser / XMLSerializer 可由 setXml 注入（Node 測試）。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var XML_NS = "http://www.w3.org/XML/1998/namespace";
  var R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  var impl = {
    DOMParser: typeof root.DOMParser === "function" ? root.DOMParser : null,
    XMLSerializer: typeof root.XMLSerializer === "function" ? root.XMLSerializer : null
  };
  /** 注入 XML 實作：{DOMParser, XMLSerializer} */
  function setXml(o) {
    if (o && o.DOMParser) impl.DOMParser = o.DOMParser;
    if (o && o.XMLSerializer) impl.XMLSerializer = o.XMLSerializer;
  }
  function xlError(msg) { var e = new Error(msg); e.name = "XlsxError"; return e; }
  function X() {
    if (!root.XLSX || typeof root.XLSX.read !== "function") throw xlError("缺少 SheetJS（lib/xlsx.full.min.js），無法讀取 Excel 檔");
    return root.XLSX;
  }

  var MIME = {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    xltm: "application/vnd.ms-excel.template.macroEnabled.12",
    xls: "application/vnd.ms-excel", xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    ods: "application/vnd.oasis.opendocument.spreadsheet", csv: "text/csv"
  };

  /* ---------------- 一般工具 ---------------- */
  function toBytes(d) {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (d && ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    throw xlError("Excel 讀取失敗：不支援的資料型別");
  }
  function extOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }
  function cleanText(s) {
    return String(s).replace(/\r\n?/g, "\n").split("\n")
      .map(function (x) { return x.replace(/^[\s　 ]+|[\s　 ]+$/g, ""); })
      .join("\n").replace(/^\n+|\n+$/g, "");
  }
  function colName(c) { // 0 → A
    var s = ""; c++;
    while (c > 0) { var r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }
  function addrOf(r, c) { return colName(c) + (r + 1); }
  function parseAddr(a) {
    var m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a || "").trim());
    if (!m) return null;
    var col = 0, s = m[1].toUpperCase();
    for (var i = 0; i < s.length; i++) col = col * 26 + (s.charCodeAt(i) - 64);
    return { r: parseInt(m[2], 10) - 1, c: col - 1 };
  }
  function decodeText(u8) {
    var start = (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) ? 3 : 0;
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8.subarray(2));
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8.subarray(2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8.subarray(start)); } catch (e) { /* 非 UTF-8 */ }
    try { return new TextDecoder("big5").decode(u8); } catch (e2) { /* 無 Big5 */ }
    return new TextDecoder("latin1").decode(u8);
  }
  function looksText(u8) {
    var n = Math.min(u8.length, 4096);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return true;
    if (u8[0] === 0xFE && u8[1] === 0xFF) return true;
    for (var i = 0; i < n; i++) if (u8[i] === 0) return false;
    return true;
  }

  /* ---------------- SheetJS 讀取 ---------------- */
  function readWorkbook(u8, kind) {
    var XL = X(), opts = { type: "array", cellFormula: true, cellNF: true, cellText: true, sheetStubs: true,
                           cellDates: false, cellStyles: false };
    try {
      if (kind === "csv" || kind === "html" || kind === "xmlss" || kind === "txt") {
        opts.type = "string";
        return XL.read(decodeText(u8), opts);
      }
      return XL.read(u8, opts);
    } catch (e) {
      var msg = String(e && e.message || e);
      var isZip = u8 && u8[0] === 0x50 && u8[1] === 0x4B;
      // 有密碼的 .xlsx 實際是 OLE（CFB）容器；ZIP 檔出現「加密」字樣多半是檔案損毀
      if (/password|encrypt/i.test(msg) && !isZip) throw xlError("Excel 檔有密碼保護，請先移除密碼再上傳");
      if (isZip || /compressed size|crc|inflate|corrupt|unexpected end/i.test(msg)) {
        throw xlError("試算表檔案損毀或不完整，無法讀取（" + msg + "）；請用 Excel 開啟確認後另存新檔再上傳");
      }
      throw xlError("無法讀取試算表（" + msg + "）");
    }
  }

  /** 儲存格顯示文字：格式化文字 w 優先；無快取值的公式以 "=公式" 表示（避免被當成空白格） */
  function cellText(cell) {
    if (!cell) return "";
    if (cell.t === "z") return cell.f ? "=" + cell.f : "";
    var s;
    if (cell.w !== undefined && cell.w !== null) s = String(cell.w);
    else if (cell.v !== undefined && cell.v !== null) s = String(cell.v);
    else s = cell.f ? "=" + cell.f : "";
    return cleanText(s);
  }

  /* ---------------- 區塊切分 ---------------- */
  /**
   * 工作表 → FTable 區塊：
   *   佔用 = 有值 / 有存在的儲存格（含只有樣式的空白格）/ 合併範圍
   *   列方向：連續 ≥ minGap 列全空 → 分成不同區塊；欄方向同理再切一次
   *   區塊內完全空的列/欄（無任何儲存格）直接略過，邏輯座標連續編號
   *   區塊第一列若只有一格文字（標題列），作為表名，不列入表格
   */
  function sheetBlocks(ws, sheetName, opts, budget, warnings) {
    var minGap = opts.minGap || 2;
    var occ = {}, rowsSet = {}, merges = ws["!merges"] || [];
    Object.keys(ws).forEach(function (k) {
      if (k.charAt(0) === "!") return;
      var a = parseAddr(k);
      if (!a) return;
      (occ[a.r] = occ[a.r] || {})[a.c] = true;
      rowsSet[a.r] = true;
    });
    merges.forEach(function (m) {
      for (var r = m.s.r; r <= m.e.r; r++) {
        rowsSet[r] = true;
        var o = occ[r] = occ[r] || {};
        for (var c = m.s.c; c <= m.e.c; c++) o[c] = true;
      }
    });
    var rows = Object.keys(rowsSet).map(Number).sort(function (a, b) { return a - b; });
    if (!rows.length) return [];
    // 列方向分群
    var groups = [], cur = [rows[0]];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i] - rows[i - 1] - 1 >= minGap) { groups.push(cur); cur = []; }
      cur.push(rows[i]);
    }
    groups.push(cur);
    // 欄方向再分群
    var rects = [];
    groups.forEach(function (g) {
      var colsSet = {};
      g.forEach(function (r) { Object.keys(occ[r] || {}).forEach(function (c) { colsSet[c] = true; }); });
      var cols = Object.keys(colsSet).map(Number).sort(function (a, b) { return a - b; });
      var cg = [cols[0]];
      for (var j = 1; j <= cols.length; j++) {
        if (j === cols.length || cols[j] - cols[j - 1] - 1 >= minGap) {
          var cs = cg.slice();
          var rs = g.filter(function (r) { return cs.some(function (c) { return occ[r] && occ[r][c]; }); });
          if (rs.length) rects.push({ rows: rs, cols: cs });
          cg = [];
        }
        if (j < cols.length) cg.push(cols[j]);
      }
    });
    // 合併範圍索引：左上角 → 合併；被覆蓋（非左上角）的格子
    var mergeAt = {}, covered = {}, bigMerges = [];
    merges.forEach(function (m) {
      mergeAt[m.s.r + ":" + m.s.c] = m;
      if ((m.e.r - m.s.r + 1) * (m.e.c - m.s.c + 1) > 20000) { bigMerges.push(m); return; }
      for (var r = m.s.r; r <= m.e.r; r++) {
        for (var c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered[r + ":" + c] = true;
      }
    });
    function coveredNonTopLeft(r, c) {
      if (covered[r + ":" + c]) return true;
      for (var k = 0; k < bigMerges.length; k++) {
        var m = bigMerges[k];
        if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) return !(r === m.s.r && c === m.s.c);
      }
      return false;
    }
    var out = [];
    rects.forEach(function (rect) {
      var rs = rect.rows.slice(), cs = rect.cols;
      var title = "";
      // 標題列偵測
      if (rs.length >= 2) {
        var r0 = rs[0], nonEmpty = [];
        cs.forEach(function (c) {
          var t = cellText(ws[addrOf(r0, c)]);
          if (t) nonEmpty.push({ c: c, t: t });
        });
        if (nonEmpty.length === 1) {
          var m0 = mergeAt[r0 + ":" + nonEmpty[0].c], t0 = nonEmpty[0].t;
          var capEnd = m0 ? m0.e.r : r0;               // 標題若跨多列，一併移除
          var nextRow = rs.filter(function (r) { return r > capEnd; })[0];
          var fullWidth = !!m0 && m0.s.c <= cs[0] && m0.e.c >= cs[cs.length - 1] && cs.length >= 2;
          var nextCount = 0;
          if (nextRow !== undefined) cs.forEach(function (c) { if (cellText(ws[addrOf(nextRow, c)])) nextCount++; });
          var looksCaption = nextRow !== undefined && (
            /^\s*(附?表|Table)\s*[\dA-Za-z一二三四五六七八九十]/.test(t0) ||
            (!m0 && nonEmpty[0].c === cs[0] && nextCount >= 2 && cs.length >= 2 && t0.length >= 4 && !/^[\d.\-+<>]+$/.test(t0)) ||
            (fullWidth && nextCount >= 1 && (nextRow - capEnd > 1 || capEnd > r0)));
          if (looksCaption) {
            title = t0.replace(/\n/g, " ");
            rs = rs.filter(function (r) { return r > capEnd; });
          }
        }
      }
      // 區塊內完全沒有儲存格的列 / 欄略過
      rs = rs.filter(function (r) { return cs.some(function (c) { return occ[r] && occ[r][c]; }); });
      var cols = cs.filter(function (c) { return rs.some(function (r) { return occ[r] && occ[r][c]; }); });
      if (!rs.length || !cols.length) return;
      var rIdx = {}, cIdx = {};
      rs.forEach(function (r, k) { rIdx[r] = k; });
      cols.forEach(function (c, k) { cIdx[c] = k; });
      function lastIdx(map, list, from, to) {   // 合併範圍末端 → 邏輯索引（不超出區塊）
        var best = map[from];
        list.forEach(function (v) { if (v >= from && v <= to) best = Math.max(best, map[v]); });
        return best;
      }
      var cells = [];
      for (var a = 0; a < rs.length; a++) {
        for (var b = 0; b < cols.length; b++) {
          var r = rs[a], c = cols[b];
          if (coveredNonTopLeft(r, c)) continue;
          if (budget.left <= 0) { budget.truncated = true; break; }
          budget.left--;
          var m = mergeAt[r + ":" + c];
          var cell = { r0: a, r1: a, c0: b, c1: b, text: cellText(ws[addrOf(r, c)]), conf: null, bbox: null,
                       ref: { sheet: sheetName, addr: addrOf(r, c) } };
          if (m) { cell.r1 = lastIdx(rIdx, rs, r, m.e.r); cell.c1 = lastIdx(cIdx, cols, c, m.e.c); }
          cells.push(cell);
        }
      }
      out.push({
        id: "s:" + sheetName + ":b" + out.length, page: null, sheet: sheetName, index: out.length,
        title: title || sheetName, caption: title, context: title ? [sheetName, title] : [sheetName],
        nRows: rs.length, nCols: cols.length, cells: cells,
        range: addrOf(rs[0], cols[0]) + ":" + addrOf(rs[rs.length - 1], cols[cols.length - 1])
      });
    });
    return out;
  }

  /* ---------------- 套件判斷 ---------------- */
  function attrRe(tag, name) {
    var m = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')").exec(tag);
    return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
  }
  /** [Content_Types].xml 中某個 part 的 ContentType */
  function partContentType(ct, part) {
    var re = /<(?:\w+:)?Override\b[^>]*>/g, m, want = "/" + part.toLowerCase();
    while ((m = re.exec(ct))) {
      var pn = attrRe(m[0], "PartName");
      if (pn && pn.toLowerCase() === want) return attrRe(m[0], "ContentType") || "";
    }
    return "";
  }
  function officeTarget(zip) {
    if (!zip.has("_rels/.rels")) return Promise.resolve(null);
    return zip.text("_rels/.rels").then(function (t) {
      var re = /<(?:\w+:)?Relationship\b[^>]*>/g, m;
      while ((m = re.exec(t))) {
        var type = attrRe(m[0], "Type"), tgt = attrRe(m[0], "Target");
        if (type && tgt && /\/officeDocument$/.test(type)) return tgt.replace(/^\/+/, "");
      }
      return null;
    });
  }

  /**
   * load(bytes, fileName, opts?) → Promise<XlsxModel>
   * XlsxModel = { kind, ext, fileName, format: "ooxml"|"sheetjs", tables:[FTable], sheets:[{name, hidden}],
   *               warnings, info, bytes, zip?, wbPart? }
   */
  function load(bytes, fileName, opts) {
    opts = opts || {};
    return new Promise(function (resolve) { resolve(toBytes(bytes)); }).then(function (u8) {
      var ext = extOf(fileName), model = { kind: ext || "xlsx", ext: ext, fileName: fileName || "", format: "sheetjs",
        tables: [], sheets: [], warnings: [], info: "", bytes: u8, zip: null, wbPart: null };
      var pre = Promise.resolve(null);
      if (YF.zip && YF.zip.isZip(u8)) {
        pre = YF.zip.read(u8).then(function (zip) {
          return officeTarget(zip).then(function (t) {
            var target = t || (zip.has("xl/workbook.xml") ? "xl/workbook.xml" : null);
            if (target && /\.xml$/i.test(target) && zip.has(target)) {
              model.zip = zip; model.format = "ooxml"; model.wbPart = zip.find(target);
              return zip.has("[Content_Types].xml") ? zip.text("[Content_Types].xml") : "";
            }
            if (target && /\.bin$/i.test(target)) model.kind = "xlsb";
            else if (zip.has("mimetype") || zip.has("content.xml")) model.kind = "ods";
            return null;
          });
        }, function () { return null; });
      } else if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) {
        model.kind = "xls";
      } else if (looksText(u8)) {
        var head = decodeText(u8.subarray(0, Math.min(u8.length, 8192))).toLowerCase();
        if (head.indexOf("urn:schemas-microsoft-com:office:spreadsheet") >= 0) model.kind = "xmlss";
        else if (/<html|<table|<!doctype html/.test(head)) model.kind = "html";
        else model.kind = "csv";
      }
      return pre.then(function (ct) {
        if (model.format === "ooxml") {
          var type = partContentType(String(ct || ""), model.wbPart);
          var macro = /macroEnabled/i.test(type) || model.zip.has("xl/vbaProject.bin");
          var tmpl = /template/i.test(type);
          model.kind = tmpl ? (macro ? "xltm" : "xltx") : (macro ? "xlsm" : "xlsx");
        }
        var wb = readWorkbook(u8, model.kind);
        model.wb = wb;
        var wbSheets = (wb.Workbook && wb.Workbook.Sheets) || [];
        var budget = { left: opts.maxCells || 300000, truncated: false };
        wb.SheetNames.forEach(function (name, i) {
          var hidden = !!(wbSheets[i] && wbSheets[i].Hidden);
          model.sheets.push({ name: name, hidden: hidden });
          var ws = wb.Sheets[name];
          if (!ws) return;
          sheetBlocks(ws, name, opts, budget, model.warnings).forEach(function (t) {
            t.index = model.tables.filter(function (x) { return x.sheet === name; }).length;
            if (hidden) t.hidden = true;
            model.tables.push(t);
          });
        });
        if (budget.truncated) model.warnings.push("試算表儲存格過多，只讀取前 " + (opts.maxCells || 300000) + " 格");
        if (!model.tables.length) model.warnings.push("試算表中沒有任何資料");
        if (model.format !== "ooxml") {
          model.warnings.push(model.kind === "csv" ? "CSV 檔輸出時沿用 CSV 格式（無框線、字型）"
            : "此格式（." + (model.ext || model.kind) + "）輸出時將以 SheetJS 重新寫出，框線、字型、底色等格式可能遺失；建議先另存為 .xlsx 再上傳");
        }
        // 輸出副檔名（與 fill() 實際寫出的格式一致，供畫面顯示檔名）
        if (model.format === "ooxml") model.outExt = /^(xlsm|xltm)$/.test(model.kind) ? "xlsm" : "xlsx";
        else model.outExt = model.kind === "csv" ? "csv" : model.kind === "xlsb" ? "xlsb" : model.kind === "ods" ? "ods" : "xls";
        var blanks = 0;
        model.tables.forEach(function (t) { t.cells.forEach(function (c) { if (!c.text) blanks++; }); });
        model.info = model.sheets.length + " 張工作表、" + model.tables.length + " 個表格區塊" +
          (blanks ? "、" + blanks + " 個空白儲存格" : "");
        return model;
      });
    });
  }

  /* ---------------- XML 工具 ---------------- */
  function parseXml(text, part) {
    if (!impl.DOMParser) throw xlError("此環境沒有 DOMParser，無法寫出 Excel 檔");
    var doc;
    try { doc = new impl.DOMParser().parseFromString(text, "application/xml"); }
    catch (e) { throw xlError("Excel 檔內容（" + part + "）XML 格式錯誤，檔案可能損毀"); }
    var de = doc && doc.documentElement;
    if (!de || de.localName === "parsererror" || doc.getElementsByTagName("parsererror").length) {
      throw xlError("Excel 檔內容（" + part + "）XML 格式錯誤，檔案可能損毀");
    }
    return doc;
  }
  function xmlDecl(text) {
    var m = /^﻿?(<\?xml[^?]*\?>[ \t]*\r?\n?)/.exec(text);
    return m ? m[1] : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  }
  function serialize(doc, decl) {
    if (!impl.XMLSerializer) throw xlError("此環境沒有 XMLSerializer，無法寫出 Excel 檔");
    var s = new impl.XMLSerializer().serializeToString(doc);
    return (decl || "") + s.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
  }
  function kids(el, name) {
    var out = [], c = el ? el.childNodes : null;
    if (!c) return out;
    for (var i = 0; i < c.length; i++) {
      if (c[i].nodeType === 1 && (!name || c[i].localName === name)) out.push(c[i]);
    }
    return out;
  }
  function child(el, name) { var k = kids(el, name); return k.length ? k[0] : null; }
  function mk(doc, name) {
    var de = doc.documentElement;
    return doc.createElementNS(de.namespaceURI, de.prefix ? de.prefix + ":" + name : name);
  }
  /** 依 schema 順序插入子元素：order 為該父元素的子元素名稱順序 */
  function insertInOrder(parent, el, order) {
    var idx = order.indexOf(el.localName), ks = kids(parent);
    for (var i = 0; i < ks.length; i++) {
      var j = order.indexOf(ks[i].localName);
      if (j > idx) { parent.insertBefore(el, ks[i]); return el; }
    }
    parent.appendChild(el);
    return el;
  }
  function resolveTarget(baseDir, target) {
    if (/^\//.test(target)) return target.replace(/^\/+/, "");
    var parts = (baseDir ? baseDir.split("/") : []).concat(target.split("/")), out = [];
    parts.forEach(function (p) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); });
    return out.join("/");
  }
  function relsPathOf(part) {
    var i = part.lastIndexOf("/");
    return (i >= 0 ? part.slice(0, i + 1) : "") + "_rels/" + part.slice(i + 1) + ".rels";
  }

  /* ---------------- 樣式（styles.xml） ---------------- */
  var BUILTIN_FMT = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%",
    11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 49: "@" };
  var STYLE_ORDER = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs",
    "tableStyles", "colors", "extLst"];

  function Styles(doc) {
    this.doc = doc; this.changed = false; this.cache = {};
    var ss = doc.documentElement;
    this.root = ss;
    this.cellXfs = child(ss, "cellXfs");
    if (!this.cellXfs) {
      this.cellXfs = insertInOrder(ss, mk(doc, "cellXfs"), STYLE_ORDER);
      var x0 = mk(doc, "xf");
      ["numFmtId", "fontId", "fillId", "borderId", "xfId"].forEach(function (a) { x0.setAttribute(a, "0"); });
      this.cellXfs.appendChild(x0);
    }
    this.xfs = kids(this.cellXfs, "xf");
    this.sigs = {};
    var self = this, ser = new impl.XMLSerializer();
    this.ser = ser;
    this.xfs.forEach(function (x, i) { var k = self.sig(x); if (!(k in self.sigs)) self.sigs[k] = i; });
  }
  Styles.prototype.sig = function (el) {
    return this.ser.serializeToString(el).replace(/\s+xmlns(:\w+)?="[^"]*"/g, "");
  };
  Styles.prototype.fmtCode = function (id) {
    if (id in BUILTIN_FMT) return BUILTIN_FMT[id];
    var nf = child(this.root, "numFmts");
    var list = kids(nf, "numFmt");
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute("numFmtId") === String(id)) return list[i].getAttribute("formatCode");
    return null;
  };
  Styles.prototype.fmtId = function (code) {
    for (var b in BUILTIN_FMT) if (BUILTIN_FMT[b] === code) return Number(b);
    var nf = child(this.root, "numFmts");
    if (!nf) { nf = insertInOrder(this.root, mk(this.doc, "numFmts"), STYLE_ORDER); nf.setAttribute("count", "0"); }
    var list = kids(nf, "numFmt"), maxId = 163;
    for (var i = 0; i < list.length; i++) {
      var id = parseInt(list[i].getAttribute("numFmtId"), 10);
      if (list[i].getAttribute("formatCode") === code) return id;
      if (id > maxId) maxId = id;
    }
    var el = mk(this.doc, "numFmt");
    el.setAttribute("numFmtId", String(maxId + 1));
    el.setAttribute("formatCode", code);
    nf.appendChild(el);
    nf.setAttribute("count", String(list.length + 1));
    this.changed = true;
    return maxId + 1;
  };
  Styles.prototype.yellowFill = function () {
    if (this._yellow !== undefined) return this._yellow;
    var fills = child(this.root, "fills");
    if (!fills) {
      fills = insertInOrder(this.root, mk(this.doc, "fills"), STYLE_ORDER);
      // 依規範 0、1 號必須為 none / gray125
      ["none", "gray125"].forEach(function (pt) {
        var f = mk(this.doc, "fill"), p = mk(this.doc, "patternFill");
        p.setAttribute("patternType", pt); f.appendChild(p); fills.appendChild(f);
      }, this);
    }
    var f = mk(this.doc, "fill"), pf = mk(this.doc, "patternFill"), fg = mk(this.doc, "fgColor"), bg = mk(this.doc, "bgColor");
    pf.setAttribute("patternType", "solid");
    fg.setAttribute("rgb", "FFFFFF00"); bg.setAttribute("indexed", "64");
    pf.appendChild(fg); pf.appendChild(bg); f.appendChild(pf);
    var list = kids(fills, "fill"), sig = this.sig(f);
    for (var i = 0; i < list.length; i++) if (this.sig(list[i]) === sig) { this._yellow = i; return i; }
    fills.appendChild(f);
    fills.setAttribute("count", String(list.length + 1));
    this.changed = true;
    this._yellow = list.length;
    return this._yellow;
  };
  /** 回傳以 sIdx 為底、套用指定數字格式 / 黃底後的 cellXfs 索引（相同者重複利用） */
  Styles.prototype.derive = function (sIdx, code, yellow) {
    var key = sIdx + "|" + (code || "") + "|" + (yellow ? 1 : 0);
    if (key in this.cache) return this.cache[key];
    var base = this.xfs[sIdx] || this.xfs[0];
    var clone = base.cloneNode(true), need = false;
    if (code !== null && code !== undefined) {
      var cur = parseInt(clone.getAttribute("numFmtId") || "0", 10);
      if (this.fmtCode(cur) !== code) {
        clone.setAttribute("numFmtId", String(this.fmtId(code)));
        clone.setAttribute("applyNumberFormat", "1");
        need = true;
      }
    }
    if (yellow) {
      var fid = this.yellowFill();
      if (clone.getAttribute("fillId") !== String(fid)) {
        clone.setAttribute("fillId", String(fid));
        clone.setAttribute("applyFill", "1");
        need = true;
      }
    }
    var out = sIdx;
    if (need) {
      var sig = this.sig(clone);
      if (sig in this.sigs) out = this.sigs[sig];
      else {
        this.cellXfs.appendChild(clone);
        this.xfs.push(clone);
        out = this.xfs.length - 1;
        this.sigs[sig] = out;
        this.cellXfs.setAttribute("count", String(this.xfs.length));
        this.changed = true;
      }
    }
    this.cache[key] = out;
    return out;
  };

  /* ---------------- 數值判斷與格式 ---------------- */
  var NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
  function numericInfo(v) {
    var s = String(v).trim();
    if (!NUM_RE.test(s)) return null;
    if (/^-0(\.0+)?$/.test(s)) return null;                    // -0 保留文字
    var digits = s.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
    if (digits.length > 15) return null;                       // 超過 Excel 精度 → 文字
    var dec = s.indexOf(".") >= 0 ? s.length - s.indexOf(".") - 1 : 0;
    var code = dec ? "0." + new Array(dec + 1).join("0") : "0";
    return { text: s, num: Number(s), v: String(Number(s)), decimals: dec, code: code };
  }

  /* ---------------- 工作表修補 ---------------- */
  function SheetPatch(doc) {
    this.doc = doc;
    var ws = doc.documentElement;
    this.ws = ws;
    this.sheetData = child(ws, "sheetData");
    if (!this.sheetData) {
      this.sheetData = mk(doc, "sheetData");
      var after = child(ws, "cols") || child(ws, "sheetFormatPr") || child(ws, "sheetViews") ||
                  child(ws, "dimension") || child(ws, "sheetPr");
      if (after && after.nextSibling) ws.insertBefore(this.sheetData, after.nextSibling);
      else if (after) ws.appendChild(this.sheetData);
      else ws.insertBefore(this.sheetData, ws.firstChild);
    }
    // 列編號正規化（r 屬性可省略）
    var prev = 0, self = this;
    this.rows = [];
    kids(this.sheetData, "row").forEach(function (row) {
      var r = parseInt(row.getAttribute("r"), 10);
      if (!(r > 0)) { r = prev + 1; row.setAttribute("r", String(r)); }
      prev = r;
      self.rows.push({ r: r, el: row });
    });
    this.colStyles = [];
    kids(child(ws, "cols"), "col").forEach(function (c) {
      var st = c.getAttribute("style");
      if (st) self.colStyles.push({ min: +c.getAttribute("min"), max: +c.getAttribute("max"), s: st });
    });
    this.maxR = 0; this.maxC = 0; this.minR = Infinity; this.minC = Infinity;
    this.formulaRemoved = false; this.sharedMasters = []; this.filled = [];
  }
  SheetPatch.prototype.row = function (r1) {   // r1：1 起算
    for (var i = 0; i < this.rows.length; i++) {
      if (this.rows[i].r === r1) return this.rows[i].el;
      if (this.rows[i].r > r1) break;
    }
    var row = mk(this.doc, "row");
    row.setAttribute("r", String(r1));
    var next = this.rows[i] ? this.rows[i].el : null;
    if (next) this.sheetData.insertBefore(row, next); else this.sheetData.appendChild(row);
    this.rows.splice(i, 0, { r: r1, el: row });
    return row;
  };
  SheetPatch.prototype.cell = function (rowEl, r, c) {
    var cs = kids(rowEl, "c"), prev = -1, addr = addrOf(r, c), next = null;
    for (var i = 0; i < cs.length; i++) {
      var a = parseAddr(cs[i].getAttribute("r"));
      var col = a ? a.c : prev + 1;
      if (!a) cs[i].setAttribute("r", addrOf(r, col));
      prev = col;
      if (col === c) return cs[i];
      if (col > c && !next) next = cs[i];
    }
    var el = mk(this.doc, "c");
    el.setAttribute("r", addr);
    // 新儲存格沿用列樣式或欄樣式
    var s = null;
    if (rowEl.getAttribute("customFormat") === "1" || rowEl.getAttribute("customFormat") === "true") s = rowEl.getAttribute("s");
    if (!s) {
      for (var k = 0; k < this.colStyles.length; k++) {
        var cst = this.colStyles[k];
        if (c + 1 >= cst.min && c + 1 <= cst.max) { s = cst.s; break; }
      }
    }
    if (s && s !== "0") el.setAttribute("s", s);
    if (!next) next = child(rowEl, "extLst");
    if (next) rowEl.insertBefore(el, next); else rowEl.appendChild(el);
    // 更新 spans 提示
    var sp = /^(\d+):(\d+)$/.exec(rowEl.getAttribute("spans") || "");
    if (sp) rowEl.setAttribute("spans", Math.min(+sp[1], c + 1) + ":" + Math.max(+sp[2], c + 1));
    return el;
  };
  SheetPatch.prototype.set = function (addr, value, mark, styles) {
    var a = parseAddr(addr);
    if (!a) return false;
    var rowEl = this.row(a.r + 1), c = this.cell(rowEl, a.r, a.c), doc = this.doc, self = this;
    kids(c).forEach(function (k) {
      if (k.localName === "f") {
        self.formulaRemoved = true;
        if (k.getAttribute("t") === "shared" && k.getAttribute("ref") && k.getAttribute("si") !== null) {
          self.sharedMasters.push(k.getAttribute("si"));
        }
      }
      if (k.localName === "f" || k.localName === "v" || k.localName === "is") c.removeChild(k);
    });
    ["t", "cm", "vm", "ph"].forEach(function (n) { if (c.hasAttribute(n)) c.removeAttribute(n); });
    var info = numericInfo(value);
    var sIdx = parseInt(c.getAttribute("s") || "0", 10) || 0;
    var ext = child(c, "extLst");
    if (info) {
      var v = mk(doc, "v");
      v.appendChild(doc.createTextNode(info.v));
      if (ext) c.insertBefore(v, ext); else c.appendChild(v);
      if (styles) {
        var code = rendersExactly(styles.fmtCode(parseInt((styles.xfs[sIdx] || styles.xfs[0]).getAttribute("numFmtId") || "0", 10)), info) ? null : info.code;
        sIdx = styles.derive(sIdx, code, mark);
      }
    } else {
      c.setAttribute("t", "inlineStr");
      var is = mk(doc, "is"), t = mk(doc, "t"), sv = String(value);
      if (/^\s|\s$|\n/.test(sv)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.appendChild(doc.createTextNode(sv));
      is.appendChild(t);
      if (ext) c.insertBefore(is, ext); else c.appendChild(is);
      if (styles && mark) sIdx = styles.derive(sIdx, null, true);
    }
    if (sIdx) c.setAttribute("s", String(sIdx)); else if (c.hasAttribute("s")) c.removeAttribute("s");
    this.filled.push(a);
    this.maxR = Math.max(this.maxR, a.r); this.maxC = Math.max(this.maxC, a.c);
    this.minR = Math.min(this.minR, a.r); this.minC = Math.min(this.minC, a.c);
    return true;
  };
  /** 被覆蓋的共用公式主格 → 其他引用同 si 的儲存格改為純值（保留快取值），避免 Excel 要求修復 */
  SheetPatch.prototype.fixShared = function () {
    if (!this.sharedMasters.length) return;
    var set = {};
    this.sharedMasters.forEach(function (si) { set[si] = true; });
    var fs = this.sheetData.getElementsByTagNameNS(this.ws.namespaceURI, "f"), list = [];
    for (var i = 0; i < fs.length; i++) list.push(fs[i]);
    list.forEach(function (f) {
      if (f.getAttribute("t") === "shared" && set[f.getAttribute("si")]) f.parentNode.removeChild(f);
    });
  };
  /** 填寫的格子落在陣列公式 / 運算列表範圍內 → 移除該公式（保留快取值），否則 Excel 會要求修復 */
  SheetPatch.prototype.fixArrays = function () {
    if (!this.filled.length) return;
    var fs = this.sheetData.getElementsByTagNameNS(this.ws.namespaceURI, "f"), list = [], self = this;
    for (var i = 0; i < fs.length; i++) list.push(fs[i]);
    list.forEach(function (f) {
      var t = f.getAttribute("t"), ref = f.getAttribute("ref");
      if ((t !== "array" && t !== "dataTable") || !ref) return;
      var p = ref.split(":"), a = parseAddr(p[0]), b = parseAddr(p[1] || p[0]);
      if (!a || !b) return;
      var hit = self.filled.some(function (x) { return x.r >= a.r && x.r <= b.r && x.c >= a.c && x.c <= b.c; });
      if (hit) { f.parentNode.removeChild(f); self.formulaRemoved = true; }
    });
  };
  SheetPatch.prototype.fixDimension = function () {
    if (this.maxR < this.minR) return;
    var dim = child(this.ws, "dimension");
    if (!dim) return;
    var ref = String(dim.getAttribute("ref") || ""), p = ref.split(":");
    var a = parseAddr(p[0]), b = parseAddr(p[1] || p[0]);
    if (!a || !b) return;
    var r0 = Math.min(a.r, this.minR), c0 = Math.min(a.c, this.minC);
    var r1 = Math.max(b.r, this.maxR), c1 = Math.max(b.c, this.maxC);
    dim.setAttribute("ref", r0 === r1 && c0 === c1 ? addrOf(r0, c0) : addrOf(r0, c0) + ":" + addrOf(r1, c1));
  };
  /** 目前的數字格式是否已固定顯示回報的小數位數（General 會依欄寬四捨五入，不算） */
  function rendersExactly(code, info) {
    return code !== null && code !== undefined && code === info.code;
  }

  /* ---------------- 填寫 ---------------- */
  function findCell(table, r, c) {
    var i, x;
    for (i = 0; i < table.cells.length; i++) { x = table.cells[i]; if (x.r0 === r && x.c0 === c) return x; }
    for (i = 0; i < table.cells.length; i++) {
      x = table.cells[i];
      if (x.r0 <= r && r <= x.r1 && x.c0 <= c && c <= x.c1) return x;
    }
    return null;
  }
  /** 填入值：去頭尾空白、統一換行、移除 XML 不允許的控制字元 */
  function cleanValue(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
      .replace(/^[\s\u3000\u00a0]+|[\s\u3000\u00a0]+$/g, "");
  }

  /** fills → [{sheet, addr, value, mark}]（最後一筆為準） */
  function resolveFills(model, fills, warnings) {
    // 鍵為工作表名稱等文件內容：用無原型物件（工作表名為「constructor」等也不出錯）
    var byId = Object.create(null), out = [], seen = Object.create(null);
    model.tables.forEach(function (t) { byId[t.id] = t; });
    (fills || []).forEach(function (f) {
      var t = byId[f.tableId];
      if (!t) { warnings.push("找不到表格 " + f.tableId); return; }
      var cell = findCell(t, f.r0, f.c0);
      if (!cell || !cell.ref) { warnings.push((t.title || t.id) + "：找不到第 " + (f.r0 + 1) + " 列第 " + (f.c0 + 1) + " 欄的儲存格"); return; }
      var v = cleanValue(f.value);
      var key = cell.ref.sheet + "!" + cell.ref.addr;
      if (seen[key] !== undefined) { out[seen[key]].value = v; out[seen[key]].mark = !!f.mark; return; }
      if (v === "" && !cell.text) return;
      if (cell.text && cell.text !== v) warnings.push(cell.ref.sheet + "!" + cell.ref.addr + " 原有內容「" + cell.text + "」已被覆寫");
      seen[key] = out.length;
      out.push({ sheet: cell.ref.sheet, addr: cell.ref.addr, value: v, mark: !!f.mark });
    });
    return out;
  }

  /**
   * fill(model, fills, opts?) → Promise<{bytes, ext, mime, warnings}>
   * fills: [{tableId, r0, c0, value, mark?}]
   */
  function fill(model, fills, opts) {
    opts = opts || {};
    var warnings = opts.warnings || [];
    return new Promise(function (resolve) { resolve(resolveFills(model, fills, warnings)); }).then(function (list) {
      if (model.format === "ooxml") return fillOoxml(model, list, warnings);
      return fillSheetJS(model, list, warnings);
    }).then(function (res) { res.warnings = warnings; return res; });
  }

  function fillOoxml(model, list, warnings) {
    var zip = model.zip, wbPart = model.wbPart, wbDir = wbPart.indexOf("/") >= 0 ? wbPart.slice(0, wbPart.lastIndexOf("/")) : "";
    var relsPart = relsPathOf(wbPart);
    var st = {};
    return Promise.all([zip.text(wbPart), zip.has(relsPart) ? zip.text(relsPart) : ""]).then(function (r) {
      st.wbText = r[0]; st.relsText = r[1];
      st.wbDoc = parseXml(st.wbText, wbPart);
      st.relsDoc = st.relsText ? parseXml(st.relsText, relsPart) : null;
      var rels = Object.create(null), relEls = st.relsDoc ? st.relsDoc.getElementsByTagName("*") : [];
      st.relEls = [];
      for (var i = 0; i < relEls.length; i++) {
        var e = relEls[i];
        if (e.localName !== "Relationship") continue;
        st.relEls.push(e);
        var tgt = resolveTarget(wbDir, e.getAttribute("Target") || "");
        rels[e.getAttribute("Id")] = { type: e.getAttribute("Type") || "", target: tgt, el: e };
      }
      st.rels = rels;
      st.sheetPart = Object.create(null);
      var sheets = st.wbDoc.getElementsByTagName("*");
      for (var j = 0; j < sheets.length; j++) {
        var s = sheets[j];
        if (s.localName !== "sheet") continue;
        var rid = s.getAttributeNS(R_NS, "id") || s.getAttribute("r:id");
        if (!rid) { for (var q = 0; q < s.attributes.length; q++) if (s.attributes[q].localName === "id") rid = s.attributes[q].value; }
        if (rels[rid]) st.sheetPart[s.getAttribute("name")] = zip.find(rels[rid].target) || rels[rid].target;
      }
      Object.keys(rels).forEach(function (id) {
        if (/\/styles$/.test(rels[id].type)) st.stylesPart = zip.find(rels[id].target);
        if (/\/calcChain$/.test(rels[id].type)) { st.calcPart = zip.find(rels[id].target); st.calcRel = rels[id].el; }
      });
      return st.stylesPart ? zip.text(st.stylesPart) : null;
    }).then(function (stylesText) {
      st.stylesText = stylesText;
      st.styles = stylesText ? new Styles(parseXml(stylesText, st.stylesPart)) : null;
      if (!st.styles) warnings.push("Excel 檔缺少樣式表，數值將以預設格式寫入");
      // 依工作表分組
      var bySheet = Object.create(null), order = [];
      list.forEach(function (f) {
        if (!bySheet[f.sheet]) { bySheet[f.sheet] = []; order.push(f.sheet); }
        bySheet[f.sheet].push(f);
      });
      st.order = order; st.bySheet = bySheet;
      // 全部工作表文字（判斷是否含公式 → 開檔時重算）
      var parts = Object.keys(st.sheetPart).map(function (n) { return st.sheetPart[n]; }).filter(function (p) { return zip.has(p); });
      return Promise.all(parts.map(function (p) { return zip.text(p).then(function (t) { return [p, t]; }); }));
    }).then(function (pairs) {
      var texts = Object.create(null), hasFormula = !!st.calcPart;
      pairs.forEach(function (pt) { texts[pt[0]] = pt[1]; if (/<(\w+:)?f[\s>\/]/.test(pt[1])) hasFormula = true; });
      var changes = {}, formulaRemoved = false;
      st.order.forEach(function (name) {
        var part = st.sheetPart[name];
        if (!part || !(part in texts)) { warnings.push("找不到工作表「" + name + "」的內容，略過 " + st.bySheet[name].length + " 格"); return; }
        var doc = parseXml(texts[part], part), sp = new SheetPatch(doc);
        st.bySheet[name].forEach(function (f) { sp.set(f.addr, f.value, f.mark, st.styles); });
        sp.fixShared();
        sp.fixArrays();
        sp.fixDimension();
        if (sp.formulaRemoved) formulaRemoved = true;
        changes[part] = serialize(doc, xmlDecl(texts[part]));
      });
      if (st.styles && st.styles.changed) changes[st.stylesPart] = serialize(st.styles.doc, xmlDecl(st.stylesText));
      var wbChanged = false;
      // 覆蓋公式 → 刪除 calcChain（Excel 會自動重建）
      if (formulaRemoved && st.calcPart) {
        changes[st.calcPart] = null;
        st.calcRel.parentNode.removeChild(st.calcRel);
        changes[relsPathOf(wbPart)] = serialize(st.relsDoc, xmlDecl(st.relsText));
        st.ctRemove = "/" + st.calcPart;
      }
      // 含公式的活頁簿：開檔時完整重算，讓公式結果反映新填入的值
      if (hasFormula && Object.keys(changes).length) {
        var calcPr = null, all = st.wbDoc.documentElement.childNodes;
        for (var i = 0; i < all.length; i++) if (all[i].nodeType === 1 && all[i].localName === "calcPr") calcPr = all[i];
        if (!calcPr) {
          calcPr = insertInOrder(st.wbDoc.documentElement, mk(st.wbDoc, "calcPr"),
            ["fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews", "sheets", "functionGroups",
             "externalReferences", "definedNames", "calcPr", "oleSize", "customWorkbookViews", "pivotCaches",
             "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"]);
        }
        calcPr.setAttribute("fullCalcOnLoad", "1");
        wbChanged = true;
      }
      if (wbChanged) changes[wbPart] = serialize(st.wbDoc, xmlDecl(st.wbText));
      var isTmpl = model.kind === "xltx" || model.kind === "xltm";
      if ((st.ctRemove || isTmpl) && zip.has("[Content_Types].xml")) {
        var ctName = zip.find("[Content_Types].xml");
        return zip.text(ctName).then(function (ct) {
          var out = ct;
          // 刪除 calcChain 的 Override
          if (st.ctRemove) {
            var want = st.ctRemove.toLowerCase();
            out = out.replace(/<(?:\w+:)?Override\b[^>]*>(?:\s*<\/(?:\w+:)?Override>)?/g, function (tag) {
              var pn = attrRe(tag, "PartName");
              return pn && pn.toLowerCase() === want ? "" : tag;
            });
          }
          // 範本（xltx/xltm）輸出成一般活頁簿
          if (isTmpl) {
            var to = model.kind === "xltm" ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
            var wantWb = "/" + wbPart.toLowerCase();
            out = out.replace(/<(?:\w+:)?Override\b[^>]*>/g, function (tag) {
              var pn = attrRe(tag, "PartName");
              if (!pn || pn.toLowerCase() !== wantWb) return tag;
              return tag.replace(/(\bContentType\s*=\s*)("[^"]*"|'[^']*')/, function (all, a) { return a + '"' + to + '"'; });
            });
          }
          if (out !== ct) changes[ctName] = out;
          return changes;
        });
      }
      return changes;
    }).then(function (changes) {
      return YF.zip.copyWithChanges(zip, changes);
    }).then(function (bytes) {
      var ext = /^(xlsm|xltm)$/.test(model.kind) ? "xlsm" : "xlsx";     // 範本輸出成一般活頁簿
      if (model.ext && !/^(xlsx|xlsm|xltx|xltm)$/.test(model.ext)) {
        warnings.push("副檔名為 ." + model.ext + "，實際為 Excel ." + ext + " 格式，輸出檔改用 ." + ext);
      }
      return { bytes: bytes, ext: ext, mime: MIME[ext] };
    });
  }

  function fillSheetJS(model, list, warnings) {
    var XL = X();
    var wb = readWorkbook(model.bytes, model.kind);   // 每次重讀，不改動 model.wb
    var marked = false;
    list.forEach(function (f) {
      var ws = wb.Sheets[f.sheet];
      if (!ws) { warnings.push("找不到工作表「" + f.sheet + "」"); return; }
      var info = numericInfo(f.value);
      ws[f.addr] = info ? { t: "n", v: info.num, z: info.code, w: info.text } : { t: "s", v: f.value, w: f.value };
      if (f.mark) marked = true;
      var a = parseAddr(f.addr), rng = ws["!ref"] ? XL.utils.decode_range(ws["!ref"]) : { s: { r: a.r, c: a.c }, e: { r: a.r, c: a.c } };
      rng.s.r = Math.min(rng.s.r, a.r); rng.s.c = Math.min(rng.s.c, a.c);
      rng.e.r = Math.max(rng.e.r, a.r); rng.e.c = Math.max(rng.e.c, a.c);
      ws["!ref"] = XL.utils.encode_range(rng);
    });
    if (marked) warnings.push("此格式無法標示黃底，已只寫入數值");
    var kind = model.kind, bookType = "biff8", ext = "xls";
    if (kind === "csv") { bookType = "csv"; ext = "csv"; }
    else if (kind === "xlsb") { bookType = "xlsb"; ext = "xlsb"; }
    else if (kind === "ods") { bookType = "ods"; ext = "ods"; }
    else if (kind !== "xls") warnings.push("原檔為 " + kind.toUpperCase() + " 格式，已改存為 .xls");
    if (bookType !== "csv") warnings.push("已以 SheetJS 重新寫出 ." + ext + "：框線、字型、底色等格式可能遺失，公式會轉為數值");
    var bytes;
    try {
      if (bookType === "csv") {
        var csv = XL.write(wb, { bookType: "csv", type: "string", sheet: wb.SheetNames[0] });
        bytes = new TextEncoder().encode("﻿" + csv);
        if (wb.SheetNames.length > 1) warnings.push("CSV 只輸出第一張工作表");
      } else {
        bytes = new Uint8Array(XL.write(wb, { bookType: bookType, type: "array" }));
      }
    } catch (e) {
      throw xlError("寫出試算表失敗（" + (e && e.message || e) + "）");
    }
    return { bytes: bytes, ext: ext, mime: MIME[ext] || "application/octet-stream" };
  }

  YF.xlsx = {
    load: load,
    fill: fill,
    setXml: setXml,
    // 測試 / 除錯用
    _numericInfo: numericInfo,
    _addr: addrOf,
    _parseAddr: parseAddr
  };
})(typeof window !== "undefined" ? window : globalThis);
