/* =========================================================================
 * Yang-analyze web — fill/docx.js
 * Word (.docx/.docm/.dotx) 表格讀取與填寫：
 *   load：解開套件 → 以 DOMParser 解析 word/document.xml → 依文件順序走訪段落與「最上層」表格，
 *         轉成共用 FTable（gridSpan / gridBefore / gridAfter → 欄跨距，vMerge → 列跨距，
 *         巢狀表格文字併入外層儲存格），表名取表格前最近的非空段落。
 *   fill：在空白儲存格第一個段落寫入數值，字型沿用該段落標記的 rPr（使用者範本即以此存放
 *         Times New Roman / 標楷體 14pt），其餘 XML 與套件內其他檔案一律不動。
 * DOMParser / XMLSerializer 可由 setXml 注入（Node 測試用 xmldom 等）。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  var W_STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main";
  var XML_NS = "http://www.w3.org/XML/1998/namespace";
  var MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  var M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";

  var impl = {
    DOMParser: typeof root.DOMParser === "function" ? root.DOMParser : null,
    XMLSerializer: typeof root.XMLSerializer === "function" ? root.XMLSerializer : null
  };
  /** 注入 XML 實作：{DOMParser, XMLSerializer} */
  function setXml(o) {
    if (o && o.DOMParser) impl.DOMParser = o.DOMParser;
    if (o && o.XMLSerializer) impl.XMLSerializer = o.XMLSerializer;
  }

  function docxError(msg) { var e = new Error(msg); e.name = "DocxError"; return e; }

  /* ---------------- XML 工具（只用 childNodes / localName，xmldom 也能跑） ---------------- */
  function parseXml(text, part) {
    if (!impl.DOMParser) throw docxError("此環境沒有 DOMParser，無法解析 Word 檔");
    var doc;
    try { doc = new impl.DOMParser().parseFromString(text, "application/xml"); }
    catch (e) { throw docxError("Word 檔內容（" + part + "）XML 格式錯誤，檔案可能損毀"); }
    var de = doc && doc.documentElement;
    if (!de || de.localName === "parsererror" || doc.getElementsByTagName("parsererror").length) {
      throw docxError("Word 檔內容（" + part + "）XML 格式錯誤，檔案可能損毀");
    }
    return doc;
  }
  function serialize(doc, decl) {
    if (!impl.XMLSerializer) throw docxError("此環境沒有 XMLSerializer，無法寫出 Word 檔");
    var s = new impl.XMLSerializer().serializeToString(doc);
    s = s.replace(/^\s*<\?xml[^?]*\?>\s*/, "");   // 有些實作會自行輸出宣告，統一換回原宣告
    return (decl || "") + s;
  }
  function xmlDecl(text) {
    var m = /^﻿?(<\?xml[^?]*\?>[ \t]*\r?\n?)/.exec(text);
    return m ? m[1] : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  }
  function kids(el) {
    var out = [], c = el ? el.childNodes : null;
    if (!c) return out;
    for (var i = 0; i < c.length; i++) if (c[i].nodeType === 1) out.push(c[i]);
    return out;
  }
  function isEl(n, ns, name) { return !!n && n.nodeType === 1 && n.localName === name && n.namespaceURI === ns; }
  function child(el, ns, name) {
    var c = el ? el.childNodes : null;
    if (!c) return null;
    for (var i = 0; i < c.length; i++) if (isEl(c[i], ns, name)) return c[i];
    return null;
  }
  function attrW(el, ns, name) {
    if (!el) return null;
    var v = el.getAttributeNS(ns, name);
    if (v === null || v === "") v = el.getAttribute("w:" + name);
    return (v === null || v === "") ? null : v;
  }
  function intAttr(el, ns, name, dflt) {
    var v = attrW(el, ns, name), n = v === null ? NaN : parseInt(v, 10);
    return isFinite(n) ? n : dflt;
  }
  /** w:val 開關屬性（缺省 = 開） */
  function isOn(el, ns) {
    if (!el) return false;
    var v = attrW(el, ns, "val");
    return !(v === "0" || v === "false" || v === "off" || v === "none");
  }

  /* ---------------- 文字擷取 ---------------- */
  var SYMBOL_MAP = { "F0B1": "±", "F0B0": "°", "F0B4": "×", "F0B3": "≥", "F0A3": "≤", "F06D": "μ",
    "F0B7": "•", "F0D7": "·", "F0BB": "≈", "F0B9": "≠", "00B1": "±", "00B0": "°", "00D7": "×" };
  var SKIP_W = { del: 1, moveFrom: 1, rPr: 1, pPr: 1, delText: 1, instrText: 1, delInstrText: 1, fldData: 1,
    rt: 1, drawing: 1, pict: 1, object: 1, footnoteReference: 1, endnoteReference: 1, commentReference: 1,
    tblPr: 1, trPr: 1, tcPr: 1, sectPr: 1 };

  function textInto(node, ns, acc) {
    var c = node.childNodes;
    for (var i = 0; i < c.length; i++) {
      var n = c[i];
      if (n.nodeType !== 1) continue;
      var ln = n.localName, nns = n.namespaceURI;
      if (nns === ns) {
        if (ln === "t") { acc.push(n.textContent); continue; }
        if (ln === "tab" || ln === "ptab") { acc.push(" "); continue; }
        if (ln === "br" || ln === "cr") { acc.push("\n"); continue; }
        if (ln === "noBreakHyphen") { acc.push("-"); continue; }
        if (ln === "sym") {
          var ch = String(attrW(n, ns, "char") || "").toUpperCase();
          if (SYMBOL_MAP[ch]) acc.push(SYMBOL_MAP[ch]);
          else if (/^[0-9A-F]{4}$/.test(ch) && ch.charAt(0) !== "F") acc.push(String.fromCharCode(parseInt(ch, 16)));
          continue;
        }
        if (SKIP_W[ln]) continue;
        if (ln === "r" && isHiddenRun(n, ns)) continue;
        if (ln === "sdt") { if (!isPlaceholderSdt(n, ns)) { var sc = child(n, ns, "sdtContent"); if (sc) textInto(sc, ns, acc); } continue; }
        if (ln === "tbl") { acc.push("\n" + tableFlatText(n, ns) + "\n"); continue; }
        textInto(n, ns, acc);
      } else if (nns === MC_NS) {
        if (ln === "Fallback") continue;
        textInto(n, ns, acc);
      } else if (nns === M_NS && ln === "t") {
        acc.push(n.textContent);
      } else {
        textInto(n, ns, acc);
      }
    }
  }
  function isHiddenRun(r, ns) {
    var rPr = child(r, ns, "rPr");
    return !!rPr && isOn(child(rPr, ns, "vanish"), ns);
  }
  function paraText(p, ns) {
    var acc = [];
    textInto(p, ns, acc);
    return acc.join("");
  }
  /** 各行去頭尾空白；保留中間空行（多段落儲存格），去掉開頭與結尾的空行 */
  function cleanLines(s) {
    return String(s).split("\n").map(function (x) { return x.replace(/^[\s\u3000\u00a0]+|[\s\u3000\u00a0]+$/g, ""); })
      .join("\n").replace(/^\n+|\n+$/g, "");
  }
  function isBlankText(s) { return String(s).replace(/[\s　 ​﻿]+/g, "") === ""; }

  /* ---------------- 區塊走訪（段落 / 表格；穿過 sdt、customXml、ins 等包裝） ---------------- */
  var BLOCK_WRAP = { sdt: 1, sdtContent: 1, customXml: 1, ins: 1, moveTo: 1, smartTag: 1 };
  function walkBlocks(container, ns, out, warnings, plc) {
    kids(container).forEach(function (el) {
      if (el.namespaceURI !== ns) {
        if (el.namespaceURI === MC_NS && el.localName === "AlternateContent") {
          var choice = child(el, MC_NS, "Choice");
          if (choice) walkBlocks(choice, ns, out, warnings, plc);
        }
        return;
      }
      var ln = el.localName;
      if (ln === "p") out.push({ type: "p", el: el, placeholder: !!plc });
      else if (ln === "tbl") out.push({ type: "tbl", el: el });
      else if (ln === "altChunk") { if (warnings) warnings.push("文件含有內嵌外部內容（altChunk），該部分無法讀取"); }
      else if (BLOCK_WRAP[ln]) walkBlocks(el, ns, out, warnings, plc || (ln === "sdt" && isPlaceholderSdt(el, ns)));
    });
    return out;
  }
  /** 內容控制項正顯示提示文字（「按一下這裡以輸入文字」）→ 視為空白 */
  function isPlaceholderSdt(sdt, ns) {
    var pr = child(sdt, ns, "sdtPr");
    return !!pr && !!child(pr, ns, "showingPlcHdr");
  }
  /** 表格的列（含 sdt / customXml 包住的列） */
  function tableRows(tbl, ns) {
    var out = [];
    (function rec(el) {
      kids(el).forEach(function (k) {
        if (k.namespaceURI !== ns) return;
        if (k.localName === "tr") out.push(k);
        else if (BLOCK_WRAP[k.localName]) rec(k);
      });
    })(tbl);
    return out;
  }
  /** 一列的儲存格（含 sdt / customXml 包住的儲存格） */
  function rowCells(tr, ns) {
    var out = [];
    (function rec(el) {
      kids(el).forEach(function (k) {
        if (k.namespaceURI !== ns) return;
        if (k.localName === "tc") out.push(k);
        else if (BLOCK_WRAP[k.localName]) rec(k);
      });
    })(tr);
    return out;
  }
  /** 儲存格內的段落（不進入巢狀表格） */
  function cellParagraphs(tc, ns) {
    return walkBlocks(tc, ns, [], null).filter(function (b) { return b.type === "p"; }).map(function (b) { return b.el; });
  }
  /** 儲存格文字：每段一行；巢狀表格每列一行（各格以空白分隔） */
  function cellText(tc, ns) {
    var lines = [];
    walkBlocks(tc, ns, [], null).forEach(function (b) {
      if (b.type === "p") lines.push(b.placeholder ? "" : paraText(b.el, ns));
      else lines.push(tableFlatText(b.el, ns));
    });
    return cleanLines(lines.join("\n"));
  }
  function tableFlatText(tbl, ns) {
    return tableRows(tbl, ns).map(function (tr) {
      return rowCells(tr, ns).map(function (tc) { return cellText(tc, ns).replace(/\n/g, " "); })
        .filter(function (s) { return s; }).join(" ");
    }).filter(function (s) { return s; }).join("\n");
  }

  /* ---------------- 表格 → FTable ---------------- */
  function buildTable(tbl, ns, k, warnings) {
    var rows = tableRows(tbl, ns), cells = [], open = {}, maxCol = 0, nested = false;
    var hOpen = null;
    rows.forEach(function (tr, ri) {
      var trPr = child(tr, ns, "trPr");
      var col = intAttr(child(trPr, ns, "gridBefore"), ns, "val", 0);
      var after = intAttr(child(trPr, ns, "gridAfter"), ns, "val", 0);
      hOpen = null;
      rowCells(tr, ns).forEach(function (tc, ci) {
        var tcPr = child(tc, ns, "tcPr");
        var span = Math.max(1, intAttr(child(tcPr, ns, "gridSpan"), ns, "val", 1));
        var vm = child(tcPr, ns, "vMerge"), hm = child(tcPr, ns, "hMerge");
        var vmVal = vm ? (attrW(vm, ns, "val") || "continue") : null;
        var hmVal = hm ? (attrW(hm, ns, "val") || "continue") : null;
        if (!nested && hasNestedTable(tc, ns)) nested = true;
        // 舊式水平合併（hMerge continue）：延伸左邊的儲存格
        if (hmVal === "continue" && hOpen) {
          hOpen.c1 = col + span - 1;
          col += span;
          return;
        }
        if (vmVal === "continue") {
          var target = open[col];
          if (!target) {   // 找欄位重疊者（跨距不一致的不規則合併）
            for (var key in open) {
              var o = open[key];
              if (o && o.c0 <= col && o.c1 >= col) { target = o; break; }
            }
          }
          if (target && target.r1 === ri - 1) {
            target.r1 = ri;
            if (col + span - 1 > target.c1) target.c1 = col + span - 1;
            col += span;
            hOpen = null;
            return;
          }
        }
        var cell = { r0: ri, r1: ri, c0: col, c1: col + span - 1, text: cellText(tc, ns), conf: null, bbox: null,
                     ref: { tbl: k, tr: ri, tc: ci } };
        cells.push(cell);
        for (var c = col; c < col + span; c++) delete open[c];
        if (vmVal === "restart") open[col] = cell;
        hOpen = (hmVal === "restart") ? cell : null;
        col += span;
      });
      // 這一列沒有 continue 的欄，關閉其垂直合併
      for (var key2 in open) if (open[key2] && open[key2].r1 < ri) delete open[key2];
      if (col + after > maxCol) maxCol = col + after;
    });
    var grid = child(tbl, ns, "tblGrid");
    var nGrid = grid ? kids(grid).filter(function (g) { return isEl(g, ns, "gridCol"); }).length : 0;
    if (nested) warnings.push("第 " + (k + 1) + " 個表格內有巢狀表格，其文字已併入外層儲存格");
    return {
      id: "t" + k, page: null, sheet: null, index: k, title: "", context: [],
      nRows: rows.length, nCols: Math.max(maxCol, cells.length ? 1 : 0) || nGrid,
      gridCols: nGrid, cells: cells
    };
  }
  function hasNestedTable(tc, ns) {
    return walkBlocks(tc, ns, [], null).some(function (b) { return b.type === "tbl"; });
  }

  /* ---------------- [Content_Types].xml（字串處理，保持原樣） ---------------- */
  function attrRe(tag, name) {
    var m = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')").exec(tag);
    return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
  }
  function partContentType(ct, part) {
    var re = /<(?:\w+:)?Override\b[^>]*>/g, m, want = "/" + String(part).toLowerCase();
    while ((m = re.exec(ct || ""))) {
      var pn = attrRe(m[0], "PartName");
      if (pn && pn.toLowerCase() === want) return attrRe(m[0], "ContentType") || "";
    }
    return "";
  }
  /** 把某 part 的 ContentType 換成 to（只改該 Override 標籤） */
  function replaceContentType(ct, part, to) {
    var want = "/" + String(part).toLowerCase();
    return String(ct).replace(/<(?:\w+:)?Override\b[^>]*>/g, function (tag) {
      var pn = attrRe(tag, "PartName");
      if (!pn || pn.toLowerCase() !== want) return tag;
      return tag.replace(/(\bContentType\s*=\s*)("[^"]*"|'[^']*')/, function (all, a) { return a + '"' + to + '"'; });
    });
  }

  /* ---------------- 主文件定位 ---------------- */
  function mainPart(zip) {
    var relsName = "_rels/.rels";
    if (!zip.has(relsName)) return Promise.resolve(zip.find("word/document.xml"));
    return zip.text(relsName).then(function (txt) {
      var target = null;
      try {
        var d = parseXml(txt, relsName), rels = d.getElementsByTagName("*");
        for (var i = 0; i < rels.length; i++) {
          var r = rels[i];
          if (r.localName === "Relationship" && /\/officeDocument$/.test(r.getAttribute("Type") || "")) {
            target = (r.getAttribute("Target") || "").replace(/^\/+/, "");
            break;
          }
        }
      } catch (e) { target = null; }
      if (target && zip.has(target)) return zip.find(target);
      return zip.find("word/document.xml");
    });
  }
  function nsOf(doc) {
    var ns = doc.documentElement.namespaceURI;
    return (ns === W_NS || ns === W_STRICT) ? ns : W_NS;
  }

  /** 版面用的「單格外框表格」：整張表只有一格且格內有表格 → 拆開，裡面的段落/表格當成本文 */
  function isWrapperTable(tbl, ns) {
    var rows = tableRows(tbl, ns);
    if (rows.length !== 1) return false;
    var tcs = rowCells(rows[0], ns);
    return tcs.length === 1 && hasNestedTable(tcs[0], ns);
  }
  function expandWrappers(blocks, ns, st, depth) {
    var out = [];
    blocks.forEach(function (b) {
      if (b.type === "tbl" && depth < 4 && isWrapperTable(b.el, ns)) {
        var tc = rowCells(tableRows(b.el, ns)[0], ns)[0];
        st.unwrapped++;
        out.push.apply(out, expandWrappers(walkBlocks(tc, ns, [], null), ns, st, depth + 1));
      } else out.push(b);
    });
    return out;
  }

  /** 解析文件 → 區塊與表格元素（load / fill 共用，保證索引一致） */
  function analyze(doc, warnings) {
    var ns = nsOf(doc);
    var body = child(doc.documentElement, ns, "body");
    if (!body) throw docxError("Word 檔缺少文件內容（w:body），無法讀取");
    var st = { unwrapped: 0 };
    var blocks = expandWrappers(walkBlocks(body, ns, [], warnings), ns, st, 0);
    if (st.unwrapped && warnings) warnings.push("已拆開 " + st.unwrapped + " 個外框表格（整張表只有一格、內含表格），改讀其中的表格");
    var tblEls = blocks.filter(function (b) { return b.type === "tbl"; }).map(function (b) { return b.el; });
    return { ns: ns, body: body, blocks: blocks, tblEls: tblEls };
  }

  /**
   * load(bytes, opts?) → Promise<DocxModel>
   * DocxModel = { kind, part, zip, xml, tables:[FTable], paragraphs:[非空段落文字], blocks:[{type,text|tableId}],
   *               headers:[頁首/頁尾文字], warnings, info }
   */
  function load(bytes, opts) {
    opts = opts || {};
    if (!YF.zip) return Promise.reject(docxError("缺少 zip.js，無法讀取 Word 檔"));
    var model = { kind: "docx", part: null, zip: null, xml: "", tables: [], paragraphs: [], blocks: [],
                  headers: [], warnings: [], info: "" };
    var u8 = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) :
      (bytes && ArrayBuffer.isView(bytes)) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
    if (u8 && u8.length >= 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) {
      return Promise.reject(docxError("這是舊版 Word（.doc）或有密碼保護的檔案，請用 Word 開啟後「另存新檔 → Word 文件 (.docx)」再上傳"));
    }
    return YF.zip.read(u8).then(function (zip) {
      model.zip = zip;
      zip.warnings.forEach(function (w) { model.warnings.push(w); });
      return mainPart(zip);
    }).then(function (part) {
      if (!part) throw docxError("這不是 Word 文件（套件內找不到 word/document.xml）");
      model.part = part;
      return model.zip.has("[Content_Types].xml") ? model.zip.text("[Content_Types].xml") : "";
    }).then(function (ct) {
      // 主文件 ContentType → docx / docm / dotx / dotm；範本（dotx/dotm）輸出時轉成一般文件
      model.contentTypes = ct;
      model.mainType = partContentType(ct, model.part);
      var macro = /macroEnabled/i.test(model.mainType) || model.zip.has("word/vbaProject.bin");
      var tmpl = /\.template/i.test(model.mainType);
      model.kind = tmpl ? (macro ? "dotm" : "dotx") : (macro ? "docm" : "docx");
      model.outExt = macro ? "docm" : "docx";
      return model.zip.text(model.part);
    }).then(function (xml) {
      model.xml = xml;
      var doc = parseXml(xml, model.part);
      var a = analyze(doc, model.warnings), ns = a.ns;
      var paraTexts = [];          // 自上一個表格以來的段落文字（含空段落）
      var k = 0;
      a.blocks.forEach(function (b) {
        if (b.type === "p") {
          var t = b.placeholder ? "" : cleanLines(paraText(b.el, ns)).replace(/\n/g, " ");
          paraTexts.push(t);
          model.blocks.push({ type: "p", text: t });
          if (t) model.paragraphs.push(t);
          return;
        }
        var ft = buildTable(b.el, ns, k, model.warnings);
        // 表名：表格前最近 3 段內的最近一個非空段落；context：上一個表格之後的非空段落（最多 3 段）
        for (var i = paraTexts.length - 1; i >= Math.max(0, paraTexts.length - 3); i--) {
          if (paraTexts[i]) { ft.title = paraTexts[i]; break; }
        }
        ft.context = paraTexts.filter(function (s) { return s; }).slice(-3);
        model.tables.push(ft);
        model.blocks.push({ type: "tbl", tableId: ft.id });
        paraTexts = [];
        k++;
      });
      if (!model.tables.length) model.warnings.push("Word 檔中沒有表格");
      return opts.headers === false ? null : loadHeaders(model);
    }).then(function () {
      var blanks = 0;
      model.tables.forEach(function (t) { t.cells.forEach(function (c) { if (!c.text) blanks++; }); });
      model.info = model.tables.length + " 個表格、" + model.paragraphs.length + " 個段落" +
        (blanks ? "、" + blanks + " 個空白儲存格" : "");
      return model;
    });
  }
  /** 頁首 / 頁尾文字（原始報告常把報告編號、測站寫在頁首） */
  function loadHeaders(model) {
    var names = model.zip.names.filter(function (n) { return /^word\/(header|footer)\d*\.xml$/i.test(n); });
    return Promise.all(names.map(function (n) {
      return model.zip.text(n).then(function (x) {
        try {
          var d = parseXml(x, n), ns = nsOf(d);
          walkBlocks(d.documentElement, ns, [], null).forEach(function (b) {
            var t = b.type === "p" ? cleanLines(paraText(b.el, ns)) : tableFlatText(b.el, ns);
            t.split("\n").forEach(function (s) { if (s && model.headers.indexOf(s) < 0) model.headers.push(s); });
          });
        } catch (e) { /* 頁首壞掉不影響主文件 */ }
      }, function () { /* 略過 */ });
    }));
  }

  /* ---------------- 填寫 ---------------- */
  // CT_RPr 子元素標準順序（插入 highlight 時維持 schema 順序，Word 才不會要求修復）
  var RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline",
    "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em",
    "lang", "eastAsianLayout", "specVanish", "oMath", "rPrChange"];
  var RPR_STRIP = { ins: 1, del: 1, moveFrom: 1, moveTo: 1, rPrChange: 1, vanish: 1, specVanish: 1, oMath: 1 };

  /** 建立 w 命名空間元素，沿用文件根元素的前綴（一般為 w:） */
  function wEl(doc, ns, name) {
    var de = doc.documentElement, pre = de && de.namespaceURI === ns ? de.prefix : "w";
    return doc.createElementNS(ns, pre ? pre + ":" + name : name);
  }
  function insertOrdered(rPr, el) {
    var idx = RPR_ORDER.indexOf(el.localName), ks = kids(rPr);
    for (var i = 0; i < ks.length; i++) {
      var j = RPR_ORDER.indexOf(ks[i].localName);
      if (j > idx) { rPr.insertBefore(el, ks[i]); return; }
    }
    rPr.appendChild(el);
  }
  /** 清掉不適用於一般文字 run 的屬性（段落標記修訂、隱藏） */
  function sanitizeRPr(rPr, ns) {
    kids(rPr).forEach(function (k) { if (k.namespaceURI === ns && RPR_STRIP[k.localName]) rPr.removeChild(k); });
    return rPr;
  }
  function applyMark(doc, ns, rPr) {
    kids(rPr).forEach(function (k) { if (isEl(k, ns, "highlight")) rPr.removeChild(k); });
    var h = wEl(doc, ns, "highlight");
    h.setAttributeNS(ns, "w:val", "yellow");
    insertOrdered(rPr, h);
  }
  /** 段落自己的 run（穿過 hyperlink / ins / sdt 等包裝，不進入圖片、文字方塊、刪除修訂） */
  function ownRuns(p, ns) {
    var out = [];
    (function rec(el) {
      kids(el).forEach(function (k) {
        if (k.namespaceURI !== ns) return;
        if (k.localName === "r") out.push(k);
        else if (!SKIP_W[k.localName] && k.localName !== "txbxContent") rec(k);
      });
    })(p);
    return out;
  }
  /** 有文字的第一個 run 的 rPr */
  function firstTextRunRPr(tc, ns) {
    var ps = cellParagraphs(tc, ns);
    for (var i = 0; i < ps.length; i++) {
      var runs = ownRuns(ps[i], ns);
      for (var j = 0; j < runs.length; j++) {
        if (isHiddenRun(runs[j], ns)) continue;
        var ts = kids(runs[j]);
        for (var k = 0; k < ts.length; k++) {
          if (isEl(ts[k], ns, "t") && !isBlankText(ts[k].textContent)) return child(runs[j], ns, "rPr") || "none";
        }
      }
    }
    return null;
  }
  /** 字型來源：段落標記 rPr → 同列最近的非空儲存格 → 同欄其他列 → 表格內任一 run */
  function templateRPr(p, tc, ctx) {
    var ns = ctx.ns, pPr = child(p, ns, "pPr"), mark = pPr ? child(pPr, ns, "rPr") : null;
    if (mark && kids(mark).some(function (k) { return !RPR_STRIP[k.localName]; })) return mark;
    var row = ctx.rowTcs, idx = row.indexOf(tc), best = null;
    for (var d = 1; d < row.length && !best; d++) {
      var cand = [row[idx - d], row[idx + d]];
      for (var i = 0; i < 2 && !best; i++) {
        if (cand[i]) { var r = firstTextRunRPr(cand[i], ns); if (r) best = r; }
      }
    }
    if (!best) {
      for (var ri = 0; ri < ctx.rows.length && !best; ri++) {
        var tcs = ctx.rows[ri];
        for (var ci = 0; ci < tcs.length && !best; ci++) {
          if (tcs[ci] !== tc) { var r2 = firstTextRunRPr(tcs[ci], ns); if (r2) best = r2; }
        }
      }
    }
    if (best && best !== "none") return best;
    return mark;   // 可能只有修訂/隱藏屬性，清理後可能為空
  }
  /** run 是否「空」：只有 rPr、空 w:t、lastRenderedPageBreak */
  function isEmptyRun(r, ns) {
    var ks = kids(r);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      if (k.namespaceURI !== ns) return false;
      if (k.localName === "rPr" || k.localName === "lastRenderedPageBreak") continue;
      if (k.localName === "t" && k.textContent === "") continue;
      return false;
    }
    return true;
  }
  function appendText(doc, ns, run, value) {
    var lines = String(value).replace(/\r\n?/g, "\n").split("\n");
    lines.forEach(function (line, li) {
      if (li > 0) run.appendChild(wEl(doc, ns, "br"));
      line.split("\t").forEach(function (piece, pi) {
        if (pi > 0) run.appendChild(wEl(doc, ns, "tab"));
        if (piece === "" && (lines.length > 1 || pi > 0)) return;
        var t = wEl(doc, ns, "t");
        t.setAttributeNS(XML_NS, "xml:space", "preserve");
        t.appendChild(doc.createTextNode(piece));
        run.appendChild(t);
      });
    });
  }
  function ensureRPr(doc, ns, run) {
    var rPr = child(run, ns, "rPr");
    if (!rPr) { rPr = wEl(doc, ns, "rPr"); run.insertBefore(rPr, run.firstChild); }
    return rPr;
  }

  /** 移除儲存格內內容控制項的提示文字（含灰色 PlaceholderText 樣式），之後就當一般空白格填寫 */
  function clearPlaceholders(tc, ns) {
    var sdts = tc.getElementsByTagNameNS(ns, "sdt"), list = [];
    for (var i = 0; i < sdts.length; i++) if (isPlaceholderSdt(sdts[i], ns)) list.push(sdts[i]);
    list.forEach(function (sdt) {
      var pr = child(sdt, ns, "sdtPr");
      pr.removeChild(child(pr, ns, "showingPlcHdr"));
      var runs = sdt.getElementsByTagNameNS(ns, "r"), rl = [];
      for (var j = 0; j < runs.length; j++) rl.push(runs[j]);
      rl.forEach(function (r) {
        kids(r).forEach(function (k) {
          if (k.namespaceURI !== ns) return;
          if (/^(t|tab|br|cr|sym|noBreakHyphen|softHyphen|ptab)$/.test(k.localName)) r.removeChild(k);
          else if (k.localName === "rPr") {
            var st = child(k, ns, "rStyle");
            if (st && /placeholder/i.test(attrW(st, ns, "val") || "")) k.removeChild(st);
          }
        });
      });
    });
  }

  /** 把 value 寫進儲存格 tc；回傳 'blank' | 'overwrite' */
  function setCell(doc, tc, value, mark, ctx) {
    var ns = ctx.ns;
    clearPlaceholders(tc, ns);
    var ps = cellParagraphs(tc, ns);
    var p = ps[0];
    if (!p) { p = wEl(doc, ns, "p"); tc.appendChild(p); ps = [p]; }
    var mode = isBlankText(cellText(tc, ns)) ? "blank" : "overwrite";
    if (mode === "blank" && value === "") return "skip";
    var run = null;
    if (mode === "overwrite") {
      // 覆寫：清掉所有段落的文字，數值放進原本第一個有字的 run（保留其字型）
      ps.forEach(function (pp) {
        ownRuns(pp, ns).forEach(function (r) {
          var hasText = false;
          kids(r).forEach(function (k) {
            if (k.namespaceURI !== ns) return;
            if (k.localName === "t") { if (!isBlankText(k.textContent)) hasText = true; r.removeChild(k); }
            else if (/^(tab|br|cr|sym|noBreakHyphen|softHyphen|ptab)$/.test(k.localName)) r.removeChild(k);
          });
          if (hasText && !run) run = r;
        });
      });
    } else {
      kids(p).forEach(function (k) { if (!run && isEl(k, ns, "r") && isEmptyRun(k, ns)) run = k; });
      if (run) kids(run).forEach(function (k) { if (isEl(k, ns, "t")) run.removeChild(k); });
    }
    if (run) {
      var ex = child(run, ns, "rPr");
      if (ex) sanitizeRPr(ex, ns);
    } else {
      run = wEl(doc, ns, "r");
      var src = templateRPr(p, tc, ctx);
      if (src) {
        var clone = sanitizeRPr(src.cloneNode(true), ns);
        // 段落標記的 rPr 與 run 的 rPr 元素名稱相同（w:rPr），直接沿用
        if (kids(clone).length) run.appendChild(clone);
      }
      p.appendChild(run);
    }
    if (mark) applyMark(doc, ns, ensureRPr(doc, ns, run));
    var rp = child(run, ns, "rPr");
    if (rp && !kids(rp).length && !mark) run.removeChild(rp);
    appendText(doc, ns, run, value);
    return mode;
  }

  /** 填入值：去頭尾空白、統一換行、移除 XML 不允許的控制字元（否則 Word 打不開） */
  function cleanValue(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
      .replace(/^[\s\u3000\u00a0]+|[\s\u3000\u00a0]+$/g, "");
  }

  /** 找出覆蓋 (r, c) 的儲存格 */
  function findCell(table, r, c) {
    for (var i = 0; i < table.cells.length; i++) {
      var x = table.cells[i];
      if (x.r0 === r && x.c0 === c) return x;
    }
    for (var j = 0; j < table.cells.length; j++) {
      var y = table.cells[j];
      if (y.r0 <= r && r <= y.r1 && y.c0 <= c && c <= y.c1) return y;
    }
    return null;
  }

  /**
   * fill(model, fills, opts?) → Promise<Uint8Array>
   * fills: [{tableId, r0, c0, value, mark?}]；opts.warnings 陣列會收到警告（找不到儲存格、覆寫既有內容）
   * 每次都從原始 XML 重新解析，可重複呼叫（不改動 model）。
   */
  function fill(model, fills, opts) {
    opts = opts || {};
    var warnings = opts.warnings || [];
    return new Promise(function (resolve) {
      var doc = parseXml(model.xml, model.part);
      var a = analyze(doc, null), ns = a.ns;
      var byId = {};
      model.tables.forEach(function (t) { byId[t.id] = t; });
      var rowsCache = {};
      function rowsOf(k) {
        if (!rowsCache[k]) rowsCache[k] = tableRows(a.tblEls[k], ns).map(function (tr) { return rowCells(tr, ns); });
        return rowsCache[k];
      }
      var done = {};
      (fills || []).forEach(function (f) {
        var t = byId[f.tableId];
        if (!t) { warnings.push("找不到表格 " + f.tableId); return; }
        var cell = findCell(t, f.r0, f.c0);
        if (!cell || !cell.ref || !a.tblEls[cell.ref.tbl]) {
          warnings.push((t.title || t.id) + "：找不到第 " + (f.r0 + 1) + " 列第 " + (f.c0 + 1) + " 欄的儲存格");
          return;
        }
        var rows = rowsOf(cell.ref.tbl), tcs = rows[cell.ref.tr], tc = tcs && tcs[cell.ref.tc];
        if (!tc) { warnings.push((t.title || t.id) + "：表格結構與讀取時不一致，略過一格"); return; }
        var key = cell.ref.tbl + ":" + cell.ref.tr + ":" + cell.ref.tc;
        if (done[key]) warnings.push((t.title || t.id) + "：第 " + (cell.r0 + 1) + " 列第 " + (cell.c0 + 1) + " 欄重複填寫，以最後一筆為準");
        done[key] = true;
        var v = cleanValue(f.value);
        var mode = setCell(doc, tc, v, !!f.mark, { ns: ns, rowTcs: tcs, rows: rows });
        if (mode === "overwrite" && !done[key + ":ow"]) {
          done[key + ":ow"] = true;
          if (cell.text) warnings.push((t.title || t.id) + "：第 " + (cell.r0 + 1) + " 列第 " + (cell.c0 + 1) + " 欄原有內容「" + cell.text + "」已被覆寫");
        }
      });
      var changes = {};
      changes[model.part] = serialize(doc, xmlDecl(model.xml));
      if ((model.kind === "dotx" || model.kind === "dotm") && model.contentTypes) {
        var to = model.kind === "dotm" ? "application/vnd.ms-word.document.macroEnabled.main+xml"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
        var ct2 = replaceContentType(model.contentTypes, model.part, to);
        if (ct2 !== model.contentTypes) changes[model.zip.find("[Content_Types].xml")] = ct2;
      }
      resolve(YF.zip.copyWithChanges(model.zip, changes));
    });
  }

  YF.docx = {
    load: load,
    fill: fill,
    setXml: setXml,
    // 測試 / 除錯用
    _paraText: paraText,
    _isBlank: isBlankText
  };
})(typeof window !== "undefined" ? window : globalThis);
