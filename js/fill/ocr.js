/* =========================================================================
 * Yang-analyze web — fill/ocr.js
 * Tesseract.js（5.1.1，本機 lib/ 內建，不連外網）OCR 工作池：
 *   - init()：延遲建立 N 個中文（chi_tra+eng，LSTM）worker；另有一個數字專用 worker
 *     （eng + 白名單 0-9 . < > - N D，PSM 7）於第一次 numeric 工作時才建立。
 *   - recognize() / recognizeCells()：工作排隊、分派給空閒 worker；每個 worker 記住目前 PSM，
 *     相同 PSM 不重複 setParameters。輸入可為 PBM/PNG/JPEG 位元組、Bitmap（1=墨）、
 *     ImageData/RGBA、canvas、Blob。
 *   - cancel()：取消排隊中的工作（AbortError）；terminate()：關閉所有 worker。
 *   - worker 當機 / 逾時：自動重建該 worker，該筆工作回報錯誤，不會整批卡住。
 * 所有 lib 路徑以「網站根目錄」解析：預設由本檔 <script src> 推算（js/fill/ → ../../），
 * 亦可用 init({base}) 指定；file:// 開啟時瀏覽器禁止載入 worker，available() 回報不可用。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  /* ---------------- 路徑 ---------------- */
  // 載入當下由 <script src=".../js/fill/ocr.js"> 推算網站根目錄
  var SCRIPT_BASE = (function () {
    try {
      var cs = root.document && root.document.currentScript;
      if (cs && cs.src) return new URL("../../", cs.src).href;
    } catch (e) { /* 忽略 */ }
    return null;
  })();

  function docBase() {
    try {
      if (root.document && root.document.baseURI) return root.document.baseURI;
      if (root.location && root.location.href) return root.location.href;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /** 網站根目錄（結尾一定有 /） */
  function resolveBase(base) {
    var b;
    if (base) b = docBase() ? new URL(String(base), docBase()).href : String(base);
    else b = SCRIPT_BASE || docBase() || "";
    b = b.replace(/[?#].*$/, "");
    if (!/\/$/.test(b)) b = base ? b + "/" : b.replace(/[^\/]*$/, "");
    return b;
  }

  var CACHE_PATH = "yangfill-tessdata-fast-v1";   // IndexedDB 快取鍵前綴（同網域多個 repo 不互相干擾）
  var NUM_WHITELIST = "0123456789.<>-NDnd";
  var LINE_PSMS = { "7": 1, "8": 1, "9": 1, "10": 1, "13": 1 }; // 單行類 PSM：結果合併成一行

  /* ---------------- 狀態 ---------------- */
  var S = newState();
  var injectedT = null;                 // 測試用：注入假的 Tesseract

  function newState() {
    return {
      gen: 0, cgen: 0, pending: 0, opts: null, initP: null, ready: false,
      pool: [], num: null, numP: null, numFailed: false,
      q: [], nq: [], lastError: null, stats: { jobs: 0, ms: 0, respawn: 0 }
    };
  }

  function T() { return injectedT || root.Tesseract || null; }

  function now() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }

  function abortError(msg) {
    var e;
    try { e = new root.DOMException(msg || "已取消", "AbortError"); } catch (x) { e = null; }
    if (!e || e.name !== "AbortError") { e = new Error(msg || "已取消"); e.name = "AbortError"; }
    return e;
  }

  function toError(e, prefix) {
    if (e && e.name === "AbortError") return e;
    var msg = (e && e.message) ? e.message : String(e);
    var err = new Error((prefix || "") + msg);
    if (e && e.code) err.code = e.code;
    return err;
  }

  /* ---------------- 可用性 ---------------- */
  function available() {
    var loc = root.location;
    if (loc && loc.protocol === "file:") {
      return { ok: false, reason: "目前以本機檔案（file://）開啟，瀏覽器禁止載入 OCR 元件；請用線上版網址或 serve.bat 開啟，才能辨識掃描檔" };
    }
    if (typeof root.Worker === "undefined" && !injectedT) {
      return { ok: false, reason: "此瀏覽器不支援 Web Worker，無法辨識掃描檔" };
    }
    if (typeof root.WebAssembly === "undefined" && !injectedT) {
      return { ok: false, reason: "此瀏覽器不支援 WebAssembly，無法辨識掃描檔（請改用新版 Chrome / Edge / Firefox / Safari）" };
    }
    if (!T()) return { ok: false, reason: "OCR 元件（lib/tesseract）未載入，請重新整理頁面" };
    return { ok: true, reason: "" };
  }

  /* ---------------- 初始化 ---------------- */
  function defaultWorkers() {
    var hc = (root.navigator && root.navigator.hardwareConcurrency) || 2;
    return Math.min(3, Math.max(1, hc - 1));
  }

  function normOpts(o) {
    o = o || {};
    var base = resolveBase(o.base);
    var n = parseInt(o.workers, 10);
    if (!(n >= 1)) n = defaultWorkers();
    var sameOrigin = true;
    try { sameOrigin = !root.location || new URL(base).origin === root.location.origin; } catch (e) { /* 忽略 */ }
    return {
      base: base,
      workers: Math.min(4, Math.max(1, n)),
      langs: o.langs || "chi_tra+eng",
      numLangs: o.numLangs || "eng",
      dpi: (o.dpi === 0 || o.dpi === null) ? 0 : (parseInt(o.dpi, 10) || 200),
      cacheMethod: o.cacheMethod || "write",
      jobTimeout: o.jobTimeout > 0 ? o.jobTimeout : 120000,
      // 每個 worker 辨識這麼多件後（空閒時）自動重建：tesseract.js 每次辨識會留下少量 wasm 記憶體，長時間使用會累積
      recycleAfter: o.recycleAfter === 0 ? 0 : (o.recycleAfter > 0 ? o.recycleAfter : 2000),
      initTimeout: o.initTimeout > 0 ? o.initTimeout : 180000,
      onProgress: typeof o.onProgress === "function" ? o.onProgress : null,
      workerPath: base + "lib/tesseract/worker.min.js",
      // 目錄 → tesseract.js 依瀏覽器是否支援 wasm SIMD 自動選 simd-lstm / lstm；也可強制指定
      corePath: o.corePath || base + "lib/tesseract/core" + (o.core === "simd" ? "/tesseract-core-simd-lstm.wasm.js" :
        o.core === "nosimd" ? "/tesseract-core-lstm.wasm.js" : ""),
      langPath: base + "lib/tessdata",
      workerBlobURL: !sameOrigin
    };
  }

  // 初始化進度：各 worker 四個階段加權平均
  var STAGES = {
    "loading tesseract core": [0, 0.25, "載入 OCR 引擎"],
    "initializing tesseract": [0.25, 0.1, "啟動 OCR 引擎"],
    "loading language traineddata": [0.35, 0.45, "載入中文辨識模型"],
    "initializing api": [0.8, 0.2, "初始化辨識模型"]
  };

  function reportInit(o, slots) {
    if (!o.onProgress) return;
    var sum = 0, status = "";
    slots.forEach(function (s) { sum += s.initProg || 0; if (s.initStatus) status = s.initStatus; });
    var p = slots.length ? sum / slots.length : 0;
    try { o.onProgress({ progress: Math.min(1, p), status: status || "載入 OCR 引擎", workers: slots.length }); } catch (e) { /* 忽略 */ }
  }

  function makeSlot(kind, idx) {
    return { kind: kind, idx: idx, w: null, busy: false, dead: false, psm: null, job: null,
      initProg: 0, initStatus: "", served: 0 };
  }

  // 建立一個 Tesseract worker（含逾時、errorHandler 取得失敗原因、可選 slot 進度回報）
  function spawn(slot, o, langs, config, params, report) {
    var Tz = T();
    if (!Tz) return Promise.reject(new Error("OCR 元件（lib/tesseract）未載入"));
    var oem = (Tz.OEM && Tz.OEM.LSTM_ONLY != null) ? Tz.OEM.LSTM_ONLY : 1;
    return new Promise(function (resolve, reject) {
      var settled = false, w = null;
      function fail(e) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (w) { try { w.terminate(); } catch (x) { /* 忽略 */ } }
        reject(toError(e, "OCR 初始化失敗："));
      }
      var timer = setTimeout(function () { fail(new Error("逾時（" + Math.round(o.initTimeout / 1000) + " 秒）")); }, o.initTimeout);
      var opt = {
        workerPath: o.workerPath, corePath: o.corePath, langPath: o.langPath,
        gzip: true, cacheMethod: o.cacheMethod, cachePath: CACHE_PATH,
        workerBlobURL: o.workerBlobURL,
        logger: function (m) {
          if (!m) return;
          var st = STAGES[m.status];
          if (st && !settled) {
            slot.initProg = st[0] + st[1] * Math.max(0, Math.min(1, +m.progress || 0));
            slot.initStatus = st[2];
            if (report) report();
          } else if (m.status === "recognizing text" && slot.job && slot.job.onProgress) {
            try { slot.job.onProgress(Math.max(0, Math.min(1, +m.progress || 0))); } catch (x) { /* 忽略 */ }
          }
        },
        // 未設定時 tesseract.js 會在 worker 回報錯誤時丟出未捕捉例外；改由此取得原因
        errorHandler: function (msg) { if (!settled) fail(msg); }
      };
      var p;
      try { p = Tz.createWorker(langs, oem, opt, config || {}); } catch (e) { fail(e); return; }
      Promise.resolve(p).then(function (worker) {
        w = worker;
        if (settled) { try { worker.terminate(); } catch (x) { /* 忽略 */ } return; }
        return Promise.resolve(worker.setParameters(params)).then(function () {
          if (settled) return;
          settled = true; clearTimeout(timer);
          slot.initProg = 1;
          if (report) report();
          resolve(worker);
        });
      }).catch(fail);
    });
  }

  function mainParams(o) {
    var p = { tessedit_pageseg_mode: "6", tessjs_create_hocr: "0", tessjs_create_tsv: "0" };
    if (o.dpi) p.user_defined_dpi = String(o.dpi);
    return p;
  }

  function numParams(o) {
    var p = mainParams(o);
    p.tessedit_pageseg_mode = "7";
    p.tessedit_char_whitelist = NUM_WHITELIST;
    return p;
  }

  // 數字 worker：關閉字典（初始化參數只能經 config 設定）
  var NUM_CONFIG = { load_system_dawg: "0", load_freq_dawg: "0" };

  function attach(slot, worker) {
    slot.w = worker; slot.dead = false; slot.served = 0; slot.psm = slot.kind === "num" ? "7" : "6";
    // worker 整個掛掉（例如記憶體不足）時 tesseract.js 不會通知進行中的工作 → 自行監聽
    var raw = worker && worker.worker;
    if (raw && raw.addEventListener) {
      raw.addEventListener("error", function (ev) {
        if (slot.w !== worker) return;
        kill(slot, new Error("OCR worker 發生錯誤：" + ((ev && ev.message) || "未知錯誤")));
      });
    }
  }

  /**
   * 初始化 OCR 工作池（重複呼叫回傳同一個 Promise；terminate() 後可重新 init）。
   * opts: {workers 1..4, onProgress({progress,status,workers}), base, langs, dpi(預設 200，0=不設),
   *        cacheMethod('write'|'none'|'refresh'|'readOnly'), jobTimeout ms, initTimeout ms, numeric(bool:同時建立數字 worker),
   *        core('auto'|'simd'|'nosimd'), corePath, recycleAfter(每個 worker 辨識幾件後重建，預設 2000，0=不重建)}
   */
  function init(opts) {
    if (S.initP) {
      if (opts && opts.numeric) S.initP.then(ensureNumeric, function () {});
      return S.initP;
    }
    var av = available();
    if (!av.ok) return Promise.reject(new Error(av.reason));
    var o = normOpts(opts);
    var gen = S.gen;
    S.opts = o;
    var slots = [];
    for (var i = 0; i < o.workers; i++) slots.push(makeSlot("main", i));
    var report = function () { reportInit(o, slots); };
    var t0 = now();
    S.initP = Promise.all(slots.map(function (s) {
      return spawn(s, o, o.langs, null, mainParams(o), report).then(function (w) {
        if (gen !== S.gen) { try { w.terminate(); } catch (x) { /* 忽略 */ } return null; }
        attach(s, w);
        return s;
      }, function (e) { return { error: e }; });
    })).then(function (res) {
      if (gen !== S.gen) throw abortError("OCR 已關閉");
      var ok = res.filter(function (r) { return r && !r.error; });
      if (!ok.length) {
        var err = (res[0] && res[0].error) || new Error("OCR 初始化失敗");
        S.lastError = err.message;
        throw err;
      }
      S.pool = ok;
      S.ready = true;
      S.stats.initMs = Math.round(now() - t0);
      if (ok.length < res.length) S.lastError = "部分 OCR worker 啟動失敗，以 " + ok.length + " 個執行";
      pump();
      if (opts && opts.numeric) ensureNumeric();
      return info();
    });
    S.initP.catch(function (e) {
      // 初始化失敗：排隊中的工作一併失敗，並允許下次重新 init
      if (gen !== S.gen) return;
      S.initP = null;
      rejectAll(S.q, e); rejectAll(S.nq, e);
    });
    return S.initP;
  }

  function ensureInit() { return S.initP || init(); }

  function ensureNumeric() {
    if (S.num || S.numP || S.numFailed) return S.numP || Promise.resolve(S.num);
    var o = S.opts, gen = S.gen;
    if (!o) return Promise.resolve(null);
    var slot = makeSlot("num", 0);
    S.numP = spawn(slot, o, o.numLangs, NUM_CONFIG, numParams(o), null).then(function (w) {
      if (gen !== S.gen) { try { w.terminate(); } catch (x) { /* 忽略 */ } return null; }
      attach(slot, w);
      S.num = slot; S.numP = null;
      pump();
      return slot;
    }, function (e) {
      if (gen !== S.gen) return null;
      // 數字 worker 失敗：改用一般 worker（無白名單）辨識
      S.numFailed = true; S.numP = null;
      S.lastError = e.message;
      while (S.nq.length) S.q.push(S.nq.shift());
      pump();
      return null;
    });
    return S.numP;
  }

  /* ---------------- 排程 ---------------- */
  function rejectAll(q, err) {
    while (q.length) {
      var j = q.shift();
      if (!j.done) { j.done = true; j.reject(err); }
    }
  }

  function pump() {
    if (!S.ready) return;
    var alive = S.pool.filter(function (s) { return !s.dead || s.respawning; });
    if (!alive.length && S.q.length) {
      rejectAll(S.q, new Error("OCR worker 全部停止運作，請重新整理頁面後再試"));
    }
    dispatch(S.q, S.pool);
    if (S.num) dispatch(S.nq, [S.num]);
    else if (S.nq.length && S.numFailed) { while (S.nq.length) S.q.push(S.nq.shift()); dispatch(S.q, S.pool); }
  }

  function dispatch(q, slots) {
    for (var i = 0; i < slots.length && q.length; i++) {
      var s = slots[i];
      if (s.busy || s.dead || !s.w) continue;
      var job = q.shift();
      if (job.done) { i--; continue; }
      run(s, job);
    }
  }

  var OUTPUT = { text: true, blocks: false, hocr: false, tsv: false };

  function run(s, job) {
    s.busy = true; s.job = job;
    var w = s.w, t0 = now();
    var to = job.timeout || (S.opts && S.opts.jobTimeout) || 120000;
    job.timer = setTimeout(function () {
      if (s.job === job) kill(s, new Error("OCR 逾時（" + Math.round(to / 1000) + " 秒）"));
    }, to);
    var p = (s.psm === job.psm) ? Promise.resolve() :
      Promise.resolve(w.setParameters({ tessedit_pageseg_mode: job.psm })).then(function () { s.psm = job.psm; });
    // 逾時/當機後 s 可能已換成新的 worker：舊 worker 晚到的結果一律忽略，不得影響新 worker
    var stale = function () { return s.job !== job || s.w !== w; };
    p.then(function () {
      return w.recognize(job.image, {}, OUTPUT);
    }).then(function (r) {
      if (stale()) return;
      var d = (r && r.data) || {};
      var text = cleanText(d.text, job.psm, job.numeric);
      var conf = typeof d.confidence === "number" ? d.confidence : null;
      if (!text) conf = 0;
      S.stats.jobs++; S.stats.ms += now() - t0;
      s.respawns = 0;
      done(s, job, null, { text: text, conf: conf });
    }, function (e) {
      if (stale()) return;
      var err = toError(e, "OCR 失敗：");
      // wasm abort（記憶體不足等）後該 worker 已無法再用 → 重建
      if (/Aborted|RuntimeError|out of memory|OOM/i.test(err.message)) { kill(s, err); return; }
      done(s, job, err);
    });
  }

  function done(s, job, err, res) {
    if (s.job === job) { s.busy = false; s.job = null; s.served++; }
    if (!job.done) {
      job.done = true;
      clearTimeout(job.timer);
      if (err) job.reject(err); else job.resolve(res);
    }
    maybeRecycle(s);
    pump();
  }

  // 定期重建（各位置門檻錯開，避免全部同時重建）
  function maybeRecycle(s) {
    var o = S.opts;
    if (!o || !o.recycleAfter || s.busy || s.dead || !s.w) return;
    var n = Math.max(1, S.pool.length);
    if (s.served < o.recycleAfter * (1 + (s.kind === "num" ? 0 : s.idx / n))) return;
    var old = s.w;
    s.dead = true; s.w = null; s.psm = null; s.respawns = 0;
    S.stats.recycled = (S.stats.recycled || 0) + 1;
    try { old.terminate(); } catch (x) { /* 忽略 */ }
    respawn(s, true);
  }

  // 停用一個 worker（逾時/當機）：進行中的工作回報錯誤，背景重建
  function kill(s, err) {
    var job = s.job, old = s.w;
    s.dead = true; s.busy = false; s.job = null; s.w = null; s.psm = null;
    if (old) { try { old.terminate(); } catch (x) { /* 忽略 */ } }
    if (job && !job.done) { job.done = true; clearTimeout(job.timer); job.reject(err); }
    respawn(s);
    pump();
  }

  // 重建 worker；失敗時延遲重試（共 3 次），期間該位置仍算「重建中」，排隊工作會等待
  function respawn(s, recycle) {
    if (s.respawning || !S.opts) return;
    if ((s.respawns || 0) >= 3) {   // 連續 3 次（當機或重建失敗）就放棄此位置
      if (s.kind === "num") { S.num = null; S.numFailed = true; }
      pump();
      return;
    }
    s.respawning = true; s.respawns = (s.respawns || 0) + 1;
    if (!recycle) S.stats.respawn++;
    var o = S.opts, gen = S.gen;
    var isNum = s.kind === "num";
    spawn(s, o, isNum ? o.numLangs : o.langs, isNum ? NUM_CONFIG : null, isNum ? numParams(o) : mainParams(o), null)
      .then(function (w) {
        s.respawning = false;
        if (gen !== S.gen) { try { w.terminate(); } catch (x) { /* 忽略 */ } return; }
        attach(s, w);
        pump();
      }, function (e) {
        S.lastError = e.message;
        if (gen !== S.gen) { s.respawning = false; return; }
        if (s.respawns < 3) {
          setTimeout(function () {
            s.respawning = false;
            if (gen === S.gen) respawn(s, recycle);
          }, RETRY_MS * s.respawns);
          return;
        }
        s.respawning = false;
        if (isNum) { S.num = null; S.numFailed = true; }
        pump();
      });
  }
  var RETRY_MS = 1000;

  /* ---------------- 影像輸入轉換 ---------------- */
  function isPNM(b) { return b.length > 2 && b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x37; }
  function isKnownImage(b) {
    if (b.length < 4) return false;
    if (isPNM(b)) return true;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;      // PNG
    if (b[0] === 0xFF && b[1] === 0xD8) return true;                                        // JPEG
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) || (b[0] === 0x4D && b[1] === 0x4D && b[3] === 0x2A)) return true; // TIFF
    if (b[0] === 0x42 && b[1] === 0x4D) return true;                                        // BMP
    return false;
  }

  function header(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /** Bitmap（1 byte/像素，1=墨）→ PBM P4 */
  function bitmapToPBM(bm) {
    var w = bm.width, h = bm.height, d = bm.data, rb = (w + 7) >> 3;
    var head = header("P4\n" + w + " " + h + "\n");
    var out = new Uint8Array(head.length + rb * h);
    out.set(head, 0);
    var o = head.length;
    for (var y = 0; y < h; y++) {
      var row = y * w, base = o + y * rb;
      for (var x = 0; x < w; x++) if (d[row + x]) out[base + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return out;
  }

  /** RGBA → 灰階 PGM P5（預設取 RGB 最大值：紅/藍章戳變淡、黑字保留；alpha 以白底合成） */
  function rgbaToPGM(w, h, data, mode) {
    var head = header("P5\n" + w + " " + h + "\n255\n");
    var out = new Uint8Array(head.length + w * h);
    out.set(head, 0);
    var luma = mode === "luma";
    for (var p = 0, i = 0, o = head.length; p < w * h; p++, i += 4, o++) {
      var r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      var v = luma ? (r * 77 + g * 150 + b * 29) >> 8 : (r > g ? (r > b ? r : b) : (g > b ? g : b));
      if (a < 255) v = (v * a + 255 * (255 - a) + 127) / 255 | 0;
      out[o] = v;
    }
    return out;
  }

  function canvasToImageData(cv) {
    var ctx = null;
    try { ctx = cv.getContext("2d"); } catch (e) { ctx = null; }
    if (!ctx) {   // 非 2D canvas（如 WebGL）：畫到新的 2D canvas
      ctx = ctx2d(cv.width, cv.height);
      ctx.drawImage(cv, 0, 0);
    }
    return ctx.getImageData(0, 0, cv.width, cv.height);
  }

  // 2D 繪圖環境：OffscreenCanvas 優先（舊版 Safari 有 OffscreenCanvas 但沒有 2D → 改用 <canvas>）
  function ctx2d(w, h) {
    var ctx = null;
    if (typeof root.OffscreenCanvas === "function") {
      try { ctx = new root.OffscreenCanvas(w, h).getContext("2d"); } catch (e) { ctx = null; }
    }
    if (!ctx && root.document) {
      var c = root.document.createElement("canvas");
      c.width = w; c.height = h;
      ctx = c.getContext("2d");
    }
    if (!ctx) throw new Error("此環境無法建立 canvas");
    return ctx;
  }

  function drawableToImageData(img) {
    var w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
    var ctx = ctx2d(w, h);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  }

  function blobToImage(blob, mode) {
    var readP = blob.arrayBuffer ? blob.arrayBuffer() : new Promise(function (res, rej) {
      var fr = new root.FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
    return readP.then(function (ab) {
      var b = new Uint8Array(ab);
      if (isKnownImage(b) || typeof root.createImageBitmap !== "function") return b;
      // Leptonica 可能不支援的格式（WebP/GIF…）：瀏覽器解碼 → 灰階
      return root.createImageBitmap(blob).then(function (bmp) {
        var id = drawableToImageData(bmp);
        if (bmp.close) bmp.close();
        return rgbaToPGM(id.width, id.height, id.data, mode);
      });
    });
  }

  /**
   * 各種影像輸入 → Tesseract 可讀的位元組（Uint8Array）。
   * 支援：Uint8Array/ArrayBuffer（PBM/PGM/PNG/JPEG/TIFF/BMP）、Bitmap {width,height,data(w*h)}、
   * ImageData / {width,height,data RGBA}、HTMLCanvasElement / OffscreenCanvas、ImageBitmap / <img>、Blob/File。
   * 空輸入回傳 null。
   */
  function toImageBytes(input, mode) {
    try {
      if (input == null) return Promise.resolve(null);
      if (input instanceof ArrayBuffer) input = new Uint8Array(input);
      if (ArrayBuffer.isView(input) && !(input.width && input.data)) {
        var u8 = input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return Promise.resolve(u8.length ? u8 : null);
      }
      if (typeof root.Blob === "function" && input instanceof root.Blob) return blobToImage(input, mode);
      var isCanvas = (typeof root.HTMLCanvasElement === "function" && input instanceof root.HTMLCanvasElement) ||
        (typeof root.OffscreenCanvas === "function" && input instanceof root.OffscreenCanvas);
      if (isCanvas) {
        if (!input.width || !input.height) return Promise.resolve(null);
        var id = canvasToImageData(input);
        return Promise.resolve(rgbaToPGM(id.width, id.height, id.data, mode));
      }
      if ((typeof root.ImageBitmap === "function" && input instanceof root.ImageBitmap) ||
          (typeof root.HTMLImageElement === "function" && input instanceof root.HTMLImageElement)) {
        var id2 = drawableToImageData(input);
        return Promise.resolve(rgbaToPGM(id2.width, id2.height, id2.data, mode));
      }
      if (input && input.data && input.width > 0 && input.height > 0) {
        var n = input.width * input.height, len = input.data.length;
        if (len === n * 4) return Promise.resolve(rgbaToPGM(input.width, input.height, input.data, mode));
        if (len === n) return Promise.resolve(bitmapToPBM(input));
        return Promise.reject(new Error("影像資料長度不符（" + input.width + "×" + input.height + "，" + len + " bytes）"));
      }
      if (input && input.width === 0) return Promise.resolve(null);
    } catch (e) {
      return Promise.reject(toError(e, "影像轉換失敗："));
    }
    return Promise.reject(new Error("不支援的影像輸入型別"));
  }

  /* ---------------- 文字後處理 ---------------- */
  var CJK = "\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u30FF\\u3100-\\u312F\\u3190-\\u31FF\\u3400-\\u4DBF" +
    "\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF\\u{20000}-\\u{2FA1F}";
  var RE_CJK_SP = new RegExp("([" + CJK + "])[ ]+(?=[" + CJK + "])", "gu");

  /**
   * OCR 原始文字整理：統一換行、壓縮空白、去除中文字之間的空白、修正「0 .034」類數字斷開；
   * 單行類 PSM（7/8/9/10/13）合併為一行，其餘（6 等）保留換行；numeric=true 移除所有空白。
   */
  function cleanText(s, psm, numeric) {
    s = String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[\u200B-\u200D\uFEFF]/g, "");
    var lines = s.split("\n").map(function (l) {
      l = l.replace(/[\s\u00A0]+/g, " ").trim();
      l = l.replace(RE_CJK_SP, "$1");
      l = l.replace(/(\d) ?\. (?=\d)/g, "$1.").replace(/(\d) \.(?=\d)/g, "$1.");
      return l;
    }).filter(Boolean);
    var out = LINE_PSMS[String(psm)] ? lines.join(" ").replace(RE_CJK_SP, "$1") : lines.join("\n");
    if (numeric) out = out.replace(/\s+/g, "");
    return out;
  }

  /* ---------------- 對外：辨識 ---------------- */
  function normPsm(p) {
    var s = String(p == null ? "" : p).trim();
    return /^(?:[0-9]|1[0-3])$/.test(s) ? s : "6";
  }

  /**
   * 辨識一張影像。opts: {psm:"6"|"7"|…, numeric:bool, timeout:ms, gray:"max"|"luma", onProgress(p 0..1)}
   * → Promise<{text, conf}>（空影像回傳 {text:"", conf:0}，不進佇列）
   */
  function recognize(input, opts) {
    opts = opts || {};
    var numeric = !!opts.numeric;
    var psm = normPsm(opts.psm != null ? opts.psm : (numeric ? "7" : "6"));
    var gen = S.gen, cgen = S.cgen;
    S.pending++;
    // 影像轉換是非同步的：呼叫後立刻 cancel() 也要能取消（以 cgen 判斷）
    return toImageBytes(input, opts.gray).then(function (bytes) {
      if (gen === S.gen) S.pending--;
      if (gen !== S.gen || cgen !== S.cgen) throw abortError("OCR 已取消");
      if (!bytes) return { text: "", conf: 0 };
      return new Promise(function (resolve, reject) {
        var job = { image: bytes, psm: psm, numeric: numeric, timeout: opts.timeout > 0 ? opts.timeout : 0,
          onProgress: typeof opts.onProgress === "function" ? opts.onProgress : null,
          resolve: resolve, reject: reject, done: false, timer: null };
        var initP = ensureInit();
        if (numeric && !S.numFailed) {
          S.nq.push(job);
          initP.then(ensureNumeric, function () {});
        } else {
          S.q.push(job);
        }
        initP.then(pump, function (e) {
          // 初始化失敗（含 available() 不通過）：此工作移出佇列並回報原因
          if (job.done) return;
          job.done = true;
          [S.q, S.nq].forEach(function (q) { var k = q.indexOf(job); if (k >= 0) q.splice(k, 1); });
          reject(e);
        });
      });
    }, function (e) {
      if (gen === S.gen) S.pending--;
      throw e;
    });
  }

  /**
   * 批次辨識儲存格。jobs: [{bytes|image, psm, numeric?}]；onProgress(done, total)。
   * → Promise<[{text, conf, error?}]>（順序同 jobs）。單格失敗不影響整批（回傳 text:"" 與 error）；
   *   cancel()/terminate() 時整批以 AbortError 拒絕。
   */
  function recognizeCells(jobs, onProgress) {
    jobs = jobs || [];
    var total = jobs.length, n = 0;
    var out = new Array(total);
    var tick = function () {
      n++;
      if (onProgress) { try { onProgress(n, total); } catch (e) { /* 忽略 */ } }
    };
    if (onProgress) { try { onProgress(0, total); } catch (e) { /* 忽略 */ } }
    if (!total) return Promise.resolve(out);
    var aborted = null;
    return Promise.all(jobs.map(function (j, i) {
      j = j || {};
      var img = j.bytes != null ? j.bytes : j.image;
      return recognize(img, { psm: j.psm, numeric: j.numeric, timeout: j.timeout, gray: j.gray }).then(function (r) {
        out[i] = r; tick();
      }, function (e) {
        if (e && e.name === "AbortError") { aborted = aborted || e; out[i] = { text: "", conf: 0, error: e.message }; return; }
        out[i] = { text: "", conf: 0, error: (e && e.message) || String(e) };
        tick();
      });
    })).then(function () {
      if (aborted) throw aborted;
      return out;
    });
  }

  /** 取消排隊中（含影像轉換中）的工作；已在辨識中的會完成。回傳取消的筆數 */
  function cancel() {
    var n = S.q.length + S.nq.length + S.pending;
    S.cgen++;
    var e = abortError("OCR 已取消");
    rejectAll(S.q, e); rejectAll(S.nq, e);
    return n;
  }

  /** 關閉全部 worker（釋放記憶體）；之後再呼叫 init()/recognize() 會重新建立 */
  function terminate() {
    var old = S;
    S = newState();
    S.gen = old.gen + 1;
    var e = abortError("OCR 已關閉");
    rejectAll(old.q, e); rejectAll(old.nq, e);
    var slots = old.pool.slice();
    if (old.num) slots.push(old.num);
    var ps = slots.map(function (s) {
      var job = s.job;
      if (job && !job.done) { job.done = true; clearTimeout(job.timer); job.reject(e); }
      var w = s.w; s.w = null; s.dead = true;
      return w ? Promise.resolve().then(function () { return w.terminate(); }).catch(function () {}) : null;
    });
    return Promise.all(ps).then(function () {});
  }

  /** 狀態（供 UI 顯示 / 除錯） */
  function info() {
    var o = S.opts;
    return {
      ready: S.ready,
      initializing: !!S.initP && !S.ready,
      workers: S.pool.filter(function (s) { return !s.dead; }).length,
      numeric: !!S.num,
      queued: S.q.length + S.nq.length + S.pending,
      running: S.pool.concat(S.num ? [S.num] : []).filter(function (s) { return s.busy; }).length,
      base: o ? o.base : resolveBase(),
      langs: o ? o.langs : null,
      initMs: S.stats.initMs || null,
      jobs: S.stats.jobs,
      avgMs: S.stats.jobs ? Math.round(S.stats.ms / S.stats.jobs) : null,
      respawns: S.stats.respawn,
      recycled: S.stats.recycled || 0,
      lastError: S.lastError
    };
  }

  YF.ocr = {
    available: available,
    init: init,
    recognize: recognize,
    recognizeCells: recognizeCells,
    cancel: cancel,
    terminate: terminate,
    info: info,
    cleanText: cleanText,
    toImageBytes: toImageBytes,
    bitmapToPBM: bitmapToPBM,
    rgbaToPGM: rgbaToPGM,
    resolveBase: resolveBase,
    defaultWorkers: defaultWorkers,
    /** 測試用：注入假的 Tesseract（null 還原） */
    _setTesseract: function (t) { injectedT = t || null; },
    _setRetryMs: function (ms) { RETRY_MS = ms > 0 ? ms : 1000; }
  };
})(typeof window !== "undefined" ? window : globalThis);
