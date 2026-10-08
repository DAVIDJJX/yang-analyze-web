/* =========================================================================
 * Yang-analyze web — fill/pdfread.js
 * pdf.js（3.11.174，本機 lib/pdfjs 內建）薄包裝：
 *   - open(bytes) → 文件；getPage(n) → 頁面（先取文字內容，textCharCount 供判斷掃描頁 / 文字頁）
 *   - page.render(dpi) → RGBA 影像（OffscreenCanvas 優先，失敗改用 <canvas>；白底）
 *   - page.textItems(dpi) → 文字片段在「同 dpi 影像」上的像素框（左上原點），含頁面旋轉
 * 超大頁面自動降低 dpi（render 與 textItems 使用同一個實際 dpi，座標必定對齊；結果帶 dpi 欄位）。
 * 安全：isEvalSupported=false（避免惡意字型執行程式碼，CVE-2024-4367）。
 * 中文非內嵌字型（UniCNS-UCS2-H、ETen-B5 等）需要 lib/pdfjs/cmaps 才能正確取出文字。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var SCRIPT_BASE = (function () {
    try {
      var cs = root.document && root.document.currentScript;
      if (cs && cs.src) return new URL("../../", cs.src).href;
    } catch (e) { /* 忽略 */ }
    return null;
  })();

  var cfg = {
    base: null,           // 網站根目錄（null = 由本檔位置推算）
    maxPixels: 25e6,      // 單頁影像像素上限（約 A3 300dpi）；超過自動降 dpi
    maxDim: 12000         // 單邊像素上限
  };

  var useOffscreen = typeof root.OffscreenCanvas === "function";
  var sharedWorker = null;   // 所有文件共用一個 pdf.js worker（否則每開一份 PDF 就多一條執行緒）

  function getWorker(L) {
    if (sharedWorker && !sharedWorker.destroyed) return sharedWorker;
    sharedWorker = null;
    try { if (typeof L.PDFWorker === "function") sharedWorker = new L.PDFWorker({ name: "yangfill-pdf", verbosity: 0 }); } catch (e) { sharedWorker = null; }
    return sharedWorker;
  }

  function docBase() {
    try {
      if (root.document && root.document.baseURI) return root.document.baseURI;
      if (root.location && root.location.href) return root.location.href;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function baseURL() {
    var b;
    if (cfg.base) {
      b = docBase() ? new URL(String(cfg.base), docBase()).href : String(cfg.base);
      b = b.replace(/[?#].*$/, "");
      if (!/\/$/.test(b)) b += "/";
      return b;
    }
    b = SCRIPT_BASE || (docBase() || "").replace(/[?#].*$/, "").replace(/[^\/]*$/, "");
    return b;
  }

  function lib() { return root.pdfjsLib || root["pdfjs-dist/build/pdf"] || null; }

  function setupLib(L) {
    var b = baseURL();
    if (L.GlobalWorkerOptions && !L.GlobalWorkerOptions.workerSrc) {
      L.GlobalWorkerOptions.workerSrc = b + "lib/pdfjs/pdf.worker.min.js";
    }
    return b;
  }

  /** 設定（可選）：{base, maxPixels, maxDim, workerSrc} */
  function configure(o) {
    o = o || {};
    if (o.base !== undefined) cfg.base = o.base;
    if (sharedWorker && (o.base !== undefined || o.workerSrc)) { try { sharedWorker.destroy(); } catch (e) { /* 忽略 */ } sharedWorker = null; }
    if (o.maxPixels > 0) cfg.maxPixels = o.maxPixels;
    if (o.maxDim > 0) cfg.maxDim = o.maxDim;
    var L = lib();
    if (L && L.GlobalWorkerOptions) {
      if (o.workerSrc) L.GlobalWorkerOptions.workerSrc = o.workerSrc;
      else if (o.base !== undefined) L.GlobalWorkerOptions.workerSrc = baseURL() + "lib/pdfjs/pdf.worker.min.js";
    }
  }

  function available() {
    if (!lib()) return { ok: false, reason: "PDF 元件（lib/pdfjs）未載入，請重新整理頁面" };
    if (root.location && root.location.protocol === "file:") {
      return { ok: true, degraded: true, reason: "以本機檔案（file://）開啟：PDF 改在主執行緒解析（較慢），部分中文字型可能無法取出文字；建議用線上版網址或 serve.bat 開啟" };
    }
    return { ok: true, reason: "" };
  }

  /* ---------------- 幾何（純函式，Node 可測） ---------------- */
  function mul(m1, m2) {   // 同 pdfjsLib.Util.transform
    return [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  /**
   * 文字片段 → 像素框。vt = viewport.transform（PDF 使用者空間 → 裝置像素，已含旋轉/翻轉）；
   * item = pdf.js textContent item {str, transform, width, height}；style = textContent.styles[fontName]。
   * 在文字空間中字串占 x∈[0, w/sx]、y∈[descent, ascent]（橫書）；四角轉到裝置座標後取外接框。
   */
  function itemBox(item, vt, style) {
    var t = item.transform || [1, 0, 0, 1, 0, 0];
    var m = mul(vt, t);
    var vertical = !!(style && style.vertical);
    var asc = style && typeof style.ascent === "number" && style.ascent > 0 ? style.ascent : 0.8;
    var desc = style && typeof style.descent === "number" && style.descent < 0 ? style.descent : -0.2;
    if (asc - desc > 2) { asc = 0.8; desc = -0.2; }          // 字型資料異常時用預設值
    var pts;
    if (!vertical) {
      var sx = Math.hypot(t[0], t[1]) || 1;
      var wl = (item.width || 0) / sx;                         // 文字空間寬度
      pts = [[0, desc], [wl, desc], [wl, asc], [0, asc]];
    } else {
      var sy = Math.hypot(t[2], t[3]) || 1;
      var hl = (item.height || 0) / sy;                        // 直書：往下延伸
      pts = [[-0.5, 0], [0.5, 0], [0.5, -hl], [-0.5, -hl]];
    }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < 4; i++) {
      var X = m[0] * pts[i][0] + m[2] * pts[i][1] + m[4];
      var Y = m[1] * pts[i][0] + m[3] * pts[i][1] + m[5];
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    return {
      x0: r2(x0), y0: r2(y0), x1: r2(x1), y1: r2(y1),
      fontSize: r2(Math.hypot(m[2], m[3])),                   // 字高（像素）
      angle: Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI),
      vertical: vertical
    };
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  /** 依頁面大小（pt）決定實際 dpi：不超過 maxPixels / maxDim */
  function effectiveDpi(dpi, widthPt, heightPt, maxPixels, maxDim) {
    dpi = +dpi > 0 ? +dpi : 200;
    maxPixels = maxPixels || cfg.maxPixels; maxDim = maxDim || cfg.maxDim;
    var w = widthPt * dpi / 72, h = heightPt * dpi / 72;
    var f = 1;
    if (w * h > maxPixels) f = Math.min(f, Math.sqrt(maxPixels / (w * h)));
    if (Math.max(w, h) * f > maxDim) f = Math.min(f, maxDim / Math.max(w, h));
    if (f < 1) dpi = Math.max(1, Math.floor(dpi * f * 100) / 100);
    return dpi;
  }

  /* ---------------- 開檔 ---------------- */
  function wrapError(e) {
    var name = e && e.name, msg = (e && e.message) || String(e);
    var err;
    if (name === "PasswordException") {
      err = new Error("PDF 設有開啟密碼，無法讀取；請先移除密碼（例如用 Acrobat 取消保護，或開啟後另存 / 列印成 PDF）再上傳");
      err.code = "password";
    } else if (name === "InvalidPDFException") {
      err = new Error("PDF 檔案損毀或不是有效的 PDF（" + msg + "）");
      err.code = "invalid";
    } else if (name === "MissingPDFException") {
      err = new Error("PDF 內容是空的");
      err.code = "invalid";
    } else {
      err = new Error("PDF 讀取失敗：" + msg);
      err.code = "error";
    }
    err.cause = e;
    return err;
  }

  /**
   * 開啟 PDF。bytes: Uint8Array | ArrayBuffer（內部複製一份，呼叫端的資料不會被 pdf.js 轉移）。
   * opts: {password}
   * → Promise<{numPages, getPage(n), getInfo(), destroy()}>
   */
  function open(bytes, opts) {
    opts = opts || {};
    var L = lib();
    if (!L) return Promise.reject(new Error("PDF 元件（lib/pdfjs）未載入，請重新整理頁面"));
    var b = setupLib(L);
    var data;
    try {
      if (bytes instanceof ArrayBuffer) data = new Uint8Array(bytes.slice(0));
      else if (bytes && ArrayBuffer.isView(bytes)) data = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      else return Promise.reject(new Error("PDF 讀取失敗：輸入不是位元組資料"));
    } catch (e) { return Promise.reject(wrapError(e)); }
    if (!data.length) return Promise.reject(wrapError({ name: "MissingPDFException", message: "empty" }));
    var params = {
      data: data,
      cMapUrl: b + "lib/pdfjs/cmaps/",
      cMapPacked: true,
      isEvalSupported: false,
      enableXfa: false,
      stopAtErrors: false,
      verbosity: 0
    };
    if (opts.password) params.password = opts.password;
    var w = getWorker(L);
    if (w) params.worker = w;
    var task;
    try { task = L.getDocument(params); } catch (e) { return Promise.reject(wrapError(e)); }
    return task.promise.then(function (pdf) { return wrapDoc(L, pdf, task); }, function (e) {
      try { task.destroy(); } catch (x) { /* 忽略 */ }
      throw wrapError(e);
    });
  }

  function wrapDoc(L, pdf, task) {
    var pages = {};
    var destroyed = false;
    return {
      numPages: pdf.numPages,
      fingerprint: (pdf.fingerprints && pdf.fingerprints[0]) || null,
      getPage: function (n) {
        n = +n;
        if (destroyed) return Promise.reject(new Error("PDF 已關閉"));
        if (!(n >= 1 && n <= pdf.numPages && Math.floor(n) === n)) {
          return Promise.reject(new RangeError("頁碼超出範圍：" + n + "（共 " + pdf.numPages + " 頁）"));
        }
        if (!pages[n]) {
          pages[n] = pdf.getPage(n).then(function (pg) { return wrapPage(L, pg, n); });
          pages[n].catch(function () { delete pages[n]; });
        }
        return pages[n];
      },
      /** 文件資訊：{producer, creator, title, pdfVersion}（DocuWorks 匯出的 PDF 可由 producer 辨識） */
      getInfo: function () {
        return pdf.getMetadata().then(function (m) {
          var i = (m && m.info) || {};
          return { producer: i.Producer || "", creator: i.Creator || "", title: i.Title || "", pdfVersion: i.PDFFormatVersion || "" };
        }, function () { return { producer: "", creator: "", title: "", pdfVersion: "" }; });
      },
      destroy: function () {
        if (destroyed) return Promise.resolve();
        destroyed = true; pages = {};
        return Promise.resolve(task.destroy ? task.destroy() : pdf.destroy()).catch(function () {});
      }
    };
  }

  function wrapPage(L, pg, n) {
    var vp1 = pg.getViewport({ scale: 1 });   // 已含 /Rotate 與 CropBox
    return pg.getTextContent().then(function (tc) { return tc; }, function () { return { items: [], styles: {} }; })
      .then(function (tc) {
        var items = (tc && tc.items) || [], styles = (tc && tc.styles) || {};
        var count = 0, text = "";
        items.forEach(function (it) {
          if (typeof it.str !== "string") return;
          count += it.str.replace(/\s+/g, "").length;
          text += it.str + (it.hasEOL ? "\n" : "");
        });
        var page = {
          n: n,
          widthPt: vp1.width,
          heightPt: vp1.height,
          rotate: pg.rotate || 0,
          textCharCount: count,
          text: text,
          /** 實際使用的 dpi（超大頁面會降低） */
          dpiFor: function (dpi) { return effectiveDpi(dpi, vp1.width, vp1.height); },
          render: function (dpi, opts) { return renderPage(L, pg, effectiveDpi(dpi, vp1.width, vp1.height), opts || {}); },
          textItems: function (dpi) {
            var d = effectiveDpi(dpi, vp1.width, vp1.height);
            var vt = pg.getViewport({ scale: d / 72 }).transform;
            var out = [];
            items.forEach(function (it) {
              if (typeof it.str !== "string" || !it.str.trim()) return;
              var bx = itemBox(it, vt, styles[it.fontName]);
              if (!isFinite(bx.x0) || !isFinite(bx.y0) || !isFinite(bx.x1) || !isFinite(bx.y1)) return;
              out.push({ str: it.str, x0: bx.x0, y0: bx.y0, x1: bx.x1, y1: bx.y1, fontSize: bx.fontSize,
                angle: bx.angle, vertical: bx.vertical, dir: it.dir || "ltr", eol: !!it.hasEOL, dpi: d });
            });
            return Promise.resolve(out);
          },
          /** 釋放此頁快取（影像/字型等） */
          cleanup: function () { try { pg.cleanup(); } catch (e) { /* 忽略 */ } }
        };
        return page;
      });
  }

  /* ---------------- 繪製 ---------------- */
  function makeCanvas(w, h, offscreen) {
    if (offscreen) return new root.OffscreenCanvas(w, h);
    if (!root.document) throw new Error("此環境沒有 canvas，無法繪製 PDF 頁面");
    var c = root.document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function renderOnce(L, pg, vp, w, h, offscreen) {   // → ImageData（另加 via 欄位）
    var cv = makeCanvas(w, h, offscreen);
    var ctx = cv.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error("無法建立 canvas 2D");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    var am = L.AnnotationMode ? L.AnnotationMode.ENABLE : 1;    // 表單/註解外觀一併畫在影像上
    var task = pg.render({ canvasContext: ctx, viewport: vp, background: "#ffffff", annotationMode: am });
    return task.promise.then(function () {
      var img = ctx.getImageData(0, 0, w, h);
      cv.width = 0; cv.height = 0;                               // 盡早釋放（Safari 記憶體）
      return { img: img, via: offscreen ? "offscreen" : "canvas" };
    }, function (e) {
      cv.width = 0; cv.height = 0;
      throw e;
    });
  }

  function renderPage(L, pg, dpi, opts) {
    var vp = pg.getViewport({ scale: dpi / 72 });
    var w = Math.max(1, Math.round(vp.width)), h = Math.max(1, Math.round(vp.height));
    var tryOff = useOffscreen && opts.offscreen !== false;
    var p;
    try { p = renderOnce(L, pg, vp, w, h, tryOff); } catch (e) { p = Promise.reject(e); }
    return p.catch(function (e) {
      if (!tryOff || !root.document) throw e;
      return renderOnce(L, pg, vp, w, h, false).then(function (r) {
        useOffscreen = false;                                   // <canvas> 成功而 OffscreenCanvas 失敗 → 之後一律用 <canvas>
        return r;
      });
    }).then(function (r) {
      try { pg.cleanup(); } catch (e) { /* 忽略 */ }
      return { width: r.img.width, height: r.img.height, data: r.img.data, dpi: dpi, via: r.via };
    }, function (e) {
      throw new Error("PDF 第 " + pg.pageNumber + " 頁繪製失敗：" + ((e && e.message) || e));
    });
  }

  YF.pdf = {
    available: available,
    configure: configure,
    open: open,
    itemBox: itemBox,
    effectiveDpi: effectiveDpi
  };
})(typeof window !== "undefined" ? window : globalThis);
