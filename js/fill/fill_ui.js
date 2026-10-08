/* =========================================================================
 * Yang-analyze web — fill/fill_ui.js
 * 「填表核對」頁面介面：
 *   ① 原始資料（DocuWorks / PDF / Word / Excel / 影像，可多檔混放）
 *   ② 待填表格（Word .docx / Excel .xlsx .xls）
 *   ③ 核對：每個空格的建議值、來源（檔名/頁/表格位置）、原始影像條帶、
 *      跨來源比對狀態；可修改、改選其他來源、對應測點
 *   ④ 核對完成檔案：下載已填寫的原格式檔案、核對報告（.xlsx）、全部打包（.zip）
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
    manual: {},       // slotKey → 使用者手動值
    picks: {},        // slotKey → 使用者改選的 factId
    verify: {},       // factId → {text, agree}
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
  function slotKey(slot) {
    var d = S.docById[slot.docId];
    return (d ? d.name : slot.docId) + "|" + slot.tableId + "|" + slot.r + "|" + slot.c;
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
    $("#fill-inspect-modal").addEventListener("click", function (e) { if (e.target === this) closeInspect(); });
    $("#fill-inspect-select").addEventListener("change", function () { renderInspectTable(); });

    Promise.all([setting("fill.aliases"), setting("fill.options"), loadKnownStations()]).then(function (r) {
      if (r[0] && typeof r[0] === "object") S.aliases = r[0];
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
    if (!av.ok) { banner.textContent = "提醒：" + av.reason; banner.hidden = false; }
  }
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
    runQueue();
  }

  function runQueue() {
    if (S.queueBusy) return;
    var next = S.tpl.filter(function (e) { return e.status === "queued"; })[0] ||
               S.raw.filter(function (e) { return e.status === "queued"; })[0];
    if (!next) { recompute(); return; }
    S.queueBusy = true;
    next.status = "processing";
    next.progress = { done: 0, total: 1, message: "讀取檔案…" };
    renderFiles();
    var t0 = Date.now();
    YF.raw.process(next.file, {
      role: next.role,
      cache: C && C.storage && C.storage.fillCache ? C.storage.fillCache : null,
      onProgress: function (p) { next.progress = p; renderFileProgress(next); }
    }).then(function (doc) {
      next.doc = doc;
      next.status = doc.unsupported ? "unsupported" : "done";
      next.ms = Date.now() - t0;
      S.docById[doc.id] = doc;
    }).catch(function (e) {
      next.status = "error";
      next.error = e && e.message ? e.message : String(e);
      if (root.console) console.error(e);
    }).then(function () {
      S.queueBusy = false;
      renderFiles();
      // 每處理完一檔就更新核對結果，讓使用者先看到部分結果
      recompute();
      runQueue();
    });
  }

  function removeEntry(role, id) {
    var list = role === "raw" ? S.raw : S.tpl;
    var idx = list.findIndex(function (e) { return e.id === id; });
    if (idx < 0) return;
    if (list[idx].status === "processing") { toast("檔案處理中，請稍候再移除", true); return; }
    var d = list[idx].doc;
    if (d) {
      delete S.docById[d.id];
      if (d._pdf && d._pdf.destroy) { try { d._pdf.destroy(); } catch (e) { /* 忽略 */ } }
    }
    list.splice(idx, 1);
    renderFiles();
    recompute();
  }

  function clearAll() {
    if ((S.raw.length || S.tpl.length) && !confirm("清除本頁全部原始資料、待填表格與核對結果？（測點對應設定會保留）")) return;
    if (S.queueBusy) { toast("檔案處理中，請稍候", true); return; }
    S.raw = []; S.tpl = []; S.facts = []; S.slots = []; S.assignments = [];
    S.factById = {}; S.slotById = {}; S.docById = {}; S.manual = {}; S.picks = {}; S.verify = {};
    renderAll();
  }

  /* ================= 比對 ================= */
  function templateStations() {
    var names = [];
    S.tpl.forEach(function (e) {
      if (e.doc && !e.doc.unsupported && YF.extract.templateStations) {
        YF.extract.templateStations(e.doc).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
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

  function recompute() {
    if (!YF.extract || !YF.match) return;
    var stations = templateStations().concat(S.knownStations);
    var facts = [], slots = [];
    S.raw.forEach(function (e) {
      if (!e.doc || e.doc.unsupported) return;
      try {
        facts = facts.concat(YF.extract.facts(e.doc, { stations: stations }) || []);
      } catch (err) {
        e.doc.warnings.push("數值擷取失敗：" + err.message);
        if (root.console) console.error(err);
      }
      facts = facts.concat(moduleFactsOf(e.doc));
    });
    S.tpl.forEach(function (e) {
      if (!e.doc || e.doc.unsupported) return;
      try {
        slots = slots.concat(YF.extract.slots(e.doc, { stations: stations }) || []);
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

  /* 使用者手動值／改選來源／第二次辨識結果 → 套用到 assignment */
  function applyUserChoices() {
    S.assignments.forEach(function (a) {
      var slot = S.slotById[a.slotId];
      if (!slot) return;
      var key = slotKey(slot);
      a._auto = a._auto || { value: a.value, status: a.status, factId: a.factId, note: a.note };
      var pick = S.picks[key];
      if (pick && S.factById[pick]) {
        var cand = (a.candidates || []).filter(function (c) { return c.factId === pick; })[0];
        if (cand) { a.value = cand.value; a.factId = pick; a.status = "manual"; a.note = "改選來源"; }
      }
      if (Object.prototype.hasOwnProperty.call(S.manual, key)) {
        a.value = S.manual[key];
        a.status = "manual";
        a.note = "手動輸入";
      }
      var v = a.factId ? S.verify[a.factId] : null;
      if (v && !v.agree && a.status !== "manual") {
        a.status = "conflict";
        a.note = (a.note ? a.note + "；" : "") + "第二次數值辨識為「" + v.text + "」，請對照原始影像";
      }
    });
  }

  function setManual(slot, value) {
    S.manual[slotKey(slot)] = value;
    var a = assignmentOf(slot.id);
    if (a) { a.value = value; a.status = "manual"; a.note = "手動輸入"; }
    renderSummary(); renderOutputs();
  }
  function resetSlot(slot) {
    var key = slotKey(slot);
    delete S.manual[key]; delete S.picks[key];
    recompute();
  }
  function assignmentOf(slotId) {
    for (var i = 0; i < S.assignments.length; i++) if (S.assignments[i].slotId === slotId) return S.assignments[i];
    return null;
  }

  function fillPlaceholders() {
    var ph = $("#fill-placeholder").value;
    S.options.placeholder = ph;
    saveSetting("fill.options", S.options);
    var n = 0;
    S.assignments.forEach(function (a) {
      if ((a.status === "missing" || a.status === "mapping") && !a.value) {
        var slot = S.slotById[a.slotId];
        if (!slot) return;
        S.manual[slotKey(slot)] = ph; n++;
      }
    });
    if (!n) { toast("沒有尚未填寫的空格"); return; }
    applyUserChoices();
    renderAll();
    toast("已將 " + n + " 個無資料空格填入「" + ph + "」");
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
    function step() {
      if (run !== S.verifyRun || i >= todo.length) {
        if (run === S.verifyRun && i >= todo.length) { applyUserChoices(); renderReview(); renderSummary(); }
        return;
      }
      var f = todo[i++];
      var doc = S.docById[f.docId], table = tableOf(doc, f.tableId), cell = cellAt(table, f.r, f.c);
      YF.raw.cellPBM(doc, table, cell).then(function (bytes) {
        if (!bytes) return null;
        return YF.ocr.recognize(bytes, { psm: "7", numeric: true });
      }).then(function (res) {
        if (!res) return;
        var t2 = String(res.text || "").replace(/\s+/g, "");
        var p1 = D().parseValue ? D().parseValue(f.value) : null;
        var p2 = D().parseValue ? D().parseValue(t2) : null;
        var agree = !!(p1 && p2 && p1.ok && p2.ok && (p1.value === p2.value ||
          (p1.num !== null && p1.num === p2.num && (p1.cmp || "") === (p2.cmp || ""))));
        S.verify[f.id] = { text: p2 && p2.ok ? p2.value : t2, agree: agree || !p2 || !p2.ok };
      }).catch(function () { /* 忽略 */ }).then(function () {
        if (i % 8 === 0) { applyUserChoices(); renderReview(); renderSummary(); }
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
    renderFiles(); renderSummary(); renderMapping(); renderReview(); renderOutputs();
  }

  var STATUS_TXT = {
    queued: "等待中", processing: "辨識中", done: "完成", error: "失敗", unsupported: "不支援"
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
        if (tl) parts.push(tl);
        if (e.doc.info) parts.push(e.doc.info);
        if (e.status === "done") {
          if (role === "raw") {
            var nf = S.facts.filter(function (f) { return f.docId === e.doc.id; }).length;
            parts.push("找到 " + e.doc.tables.length + " 個表格、" + nf + " 筆數值");
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
    if (p.stage === "page" && p.total) frac = p.done / p.total;
    else if (p.stage === "ocr" && p.total) frac = p.done / p.total;
    bar.style.width = Math.max(3, Math.round(frac * 100)) + "%";
    msg.textContent = p.message || "";
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
    var c = { total: 0, filled: 0, checked: 0, auto: 0, conflict: 0, mapping: 0, missing: 0, manual: 0 };
    S.assignments.forEach(function (a) {
      c.total++;
      if (a.value !== "" && a.value !== null && a.value !== undefined) c.filled++;
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
    if (c.conflict) chip("conflict", "需核對", c.conflict);
    if (c.mapping) chip("mapping", "待對應測點", c.mapping);
    if (c.missing) chip("missing", "無對應資料", c.missing);
    if (c.manual) chip("manual", "手動", c.manual);
  }

  /* ---------- 測點對應 ---------- */
  function renderMapping() {
    var box = $("#fill-mapping");
    box.innerHTML = "";
    if (!YF.match || !YF.match.unmatchedGroups || !S.slots.length) { box.hidden = true; return; }
    var groups = [];
    try { groups = YF.match.unmatchedGroups(S.slots, S.facts, S.assignments) || []; } catch (e) { groups = []; }
    var mapped = Object.keys(S.aliases).filter(function (k) {
      return S.facts.some(function (f) { return f.stationKey === k; });
    });
    if (!groups.length && !mapped.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el("h4", null, "測點對應"));
    box.appendChild(el("p", "fill-note",
      "以下原始資料的測點沒有明確測站名稱（例：異味報告的測點①～④），或名稱與表格不同。請選擇對應的表格測站；設定會記住，下一季同樣的報告會自動帶入。"));
    var tbl = el("table", "fill-map-table");
    var thead = el("tr");
    ["原始資料測點", "項目／數值", "對應到表格測站"].forEach(function (h) { thead.appendChild(el("th", null, h)); });
    tbl.appendChild(thead);
    var stationOptions = slotStations();
    function addRow(key, label, sample) {
      var tr = el("tr");
      tr.appendChild(el("td", null, label));
      tr.appendChild(el("td", "fill-map-sample", sample));
      var td = el("td");
      var sel = el("select", "fill-map-select");
      sel.appendChild(new Option("（未對應）", ""));
      stationOptions.forEach(function (n) { sel.appendChild(new Option(n, n)); });
      if (S.aliases[key] && stationOptions.indexOf(S.aliases[key]) < 0) sel.appendChild(new Option(S.aliases[key], S.aliases[key]));
      sel.value = S.aliases[key] || "";
      sel.addEventListener("change", function () {
        if (sel.value) S.aliases[key] = sel.value; else delete S.aliases[key];
        saveSetting("fill.aliases", S.aliases);
        recompute();
      });
      td.appendChild(sel);
      tr.appendChild(td);
      tbl.appendChild(tr);
    }
    var shown = {};
    groups.forEach(function (g) {
      shown[g.stationKey] = true;
      var sample = (g.facts || []).slice(0, 4).map(function (f) {
        return itemLabel(f.item) + " " + f.value + (f.unit ? " " + unitLabel(f.unit) : "");
      }).join("、");
      addRow(g.stationKey, g.label || g.stationKey, sample);
    });
    mapped.forEach(function (k) {
      if (shown[k]) return;
      var fs = S.facts.filter(function (f) { return f.stationKey === k; });
      var lab = fs[0] ? (fs[0].station || (fs[0].docName + " 第" + (fs[0].pointNo || "?") + "點")) : k;
      addRow(k, lab, fs.slice(0, 4).map(function (f) { return itemLabel(f.item) + " " + f.value; }).join("、"));
    });
    box.appendChild(tbl);
  }
  function slotStations() {
    var out = [];
    S.slots.forEach(function (s) { if (s.station && out.indexOf(s.station) < 0) out.push(s.station); });
    return out;
  }

  /* ---------- 核對表 ---------- */
  var STATUS_LABEL = {
    checked: "✓ 兩來源一致", auto: "自動帶入", conflict: "⚠ 需核對", mapping: "待對應測點",
    missing: "無對應資料", manual: "手動"
  };
  var thumbObserver = null;
  function renderReview() {
    var wrap = $("#fill-review");
    wrap.innerHTML = "";
    if (!S.assignments.length) return;
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = ("IntersectionObserver" in root) ? new IntersectionObserver(onThumbVisible, { rootMargin: "200px" }) : null;

    var byDoc = {};
    S.assignments.forEach(function (a) {
      var slot = S.slotById[a.slotId];
      if (!slot) return;
      if (S.options.onlyIssues && ["conflict", "mapping", "missing"].indexOf(a.status) < 0) return;
      (byDoc[slot.docId] = byDoc[slot.docId] || []).push({ a: a, slot: slot });
    });
    Object.keys(byDoc).forEach(function (docId) {
      var doc = S.docById[docId];
      var sec = el("div", "fill-review-doc");
      sec.appendChild(el("h4", null, doc ? doc.name : docId));
      var tbl = el("table", "fill-review-table");
      var hr = el("tr");
      ["測站", "項目", "統計／單位", "填入值", "狀態", "來源", "原始影像"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
      var thead = el("thead"); thead.appendChild(hr); tbl.appendChild(thead);
      var tbody = el("tbody");
      var lastTable = null;
      byDoc[docId].forEach(function (x) {
        if (x.slot.tableId !== lastTable) {
          lastTable = x.slot.tableId;
          var t = tableOf(doc, x.slot.tableId);
          var gr = el("tr", "fill-group");
          var gtd = el("td", null, (t && t.title) ? t.title : ("表格 " + x.slot.tableId));
          gtd.colSpan = 7;
          gr.appendChild(gtd);
          tbody.appendChild(gr);
        }
        tbody.appendChild(reviewRow(x.a, x.slot));
      });
      tbl.appendChild(tbody);
      var scroller = el("div", "fill-review-scroll");
      scroller.appendChild(tbl);
      sec.appendChild(scroller);
      wrap.appendChild(sec);
    });
    if (!wrap.children.length) wrap.appendChild(el("div", "fill-empty", "沒有需要處理的空格 🎉"));
  }

  function reviewRow(a, slot) {
    var tr = el("tr", "st-" + a.status);
    tr.appendChild(el("td", null, slot.station || "—"));
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
    inp.addEventListener("change", function () { setManual(slot, inp.value.trim()); tr.className = "st-manual"; badge.textContent = STATUS_LABEL.manual; badge.className = "fill-st st-manual"; });
    vtd.appendChild(inp);
    if (a.status === "manual") {
      var rb = el("button", "fill-reset", "↺");
      rb.title = "還原自動值";
      rb.addEventListener("click", function () { resetSlot(slot); });
      vtd.appendChild(rb);
    }
    tr.appendChild(vtd);

    var std = el("td");
    var badge = el("span", "fill-st st-" + a.status, STATUS_LABEL[a.status] || a.status);
    std.appendChild(badge);
    if (a.note) { var nt = el("div", "fill-note-sm", a.note); std.appendChild(nt); }
    tr.appendChild(std);

    var srcTd = el("td", "fill-src");
    var f = a.factId ? S.factById[a.factId] : null;
    if (f) {
      srcTd.appendChild(el("div", "fill-src-file", f.docName));
      srcTd.appendChild(el("div", "fill-src-where", f.where || ""));
      if (f.cellText && f.cellText !== f.value) srcTd.appendChild(el("div", "fill-src-raw", "原文：" + f.cellText));
    } else {
      srcTd.appendChild(el("span", "fill-note-sm", a.status === "mapping" ? "請在上方「測點對應」選擇" : "原始資料中找不到"));
    }
    var cands = (a.candidates || []).filter(function (c) { return S.factById[c.factId]; });
    if (cands.length > 1) {
      var sel = el("select", "fill-alt");
      cands.forEach(function (c) {
        var cf = S.factById[c.factId];
        var lab = c.value + "｜" + cf.docName + " " + (cf.where || "") + (c.agrees === false ? "（不一致）" : "");
        sel.appendChild(new Option(lab, c.factId));
      });
      sel.value = a.factId || "";
      sel.title = "其他來源";
      sel.addEventListener("change", function () {
        S.picks[slotKey(slot)] = sel.value;
        delete S.manual[slotKey(slot)];
        recompute();
      });
      srcTd.appendChild(sel);
    }
    tr.appendChild(srcTd);

    var imgTd = el("td", "fill-thumb");
    if (f && f.bbox && f.page) {
      var img = el("img");
      img.alt = "原始影像";
      img.dataset.fact = f.id;
      img.className = "fill-thumb-img loading";
      imgTd.appendChild(img);
      if (thumbObserver) thumbObserver.observe(img); else loadThumb(img);
    } else if (f && f.source === "module") {
      imgTd.appendChild(el("span", "fill-note-sm", "Excel 精確值"));
    } else if (f) {
      imgTd.appendChild(el("span", "fill-note-sm", "文字檔精確值"));
    }
    tr.appendChild(imgTd);
    return tr;
  }

  var thumbQueue = [], thumbBusy = false, thumbCache = {};
  function onThumbVisible(entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { thumbObserver.unobserve(en.target); loadThumb(en.target); }
    });
  }
  function loadThumb(img) {
    var fid = img.dataset.fact;
    if (thumbCache[fid]) { img.src = thumbCache[fid]; img.classList.remove("loading"); return; }
    thumbQueue.push(img);
    pumpThumbs();
  }
  function pumpThumbs() {
    if (thumbBusy || !thumbQueue.length) return;
    thumbBusy = true;
    // 依頁面排序，減少重複解碼
    thumbQueue.sort(function (a, b) {
      var fa = S.factById[a.dataset.fact], fb = S.factById[b.dataset.fact];
      return ((fa && fa.page) || 0) - ((fb && fb.page) || 0);
    });
    var img = thumbQueue.shift();
    var f = S.factById[img.dataset.fact];
    var doc = f ? S.docById[f.docId] : null;
    var table = doc ? tableOf(doc, f.tableId) : null;
    var cell = cellAt(table, f ? f.r : -1, f ? f.c : -1);
    var p = (doc && table && cell) ? YF.raw.rowStripDataURL(doc, table, cell, 520) : Promise.resolve(null);
    p.then(function (url) {
      if (url) { thumbCache[f.id] = url; img.src = url; img.classList.remove("loading"); img.title = "紅框＝填入值所在的原始儲存格"; }
      else { img.classList.remove("loading"); img.classList.add("none"); }
    }).catch(function () { img.classList.remove("loading"); }).then(function () {
      thumbBusy = false;
      setTimeout(pumpThumbs, 0);
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
      var filled = mine.filter(function (a) { return a.value; }).length;
      var issues = mine.filter(function (a) { return a.status === "conflict"; }).length;
      var row = el("div", "fill-out-row");
      var info = el("div", "fill-out-info");
      info.appendChild(el("div", "fill-out-name", YF.tpl.filledName(e.doc.name, outExt(e.doc))));
      var st = "已填 " + filled + " / " + mine.length + " 格";
      if (filled < mine.length) st += "，" + (mine.length - filled) + " 格仍空白";
      if (issues) st += "，" + issues + " 格建議再核對";
      info.appendChild(el("div", "fill-out-sub" + (filled === mine.length && !issues ? " ok" : ""), st));
      row.appendChild(info);
      var btn = el("button", "btn primary", "下載已填寫檔案");
      btn.addEventListener("click", function () { downloadTemplate(e, btn); });
      row.appendChild(btn);
      box.appendChild(row);
    });
  }
  function outExt(doc) {
    var ext = (String(doc.name).match(/\.([^.]+)$/) || [, "docx"])[1].toLowerCase();
    if (doc.family === "word") return ext === "docm" ? "docm" : "docx";
    return ext === "xlsm" ? "xlsm" : ext === "xls" ? "xls" : "xlsx";
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
      (out.warnings || []).forEach(function (w) { toast(w); });
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
  var inspectEntry = null;
  function openInspect(e) {
    inspectEntry = e;
    var sel = $("#fill-inspect-select");
    sel.innerHTML = "";
    e.doc.tables.forEach(function (t, i) {
      var nf = S.facts.filter(function (f) { return f.docId === e.doc.id && f.tableId === t.id; }).length;
      var lab = (t.page ? "第 " + t.page + " 頁 " : "") + (t.sheet ? "工作表「" + t.sheet + "」 " : "") +
        "表格 " + (t.index + 1) + (t.title ? "：" + t.title.slice(0, 24) : "") + "（" + t.cells.length + " 格、" + nf + " 筆數值）";
      sel.appendChild(new Option(lab, String(i)));
    });
    $("#fill-inspect-title").textContent = e.file.name;
    $("#fill-inspect-modal").classList.remove("hidden");
    renderInspectTable();
  }
  function closeInspect() {
    $("#fill-inspect-modal").classList.add("hidden");
    inspectEntry = null;
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
