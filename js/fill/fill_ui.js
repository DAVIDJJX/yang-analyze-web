/* =========================================================================
 * Yang-analyze web — fill/fill_ui.js
 * 「填表核對」頁面介面：
 *   ① 原始資料（DocuWorks / PDF / Word / Excel / 影像，可多檔混放）
 *   ② 待填表格（Word .docx / Excel .xlsx .xls）
 *   ③ 核對：每個空格的建議值、來源（檔名/頁/表格位置）、原始影像條帶、
 *      跨來源比對狀態；可修改、改選其他來源、對應測點
 *   ④ 核對完成檔案：下載已填寫的原格式檔案、核對報告（.xlsx）、全部下載（.zip）
 * 版面樣式在 css/main.css（fill-* class）；此檔只操作 DOM 結構。
 * 所有辨識在本機瀏覽器執行，不上傳任何檔案。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};
  var C = root.YangCore;

  var S = {
    raw: [],          // {id, file, status, doc, progress, error}
    tpl: [],          // {id, file, status, doc, error}
    facts: [], slots: [], assignments: [],
    factById: {}, slotById: {}, docById: {},
    aliases: {},      // stationKey → 範本測站名（記住，跨季沿用）
    aliasSrc: {},     // stationKey → 設定（或確認）此對應時的原始資料檔名；換了報告需再確認一次
    manual: {},       // slotKey → 使用者手動值
    placeholder: {},  // slotKey → 「無對應資料」時填入的文字（有資料時自動讓位）
    picks: {},        // slotKey → 使用者改選的來源（穩定鍵：檔案＋表格＋儲存格，重新加入同檔仍有效）
    verify: {},       // factId → {text, agree}
    expanded: {},     // 核對表中「整表無資料」群組是否展開
    rowEls: {},       // slotId → 核對表該列的元素（背景更新狀態用）
    pendingReview: false,
    options: { mark: false, onlyIssues: false, placeholder: "-" },
    knownStations: [],
    queueBusy: false,
    seq: 1,
    verifyRun: 0
  };

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "show" + (isErr ? " error" : "");
    clearTimeout(toast._h);
    toast._h = setTimeout(function () { t.className = ""; }, 3200);
  }
  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function setting(key) {
    return C && C.storage ? C.storage.getSetting(key).catch(function () { return null; }) : Promise.resolve(null);
  }
  function saveSetting(key, val) {
    if (C && C.storage) C.storage.setSetting(key, val).catch(function () { /* 忽略 */ });
  }
  function D() { return YF.dict || {}; }
  function itemLabel(code) { return D().itemLabel ? D().itemLabel(code) : (code || ""); }
  function statLabel(code) { return D().statLabel ? D().statLabel(code) : (code || ""); }
  function unitLabel(code) { return D().unitLabel ? D().unitLabel(code) : (code || ""); }
  /* 檔案的穩定識別（檔名＋大小）：同名但內容不同的兩個範本不會共用手動值；移除後重新加入同檔仍沿用 */
  function docKey(docId) {
    var d = S.docById[docId];
    return d ? d.name + "#" + d.size : String(docId);
  }
  function slotKey(slot) {
    return docKey(slot.docId) + "|" + slot.tableId + "|" + slot.r + "|" + slot.c;
  }
  /* 原始數值的穩定鍵（fact.id 含每次上傳不同的 docId，不能直接記住） */
  function factKey(f) {
    var d = S.docById[f.docId];
    var dk = d ? (d.hash || (d.name + "#" + d.size)) : String(f.docId);
    if (f.source === "module") return dk + "|m|" + f.item + "|" + (f.stat || "") + "|" + (f.station || "") + "|" + f.value;
    return dk + "|" + f.tableId + "|" + f.r + "," + f.c + "|" + f.item;
  }
  function hasValue(v) { return v !== "" && v !== null && v !== undefined; }
  function isBusy() {
    return S.raw.concat(S.tpl).some(function (e) { return e.status === "queued" || e.status === "processing"; });
  }

  /* ================= 初始化 ================= */
  function init() {
    if (!document.getElementById("view-fill")) return;
    bindDrop("#fill-raw-drop", "#fill-raw-input", function (files) { addFiles(files, "raw"); });
    bindDrop("#fill-tpl-drop", "#fill-tpl-input", function (files) { addFiles(files, "template"); });
    if (YF.filetype && YF.filetype.acceptAttr) {
      $("#fill-raw-input").setAttribute("accept", YF.filetype.acceptAttr("raw"));
      $("#fill-tpl-input").setAttribute("accept", YF.filetype.acceptAttr("template"));
    }
    $("#fill-only-issues").addEventListener("change", function () {
      S.options.onlyIssues = this.checked; renderReview();
    });
    $("#fill-mark").addEventListener("change", function () {
      S.options.mark = this.checked; saveSetting("fill.options", S.options);
    });
    $("#fill-placeholder-btn").addEventListener("click", fillPlaceholders);
    $("#fill-clear-btn").addEventListener("click", clearAll);
    $("#fill-report-btn").addEventListener("click", downloadReport);
    $("#fill-zip-btn").addEventListener("click", downloadAll);
    $("#fill-inspect-close").addEventListener("click", closeInspect);
    var ix = $("#fill-inspect-x");
    if (ix) ix.addEventListener("click", closeInspect);
    $("#fill-inspect-modal").addEventListener("click", function (e) { if (e.target === this) closeInspect(); });
    $("#fill-inspect-select").addEventListener("change", function () { renderInspectTable(); });
    document.addEventListener("keydown", function (e) {
      var modal = $("#fill-inspect-modal");
      if (modal.classList.contains("hidden")) return;
      if (e.key === "Escape") { closeInspect(); return; }
      if (e.key === "Tab") {
        // 焦點留在對話框內
        var f = Array.prototype.filter.call(modal.querySelectorAll("button, select, [tabindex]"), function (x) {
          return !x.hidden && !x.disabled && x.offsetParent !== null;
        });
        if (!f.length) return;
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i < 0 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      }
    });
    // 核對表內正在輸入／選擇時不重畫；焦點離開後補畫
    $("#fill-review").addEventListener("focusout", function () {
      setTimeout(function () { if (S.pendingReview && !reviewFocused()) { S.pendingReview = false; renderReview(); } }, 0);
    });
    // 有手動修改時，關閉或重新整理頁面前提醒（修改不會保存）
    root.addEventListener("beforeunload", function (e) {
      if (Object.keys(S.manual).length || Object.keys(S.picks).length || isBusy()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    Promise.all([setting("fill.aliases"), setting("fill.options"), loadKnownStations(), setting("fill.aliasSrc")]).then(function (r) {
      if (r[0] && typeof r[0] === "object") S.aliases = r[0];
      if (r[3] && typeof r[3] === "object") S.aliasSrc = r[3];
      if (r[1] && typeof r[1] === "object") {
        S.options.mark = !!r[1].mark;
        if (typeof r[1].placeholder === "string") S.options.placeholder = r[1].placeholder;
      }
      $("#fill-mark").checked = S.options.mark;
      $("#fill-placeholder").value = S.options.placeholder;
      renderAll();
    });
    var av = YF.ocr && YF.ocr.available ? YF.ocr.available() : { ok: false, reason: "OCR 元件未載入" };
    var banner = $("#fill-ocr-banner");
    if (!av.ok) {
      banner.textContent = "提醒：" + av.reason;
      if (location.protocol === "file:") {
        banner.appendChild(document.createTextNode(" "));
        var a = el("a", null, "開啟線上版");
        a.href = ONLINE_URL;
        a.target = "_blank";
        a.rel = "noopener";
        banner.appendChild(a);
      }
      banner.hidden = false;
    }
  }
  var ONLINE_URL = "https://davidjjx.github.io/yang-analyze-web/#fill";
  function loadKnownStations() {
    if (!C || !C.storage) return Promise.resolve();
    return C.storage.getAll("stations").then(function (rows) {
      var names = [];
      (rows || []).forEach(function (s) {
        if (s.name) names.push(s.name);
        (s.aliases || []).forEach(function (a) { if (a) names.push(a); });
      });
      S.knownStations = names;
    }).catch(function () { /* 忽略 */ });
  }

  function bindDrop(zoneSel, inputSel, onFiles) {
    var dz = $(zoneSel), input = $(inputSel);
    dz.addEventListener("click", function () { input.click(); });
    dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", function () {
      onFiles(Array.prototype.slice.call(input.files));
      input.value = "";
    });
    ["dragover", "dragenter"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragover"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragover"); });
    });
    dz.addEventListener("drop", function (e) {
      onFiles(Array.prototype.slice.call(e.dataTransfer.files));
    });
  }

  /* ================= 檔案佇列 ================= */
  function addFiles(files, role) {
    var list = role === "raw" ? S.raw : S.tpl;
    files.forEach(function (f) {
      var dup = list.some(function (e) { return e.file.name === f.name && e.file.size === f.size; });
      if (dup) { toast("已在清單中：" + f.name); return; }
      list.push({ id: "f" + (S.seq++), file: f, role: role, status: "queued", doc: null, progress: null, error: null });
    });
    renderFiles();
    // 已有核對結果時：「無對應資料」改顯示「辨識中」，避免使用者誤以為找不到
    if (role === "raw" && S.assignments.length) { renderSummary(); renderReviewSafe(); renderSticky(); }
    runQueue();
  }

  function runQueue() {
    if (S.queueBusy) return;
    var next = S.tpl.filter(function (e) { return e.status === "queued"; })[0] ||
               S.raw.filter(function (e) { return e.status === "queued"; })[0];
    if (!next) return;
    S.queueBusy = true;
    next.status = "processing";
    next.progress = { done: 0, total: 1, message: "讀取檔案…" };
    next.abort = root.AbortController ? new root.AbortController() : null;
    renderFiles();
    renderSummary();
    var t0 = Date.now();
    YF.raw.process(next.file, {
      role: next.role,
      signal: next.abort ? next.abort.signal : undefined,
      cache: C && C.storage && C.storage.fillCache ? C.storage.fillCache : null,
      onProgress: function (p) { next.progress = p; renderFileProgress(next); }
    }).then(function (doc) {
      if (next.removed) { releaseDoc(doc); return; }
      next.doc = doc;
      next.ms = Date.now() - t0;
      S.docById[doc.id] = doc;
      var dup = next.role === "raw" && doc.hash ? S.raw.filter(function (o) {
        return o !== next && o.doc && o.doc.hash === doc.hash && o.status !== "duplicate";
      })[0] : null;
      if (dup) {
        // 內容完全相同的檔案（改名、不同資料夾）：不重複計入，避免同一份報告被當成「兩來源一致」
        next.status = "duplicate";
        doc.duplicateOf = dup.file.name;
        doc.warnings.push("與「" + dup.file.name + "」內容完全相同，已略過（不重複計算為第二個來源）");
      } else {
        next.status = doc.unsupported ? "unsupported" : doc.needsOcr ? "needsocr" : "done";
      }
    }).catch(function (e) {
      if (next.removed || (e && e.name === "AbortError")) { next.status = "removed"; return; }
      next.status = "error";
      next.error = e && e.message ? e.message : String(e);
      if (root.console) console.error(e);
    }).then(function () {
      S.queueBusy = false;
      next.abort = null;
      renderFiles();
      // 每處理完一檔就更新核對結果，讓使用者先看到部分結果（佇列清空時不再重算第二次）
      recompute();
      runQueue();
    });
  }
  function releaseDoc(d) {
    if (d && d._pdf && d._pdf.destroy) { try { d._pdf.destroy(); } catch (e) { /* 忽略 */ } }
  }
  /* 處理中的檔案：中止（含排隊中的 OCR 工作） */
  function abortEntry(e) {
    e.removed = true;
    if (e.abort) { try { e.abort.abort(); } catch (x) { /* 忽略 */ } }
    if (YF.ocr && YF.ocr.cancel) { try { YF.ocr.cancel(); } catch (x) { /* 忽略 */ } }
  }

  function removeEntry(role, id) {
    var list = role === "raw" ? S.raw : S.tpl;
    var idx = list.findIndex(function (e) { return e.id === id; });
    if (idx < 0) return;
    var ent = list[idx];
    if (ent.status === "processing") { abortEntry(ent); toast("已取消處理：" + ent.file.name); }
    var d = ent.doc;
    if (d) {
      delete S.docById[d.id];
      releaseDoc(d);
    }
    list.splice(idx, 1);
    if (role === "raw") refreshDuplicates();
    renderFiles();
    recompute();
  }
  /* 移除原檔後，原本被判為重複的另一份改為正式使用 */
  function refreshDuplicates() {
    var seen = {};
    S.raw.forEach(function (e) {
      if (!e.doc || !e.doc.hash || ["done", "needsocr", "duplicate"].indexOf(e.status) < 0) return;
      var h = e.doc.hash;
      if (seen[h]) return;
      seen[h] = e;
      if (e.status === "duplicate") {
        e.status = e.doc.needsOcr ? "needsocr" : "done";
        e.doc.warnings = e.doc.warnings.filter(function (w) { return w.indexOf("內容完全相同，已略過") < 0; });
        delete e.doc.duplicateOf;
      }
    });
  }

  function clearAll() {
    if ((S.raw.length || S.tpl.length) && !confirm("清除本頁全部原始資料、待填表格與核對結果？（測點對應設定會保留）")) return;
    S.raw.concat(S.tpl).forEach(function (e) {
      if (e.status === "processing") abortEntry(e);
      if (e.doc) releaseDoc(e.doc);
    });
    S.verifyRun++;                      // 停止背景第二次辨識
    thumbQueue = []; thumbCache = {};
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    S.raw = []; S.tpl = []; S.facts = []; S.slots = []; S.assignments = [];
    S.factById = {}; S.slotById = {}; S.docById = {}; S.manual = {}; S.placeholder = {}; S.picks = {}; S.verify = {};
    S.rowEls = {};
    renderAll();
  }

  /* ================= 比對 ================= */
  function templateStations() {
    var names = [];
    S.tpl.forEach(function (e) {
      if (e.doc && !e.doc.unsupported && YF.extract.templateStations) {
        // 範本內容不變：每份範本只判讀一次（大型範本每次重算很慢）
        if (!e.doc._tplStations) {
          try { e.doc._tplStations = YF.extract.templateStations(e.doc) || []; } catch (err) { e.doc._tplStations = []; }
        }
        e.doc._tplStations.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
      }
    });
    return names;
  }

  function moduleFactsOf(doc) {
    var out = [];
    (doc.moduleFacts || []).forEach(function (mf, i) {
      var pv = D().parseValue ? D().parseValue(mf.value) : { ok: true, value: mf.value, num: Number(mf.value), cmp: "" };
      if (!pv.ok) return;
      var f = {
        id: doc.id + "m" + i, docId: doc.id, docName: doc.name, tableId: null, page: null, r: null, c: null,
        cellText: String(mf.value), item: mf.item, stat: mf.stat || "value", unit: mf.unit || null,
        station: mf.station || null, pointNo: null, value: pv.value, num: pv.num, cmp: pv.cmp || "",
        date: mf.date || null, conf: null, bbox: null, source: "module", where: mf.where || ""
      };
      f.stationKey = YF.match.stationKeyOf ? YF.match.stationKeyOf(f) : (f.station || "");
      out.push(f);
    });
    return out;
  }

  function usableDoc(e) { return e.doc && !e.doc.unsupported && e.status !== "duplicate"; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function recompute() {
    if (!YF.extract || !YF.match) return;
    var stations = templateStations().concat(S.knownStations);
    var facts = [], slots = [];
    S.raw.forEach(function (e) {
      if (!usableDoc(e)) return;
      try {
        facts = facts.concat(YF.extract.facts(e.doc, { stations: stations }) || []);
      } catch (err) {
        e.doc.warnings.push("數值擷取失敗：" + err.message);
        if (root.console) console.error(err);
      }
      facts = facts.concat(moduleFactsOf(e.doc));
    });
    // 原始資料的測站名稱也提供給待填表格判讀（測站只寫在章節標題「（一）示範新城」或工作表名稱時）
    var slotStations = stations.slice(), seenSt = {};
    facts.forEach(function (f) {
      var n = f.station;
      if (!n || seenSt[n] || slotStations.length > stations.length + 100) return;
      seenSt[n] = 1;
      if (D().hasCJK && !D().hasCJK(n)) return;
      if (String(n).length < 2 || String(n).length > 24) return;
      slotStations.push(n);
    });
    S.tpl.forEach(function (e) {
      if (!usableDoc(e)) return;
      try {
        slots = slots.concat(YF.extract.slots(e.doc, { stations: slotStations }) || []);
      } catch (err) {
        e.doc.warnings.push("空格判讀失敗：" + err.message);
        if (root.console) console.error(err);
      }
    });
    S.facts = facts; S.slots = slots;
    S.factById = {}; facts.forEach(function (f) { S.factById[f.id] = f; });
    S.slotById = {}; slots.forEach(function (s) { S.slotById[s.id] = s; });
    try {
      S.assignments = YF.match.run(slots, facts, { aliases: S.aliases }) || [];
    } catch (err) {
      S.assignments = [];
      toast("比對失敗：" + err.message, true);
      if (root.console) console.error(err);
    }
    applyUserChoices();
    renderAll();
    scheduleVerify();
  }

  /* 使用者手動值／改選來源／無資料填入文字／第二次辨識結果 → 套用到 assignment
   * （每次都從自動比對結果 a._auto 重新套用，提示文字不會重複累加） */
  function applyUserChoices() {
    var byKey = null, confirmCache = Object.create(null);
    function confirmNeeded(k) {
      if (!(k in confirmCache)) confirmCache[k] = aliasNeedsConfirm(k);
      return confirmCache[k];
    }
    function factByKey(k) {
      if (!byKey) { byKey = {}; S.facts.forEach(function (f) { byKey[factKey(f)] = f; }); }
      return byKey[k] || null;
    }
    S.assignments.forEach(function (a) {
      var slot = S.slotById[a.slotId];
      if (!slot) return;
      var key = slotKey(slot);
      if (!a._auto) a._auto = { value: a.value, status: a.status, factId: a.factId, note: a.note };
      a.value = a._auto.value; a.status = a._auto.status; a.factId = a._auto.factId; a.note = a._auto.note;
      var pf = S.picks[key] ? factByKey(S.picks[key]) : null;
      if (pf) {
        var cand = (a.candidates || []).filter(function (c) { return c.factId === pf.id; })[0];
        if (cand) { a.value = cand.value; a.factId = pf.id; a.status = "manual"; a.note = "改選來源"; }
        else if (a._auto.status === "mapping") { a.value = pf.value; a.factId = pf.id; a.status = "manual"; a.note = "直接指定測點"; }
      }
      if (hasOwn(S.manual, key)) {
        a.value = S.manual[key];
        a.status = "manual";
        a.note = "手動輸入";
      } else if (a.status === "missing" && !hasValue(a.value) && hasOwn(S.placeholder, key)) {
        // 「無對應資料」的填入文字：之後加入的原始資料有值時自動讓位
        a.value = S.placeholder[key];
        a.status = "placeholder";
        a.note = "無對應資料，已填入「" + a.value + "」";
      }
      var af = a.factId ? S.factById[a.factId] : null;
      if (af && a.status !== "manual" && a.status !== "placeholder" && aliasOf(af.stationKey) && confirmNeeded(af.stationKey)) {
        a.status = "conflict";
        a.note = (a.note ? a.note + "；" : "") + "沿用先前儲存的測點對應（→" + aliasOf(af.stationKey) + "），請在上方「測點對應」確認";
      }
      var v = a.factId ? S.verify[a.factId] : null;
      if (v && !v.agree && a.status !== "manual" && a.status !== "placeholder") {
        var msg = "第二次數值辨識為「" + v.text + "」，請對照原始影像";
        a.note = (a.note ? a.note + "；" : "") + msg;
        // 已有另一個獨立來源一致（checked）時只提示，不降級
        if (a.status !== "checked") a.status = "conflict";
      }
    });
  }

  function setManual(slot, value) {
    S.manual[slotKey(slot)] = value;
    var a = assignmentOf(slot.id);
    if (a) { a.value = value; a.status = "manual"; a.note = "手動輸入"; }
    renderSummary(); renderOutputs(); renderSticky();
  }
  function resetSlot(slot) {
    var key = slotKey(slot);
    delete S.manual[key]; delete S.picks[key]; delete S.placeholder[key];
    applyUserChoices();
    renderAll();
  }
  function assignmentOf(slotId) {
    for (var i = 0; i < S.assignments.length; i++) if (S.assignments[i].slotId === slotId) return S.assignments[i];
    return null;
  }

  function fillPlaceholders() {
    var ph = $("#fill-placeholder").value;
    S.options.placeholder = ph;
    saveSetting("fill.options", S.options);
    var n = 0, m = 0;
    if (ph === "") {
      n = Object.keys(S.placeholder).length;
      S.placeholder = {};
      applyUserChoices(); renderAll();
      toast(n ? "已清除 " + n + " 個無資料空格的填入文字" : "填入文字為空白，沒有變更");
      return;
    }
    S.assignments.forEach(function (a) {
      var slot = S.slotById[a.slotId];
      if (!slot) return;
      var key = slotKey(slot), auto = a._auto || a;
      if (hasOwn(S.manual, key)) return;
      // 只填「無對應資料」；「待對應測點」有原始數值，應先在「測點對應」選擇
      if (auto.status === "missing" && !hasValue(auto.value)) { S.placeholder[key] = ph; n++; }
      else if (auto.status === "mapping") m++;
    });
    if (!n && !m) { toast("沒有尚未填寫的空格"); return; }
    applyUserChoices();
    renderAll();
    var msg = n ? "已將 " + n + " 個無資料空格填入「" + ph + "」" : "沒有「無對應資料」的空格";
    if (m) msg += "；另有 " + m + " 格「待對應測點」，請先在上方「測點對應」選擇";
    if (isBusy()) msg += "（原始資料仍在辨識中，之後找到數值的空格會自動改填數值）";
    toast(msg);
  }

  /* ---------- 第二次數值辨識（僅白名單數字，逐格比對第一次辨識） ---------- */
  function scheduleVerify() {
    if (!YF.ocr || !YF.ocr.available || !YF.ocr.available().ok) return;
    var run = ++S.verifyRun;
    var todo = [];
    S.assignments.forEach(function (a) {
      var f = a.factId ? S.factById[a.factId] : null;
      if (!f || f.conf === null || f.conf === undefined || !f.bbox || S.verify[f.id]) return;
      if (!/\d/.test(f.value)) return;
      todo.push(f);
    });
    if (!todo.length) return;
    var i = 0;
    function update() {
      // 只更新狀態欄位，不重畫整張表（使用者可能正在輸入）
      applyUserChoices(); patchReviewRows(); renderSummary(); renderOutputs(); renderSticky();
    }
    function step() {
      if (run !== S.verifyRun || i >= todo.length) {
        if (run === S.verifyRun && i >= todo.length) {
          update();
          if (S.options.onlyIssues) renderReviewSafe();
        }
        return;
      }
      var f = todo[i++];
      var doc = S.docById[f.docId], table = tableOf(doc, f.tableId), cell = cellAt(table, f.r, f.c);
      if (!doc || !table || !cell) { step(); return; }
      YF.raw.cellPBM(doc, table, cell).then(function (bytes) {
        if (!bytes || run !== S.verifyRun) return null;
        return YF.ocr.recognize(bytes, { psm: "7", numeric: true });
      }).then(function (res) {
        if (!res || run !== S.verifyRun) return;
        var t2 = String(res.text || "").replace(/\s+/g, "");
        var p1 = D().parseValue ? D().parseValue(f.value) : null;
        var p2 = D().parseValue ? D().parseValue(t2) : null;
        var agree = !!(p1 && p2 && p1.ok && p2.ok && (p1.value === p2.value ||
          (p1.num !== null && p1.num === p2.num && (p1.cmp || "") === (p2.cmp || ""))));
        S.verify[f.id] = { text: p2 && p2.ok ? p2.value : t2, agree: agree || !p2 || !p2.ok };
      }).catch(function () { /* 忽略 */ }).then(function () {
        if (run !== S.verifyRun) return;
        if (i % 8 === 0) update();
        step();
      });
    }
    step();
  }

  function tableOf(doc, tableId) {
    if (!doc) return null;
    for (var i = 0; i < doc.tables.length; i++) if (doc.tables[i].id === tableId) return doc.tables[i];
    return null;
  }
  function cellAt(table, r, c) {
    if (!table) return null;
    for (var i = 0; i < table.cells.length; i++) {
      var x = table.cells[i];
      if (r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1) return x;
    }
    return null;
  }

  /* ================= 畫面 ================= */
  function renderAll() {
    renderFiles(); renderSummary(); renderMapping(); renderReviewSafe(); renderOutputs(); renderSticky();
  }

  var STATUS_TXT = {
    queued: "等待中", processing: "辨識中", done: "完成", error: "失敗", unsupported: "不支援",
    needsocr: "未辨識（需 OCR）", duplicate: "重複檔案"
  };

  function renderFiles() {
    renderFileList("#fill-raw-list", S.raw, "raw");
    renderFileList("#fill-tpl-list", S.tpl, "template");
  }
  function renderFileList(sel, list, role) {
    var box = $(sel);
    box.innerHTML = "";
    if (!list.length) {
      box.appendChild(el("div", "fill-empty", role === "raw" ? "尚未加入原始資料" : "尚未加入待填表格"));
      return;
    }
    list.forEach(function (e) {
      var row = el("div", "fill-file st-" + e.status);
      row.id = "fill-file-" + e.id;
      var head = el("div", "fill-file-head");
      var icon = el("span", "fill-ficon fam-" + (e.doc ? e.doc.family : guessFamily(e.file.name)), famShort(e.doc ? e.doc.family : guessFamily(e.file.name)));
      head.appendChild(icon);
      var nm = el("span", "fill-fname", e.file.name);
      nm.title = e.file.name;
      head.appendChild(nm);
      head.appendChild(el("span", "fill-fsize", fmtSize(e.file.size)));
      head.appendChild(el("span", "fill-badge st-" + e.status, STATUS_TXT[e.status] || e.status));
      var acts = el("span", "fill-file-acts");
      if (e.doc && role === "raw" && e.doc.tables && e.doc.tables.length) {
        var bi = el("button", "btn small", "檢視辨識結果");
        bi.addEventListener("click", function () { openInspect(e); });
        acts.appendChild(bi);
      }
      var br = el("button", "btn small danger", "移除");
      br.addEventListener("click", function () { removeEntry(role, e.id); });
      acts.appendChild(br);
      head.appendChild(acts);
      row.appendChild(head);

      var sub = el("div", "fill-file-sub");
      if (e.doc) {
        var tl = e.doc.typeLabel ? e.doc.typeLabel : "";
        var parts = [];
        // 說明文字已以格式名稱開頭（「DocuWorks 文件：26 頁」）時不重複顯示格式
        var tlHead = tl.split(/[\s(（]/)[0];
        if (tl && !(e.doc.info && tlHead && e.doc.info.indexOf(tlHead) === 0)) parts.push(tl);
        if (e.doc.info) parts.push(e.doc.info);
        if (e.status === "done" || e.status === "needsocr") {
          if (role === "raw") {
            var nf = S.facts.filter(function (f) { return f.docId === e.doc.id; }).length;
            var nt = e.doc.tables.filter(function (t) { return !t.textOnly; }).length;
            parts.push("找到 " + nt + " 個表格、" + nf + " 筆數值");
          } else {
            var ns = S.slots.filter(function (s) { return s.docId === e.doc.id; }).length;
            parts.push("找到 " + ns + " 個待填空格");
          }
          if (e.doc.fromCache) parts.push("（沿用先前辨識結果）");
          else if (e.ms > 1500) parts.push("耗時 " + (e.ms / 1000).toFixed(0) + " 秒");
        }
        sub.textContent = parts.join("｜");
      } else if (e.status === "error") {
        sub.textContent = "處理失敗：" + e.error;
      } else if (e.status === "processing") {
        sub.textContent = isScanName(e.file.name) ? "辨識中…（掃描檔每頁約需數秒）" : "讀取中…";
      } else {
        sub.textContent = "等待處理…";
      }
      row.appendChild(sub);

      var prog = el("div", "fill-prog");
      prog.hidden = e.status !== "processing";
      var bar = el("div", "fill-prog-bar");
      prog.appendChild(bar);
      var pm = el("div", "fill-prog-msg");
      prog.appendChild(pm);
      row.appendChild(prog);
      if (e.doc && e.doc.warnings && e.doc.warnings.length) {
        var ul = el("ul", "fill-warn");
        e.doc.warnings.slice(0, 6).forEach(function (w) { ul.appendChild(el("li", null, w)); });
        if (e.doc.warnings.length > 6) ul.appendChild(el("li", null, "…另有 " + (e.doc.warnings.length - 6) + " 則提示"));
        row.appendChild(ul);
      }
      box.appendChild(row);
      if (e.status === "processing") renderFileProgress(e);
    });
  }
  function renderFileProgress(e) {
    var row = document.getElementById("fill-file-" + e.id);
    if (!row || !e.progress) return;
    var p = e.progress, bar = $(".fill-prog-bar", row), msg = $(".fill-prog-msg", row), box = $(".fill-prog", row);
    box.hidden = false;
    var frac = 0;
    // 多頁文件以整體進度顯示（不會每頁重新從 0% 開始）
    if (p.overall !== undefined && p.overall !== null) frac = p.overall;
    else if ((p.stage === "page" || p.stage === "ocr") && p.total) frac = p.done / p.total;
    bar.style.width = Math.max(3, Math.round(frac * 100)) + "%";
    msg.textContent = (p.overall !== undefined && p.overall !== null ? "整體 " + Math.round(frac * 100) + "%｜" : "") + (p.message || "");
  }
  function isScanName(name) {
    return /\.(xdw|xbd|pdf|png|jpe?g|tiff?|bmp|gif|webp)$/i.test(String(name));
  }
  function guessFamily(name) {
    var ext = (String(name).match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
    if (ext === "xdw" || ext === "xbd") return "docuworks";
    if (ext === "pdf") return "pdf";
    if (/^docx?$|^docm$|^rtf$/.test(ext)) return "word";
    if (/^xls[xmb]?$|^csv$|^ods$/.test(ext)) return "excel";
    if (/^(png|jpe?g|tiff?|bmp|gif|webp)$/.test(ext)) return "image";
    return "other";
  }
  function famShort(f) {
    return { docuworks: "DW", pdf: "PDF", word: "W", excel: "X", image: "IMG", text: "TXT" }[f] || "?";
  }

  /* ---------- 摘要 ---------- */
  function counts() {
    var c = { total: 0, filled: 0, checked: 0, auto: 0, conflict: 0, mapping: 0, missing: 0, manual: 0, placeholder: 0 };
    S.assignments.forEach(function (a) {
      c.total++;
      if (hasValue(a.value) && a.status !== "placeholder") c.filled++;
      c[a.status] = (c[a.status] || 0) + 1;
    });
    return c;
  }
  function renderSummary() {
    var box = $("#fill-summary");
    box.innerHTML = "";
    var c = counts();
    if (!c.total) {
      box.appendChild(el("span", "fill-empty-inline",
        S.tpl.length ? "待填表格中沒有找到可判讀的空格" : "加入待填表格與原始資料後，這裡會列出每個空格的建議值"));
      $("#fill-review-tools").hidden = true;
      return;
    }
    $("#fill-review-tools").hidden = false;
    function chip(cls, label, n) {
      var s = el("span", "fill-chip " + cls);
      s.appendChild(el("b", null, String(n)));
      s.appendChild(document.createTextNode(" " + label));
      box.appendChild(s);
    }
    chip("all", "個空格", c.total);
    chip("ok", "已填入", c.filled);
    if (c.checked) chip("checked", "兩來源一致", c.checked);
    if (c.auto) chip("auto", "單一來源（請目視核對）", c.auto);
    if (c.conflict) chip("conflict", "需核對", c.conflict);
    if (c.mapping) chip("mapping", "待對應測點", c.mapping);
    if (c.missing) chip("missing", "無對應資料", c.missing);
    if (c.placeholder) chip("placeholder", "無資料已填「" + S.options.placeholder + "」", c.placeholder);
    if (c.manual) chip("manual", "手動", c.manual);
    var busy = S.raw.filter(function (e) { return e.status === "queued" || e.status === "processing"; });
    if (busy.length) {
      var doneN = S.raw.length - busy.length;
      box.appendChild(el("span", "fill-chip busy", "原始資料辨識中（已完成 " + doneN + "/" + S.raw.length + " 檔），結果會陸續更新"));
    }
  }

  /* ---------- 測點對應 ---------- */
  var MAX_MAP_ROWS = 50;          // 測點對應最多列出幾列（無測站的逐時資料可能有上千個「測點」）
  var CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  function pointText(n) { return n >= 1 && n <= 20 ? "測點" + CIRCLED.charAt(n - 1) : "測點 " + (n || "?"); }
  /* 測點對應列的名稱（對應前後一致）：有測站名稱者顯示原文；無測站者「檔名 項目 測點①」 */
  function pointLabel(fs) {
    var f0 = fs[0];
    if (!f0) return "";
    if (f0.station) return (f0.stationRaw && f0.stationRaw !== f0.station ? f0.stationRaw : f0.station) + "（" + f0.docName + "）";
    var items = [];
    fs.forEach(function (f) { if (items.indexOf(f.item) < 0) items.push(f.item); });
    return f0.docName + " " + items.map(itemLabel).join("、") + " " + pointText(f0.pointNo);
  }
  function renderMapping() {
    var box = $("#fill-mapping");
    box.innerHTML = "";
    if (!YF.match || !YF.match.unmatchedGroups || !S.slots.length) { box.hidden = true; return; }
    var groups = [];
    try { groups = YF.match.unmatchedGroups(S.slots, S.facts, S.assignments) || []; } catch (e) { groups = []; }
    // 只列出「還有空格待填」的項目（例：臭氣），其餘未使用的原始數值不打擾使用者
    // （以自動比對狀態判斷：已填入「-」或手動值的空格，仍可在此對應測點）
    var openItems = {};
    S.assignments.forEach(function (a) {
      var sl = S.slotById[a.slotId], auto = a._auto || a;
      if (sl && (auto.status === "mapping" || auto.status === "missing" || !hasValue(a.value))) openItems[sl.item] = true;
    });
    groups = groups.filter(function (g) {
      var it = g.item || (g.facts && g.facts[0] && g.facts[0].item);
      return !it || openItems[it];
    });
    var factsByKey = Object.create(null), order = Object.create(null);
    S.facts.forEach(function (f, i) {
      var k = f.stationKey;
      (factsByKey[k] = factsByKey[k] || []).push(f);
      if (order[k] === undefined) order[k] = i;
    });
    // 列順序固定（依原始資料出現順序），選擇後不會跳動或改名
    var keys = [], seen = Object.create(null);
    groups.forEach(function (g) { if (!seen[g.stationKey]) { seen[g.stationKey] = 1; keys.push(g.stationKey); } });
    Object.keys(S.aliases).forEach(function (k) { if (!seen[k] && factsByKey[k]) { seen[k] = 1; keys.push(k); } });
    if (!keys.length) { box.hidden = true; return; }
    keys.sort(function (a, b) { return order[a] - order[b]; });
    box.hidden = false;
    box.appendChild(el("h4", null, "測點對應"));
    box.appendChild(el("p", "fill-note",
      "以下原始資料的測點沒有明確測站名稱（例：異味報告的測點①～④），或名稱與表格不同。請選擇對應的表格測站；設定會記住，下一季同樣的報告會自動帶入。"));
    var tbl = el("table", "fill-map-table");
    var thead = el("tr");
    ["原始資料測點", "項目／數值", "對應到表格測站"].forEach(function (h) { thead.appendChild(el("th", null, h)); });
    tbl.appendChild(thead);
    var allStations = slotStations();
    function addRow(key) {
      var fs = factsByKey[key] || [];
      var items = {};
      fs.forEach(function (f) { items[f.item] = 1; });
      // 下拉只列「有該項目空格」的測站，其他測站放在後面
      var rel = [];
      S.slots.forEach(function (s) { if (s.station && items[s.item] && rel.indexOf(s.station) < 0) rel.push(s.station); });
      var other = allStations.filter(function (n) { return rel.indexOf(n) < 0; });
      var tr = el("tr");
      var ltd = el("td", null, pointLabel(fs));
      var f0 = fs[0];
      if (f0 && f0.where) ltd.appendChild(el("div", "fill-note-sm", f0.where));
      tr.appendChild(ltd);
      var sample = fs.slice(0, 4).map(function (f) {
        return itemLabel(f.item) + " " + f.value + (f.unit ? " " + unitLabel(f.unit) : "");
      }).join("、");
      var std = el("td", "fill-map-sample", sample);
      if (f0 && f0.bbox && f0.page) {
        var img = el("img", "fill-thumb-img loading");
        img.alt = "";
        img.dataset.fact = f0.id;
        img.src = thumbCache[f0.id] || BLANK_IMG;
        if (thumbCache[f0.id]) img.classList.remove("loading");
        else loadThumb(img);
        img.addEventListener("click", function () { openZoom(f0); });
        std.appendChild(img);
      }
      tr.appendChild(std);
      var td = el("td");
      var sel = el("select", "fill-map-select");
      sel.setAttribute("aria-label", pointLabel(fs) + " 對應測站");
      sel.appendChild(new Option("（未對應）", ""));
      rel.forEach(function (n) { sel.appendChild(new Option(n, n)); });
      if (other.length) {
        var og = document.createElement("optgroup");
        og.label = "其他測站（無此項目空格）";
        other.forEach(function (n) { og.appendChild(new Option(n, n)); });
        sel.appendChild(og);
      }
      var cur = aliasOf(key);
      if (cur && allStations.indexOf(cur) < 0) sel.appendChild(new Option(cur, cur));
      sel.value = cur;
      sel.addEventListener("change", function () {
        setAlias(key, sel.value);
        recompute();
        if (sel.value && rel.indexOf(sel.value) < 0) toast("「" + sel.value + "」沒有" + Object.keys(items).map(itemLabel).join("、") + "的空格，此對應不會填入任何值");
      });
      td.appendChild(sel);
      if (aliasNeedsConfirm(key)) {
        var cb = el("button", "btn small", "確認此對應");
        cb.title = "此對應是先前在其他報告上設定的；確認本次報告的測點順序相同";
        cb.addEventListener("click", function () { setAlias(key, aliasOf(key)); applyUserChoices(); renderAll(); });
        td.appendChild(el("div", "fill-note-sm", "沿用先前設定，請確認"));
        td.appendChild(cb);
      }
      tr.appendChild(td);
      tbl.appendChild(tr);
    }
    keys.slice(0, MAX_MAP_ROWS).forEach(addRow);
    box.appendChild(tbl);
    if (keys.length > MAX_MAP_ROWS) {
      box.appendChild(el("p", "fill-note", "另有 " + (keys.length - MAX_MAP_ROWS) +
        " 個未標示測站的測點未列出（多為逐時／逐日數列）。請確認原始資料是否標示測站，或改用含測站名稱的報告。"));
    }
  }
  /* 測點對應：設定／清除，並記下是在哪一份原始資料上設定的 */
  function setAlias(key, station) {
    if (station) { S.aliases[key] = station; S.aliasSrc[key] = aliasDocsOf(key); }
    else { delete S.aliases[key]; delete S.aliasSrc[key]; }
    saveSetting("fill.aliases", S.aliases);
    saveSetting("fill.aliasSrc", S.aliasSrc);
  }
  function aliasDocsOf(key) {
    var names = [];
    S.facts.forEach(function (f) { if (f.stationKey === key && names.indexOf(f.docName) < 0) names.push(f.docName); });
    return names.sort().join("\n");
  }
  /* 沿用先前（其他報告）儲存的對應 → 需使用者確認一次 */
  function aliasNeedsConfirm(key) {
    if (!aliasOf(key)) return false;
    var cur = aliasDocsOf(key);
    if (!cur) return false;
    var src = hasOwn(S.aliasSrc, key) ? String(S.aliasSrc[key] || "").split("\n") : [];
    return cur.split("\n").some(function (n) { return src.indexOf(n) < 0; });
  }
  function aliasOf(key) {
    var v = hasOwn(S.aliases, key) ? S.aliases[key] : "";
    return typeof v === "string" ? v : "";
  }
  function slotStations() {
    var out = [];
    S.slots.forEach(function (s) { if (s.station && out.indexOf(s.station) < 0) out.push(s.station); });
    return out;
  }

  /* ---------- 核對表 ---------- */
  var STATUS_LABEL = {
    checked: "✓ 兩來源一致", auto: "單一來源", conflict: "⚠ 需核對", mapping: "待對應測點",
    missing: "無對應資料", manual: "手動", placeholder: "無資料（已填入）"
  };
  var ISSUE_STATUS = ["conflict", "mapping", "missing", "placeholder"];
  var MAX_PICK_OPTIONS = 30;
  var MAX_REVIEW_ROWS = 500;      // 核對表一次最多畫幾列      // 每格「直接選擇測點」下拉最多列幾個
  var thumbObserver = null;
  function reviewFocused() {
    var w = $("#fill-review"), a = document.activeElement;
    return !!(w && a && a !== document.body && w.contains(a));
  }
  /* 使用者正在核對表內輸入／選擇時延後重畫（焦點離開後再畫），避免輸入到一半被清掉 */
  function renderReviewSafe() {
    if (reviewFocused()) { S.pendingReview = true; return; }
    S.pendingReview = false;
    renderReview();
  }
  /* 只更新各列的狀態標籤與說明（背景第二次辨識進度用，不重建表格） */
  function patchReviewRows() {
    S.assignments.forEach(function (a) {
      var r = S.rowEls[a.slotId];
      if (!r) return;
      var note = a.note || "";
      if (r.status === a.status && r.note === note) return;
      r.status = a.status; r.note = note;
      r.tr.className = "st-" + a.status;
      r.badge.className = "fill-st st-" + a.status;
      r.badge.textContent = STATUS_LABEL[a.status] || a.status;
      r.noteEl.textContent = note;
    });
  }
  function renderReview() {
    var wrap = $("#fill-review");
    wrap.innerHTML = "";
    S.rowEls = {};
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = ("IntersectionObserver" in root) ? new IntersectionObserver(onThumbVisible, { rootMargin: "200px" }) : null;
    if (!S.assignments.length) return;

    var byDoc = {};
    S.assignments.forEach(function (a) {
      var slot = S.slotById[a.slotId];
      if (!slot) return;
      if (S.options.onlyIssues && ISSUE_STATUS.indexOf(a.status) < 0) return;
      (byDoc[slot.docId] = byDoc[slot.docId] || []).push({ a: a, slot: slot });
    });
    var busy = S.raw.some(function (e) { return e.status === "queued" || e.status === "processing"; });
    var budget = S.reviewLimit || MAX_REVIEW_ROWS, shown = 0, total = 0;
    Object.keys(byDoc).forEach(function (k) { total += byDoc[k].length; });
    Object.keys(byDoc).forEach(function (docId) {
      if (shown >= budget) return;
      var doc = S.docById[docId];
      var sec = el("div", "fill-review-doc");
      sec.appendChild(el("h4", null, doc ? doc.name : docId));
      var tbl = el("table", "fill-review-table");
      var hr = el("tr");
      ["測站", "項目", "統計／單位", "填入值", "狀態", "來源", "原始影像"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
      var thead = el("thead"); thead.appendChild(hr); tbl.appendChild(thead);
      var tbody = el("tbody");
      // 依表格分組；整張表都沒有資料（例：本次沒有噪音報告）時預設收合成一列
      var groups = [], gmap = {};
      byDoc[docId].forEach(function (x) {
        var g = gmap[x.slot.tableId];
        if (!g) { g = gmap[x.slot.tableId] = { tableId: x.slot.tableId, rows: [] }; groups.push(g); }
        g.rows.push(x);
      });
      groups.forEach(function (g) {
        var t = tableOf(doc, g.tableId);
        var gkey = docKey(docId) + "|" + g.tableId;
        var empty = !busy && g.rows.length >= 3 && g.rows.every(function (x) { return x.a.status === "missing" || x.a.status === "placeholder"; });
        var open = !empty || !!S.expanded[gkey];
        var gr = el("tr", "fill-group");
        var gtd = el("td", null, (t && t.title) ? t.title : ("表格 " + g.tableId));
        gtd.colSpan = 7;
        var trs = [];
        if (empty) {
          var tg = el("button", "fill-group-toggle", open ? "收合" : "此表 " + g.rows.length + " 格皆無對應資料（展開）");
          tg.setAttribute("aria-expanded", open ? "true" : "false");
          tg.addEventListener("click", function () {
            S.expanded[gkey] = !S.expanded[gkey];
            trs.forEach(function (r) { r.hidden = !S.expanded[gkey]; });
            tg.textContent = S.expanded[gkey] ? "收合" : "此表 " + g.rows.length + " 格皆無對應資料（展開）";
            tg.setAttribute("aria-expanded", S.expanded[gkey] ? "true" : "false");
          });
          gtd.appendChild(document.createTextNode(" "));
          gtd.appendChild(tg);
        }
        gr.appendChild(gtd);
        tbody.appendChild(gr);
        g.rows.forEach(function (x) {
          if (shown >= budget) return;
          shown++;
          var tr = reviewRow(x.a, x.slot, busy);
          if (!open) tr.hidden = true;
          trs.push(tr);
          tbody.appendChild(tr);
        });
      });
      tbl.appendChild(tbody);
      var scroller = el("div", "fill-review-scroll");
      scroller.appendChild(tbl);
      sec.appendChild(scroller);
      wrap.appendChild(sec);
    });
    if (shown < total) {
      // 超大範本：一次只畫前幾百列，避免頁面卡住
      var more = el("button", "btn", "顯示其餘 " + (total - shown) + " 格");
      more.addEventListener("click", function () { S.reviewLimit = budget + MAX_REVIEW_ROWS; renderReview(); });
      wrap.appendChild(el("p", "fill-note", "核對表只先列出前 " + shown + " 格（全部 " + total + " 格；下載的檔案包含全部填入值）。"));
      wrap.appendChild(more);
    }
    if (!wrap.children.length) wrap.appendChild(el("div", "fill-empty", "沒有需要處理的空格 🎉"));
  }

  function reviewRow(a, slot, busy) {
    var tr = el("tr", "st-" + a.status);
    tr.appendChild(el("td", "fill-stn", slot.station || "—"));
    var itd = el("td", "fill-item");
    itd.textContent = itemLabel(slot.item);
    if (slot.headers && slot.headers.length) itd.title = "表頭：" + slot.headers.join(" / ");
    tr.appendChild(itd);
    var su = [];
    if (slot.stat && slot.stat !== "value") su.push(statLabel(slot.stat));
    if (slot.unit) su.push(unitLabel(slot.unit));
    tr.appendChild(el("td", "fill-stat", su.join("・") || "—"));

    var vtd = el("td", "fill-val-cell");
    var inp = el("input", "fill-val");
    inp.value = a.value || "";
    inp.placeholder = "（空白）";
    inp.setAttribute("aria-label", (slot.station || "") + " " + itemLabel(slot.item) + " 填入值");
    var rb = null;
    function addReset() {
      if (rb) return;
      rb = el("button", "fill-reset", "↺");
      rb.title = "還原自動值";
      rb.setAttribute("aria-label", "還原自動值");
      rb.addEventListener("click", function () { rb.blur(); resetSlot(slot); });
      vtd.appendChild(rb);
    }
    inp.addEventListener("change", function () {
      setManual(slot, inp.value.trim());
      tr.className = "st-manual"; badge.textContent = STATUS_LABEL.manual; badge.className = "fill-st st-manual";
      nt.textContent = "手動輸入";
      var r = S.rowEls[slot.id];
      if (r) { r.status = "manual"; r.note = "手動輸入"; }
      addReset();
    });
    vtd.appendChild(inp);
    if (a.status === "manual" || a.status === "placeholder") addReset();
    tr.appendChild(vtd);

    var std = el("td", "fill-st-cell");
    var stLabel = STATUS_LABEL[a.status] || a.status;
    if (a.status === "placeholder") stLabel = "無資料（已填「" + a.value + "」）";
    var badge = el("span", "fill-st st-" + a.status, stLabel);
    std.appendChild(badge);
    var noteText = a.note || "";
    if (busy && a.status === "missing") {
      // 還在辨識：以灰色「辨識中」顯示，不要看起來像「找不到資料」
      noteText = "原始資料辨識中，完成後會再比對";
      badge.textContent = "辨識中…";
      badge.className = "fill-st st-placeholder";
      tr.className = "st-pending";
    }
    else if (a.status === "missing" && S.raw.some(function (e) { return e.status === "needsocr"; })) {
      noteText = (noteText ? noteText + "；" : "") + "部分原始資料（掃描檔）尚未辨識，結果可能不完整";
    }
    var nt = el("div", "fill-note-sm", noteText);
    std.appendChild(nt);
    tr.appendChild(std);
    S.rowEls[slot.id] = { tr: tr, badge: badge, noteEl: nt, status: a.status, note: a.note || "" };

    var srcTd = el("td", "fill-src");
    var f = a.factId ? S.factById[a.factId] : null;
    if (f) {
      srcTd.appendChild(el("div", "fill-src-file", f.docName));
      srcTd.appendChild(el("div", "fill-src-where", f.where || ""));
      if (f.cellText && f.cellText !== f.value) srcTd.appendChild(el("div", "fill-src-raw", "原文：" + f.cellText));
    } else if (a.status === "mapping") {
      srcTd.appendChild(el("span", "fill-note-sm", "請在上方「測點對應」選擇"));
    } else {
      srcTd.appendChild(el("span", "fill-note-sm", "—"));
    }
    var cands = (a.candidates || []).filter(function (c) { return S.factById[c.factId]; });
    var mappingList = !a.factId && a.status === "mapping";
    // 待對應測點：列出同項目、未標測站的數值，可直接逐格指定（數量多時只列前幾個）
    if (mappingList) {
      cands = S.facts.filter(function (x) { return x.item === slot.item && !x.station && x.pointNo; })
        .map(function (x) { return { factId: x.id, value: x.value }; });
    }
    var extra = 0;
    if (cands.length > MAX_PICK_OPTIONS) { extra = cands.length - MAX_PICK_OPTIONS; cands = cands.slice(0, MAX_PICK_OPTIONS); }
    if (cands.length > 1 || (!a.factId && cands.length)) {
      var sel = el("select", "fill-alt");
      if (!a.factId) sel.appendChild(new Option(mappingList ? "— 直接選擇測點 —" : "— 選擇來源 —", ""));
      var bestF = a.factId ? S.factById[a.factId] : null;
      cands.forEach(function (c) {
        var cf = S.factById[c.factId];
        var lab = c.value + "｜" + (cf.station || (cf.pointNo ? pointText(cf.pointNo) : "")) + " " + cf.docName + " " + (cf.where || "");
        // 「不一致」只標在與目前填入值同一測點、數值不同的候選
        if (!mappingList && c.agrees === false && c.factId !== a.factId && (!bestF || cf.stationKey === bestF.stationKey)) lab += "（不一致）";
        sel.appendChild(new Option(lab, c.factId));
      });
      if (extra) {
        var more = new Option("…另有 " + extra + " 筆，請改用上方「測點對應」", "");
        more.disabled = true;
        sel.appendChild(more);
      }
      sel.value = a.factId || "";
      sel.title = "其他來源";
      sel.setAttribute("aria-label", "改選來源");
      sel.addEventListener("change", function () {
        if (!sel.value) return;
        var pickedFact = S.factById[sel.value];
        if (!pickedFact) return;
        sel.blur();          // 讓核對表立即重畫（焦點在表內時會延後重畫）
        var key = slotKey(slot);
        delete S.manual[key]; delete S.placeholder[key];
        if (mappingList && slot.station && pickedFact.stationKey) {
          // 直接選擇測點＝測點對應（同測點其他項目一併對應，並記住供下一季沿用）
          setAlias(pickedFact.stationKey, slot.station);
          delete S.picks[key];
        } else {
          S.picks[key] = factKey(pickedFact);
        }
        recompute();
      });
      srcTd.appendChild(sel);
    }
    tr.appendChild(srcTd);

    var imgTd = el("td", "fill-thumb");
    if (f && f.bbox && f.page) {
      var img = el("img");
      img.alt = "原始影像（點擊放大）";
      img.title = "紅框＝填入值所在的原始儲存格；點擊放大";
      img.dataset.fact = f.id;
      if (thumbCache[f.id]) { img.src = thumbCache[f.id]; img.className = "fill-thumb-img"; }
      else {
        img.src = BLANK_IMG;
        img.className = "fill-thumb-img loading";
        if (thumbObserver) thumbObserver.observe(img); else loadThumb(img);
      }
      img.tabIndex = 0;
      img.addEventListener("click", function () { openZoom(f); });
      img.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openZoom(f); } });
      imgTd.appendChild(img);
    } else if (f && f.source === "module") {
      imgTd.appendChild(el("span", "fill-note-sm", "Excel 精確值"));
    } else if (f) {
      imgTd.appendChild(el("span", "fill-note-sm", "文字檔精確值"));
    }
    tr.appendChild(imgTd);
    return tr;
  }

  var BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  var thumbQueue = [], thumbBusy = false, thumbCache = {};
  function onThumbVisible(entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting && thumbObserver) { thumbObserver.unobserve(en.target); loadThumb(en.target); }
    });
  }
  function loadThumb(img) {
    var fid = img.dataset.fact;
    if (thumbCache[fid]) { img.src = thumbCache[fid]; img.classList.remove("loading"); return; }
    thumbQueue.push(img);
    setTimeout(pumpThumbs, 0);      // 等目前的畫面建好（元素已放進頁面）再處理
  }
  function pumpThumbs() {
    if (thumbBusy || !thumbQueue.length) return;
    // 已不在畫面上的（表格重畫後）略過
    thumbQueue = thumbQueue.filter(function (im) { return im.isConnected !== false; });
    if (!thumbQueue.length) return;
    thumbBusy = true;
    // 依頁面排序，減少重複解碼
    thumbQueue.sort(function (a, b) {
      var fa = S.factById[a.dataset.fact], fb = S.factById[b.dataset.fact];
      return ((fa && fa.page) || 0) - ((fb && fb.page) || 0);
    });
    var img = thumbQueue.shift();
    var fid = img.dataset.fact;
    var f = S.factById[fid];
    var cached = thumbCache[fid];
    var doc = f ? S.docById[f.docId] : null;
    var table = doc ? tableOf(doc, f.tableId) : null;
    var cell = cellAt(table, f ? f.r : -1, f ? f.c : -1);
    var p = cached ? Promise.resolve(cached) :
      (doc && table && cell) ? YF.raw.rowStripDataURL(doc, table, cell, 360) : Promise.resolve(null);
    p.then(function (url) {
      if (url) { thumbCache[fid] = url; img.src = url; img.classList.remove("loading"); }
      else { img.classList.remove("loading"); img.classList.add("none"); }
    }).catch(function () { img.classList.remove("loading"); }).then(function () {
      thumbBusy = false;
      setTimeout(pumpThumbs, 0);
    });
  }

  /* 點擊原始影像：放大顯示整列（上下各多一列）＋紅框 */
  function openZoom(f) {
    var doc = f ? S.docById[f.docId] : null;
    var table = doc ? tableOf(doc, f.tableId) : null;
    var cell = cellAt(table, f ? f.r : -1, f ? f.c : -1);
    if (!doc || !table || !cell) return;
    inspectOpener = document.activeElement;
    inspectEntry = null;
    $("#fill-inspect-kind").textContent = "原始影像";
    $("#fill-inspect-title").textContent = f.docName + "　" + (f.where || "");
    $("#fill-inspect-select").hidden = true;
    var box = $("#fill-inspect-body");
    box.innerHTML = "";
    box.appendChild(el("div", "fill-note", "紅框＝填入值「" + f.value + "」所在的原始儲存格（" + itemLabel(f.item) +
      (f.station ? "，" + f.station : f.pointNo ? "，" + pointText(f.pointNo) : "") + "）"));
    var holder = el("div", "fill-inspect-page", "載入中…");
    box.appendChild(holder);
    $("#fill-inspect-modal").classList.remove("hidden");
    focusModal();
    YF.raw.rowStripDataURL(doc, table, cell, 1200, { wide: true }).then(function (url) {
      holder.textContent = "";
      if (!url) { holder.textContent = "無法顯示原始影像"; return; }
      var im = el("img"); im.src = url; im.alt = "原始影像";
      holder.appendChild(im);
    });
  }

  /* ---------- 輸出 ---------- */
  function renderOutputs() {
    var box = $("#fill-outputs");
    box.innerHTML = "";
    var ready = S.tpl.filter(function (e) { return e.doc && !e.doc.unsupported && e.status === "done"; });
    $("#fill-report-btn").disabled = !S.assignments.length;
    $("#fill-zip-btn").disabled = !ready.length;
    if (!ready.length) {
      box.appendChild(el("div", "fill-empty", "加入待填表格後，這裡會出現「下載已填寫檔案」"));
      return;
    }
    ready.forEach(function (e) {
      var mine = S.assignments.filter(function (a) { var s = S.slotById[a.slotId]; return s && s.docId === e.doc.id; });
      var filled = mine.filter(function (a) { return hasValue(a.value); }).length;
      var issues = mine.filter(function (a) { return a.status === "conflict"; }).length;
      var row = el("div", "fill-out-row");
      var info = el("div", "fill-out-info");
      info.appendChild(el("div", "fill-out-name", YF.tpl.filledName(e.doc.name, outExt(e.doc))));
      var st = "已填 " + filled + " / " + mine.length + " 格";
      if (filled < mine.length) st += "，" + (mine.length - filled) + " 格仍空白";
      if (issues) st += "，" + issues + " 格建議再核對";
      info.appendChild(el("div", "fill-out-sub" + (filled === mine.length && !issues ? " ok" : ""), st));
      var m = e.doc._model;
      if (m && m.format === "sheetjs" && m.kind !== "csv") {
        info.appendChild(el("div", "fill-out-sub", "注意：." + (m.ext || m.kind) + " 格式輸出時框線、字型、底色可能遺失；建議先將範本另存為 .xlsx 再上傳"));
      }
      row.appendChild(info);
      var btn = el("button", "btn primary", "下載已填寫檔案");
      btn.addEventListener("click", function () { downloadTemplate(e, btn); });
      row.appendChild(btn);
      box.appendChild(row);
    });
  }
  function outExt(doc) {
    var ext = (String(doc.name).match(/\.([^.]+)$/) || [, "docx"])[1].toLowerCase();
    if (doc._model && doc._model.outExt) return doc._model.outExt;
    if (doc.type && doc.type.route === "docx") return ext === "docm" ? "docm" : "docx";
    if (ext === "csv") return "csv";
    return ext === "xlsm" ? "xlsm" : ext === "xltx" ? "xlsx" : ext === "xls" ? "xls" : "xlsx";
  }

  /* 頁面底部固定列：填寫進度＋下載（核對表很長時不必捲到最下面） */
  function renderSticky() {
    var bar = $("#fill-sticky");
    if (!bar) return;
    var ready = S.tpl.filter(function (e) { return e.doc && !e.doc.unsupported && e.status === "done"; });
    if (!ready.length || !S.assignments.length) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = "";
    var c = counts();
    var txt = "已填 " + c.filled + " / " + c.total + " 格";
    if (c.conflict) txt += "｜" + c.conflict + " 格需核對";
    if (c.mapping) txt += "｜" + c.mapping + " 格待對應測點";
    if (isBusy()) txt += "｜原始資料辨識中…";
    bar.appendChild(el("span", "fill-sticky-txt", txt));
    if (ready.length === 1) {
      var b = el("button", "btn primary small", "下載已填寫檔案");
      b.addEventListener("click", function () { downloadTemplate(ready[0], b); });
      bar.appendChild(b);
    }
    var go = el("button", "btn small", "前往下載 ↓");
    go.addEventListener("click", function () {
      var pnl = $("#fill-out-panel");
      if (pnl && pnl.scrollIntoView) pnl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    bar.appendChild(go);
  }

  function fillsFor(doc) {
    var fills = [];
    S.assignments.forEach(function (a) {
      var s = S.slotById[a.slotId];
      if (!s || s.docId !== doc.id) return;
      if (a.value === "" || a.value === null || a.value === undefined) return;
      fills.push({ tableId: s.tableId, r0: s.r, c0: s.c, value: String(a.value), mark: S.options.mark, ref: s.ref });
    });
    return fills;
  }
  function buildFilled(e) {
    return YF.tpl.fill(e.doc, fillsFor(e.doc));
  }
  function saveBlob(bytes, name, mime) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || "application/octet-stream" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function downloadTemplate(e, btn) {
    if (btn) btn.disabled = true;
    buildFilled(e).then(function (out) {
      saveBlob(out.bytes, out.fileName, out.mime);
      var ws = out.warnings || [];
      if (ws.length) toast(ws[0] + (ws.length > 1 ? "（另有 " + (ws.length - 1) + " 則提示）" : ""));
    }).catch(function (err) {
      toast("產生檔案失敗：" + err.message, true);
      if (root.console) console.error(err);
    }).then(function () { if (btn) btn.disabled = false; });
  }

  function reportRows() {
    var rows = [["待填表格", "表格", "測站", "項目", "統計", "單位", "填入值", "狀態", "說明",
      "來源檔案", "來源位置", "原始文字", "OCR 信心度", "其他來源"]];
    S.assignments.forEach(function (a) {
      var s = S.slotById[a.slotId];
      if (!s) return;
      var doc = S.docById[s.docId], t = tableOf(doc, s.tableId);
      var f = a.factId ? S.factById[a.factId] : null;
      var alts = (a.candidates || []).filter(function (c) { return c.factId !== a.factId && S.factById[c.factId]; })
        .map(function (c) { var cf = S.factById[c.factId]; return c.value + "（" + cf.docName + " " + (cf.where || "") + "）"; }).join("；");
      rows.push([doc ? doc.name : "", t && t.title ? t.title : s.tableId, s.station || "", itemLabel(s.item),
        statLabel(s.stat), unitLabel(s.unit), a.value || "", (STATUS_LABEL[a.status] || a.status).replace(/^[✓⚠]\s*/, ""),
        a.note || "", f ? f.docName : "", f ? (f.where || "") : "", f ? (f.cellText || "") : "",
        f && f.conf !== null && f.conf !== undefined ? f.conf : "", alts]);
    });
    return rows;
  }
  function rawRows() {
    var rows = [["原始資料檔案", "辨識格式", "說明", "表格數", "數值筆數", "提示"]];
    S.raw.forEach(function (e) {
      var d = e.doc;
      rows.push([e.file.name, d ? d.typeLabel : "", d ? d.info : (e.error || ""), d ? d.tables.length : 0,
        d ? S.facts.filter(function (f) { return f.docId === d.id; }).length : 0, d ? d.warnings.join("；") : ""]);
    });
    return rows;
  }
  function buildReport() {
    var X = root.XLSX;
    var wb = X.utils.book_new();
    var ws1 = X.utils.aoa_to_sheet(reportRows());
    ws1["!cols"] = [{ wch: 26 }, { wch: 34 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 10 },
      { wch: 12 }, { wch: 28 }, { wch: 22 }, { wch: 24 }, { wch: 14 }, { wch: 8 }, { wch: 40 }];
    X.utils.book_append_sheet(wb, ws1, "核對明細");
    var ws2 = X.utils.aoa_to_sheet(rawRows());
    ws2["!cols"] = [{ wch: 30 }, { wch: 22 }, { wch: 40 }, { wch: 8 }, { wch: 8 }, { wch: 60 }];
    X.utils.book_append_sheet(wb, ws2, "原始資料");
    return new Uint8Array(X.write(wb, { bookType: "xlsx", type: "array" }));
  }
  function reportName() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return "核對報告_" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + ".xlsx";
  }
  function downloadReport() {
    try { saveBlob(buildReport(), reportName(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); }
    catch (err) { toast("核對報告產生失敗：" + err.message, true); }
  }
  function downloadAll() {
    var ready = S.tpl.filter(function (e) { return e.doc && !e.doc.unsupported && e.status === "done"; });
    if (!ready.length) return;
    var btn = $("#fill-zip-btn");
    btn.disabled = true;
    var entries = [];
    var chain = Promise.resolve();
    ready.forEach(function (e) {
      chain = chain.then(function () {
        return buildFilled(e).then(function (out) {
          var name = out.fileName, k = 2;
          while (entries.some(function (x) { return x.name === name; })) name = out.fileName.replace(/(\.[^.]+)$/, "(" + (k++) + ")$1");
          entries.push({ name: name, data: out.bytes });
        });
      });
    });
    chain.then(function () {
      try { entries.push({ name: reportName(), data: buildReport() }); } catch (e) { /* 報告失敗仍輸出檔案 */ }
      return YF.zip.write(entries);
    }).then(function (zipBytes) {
      var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
      saveBlob(zipBytes, "核對完成檔案_" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + ".zip", "application/zip");
    }).catch(function (err) {
      toast("打包失敗：" + err.message, true);
    }).then(function () { btn.disabled = false; });
  }

  /* ---------- 辨識結果檢視（原始資料表格） ---------- */
  var inspectEntry = null, inspectOpener = null;
  function openInspect(e) {
    inspectOpener = document.activeElement;
    inspectEntry = e;
    var sel = $("#fill-inspect-select");
    sel.hidden = false;
    sel.innerHTML = "";
    e.doc.tables.forEach(function (t, i) {
      var fs = S.facts.filter(function (f) { return f.docId === e.doc.id && f.tableId === t.id; });
      var st = [];
      fs.forEach(function (f) { if (f.station && st.indexOf(f.station) < 0) st.push(f.station); });
      // 表格名稱：偵測到的測站優先（OCR 的頁首文字常是採樣編號等雜訊）
      var name = st.length ? st.slice(0, 2).join("、") + (st.length > 2 ? "…" : "") : (t.title ? t.title.slice(0, 24) : "");
      var lab = (t.page ? "第 " + t.page + " 頁 " : "") + (t.sheet ? "工作表「" + t.sheet + "」 " : "") +
        "表格 " + (t.index + 1) + (name ? "：" + name : "") + "（" + t.cells.length + " 格、" + fs.length + " 筆數值）";
      sel.appendChild(new Option(lab, String(i)));
    });
    $("#fill-inspect-kind").textContent = "辨識結果";
    $("#fill-inspect-title").textContent = e.file.name;
    $("#fill-inspect-modal").classList.remove("hidden");
    renderInspectTable();
    focusModal();
  }
  function focusModal() {
    var sel = $("#fill-inspect-select"), x = $("#fill-inspect-x");
    var target = !sel.hidden ? sel : (x || $("#fill-inspect-close"));
    try { target.focus(); } catch (e) { /* 忽略 */ }
  }
  function closeInspect() {
    $("#fill-inspect-modal").classList.add("hidden");
    $("#fill-inspect-select").hidden = false;
    inspectEntry = null;
    if (inspectOpener && inspectOpener.focus && inspectOpener.isConnected !== false) {
      try { inspectOpener.focus(); } catch (e) { /* 忽略 */ }
    }
    inspectOpener = null;
  }
  function renderInspectTable() {
    var box = $("#fill-inspect-body");
    box.innerHTML = "";
    if (!inspectEntry) return;
    var t = inspectEntry.doc.tables[Number($("#fill-inspect-select").value) || 0];
    if (!t) return;
    var used = {};
    S.facts.forEach(function (f) { if (f.docId === inspectEntry.doc.id && f.tableId === t.id) used[f.r + "," + f.c] = f; });
    var grid = [];
    for (var r = 0; r < t.nRows; r++) grid.push(new Array(t.nCols).fill(null));
    t.cells.forEach(function (c) {
      for (var rr = c.r0; rr <= c.r1 && rr < t.nRows; rr++) for (var cc = c.c0; cc <= c.c1 && cc < t.nCols; cc++) grid[rr][cc] = (rr === c.r0 && cc === c.c0) ? c : "span";
    });
    var tbl = el("table", "fill-inspect-table");
    for (var r2 = 0; r2 < t.nRows; r2++) {
      var tr = el("tr");
      for (var c2 = 0; c2 < t.nCols; c2++) {
        var cell = grid[r2][c2];
        if (cell === "span") continue;
        var td = el("td");
        if (cell) {
          td.textContent = cell.text;
          if (cell.r1 > cell.r0) td.rowSpan = cell.r1 - cell.r0 + 1;
          if (cell.c1 > cell.c0) td.colSpan = cell.c1 - cell.c0 + 1;
          var f = used[cell.r0 + "," + cell.c0];
          if (f) {
            td.className = "fact";
            td.title = (f.station || ("測點" + (f.pointNo || "?"))) + "｜" + itemLabel(f.item) + "｜" + statLabel(f.stat) + (f.unit ? "｜" + unitLabel(f.unit) : "");
          }
          if (cell.conf !== null && cell.conf !== undefined && cell.conf < 60 && cell.text) td.classList.add("lowconf");
        }
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    if (t.context && t.context.length) {
      box.appendChild(el("div", "fill-inspect-ctx", "頁面文字：" + t.context.slice(0, 8).join("／")));
    }
    var leg = el("div", "fill-note", "藍底＝擷取為數值的儲存格（滑鼠移上可看判讀結果）；黃底＝OCR 信心度較低。");
    box.appendChild(leg);
    var sc = el("div", "fill-inspect-scroll");
    sc.appendChild(tbl);
    box.appendChild(sc);
    if (t.page && inspectEntry.doc.getPageBitmap && YF.raw.pageThumbDataURL) {
      var holder = el("div", "fill-inspect-page");
      box.appendChild(holder);
      YF.raw.pageThumbDataURL(inspectEntry.doc, t.page, 640).then(function (url) {
        if (!url) return;
        var im = el("img"); im.src = url; im.alt = "第 " + t.page + " 頁";
        holder.appendChild(el("div", "fill-note", "第 " + t.page + " 頁原始影像："));
        holder.appendChild(im);
      });
    }
  }

  /* ---------- 對外 ---------- */
  YF.ui = {
    state: S,
    init: init,
    onShow: function () { renderAll(); },
    addFiles: addFiles,
    recompute: recompute,
    buildFilled: buildFilled,
    buildReport: buildReport
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : globalThis);
