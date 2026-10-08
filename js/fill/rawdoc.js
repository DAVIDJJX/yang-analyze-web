/* =========================================================================
 * Yang-analyze web — fill/rawdoc.js
 * 「填表核對」檔案處理管線：任一上傳檔 → Doc（表格模型 FTable[]）。
 *  - 原始資料：DocuWorks（.xdw/.xbd 掃描影像）、PDF（文字型直接取字；掃描型 OCR）、
 *    影像（PNG/JPG/TIFF…）、Word（.docx 表格）、Excel（.xlsx/.xls/.csv…，
 *    另以既有水質/空氣/噪音模組解析器補充精確數值）。
 *  - 待填表格：Word（.docx）、Excel（.xlsx/.xlsm/.xls）。
 * 掃描頁流程：解碼 → 二值化 → 表格格線偵測（grid.js）→ 逐格 OCR（ocr.js）
 *            → 表格外文字列 OCR（頁面脈絡，如「監測位置：示範新城」）。
 * 辨識結果依檔案 SHA-256 快取（呼叫端提供 cache.get/put），同檔再次上傳免重算。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var PIPELINE_VERSION = 3;          // 快取格式／辨識流程版本（變更時 +1 使舊快取失效）
  var MAX_CONTEXT_LINES = 40;        // 每頁最多 OCR 幾列表格外文字
  var MIN_INK = 12;                  // 儲存格內墨點少於此數視為空白
  var MAX_PAGE_PIXELS = 100e6;       // 單頁影像像素上限（600 dpi A3 約 70M）

  var docSeq = 1;

  /* ---------------- 小工具 ---------------- */
  function sha256Hex(bytes) {
    if (!root.crypto || !root.crypto.subtle) return Promise.resolve(null);
    return root.crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var a = new Uint8Array(buf), s = "";
      for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
      return s;
    }).catch(function () { return null; });
  }
  function readBytes(file) {
    return file.arrayBuffer().then(function (buf) { return new Uint8Array(buf); }, function (e) {
      var n = e && e.name;
      if (n === "NotReadableError" || n === "NotFoundError" || n === "SecurityError" || n === "NotAllowedError") {
        throw new Error("無法讀取檔案（檔案可能已移動、被其他程式開啟、為尚未下載的雲端檔，或大於 2 GB）");
      }
      if (n === "RangeError" || /allocation|memory/i.test(String(e && e.message))) throw new Error("檔案過大，瀏覽器記憶體不足，無法讀取");
      throw e;
    });
  }
  /* 警告不重複加入 */
  function addWarning(doc, w) {
    if (w && doc.warnings.indexOf(w) < 0) doc.warnings.push(w);
  }
  function aborted(opts) {
    return opts && opts.signal && opts.signal.aborted;
  }
  function checkAbort(opts) {
    if (aborted(opts)) {
      var e = new Error("已取消");
      e.name = "AbortError";
      throw e;
    }
  }
  function progress(opts, stage, done, total, msg, extra) {
    if (opts && typeof opts.onProgress === "function") {
      var p = { stage: stage, done: done, total: total, message: msg || "" };
      // 多頁文件：整體進度＝（已完成頁數＋本頁進度）／總頁數
      var pg = opts._page;
      if (pg && pg.pages) {
        p.page = pg.index; p.pages = pg.pages;
        var frac = stage === "page" ? 0 : (total ? done / total : 0);
        p.overall = Math.min(1, (pg.index + frac) / pg.pages);
      }
      if (extra) for (var k in extra) p[k] = extra[k];
      try { opts.onProgress(p); } catch (e) { /* 忽略 UI 錯誤 */ }
    }
  }
  function setPage(opts, i, n) {
    if (opts) opts._page = { index: i, pages: n };
  }
  function cleanOcrText(s) {
    s = String(s || "").replace(/\r/g, "").split("\n").map(function (l) {
      return l.replace(/\s+/g, " ").trim();
    }).filter(Boolean).join("\n");
    // 中文字之間的空白（OCR 常見）去除
    return s.replace(/([㐀-鿿豈-﫿])\s+(?=[㐀-鿿豈-﫿])/g, "$1");
  }
  function plainBox(b) {
    return b ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null;
  }
  /* 「10:00 ~ 11:00」「10:00-11:00」「10時~11時」等時段文字 */
  function isTimeRangeText(s) {
    if (YF.dict && YF.dict.isTimeRange) { try { return !!YF.dict.isTimeRange(s); } catch (e) { /* 改用內建 */ } }
    var t = String(s || "").replace(/\s+/g, "");
    return /^\d{1,2}[:：]\d{2}[~～〜\-－—至到]+\d{1,2}[:：]\d{2}$/.test(t) || /^\d{1,2}時?[~～\-至]\d{1,2}時$/.test(t);
  }

  function newDoc(file, role, type) {
    return {
      id: "d" + (docSeq++),
      name: file.name,
      size: file.size,
      kind: type ? type.kind : "unknown",
      family: type ? type.family : "other",
      typeLabel: type ? type.label : "",
      role: role,
      tables: [],
      pages: [],
      warnings: [],
      info: "",
      stats: { pages: 0, tables: 0, cells: 0, ocrCells: 0 },
      moduleFacts: [],
      hash: null,
      fromCache: false
    };
  }

  /* =====================================================================
   * 掃描頁（Bitmap）→ FTable[]
   * ===================================================================== */
  function processBitmapPage(bin, pageNo, dpi, doc, opts) {
    var G = YF.grid, R = YF.raster;
    dpi = dpi || 200;
    var det = G.detectTables(bin, { dpi: dpi });
    var tables = det.tables || [];
    var mask = det.mask;
    var multiLineH = Math.round(dpi * 0.21);      // 200 dpi ≈ 42 px：超過即視為多行文字
    var pad = Math.max(8, Math.round(dpi * 0.06));
    var firstJobs = [], firstTargets = [], restCells = [];

    var ftables = tables.map(function (t, ti) {
      var ft = {
        id: "p" + pageNo + "t" + ti, page: pageNo, sheet: null, index: ti,
        title: "", context: [], nRows: t.nRows || (t.ys ? t.ys.length - 1 : 0),
        nCols: t.nCols || (t.xs ? t.xs.length - 1 : 0),
        bbox: t.bbox || null,
        cells: []
      };
      (t.cells || []).forEach(function (c) {
        var cell = { r0: c.r0, r1: c.r1, c0: c.c0, c1: c.c1, text: "", conf: null, bbox: plainBox(c.bbox), ref: null };
        if (c.frame || (c.bbox && c.bbox.frame)) cell.frame = c.frame || c.bbox.frame;   // 歪斜掃描的儲存格框（裁切用）
        ft.cells.push(cell);
        var ink = G.cellInk(bin, mask, c.bbox, 3);
        if (!ink || ink.count < MIN_INK || !ink.bbox) return;
        var th = ink.bbox.y1 - ink.bbox.y0 + 1;
        var job = { bytes: R.encodePBM(bin, ink.bbox, pad, mask), psm: th > multiLineH ? "6" : "7" };
        // 第一輪先辨識最左欄（列標籤），用來判斷哪些列是逐時資料
        if (c.c0 === 0) { firstJobs.push(job); firstTargets.push({ cell: cell, ft: ft }); }
        else restCells.push({ cell: cell, job: job, ft: ft });
      });
      return ft;
    });

    // 表格外文字列（頁面脈絡）
    var lineBoxes = [];
    try {
      lineBoxes = G.textLines(bin, tables.map(function (t) { return t.bbox; }), { dpi: dpi }) || [];
    } catch (e) { lineBoxes = []; }
    // 無表格頁面不辨識文字（封面/目錄等，辨識耗時但不含要填的數值）
    var lineLimit = tables.length ? MAX_CONTEXT_LINES : 0;
    lineBoxes = lineBoxes.slice(0, lineLimit);

    var totalCells = firstJobs.length + restCells.length + lineBoxes.length;
    if (!totalCells) return Promise.resolve({ tables: ftables, lines: [] });
    var doneBase = 0;
    var pg = opts && opts._page, pageTxt = pg && pg.pages > 1 ? pageNo + "/" + pg.pages : String(pageNo);
    function prog(d, tot) {
      progress(opts, "ocr", doneBase + d, totalCells, "第 " + pageTxt + " 頁：辨識儲存格 " + (doneBase + d) + "/" + totalCells);
    }
    // OCR 失敗（元件載入失敗、逾時、worker 當掉）的格數：有失敗時結果不快取，並提示使用者
    var oe = doc._ocrErr || (doc._ocrErr = { n: 0, ok: 0, msg: "" });
    function note(r) {
      if (r && r.error) { oe.n++; if (!oe.msg) oe.msg = String(r.error); }
      else if (r) oe.ok++;
    }
    function assign(targets, res) {
      for (var i = 0; i < targets.length; i++) {
        var r = res[i] || {};
        note(res[i]);
        targets[i].text = cleanOcrText(r.text);
        targets[i].conf = (typeof r.conf === "number") ? Math.round(r.conf) : null;
      }
    }
    function ocrBatch(jobs) {
      return jobs.length ? YF.ocr.recognizeCells(jobs, prog) : Promise.resolve([]);
    }
    var firstCells = firstTargets.map(function (x) { return x.cell; });
    return ocrBatch(firstJobs).then(function (res1) {
      assign(firstCells, res1);
      doneBase += firstJobs.length;
      // 列標籤為時段（10:00 ~ 11:00）的單列＝逐時資料：填表只用最大/最小/日平均列，略過以加速
      var timeRows = {};
      firstTargets.forEach(function (x) {
        if (x.cell.r0 === x.cell.r1 && isTimeRangeText(x.cell.text)) timeRows[x.ft.id + ":" + x.cell.r0] = true;
      });
      var jobs = [], targets = [], skipped = 0;
      restCells.forEach(function (x) {
        if (x.cell.r0 === x.cell.r1 && timeRows[x.ft.id + ":" + x.cell.r0]) {
          x.cell.skipped = true; skipped++; return;
        }
        jobs.push(x.job); targets.push(x.cell);
      });
      totalCells -= skipped;
      var lineStart = jobs.length;
      lineBoxes.forEach(function (lb) {
        var bb = lb.bbox || lb;
        jobs.push({ bytes: R.encodePBM(bin, bb, pad, null), psm: "7" });
      });
      doc.stats.ocrCells += firstCells.length + targets.length;
      doc.stats.skippedCells = (doc.stats.skippedCells || 0) + skipped;
      return ocrBatch(jobs).then(function (res) {
        assign(targets, res);
        return res.slice(lineStart);
      });
    }).then(function (res) {
      var lines = [];
      for (var k = 0; k < lineBoxes.length; k++) {
        var lr = res[k] || {};
        note(res[k]);
        var txt = cleanOcrText(lr.text);
        if (txt) lines.push({ text: txt, bbox: lineBoxes[k].bbox || lineBoxes[k], conf: lr.conf });
      }
      var ctx = lines.map(function (l) { return l.text; });
      ftables.forEach(function (ft) {
        ft.context = ctx.slice();
        // 表格正上方最近的一列文字當作標題（例：「表六、周界檢測中異味污染物檢測記錄表」）
        if (ft.bbox) {
          var best = null;
          lines.forEach(function (l) {
            var b = l.bbox;
            if (b.y1 <= ft.bbox.y0 + 4 && ft.bbox.y0 - b.y1 < dpi * 0.6) {
              if (!best || b.y1 > best.bbox.y1) best = l;
            }
          });
          if (best) ft.title = best.text;
        }
      });
      return { tables: ftables, lines: lines };
    });
  }

  /* 文字型 PDF：格線由渲染圖偵測，文字取自 PDF 內文（免 OCR，精確） */
  function processVectorPdfPage(bin, items, pageNo, dpi) {
    var G = YF.grid;
    var det = G.detectTables(bin, { dpi: dpi });
    var tables = det.tables || [];
    var used = new Array(items.length);
    var ftables = tables.map(function (t, ti) {
      var ft = {
        id: "p" + pageNo + "t" + ti, page: pageNo, sheet: null, index: ti, title: "", context: [],
        nRows: t.nRows || (t.ys ? t.ys.length - 1 : 0), nCols: t.nCols || (t.xs ? t.xs.length - 1 : 0),
        bbox: t.bbox || null, cells: []
      };
      (t.cells || []).forEach(function (c) {
        var parts = [];
        items.forEach(function (it, ii) {
          var cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2;
          if (cx >= c.bbox.x0 && cx <= c.bbox.x1 && cy >= c.bbox.y0 && cy <= c.bbox.y1) {
            parts.push(it); used[ii] = true;
          }
        });
        ft.cells.push({ r0: c.r0, r1: c.r1, c0: c.c0, c1: c.c1, text: joinItems(parts), conf: null, bbox: c.bbox, ref: null });
      });
      return ft;
    });
    var rest = items.filter(function (it, ii) { return !used[ii]; });
    var lines = groupLines(rest);
    var ctx = lines.map(function (l) { return l.text; });
    ftables.forEach(function (ft) {
      ft.context = ctx.slice();
      if (ft.bbox) {
        var best = null;
        lines.forEach(function (l) {
          if (l.y1 <= ft.bbox.y0 + 4 && ft.bbox.y0 - l.y1 < dpi * 0.6 && (!best || l.y1 > best.y1)) best = l;
        });
        if (best) ft.title = best.text;
      }
    });
    // 沒有格線的文字型 PDF（三線表、無框線表）：依文字位置推估欄位；再不行才以文字列當作單欄表格
    if (!ftables.length && lines.length) {
      var lt = layoutTables(lines, pageNo, dpi);
      if (lt.length) { lt.forEach(function (t) { ftables.push(t); }); ftables.noGrid = true; }
      else ftables.push(linesAsTable(lines, pageNo));
    }
    return ftables;
  }
  /* 一列文字依水平間距切成片段（間距超過約 0.8 個字高即視為換欄） */
  function lineSegments(L) {
    var segs = [], cur = null;
    L.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var h = Math.max(1, it.y1 - it.y0);
      if (cur && it.x0 - cur.x1 <= h * 0.8) {
        cur.items.push(it);
        cur.x1 = Math.max(cur.x1, it.x1); cur.y0 = Math.min(cur.y0, it.y0); cur.y1 = Math.max(cur.y1, it.y1);
      } else {
        cur = { items: [it], x0: it.x0, x1: it.x1, y0: it.y0, y1: it.y1 };
        segs.push(cur);
      }
    });
    segs.forEach(function (sg) {
      var t = "", prev = null;
      sg.items.forEach(function (it) {
        if (prev && it.x0 - prev.x1 > (it.y1 - it.y0) * 0.35) t += " ";
        t += it.str; prev = it;
      });
      sg.text = cleanOcrText(t);
    });
    return segs.filter(function (sg) { return sg.text; });
  }
  /* 無框線表格：連續 ≥ 2 列、每列 ≥ 2 個片段者視為一張表；欄位以片段最多的列對齊 */
  function layoutTables(lines, pageNo, dpi) {
    var rows = lines.map(function (L) { return { L: L, segs: lineSegments(L) }; });
    var blocks = [], cur = [];
    rows.forEach(function (r) {
      if (r.segs.length >= 2) cur.push(r);
      else { if (cur.length >= 2) blocks.push(cur); cur = []; }
    });
    if (cur.length >= 2) blocks.push(cur);
    var out = [], used = {};
    blocks.forEach(function (blk, bi) {
      var maxSegs = 0;
      blk.forEach(function (r) { maxSegs = Math.max(maxSegs, r.segs.length); });
      // 欄帶：片段最多的列，同序片段區間取聯集；與相鄰欄重疊則合併
      var bands = [];
      blk.forEach(function (r) {
        if (r.segs.length !== maxSegs) return;
        r.segs.forEach(function (sg, k) {
          if (!bands[k]) bands[k] = { x0: sg.x0, x1: sg.x1 };
          else { bands[k].x0 = Math.min(bands[k].x0, sg.x0); bands[k].x1 = Math.max(bands[k].x1, sg.x1); }
        });
      });
      for (var k = bands.length - 1; k > 0; k--) {
        if (bands[k].x0 <= bands[k - 1].x1) { bands[k - 1].x1 = Math.max(bands[k - 1].x1, bands[k].x1); bands.splice(k, 1); }
      }
      if (bands.length < 2) return;
      function bandsOf(sg) {
        var hit = [];
        bands.forEach(function (b, i) { if (sg.x0 <= b.x1 && sg.x1 >= b.x0) hit.push(i); });
        if (hit.length) return [hit[0], hit[hit.length - 1]];
        var cx = (sg.x0 + sg.x1) / 2, best = 0, bd = Infinity;
        bands.forEach(function (b, i) {
          var d = cx < b.x0 ? b.x0 - cx : cx > b.x1 ? cx - b.x1 : 0;
          if (d < bd) { bd = d; best = i; }
        });
        return [best, best];
      }
      var cells = [], x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      blk.forEach(function (r, ri) {
        used[lines.indexOf(r.L)] = true;
        var byCol = {};
        r.segs.forEach(function (sg) {
          var span = bandsOf(sg), key = span[0] + "-" + span[1];
          var c = byCol[key];
          if (c) { c.text += " " + sg.text; c.bbox.x1 = Math.max(c.bbox.x1, sg.x1); return; }
          // 與已有儲存格重疊的欄位（跨欄片段）不重複建立
          var clash = cells.some(function (o) { return o.r0 === ri && span[0] <= o.c1 && span[1] >= o.c0; });
          if (clash) return;
          c = byCol[key] = { r0: ri, r1: ri, c0: span[0], c1: span[1], text: sg.text, conf: null,
            bbox: { x0: sg.x0, y0: sg.y0, x1: sg.x1, y1: sg.y1 }, ref: null };
          cells.push(c);
        });
        x0 = Math.min(x0, r.L.x0); y0 = Math.min(y0, r.L.y0); x1 = Math.max(x1, r.L.x1); y1 = Math.max(y1, r.L.y1);
      });
      out.push({
        id: "p" + pageNo + "x" + bi, page: pageNo, sheet: null, index: bi, title: "", context: [],
        nRows: blk.length, nCols: bands.length, bbox: { x0: x0, y0: y0, x1: x1, y1: y1 }, cells: cells, layout: true
      });
    });
    if (!out.length) return out;
    var rest = lines.filter(function (l, i) { return !used[i]; });
    var ctx = rest.map(function (l) { return l.text; });
    out.forEach(function (ft) {
      ft.context = ctx.slice();
      var best = null;
      rest.forEach(function (l) {
        if (l.y1 <= ft.bbox.y0 + 4 && ft.bbox.y0 - l.y1 < dpi * 0.6 && (!best || l.y1 > best.y1)) best = l;
      });
      if (best) ft.title = best.text;
    });
    return out;
  }
  function joinItems(parts) {
    if (!parts.length) return "";
    var lines = groupLines(parts);
    return cleanOcrText(lines.map(function (l) { return l.text; }).join("\n"));
  }
  function groupLines(items) {
    var sorted = items.filter(function (it) { return it.str && it.str.trim(); }).slice().sort(function (a, b) {
      return (a.y0 - b.y0) || (a.x0 - b.x0);
    });
    var lines = [];
    sorted.forEach(function (it) {
      var h = Math.max(1, it.y1 - it.y0);
      var cy = (it.y0 + it.y1) / 2;
      var line = null;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
        var L = lines[i];
        if (Math.abs(((L.y0 + L.y1) / 2) - cy) < Math.max(h, L.y1 - L.y0) * 0.6) { line = L; break; }
      }
      if (!line) { line = { items: [], x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1 }; lines.push(line); }
      line.items.push(it);
      line.x0 = Math.min(line.x0, it.x0); line.y0 = Math.min(line.y0, it.y0);
      line.x1 = Math.max(line.x1, it.x1); line.y1 = Math.max(line.y1, it.y1);
    });
    lines.forEach(function (L) {
      L.items.sort(function (a, b) { return a.x0 - b.x0; });
      var s = "", prev = null;
      L.items.forEach(function (it) {
        if (prev && it.x0 - prev.x1 > (it.y1 - it.y0) * 0.35) s += " ";
        s += it.str; prev = it;
      });
      L.text = cleanOcrText(s);
      L.bbox = { x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y1 };
    });
    return lines.filter(function (l) { return l.text; });
  }
  function linesAsTable(lines, pageNo) {
    return {
      id: "p" + pageNo + "L", page: pageNo, sheet: null, index: 99, title: "", context: [], textOnly: true,
      nRows: lines.length, nCols: 1, bbox: null,
      cells: lines.map(function (l, i) {
        return { r0: i, r1: i, c0: 0, c1: 0, text: l.text, conf: null, bbox: l.bbox, ref: null };
      })
    };
  }

  /* =====================================================================
   * 各格式處理
   * ===================================================================== */
  function processXdw(bytes, doc, opts) {
    var parsed = YF.xdw.parse(bytes);
    (parsed.warnings || []).forEach(function (w) { doc.warnings.push(w); });
    doc.info = YF.xdw.describe ? YF.xdw.describe(bytes) : ("DocuWorks：" + parsed.pages.length + " 頁");
    var pages = parsed.pages || [];
    doc.stats.pages = pages.length;
    doc._xdwPages = pages;
    doc.pages = pages.map(function (p, i) {
      return { index: i + 1, width: p.width, height: p.height, dpi: p.dpiX || 200 };
    });
    if (!pages.length) return Promise.resolve();
    if (!ocrReady(doc)) return Promise.resolve();
    var chain = Promise.resolve();
    pages.forEach(function (p, i) {
      chain = chain.then(function () {
        checkAbort(opts);
        setPage(opts, i, pages.length);
        progress(opts, "page", i, pages.length, "第 " + (i + 1) + "/" + pages.length + " 頁：解碼影像");
        // 像素上限：異常巨大的頁面（例：20000×20000）解碼需數十秒、上 GB 記憶體，直接略過
        if (p.width && p.height && p.width * p.height > MAX_PAGE_PIXELS) {
          addWarning(doc, "第 " + (i + 1) + " 頁影像過大（" + p.width + "×" + p.height + "），已略過");
          doc._noCache = true;
          return null;
        }
        return Promise.resolve().then(function () {
          return p.decode ? p.decode() : null;
        }).then(function (bin) {
          if (!bin && p.decodeAsync) return p.decodeAsync().then(function (rgba) { return toBitmap(rgba); });
          return bin;
        }).catch(function (e) {
          addWarning(doc, "第 " + (i + 1) + " 頁影像解碼失敗（" + e.message + "），已略過");
          doc._noCache = true;
          return null;
        }).then(function (bin) {
          // 解碼時的提示（例：G4 資料截斷，其餘留白）在 decode() 內才產生，逐頁帶到檔案提示
          if (p.warnings && p.warnings.length) {
            p.warnings.forEach(function (w) { addWarning(doc, w); });
            doc._noCache = true;
          }
          if (!bin) { addWarning(doc, "第 " + (i + 1) + " 頁影像格式無法解碼，已略過"); doc._noCache = true; return null; }
          return processBitmapPage(bin, i + 1, p.dpiX || 200, doc, opts).then(function (r) {
            r.tables.forEach(function (t) { doc.tables.push(t); });
          });
        });
      });
    });
    return chain.then(function () { progress(opts, "page", pages.length, pages.length, "完成"); });
  }

  function toBitmap(img) {
    if (!img) return null;
    if (img.data && img.data.length === img.width * img.height) return img;       // 已是 Bitmap
    return YF.raster.binarize(img.data, img.width, img.height);
  }

  function processPdf(bytes, doc, opts) {
    var DPI = 200;
    return YF.pdf.open(bytes).then(function (pdf) {
      doc.stats.pages = pdf.numPages;
      doc._pdf = pdf;
      var scanned = 0, vector = 0, ocrPages = 0, noGrid = 0;
      var chain = Promise.resolve();
      for (var n = 1; n <= pdf.numPages; n++) {
        (function (n) {
          chain = chain.then(function () {
            checkAbort(opts);
            setPage(opts, n - 1, pdf.numPages);
            progress(opts, "page", n - 1, pdf.numPages, "第 " + n + "/" + pdf.numPages + " 頁：轉換影像");
            return pdf.getPage(n).then(function (pg) {
              return Promise.all([pg.render(DPI), pg.textItems(DPI)]).then(function (res) {
                var rgba = res[0], items = res[1] || [];
                var dpi = rgba.dpi || DPI;      // 超大頁面時 pdfread 會自動降低 dpi（座標與文字一致）
                var bin = YF.raster.binarize(rgba.data, rgba.width, rgba.height);
                doc.pages.push({ index: n, width: rgba.width, height: rgba.height, dpi: dpi });
                var chars = items.reduce(function (s, it) { return s + (it.str ? it.str.trim().length : 0); }, 0);
                if (chars >= 30) {
                  vector++;
                  var vt = processVectorPdfPage(bin, items, n, dpi);
                  if (vt.noGrid) noGrid++;
                  vt.forEach(function (t) { doc.tables.push(t); });
                  return null;
                }
                scanned++;
                if (!ocrReady(doc)) return null;
                ocrPages++;
                return processBitmapPage(bin, n, dpi, doc, opts).then(function (r) {
                  r.tables.forEach(function (t) { doc.tables.push(t); });
                });
              });
            });
          });
        })(n);
      }
      return chain.then(function () {
        doc.info = "PDF：" + pdf.numPages + " 頁" +
          (vector ? "（文字型 " + vector + " 頁" : "（") + (vector && scanned ? "、" : "") +
          (scanned ? "掃描影像 " + scanned + " 頁" + (ocrPages ? "，以 OCR 辨識" : "，未辨識") : "") + "）";
        if (vector && noGrid) {
          addWarning(doc, noGrid === vector ? "未偵測到表格框線，已依文字位置推估欄位；數值請對照原檔核對"
            : noGrid + " 頁未偵測到表格框線，已依文字位置推估欄位；數值請對照原檔核對");
        }
      });
    });
  }

  /* 影像檔 → [{bin, dpi}]（多頁 TIFF 取全部頁；大圖會在解碼時縮小，dpi 依比例調整） */
  function decodeImagePages(bytes, type, warnings) {
    var metaDpi = (type.meta && type.meta.dpi >= 72 && type.meta.dpi <= 1200) ? type.meta.dpi : null;
    if (type.kind === "tif" && YF.ccitt && YF.ccitt.decodeTiff) {
      var bms = [];
      try { bms = YF.ccitt.decodeTiff(bytes, { warnings: warnings || [] }) || []; } catch (e) { bms = []; }
      if (bms.length) {
        return Promise.resolve(bms.map(function (bm) {
          return { bin: bm, dpi: bm.dpi || bm.dpiX || metaDpi || estimateDpi(bm) };
        }));
      }
    }
    return YF.raster.decodeImageBytes(bytes, type.mime || null).then(function (res) {
      var scale = res.scale || 1;
      var list = res.pages && res.pages.length ? res.pages : [res];
      return list.map(function (pg) {
        var bin = pg.bitmap || (pg.data && pg.data.length === pg.width * pg.height ? pg : YF.raster.binarize(pg.data, pg.width, pg.height));
        var dpi = metaDpi ? Math.round(metaDpi * scale) : estimateDpi(bin);
        return { bin: bin, dpi: dpi };
      });
    });
  }

  function processImage(bytes, doc, opts, type) {
    var ws = [];
    return decodeImagePages(bytes, type, ws).then(function (pages) {
      if (ws.length) { ws.forEach(function (w) { addWarning(doc, w); }); doc._noCache = true; }
      pages = (pages || []).filter(function (p) { return p && p.bin; });
      doc.stats.pages = pages.length;
      doc._bitmaps = pages.map(function (p) { return p.bin; });
      doc.info = "影像：" + pages.length + " 頁" + (pages[0] ? "（" + pages[0].bin.width + "×" + pages[0].bin.height + "）" : "");
      pages.forEach(function (p, i) { doc.pages.push({ index: i + 1, width: p.bin.width, height: p.bin.height, dpi: p.dpi }); });
      if (!pages.length || !ocrReady(doc)) return null;
      var chain = Promise.resolve();
      pages.forEach(function (p, i) {
        chain = chain.then(function () {
          checkAbort(opts);
          setPage(opts, i, pages.length);
          progress(opts, "page", i, pages.length, "第 " + (i + 1) + "/" + pages.length + " 頁");
          return processBitmapPage(p.bin, i + 1, p.dpi, doc, opts).then(function (r) {
            r.tables.forEach(function (t) { doc.tables.push(t); });
          });
        });
      });
      return chain;
    });
  }
  /* 影像無 dpi 資訊：以 A4 直式寬度推估（1654 px ≈ 200 dpi） */
  function estimateDpi(bin) {
    var shortSide = Math.min(bin.width, bin.height);
    var dpi = Math.round(shortSide / 8.27);
    return Math.max(100, Math.min(600, dpi));
  }

  function processDocx(bytes, doc) {
    return YF.docx.load(bytes).then(function (model) {
      doc._model = model;
      doc.tables = model.tables || [];
      doc.info = "Word：" + doc.tables.length + " 個表格";
      (model.warnings || []).forEach(function (w) { addWarning(doc, w); });
      if (doc.role === "raw") rawDocxContext(doc.tables, model.headers || []);
    });
  }
  /* 原始 Word 報告：測站／監測日期常寫在頁首（監測位置：…），或只寫在該段第一個表格前；
   * 表格本身脈絡沒有時，補上同段前一個表格的「監測位置」「監測日期」與頁首文字 */
  var RE_CTX_DATE = /(監測|檢測|採樣|量測)\s*(日期|時間)/;
  function rawDocxContext(tables, headers) {
    var dict = YF.dict;
    if (!dict || !dict.findStationCapture) return;
    function capOf(lines) {
      for (var i = 0; i < lines.length; i++) {
        if (typeof lines[i] === "string" && dict.findStationCapture(lines[i])) return lines[i];
      }
      return null;
    }
    function dateOf(lines) {
      for (var i = 0; i < lines.length; i++) {
        var l = typeof lines[i] === "string" ? lines[i] : "";
        var at = l.search(RE_CTX_DATE);
        if (at >= 0 && dict.parseRocDate && dict.parseRocDate(l.slice(at))) return l;
      }
      return null;
    }
    var headCap = capOf(headers), headDate = dateOf(headers), last = null, lastDate = null;
    tables.forEach(function (t) {
      var ctx = (t.context || []).slice();
      var own = ctx.concat(t.title ? [t.title] : []);
      var ownCap = capOf(own), ownDate = dateOf(own);
      // 只有「表N …」表名或無文字時才沿用（有其他標題文字者可能是另一段）
      var captionOnly = ctx.every(function (l) { return !l || /^\s*(附)?(表|圖)\s*[\dA-Za-z一二三四五六七八九十]/.test(l); });
      if (ownCap) last = ownCap;
      else if (last && captionOnly) ctx.push(last);
      else if (headCap) ctx.push(headCap);
      if (ownDate) lastDate = ownDate;
      else if (lastDate && (captionOnly || ownCap)) ctx.push(lastDate);
      else if (headDate) ctx.push(headDate);
      t.context = ctx;
    });
  }

  function processSheet(bytes, doc, type) {
    var input = bytes;
    // Big5 / UTF-16 的 CSV 先轉成 UTF-8，SheetJS 才不會亂碼
    var enc = type.meta && type.meta.encoding;
    if ((type.kind === "csv" || type.kind === "txt") && enc && enc !== "utf-8" && root.TextDecoder) {
      try {
        var text = new root.TextDecoder(enc).decode(bytes);
        input = new root.TextEncoder().encode("\ufeff" + text.replace(/^\ufeff/, ""));
      } catch (e) { input = bytes; }
    }
    return YF.xlsx.load(input, doc.name).then(function (model) {
      doc._model = model;
      doc.tables = model.tables || [];
      (model.warnings || []).forEach(function (w) {
        // 原始資料不輸出檔案，「輸出時格式可能遺失」的提示只對待填表格有意義
        if (doc.role === "raw" && /輸出/.test(w)) return;
        addWarning(doc, w);
      });
      var sheets = {};
      doc.tables.forEach(function (t) { if (t.sheet) sheets[t.sheet] = 1; });
      doc.info = (type.family === "excel" ? "Excel" : type.label) + "：" + Object.keys(sheets).length +
        " 個工作表、" + doc.tables.length + " 個表格區塊";
      if (doc.role === "raw") doc.moduleFacts = moduleFacts(bytes, doc);
    });
  }

  function ocrReady(doc) {
    var av = YF.ocr && YF.ocr.available ? YF.ocr.available() : { ok: false, reason: "OCR 元件未載入" };
    if (!av.ok) {
      addWarning(doc, "此檔為掃描影像，需要 OCR：" + av.reason);
      doc.needsOcr = true;
      return false;
    }
    return true;
  }

  /* =====================================================================
   * 既有模組（水質/空氣/噪音）解析器 → Fact（Excel 原始資料的精確補充）
   * 只取解析器有把握的值：空氣=日平均、噪音=L日/L晚/L夜、振動=Lv日/Lv夜、水質=各項目。
   * ===================================================================== */
  function moduleFacts(bytes, doc) {
    var out = [];
    if (!root.XLSX || !root.YangConfigs || !root.YangCore || !root.YangCore.parser) return out;
    try {
      var wb = root.XLSX.read(bytes, { type: "array", cellDates: false });
      var fm = {
        fileName: doc.name,
        sheetNames: wb.SheetNames.slice(),
        sheet: function (name) {
          var ws = wb.Sheets[name];
          return {
            get: function (addr) { var c = ws[addr]; return (!c || c.v === undefined || c.v === null) ? null : c.v; },
            str: function (addr) { var v = this.get(addr); return v === null ? "" : String(v).trim(); }
          };
        }
      };
      var tables = {};
      ["water", "air", "noise"].forEach(function (mid) {
        var cfg = root.YangConfigs[mid], db = root.YangDB && root.YangDB[mid];
        if (!cfg || !db) return;
        tables[mid] = {};
        (cfg.tableNames || []).forEach(function (n) { tables[mid][n] = db[n]; });
      });
      var jobs = ["noise", "air", "water"].filter(function (mid) { return root.YangConfigs[mid]; }).map(function (mid) {
        return { config: root.YangConfigs[mid], ctx: { tables: tables[mid], stations: [] } };
      });
      var res = root.YangCore.parser.parseFilesMulti([fm], jobs);
      res.records.forEach(function (rec) {
        var cfg = root.YangConfigs[rec.module];
        var site = rec.f[cfg.stationField] ? rec.f[cfg.stationField].v : rec.stationRaw;
        var date = rec.f.dateStart ? rec.f.dateStart.v : null;
        (rec.items || []).forEach(function (it) {
          var conv = moduleItemToFact(rec.module, it);
          if (!conv) return;
          out.push({
            item: conv.item, stat: conv.stat, unit: conv.unit, station: site,
            value: conv.value, date: date, sheet: rec.sheetName,
            where: "工作表「" + rec.sheetName + "」（" + cfg.label + "模組解析）"
          });
        });
      });
    } catch (e) {
      doc.warnings.push("既有模組解析器略過：" + e.message);
    }
    return out;
  }
  function moduleItemToFact(mid, it) {
    var v = it.valueOut ? it.valueOut.v : null;
    if (v === null || v === undefined || v === "") return null;
    var cmp = it.compare && it.compare.v ? it.compare.v : "";
    var value = String(v);
    if (cmp === "<" || cmp === ">") value = cmp + value;
    if (mid === "noise") {
      var ct = it.charType ? String(it.charType.v || "") : "", per = it.period ? String(it.period.v || "") : "";
      var item = null;
      if (/Leq|均能/.test(ct)) item = per.indexOf("日") >= 0 ? "LD" : per.indexOf("晚") >= 0 ? "LE" : per.indexOf("夜") >= 0 ? "LN" : null;
      else if (/Lvd/i.test(ct)) item = "LVD";
      else if (/Lvn/i.test(ct)) item = "LVN";
      if (!item) return null;
      // 噪音／振動以一位小數表示（41 → 41.0，與報告原文一致）
      if (typeof v === "number" && isFinite(v)) value = (cmp === "<" || cmp === ">" ? cmp : "") + v.toFixed(1);
      return { item: item, stat: "value", unit: /Lv/i.test(ct) ? "dB" : "dB(A)", value: value };
    }
    var name = it.rawName || (it.itemName ? it.itemName.v : "");
    var hits = YF.dict && YF.dict.findItems ? YF.dict.findItems(String(name)) : [];
    if (!hits.length) return null;
    return { item: hits[0].code, stat: mid === "air" ? "daily" : "value", unit: null, value: value };
  }

  /* =====================================================================
   * 對外 API
   * ===================================================================== */
  /**
   * process(file, opts) → Promise<Doc>
   * opts: { role: 'raw'|'template', onProgress, signal, cache: {get(key)→Promise, put(obj)→Promise} }
   */
  function processFile(file, opts) {
    opts = opts || {};
    var role = opts.role || "raw";
    return readBytes(file).then(function (bytes) {
      var FT = YF.filetype;
      var type = FT.detect(bytes, file.name);
      var doc = newDoc(file, role, type);
      doc._bytes = bytes;
      doc.type = type;
      var mismatchText = type.mismatch ? (type.mismatchText || ("副檔名與實際內容不符：" + type.label)) : null;
      if (mismatchText) doc.warnings.push(mismatchText);
      if (type.supported === false || !type.route) {
        doc.warnings.push(type.hint || ("不支援的檔案格式（" + (type.label || type.kind) + "）"));
        doc.unsupported = true;
        return doc;
      }
      if (FT.canUse) {
        var cu = FT.canUse(type, role);
        if (!cu.ok) { doc.warnings.push(cu.reason); doc.unsupported = true; return doc; }
      } else if (role === "template" && ["word", "excel"].indexOf(type.family) < 0) {
        doc.warnings.push("待填表格目前支援 Word（.docx）與 Excel（.xlsx/.xls）");
        doc.unsupported = true;
        return doc;
      }
      // 範本需保留可寫回的模型，不使用快取；原始資料一律計算雜湊（辨識快取、重複檔案判斷）
      var useCache = role === "raw" && opts.cache && ["xdw", "pdf", "image"].indexOf(type.route) >= 0;
      var hashP = role === "raw" ? sha256Hex(bytes) : Promise.resolve(null);
      return hashP.then(function (hash) {
        doc.hash = hash;
        var key = hash && useCache ? hash + ":" + PIPELINE_VERSION : null;
        var cachedP = key ? opts.cache.get(key).catch(function () { return null; }) : Promise.resolve(null);
        return cachedP.then(function (cached) {
          checkAbort(opts);
          if (cached && cached.tables) {
            doc.tables = cached.tables; doc.pages = cached.pages || []; doc.info = cached.info || "";
            doc.stats = cached.stats || doc.stats;
            (cached.warnings || []).forEach(function (w) { addWarning(doc, w); });
            doc.fromCache = true;
            attachPageSource(doc, type, bytes);
            return doc;
          }
          var work;
          switch (type.route) {
            case "xdw": work = processXdw(bytes, doc, opts); break;
            case "pdf": work = processPdf(bytes, doc, opts); break;
            case "image": work = processImage(bytes, doc, opts, type); break;
            case "docx": work = processDocx(bytes, doc); break;
            case "sheet": work = processSheet(bytes, doc, type); break;
            default:
              doc.warnings.push(type.hint || ("無法辨識的檔案格式（" + (type.label || type.kind) + "）"));
              doc.unsupported = true; work = Promise.resolve();
          }
          return work.then(function () {
            doc.stats.tables = doc.tables.length;
            doc.stats.cells = doc.tables.reduce(function (s, t) { return s + t.cells.length; }, 0);
            var oe = doc._ocrErr;
            delete doc._ocrErr;
            if (oe && oe.n) {
              // OCR 元件載入失敗／逾時：不可當成「空白儲存格」存入快取，下次上傳需重新辨識
              doc.ocrFailed = true;
              if (!oe.ok) doc.needsOcr = true;
              addWarning(doc, (oe.ok ? oe.n + " 格" : "全部 " + oe.n + " 格") + " OCR 辨識失敗（" + oe.msg +
                "）；結果未存入快取，請移除後重新加入此檔再試一次");
            }
            // 有 OCR 但沒有任何儲存格讀到文字：多半是辨識異常，不快取
            var noText = doc.stats.ocrCells > 0 && !doc.tables.some(function (t) {
              return t.cells.some(function (c) { return !!c.text; });
            });
            if (key && !doc.needsOcr && !doc.unsupported && !doc.ocrFailed && !doc._noCache && !noText) {
              var pipeWarn = doc.warnings.filter(function (w) { return w !== mismatchText; });
              return opts.cache.put({
                key: key, name: doc.name, savedAt: new Date().toISOString(),
                tables: doc.tables, pages: doc.pages, info: doc.info, stats: doc.stats, warnings: pipeWarn
              }).catch(function () { /* 快取失敗不影響結果 */ });
            }
          }).then(function () {
            attachPageSource(doc, type, bytes);
            return doc;
          });
        });
      });
    });
  }

  /* 頁面影像來源（核對畫面裁切原始儲存格用；不常駐記憶體，用到才解碼，保留最近 3 頁） */
  function attachPageSource(doc, type, bytes) {
    var lru = [];
    function remember(n, bin) {
      lru = lru.filter(function (e) { return e.n !== n; });
      lru.unshift({ n: n, bin: bin });
      if (lru.length > 3) lru.length = 3;
      return bin;
    }
    doc.getPageBitmap = function (n) {
      for (var i = 0; i < lru.length; i++) if (lru[i].n === n) return Promise.resolve(lru[i].bin);
      if (type.route === "xdw") {
        if (!doc._xdwPages) doc._xdwPages = YF.xdw.parse(bytes).pages || [];
        var p = doc._xdwPages[n - 1];
        if (!p) return Promise.resolve(null);
        return Promise.resolve(p.decode ? p.decode() : null).then(function (bin) {
          if (!bin && p.decodeAsync) return p.decodeAsync().then(toBitmap);
          return bin;
        }).then(function (bin) { return bin ? remember(n, bin) : null; });
      }
      if (type.route === "pdf") {
        var pdfP = doc._pdf ? Promise.resolve(doc._pdf) : YF.pdf.open(bytes).then(function (pdf) { doc._pdf = pdf; return pdf; });
        return pdfP.then(function (pdf) { return pdf.getPage(n); }).then(function (pg) { return pg.render(200); })
          .then(function (rgba) { return remember(n, YF.raster.binarize(rgba.data, rgba.width, rgba.height)); });
      }
      if (type.route === "image") {
        if (doc._bitmaps) return Promise.resolve(doc._bitmaps[n - 1] || null);
        return decodeImagePages(bytes, type).then(function (pages) {
          doc._bitmaps = pages.map(function (p) { return p.bin; });
          return doc._bitmaps[n - 1] || null;
        });
      }
      return Promise.resolve(null);
    };
  }
  /* 頁面格線遮罩（裁切儲存格時去除框線用），每頁算一次 */
  function pageMask(doc, n, bin) {
    doc._masks = doc._masks || {};
    var m = doc._masks[n];
    if (m && m.w === bin.width && m.h === bin.height) return m.mask;
    var det = YF.grid.detectTables(bin, { dpi: (doc.pages[n - 1] && doc.pages[n - 1].dpi) || 200 });
    var keys = Object.keys(doc._masks);
    if (keys.length >= 3) delete doc._masks[keys[0]];
    doc._masks[n] = { w: bin.width, h: bin.height, mask: det.mask };
    return det.mask;
  }

  /* Bitmap 區塊 → PNG data URL（白底黑字；highlight 框以紅色標示），需要 DOM canvas */
  function renderBitmapRegion(bin, bbox, maxWidth, highlight) {
    var doc = root.document;
    if (!doc || !doc.createElement) return null;
    var w = bbox.x1 - bbox.x0 + 1, h = bbox.y1 - bbox.y0 + 1;
    if (w <= 0 || h <= 0) return null;
    var c1 = doc.createElement("canvas");
    c1.width = w; c1.height = h;
    var ctx = c1.getContext("2d");
    var img = ctx.createImageData(w, h), d = img.data, src = bin.data, W = bin.width;
    for (var y = 0; y < h; y++) {
      var row = (y + bbox.y0) * W + bbox.x0, o = y * w * 4;
      for (var x = 0; x < w; x++, o += 4) {
        var v = src[row + x] ? 20 : 255;
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    var scale = Math.min(1, (maxWidth || 560) / w);
    var c2 = doc.createElement("canvas");
    c2.width = Math.max(1, Math.round(w * scale)); c2.height = Math.max(1, Math.round(h * scale));
    var ctx2 = c2.getContext("2d");
    ctx2.imageSmoothingEnabled = true;
    ctx2.imageSmoothingQuality = "high";
    ctx2.drawImage(c1, 0, 0, c2.width, c2.height);
    if (highlight) {
      ctx2.strokeStyle = "rgba(220,40,40,.95)";
      ctx2.lineWidth = 2;
      ctx2.strokeRect((highlight.x0 - bbox.x0) * scale + 1, (highlight.y0 - bbox.y0) * scale + 1,
        (highlight.x1 - highlight.x0) * scale - 2, (highlight.y1 - highlight.y0) * scale - 2);
      ctx2.fillStyle = "rgba(255,214,0,.18)";
      ctx2.fillRect((highlight.x0 - bbox.x0) * scale, (highlight.y0 - bbox.y0) * scale,
        (highlight.x1 - highlight.x0) * scale, (highlight.y1 - highlight.y0) * scale);
    }
    return c2.toDataURL("image/png");
  }

  /** 數個區塊左右並排成一張 PNG（區塊間留白），highlight 為原始座標的紅框 */
  function renderRegions(bin, boxes, maxWidth, highlight) {
    var doc = root.document;
    if (!doc || !doc.createElement || !boxes.length) return null;
    var GAP = 10, W = 0, H = 0;
    boxes.forEach(function (b, i) { W += b.x1 - b.x0 + 1 + (i ? GAP : 0); H = Math.max(H, b.y1 - b.y0 + 1); });
    if (W <= 0 || H <= 0) return null;
    var c1 = doc.createElement("canvas");
    c1.width = W; c1.height = H;
    var ctx = c1.getContext("2d");
    var img = ctx.createImageData(W, H), d = img.data, src = bin.data, BW = bin.width;
    for (var q = 0; q < d.length; q++) d[q] = 255;
    var ox = 0, hl = null;
    boxes.forEach(function (b, i) {
      if (i) {
        for (var yy = 0; yy < H; yy++) for (var xx = ox; xx < ox + GAP; xx++) {
          var g = (yy * W + xx) * 4; d[g] = d[g + 1] = d[g + 2] = 236;
        }
        ox += GAP;
      }
      var w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
      for (var y = 0; y < h; y++) {
        var row = (y + b.y0) * BW + b.x0, o = (y * W + ox) * 4;
        for (var x = 0; x < w; x++, o += 4) {
          var v = src[row + x] ? 20 : 255;
          d[o] = v; d[o + 1] = v; d[o + 2] = v;
        }
      }
      if (highlight && !hl && highlight.x1 > b.x0 && highlight.x0 < b.x1) {
        // 紅框裁到此區塊範圍內
        hl = { x0: Math.max(highlight.x0, b.x0) - b.x0 + ox, y0: Math.max(highlight.y0, b.y0) - b.y0,
          x1: Math.min(highlight.x1, b.x1) - b.x0 + ox, y1: Math.min(highlight.y1, b.y1) - b.y0 };
      }
      ox += w;
    });
    ctx.putImageData(img, 0, 0);
    var scale = Math.min(1, (maxWidth || 360) / W);
    var c2 = doc.createElement("canvas");
    c2.width = Math.max(1, Math.round(W * scale)); c2.height = Math.max(1, Math.round(H * scale));
    var ctx2 = c2.getContext("2d");
    ctx2.imageSmoothingEnabled = true;
    ctx2.imageSmoothingQuality = "high";
    ctx2.drawImage(c1, 0, 0, c2.width, c2.height);
    if (hl) {
      ctx2.fillStyle = "rgba(255,214,0,.18)";
      ctx2.fillRect(hl.x0 * scale, hl.y0 * scale, (hl.x1 - hl.x0) * scale, (hl.y1 - hl.y0) * scale);
      ctx2.strokeStyle = "rgba(220,40,40,.95)";
      ctx2.lineWidth = 2;
      ctx2.strokeRect(hl.x0 * scale + 1, hl.y0 * scale + 1, (hl.x1 - hl.x0) * scale - 2, (hl.y1 - hl.y0) * scale - 2);
    }
    return c2.toDataURL("image/png");
  }

  /**
   * 原始影像條帶（核對畫面用）；回傳 PNG data URL 或 null。
   * 預設：該列的列標題格＋數值格左右各一兩格（縮放後仍看得清楚）；
   * opts.wide：整張表格寬度、上下各多一列（點擊放大檢視用）
   */
  function rowStripDataURL(doc, table, cell, maxWidth, opts) {
    if (!doc || !doc.getPageBitmap || !cell || !cell.bbox || !table || !table.page) return Promise.resolve(null);
    opts = opts || {};
    return doc.getPageBitmap(table.page).then(function (bin) {
      if (!bin) return null;
      var tb = table.bbox || cell.bbox, cb = cell.bbox, m = 6;
      function clip(b) {
        return { x0: Math.max(0, Math.round(b.x0)), y0: Math.max(0, Math.round(b.y0)),
          x1: Math.min(bin.width - 1, Math.round(b.x1)), y1: Math.min(bin.height - 1, Math.round(b.y1)) };
      }
      var rowH = Math.max(8, cb.y1 - cb.y0);
      if (opts.wide) {
        var wb = clip({ x0: Math.min(tb.x0, cb.x0) - m, x1: Math.max(tb.x1, cb.x1) + m,
          y0: cb.y0 - Math.min(rowH * 1.5, 160) - m, y1: cb.y1 + Math.min(rowH * 1.5, 160) + m });
        return renderRegions(bin, [wb], maxWidth || 1200, cb);
      }
      var y0 = cb.y0 - m, y1 = cb.y1 + m;
      // 合併儲存格很高時只取到最多 3 列文字高度，避免縮圖過大
      if (y1 - y0 > 260) y1 = y0 + 260;
      // 寬度預算：縮放後仍保有約 2/3 原尺寸（200 dpi 一列文字縮圖後約 30～40 px 高，數字清楚可讀）
      var mw = maxWidth || 360, budget = Math.round(mw / 0.65);
      var cw = Math.max(40, cb.x1 - cb.x0);
      var winW = Math.min(cw + 2 * m + Math.min(cw * 0.3, 60), Math.round(budget * 0.62));
      var cx = (cb.x0 + cb.x1) / 2;
      var win = clip({ x0: Math.max(tb.x0 - m, cx - winW / 2), x1: Math.min(tb.x1 + m, cx + winW / 2), y0: y0, y1: y1 });
      var boxes = [win];
      // 同列最左側的標題格（測站／項目），不在視窗內時另外並排顯示（取左段）
      var lab = null;
      (table.cells || []).forEach(function (c) {
        if (c.c0 === 0 && c.bbox && c !== cell && c.r0 <= cell.r0 && c.r1 >= cell.r0 && c.text) lab = c;
      });
      if (lab && lab.bbox.x1 < win.x0) {
        var lw = Math.min(lab.bbox.x1 - lab.bbox.x0, budget - (win.x1 - win.x0) - 10);
        // 跨列的標題格（例：CO 兩列）文字在格子中間：取標題格的垂直中段
        var ly0 = y0, ly1 = y1;
        if (lab.r1 > lab.r0) {
          var lcy = (lab.bbox.y0 + lab.bbox.y1) / 2, hh = (y1 - y0) / 2;
          ly0 = Math.max(lab.bbox.y0, lcy - hh); ly1 = Math.min(lab.bbox.y1, lcy + hh);
        }
        if (lw >= 40) boxes.unshift(clip({ x0: lab.bbox.x0, x1: lab.bbox.x0 + lw, y0: ly0, y1: ly1 }));
      }
      return renderRegions(bin, boxes, mw, cb);
    }).catch(function () { return null; });
  }

  /** 單一儲存格 PBM（第二次數值辨識用） */
  function cellPBM(doc, table, cell) {
    if (!doc || !doc.getPageBitmap || !cell || !cell.bbox || !table || !table.page) return Promise.resolve(null);
    return doc.getPageBitmap(table.page).then(function (bin) {
      if (!bin) return null;
      var mask = pageMask(doc, table.page, bin);
      var ink = YF.grid.cellInk(bin, mask, cell.bbox, 3, cell.frame ? { frame: cell.frame } : undefined);
      if (!ink || !ink.bbox || ink.count < MIN_INK) return null;
      return YF.raster.encodePBM(bin, ink.bbox, 12, mask);
    }).catch(function () { return null; });
  }

  /** 整頁縮圖（辨識結果檢視用） */
  function pageThumbDataURL(doc, n, maxWidth) {
    if (!doc || !doc.getPageBitmap) return Promise.resolve(null);
    return doc.getPageBitmap(n).then(function (bin) {
      if (!bin) return null;
      return renderBitmapRegion(bin, { x0: 0, y0: 0, x1: bin.width - 1, y1: bin.height - 1 }, maxWidth || 420, null);
    }).catch(function () { return null; });
  }

  /* =====================================================================
   * 待填表格寫回：fills = [{tableId, r0, c0, value, mark}]
   * → Promise<{bytes, fileName, mime, warnings}>（與原檔同格式）
   * ===================================================================== */
  var MIME = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    docm: "application/vnd.ms-word.document.macroEnabled.12",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    xls: "application/vnd.ms-excel"
  };
  function filledName(name, ext) {
    var base = String(name).replace(/\.[^.]+$/, "");
    return base + "_已填寫." + ext;
  }
  function fillTemplate(doc, fills) {
    if (!doc || !doc._model) return Promise.reject(new Error("範本尚未載入"));
    var origExt = (String(doc.name).match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
    var warnings = [];
    if (doc.type && doc.type.route === "docx") {
      return YF.docx.fill(doc._model, fills, { warnings: warnings }).then(function (bytes) {
        var ext = doc._model.outExt || (origExt === "docm" ? "docm" : "docx");
        return { bytes: bytes, fileName: filledName(doc.name, ext), mime: MIME[ext] || MIME.docx, warnings: warnings };
      });
    }
    return YF.xlsx.fill(doc._model, fills, { warnings: warnings }).then(function (res) {
      var bytes = res && res.bytes ? res.bytes : res;
      var ext = (res && res.ext) || (origExt === "xlsm" ? "xlsm" : origExt === "xls" ? "xls" : "xlsx");
      var warns = (res && res.warnings) || warnings;
      return { bytes: bytes, fileName: filledName(doc.name, ext), mime: (res && res.mime) || MIME[ext] || "application/octet-stream", warnings: warns };
    });
  }

  YF.tpl = { fill: fillTemplate, filledName: filledName, MIME: MIME };

  YF.raw = {
    PIPELINE_VERSION: PIPELINE_VERSION,
    process: processFile,
    rowStripDataURL: rowStripDataURL,
    cellPBM: cellPBM,
    pageThumbDataURL: pageThumbDataURL,
    _cleanOcrText: cleanOcrText,
    _layoutTables: layoutTables,
    _rawDocxContext: rawDocxContext,
    _groupLines: groupLines
  };
})(typeof window !== "undefined" ? window : globalThis);
