/* =========================================================================
 * Yang-analyze web — app.js（介面邏輯）
 * 版面樣式一律在 css/main.css；此檔只操作 DOM 結構與 class。
 * ========================================================================= */
(function () {
  "use strict";
  var C = window.YangCore, DB = window.YangDB;
  var MODULE_IDS = ["water", "air"];                       // 已啟用的分析種類（噪音待開發）
  function cfgOf(mid) { return window.YangConfigs[mid]; }
  function cfgOfRec(rec) { return cfgOf(rec.module); }
  function enabledModules() {
    var list = [];
    if ($("#mod-water").checked) list.push("water");
    if ($("#mod-air").checked) list.push("air");
    return list;
  }

  var state = {
    files: [],            // {name}
    records: [],
    warnings: [],
    missing: [],
    stations: [],
    projects: [],
    tables: {},           // 合併後對照表
    storedTables: {},     // IndexedDB 裡的自訂表原始列（含 base/baseVersion）
    activeProjectCode: null,
    importId: null,       // 目前草稿在匯入紀錄中的 id
    editingTable: null    // 對照表編輯中的分頁
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "show" + (isErr ? " error" : "");
    clearTimeout(toast._h);
    toast._h = setTimeout(function () { t.className = ""; }, 2800);
  }

  /* ================= 啟動 ================= */
  function init() {
    seedIfFirstRun()
      .then(reloadStations)
      .then(reloadProjects)
      .then(loadTables)
      .then(function () {
        return C.storage.getSetting("activeProject").then(function (code) {
          state.activeProjectCode = code;
        });
      })
      .then(function () {
        buildDatalists();
        bindNav(); bindUpload(); bindActions();
        renderProjectSelect(); renderStationsView(); renderProjectsView();
        renderTablesView(); renderHistoryView(); updateStatusBar();
      })
      .catch(function (e) { toast("初始化失敗：" + e.message, true); });
  }

  function seedIfFirstRun() {
    return C.storage.getSetting("seeded").then(function (done) {
      if (done) return null;
      var ops = [C.storage.put("projects", DB.seed.project)];
      DB.seed.stations.forEach(function (st) { ops.push(C.storage.put("stations", st)); });
      ops.push(C.storage.setSetting("activeProject", DB.seed.project.code));
      ops.push(C.storage.setSetting("seeded", true));
      return Promise.all(ops);
    });
  }
  function reloadStations() {
    return C.storage.getAll("stations").then(function (rows) { state.stations = rows || []; });
  }
  function reloadProjects() {
    return C.storage.getAll("projects").then(function (rows) { state.projects = rows || []; });
  }
  function loadTables() {
    var tables = {}, stored = {}, ops = [];
    MODULE_IDS.forEach(function (mid) {
      tables[mid] = {};
      cfgOf(mid).tableNames.forEach(function (name) {
        ops.push(C.storage.get("tables", mid + "." + name).then(function (row) {
          if (row) stored[mid + "." + name] = row;
          tables[mid][name] = row ? row.data : JSON.parse(JSON.stringify(DB[mid][name]));
        }));
      });
    });
    return Promise.all(ops).then(function () {
      state.tables = tables;        // state.tables[mid][name] = 合併後對照表
      state.storedTables = stored;  // key: mid.name
    });
  }

  /* 自訂表存檔時記錄的 baseVersion 比該模組內建預設舊 → 需提示合併 */
  function outdatedTableNames(mid) {
    return cfgOf(mid).tableNames.filter(function (name) {
      var row = state.storedTables[mid + "." + name];
      return row && (row.baseVersion || 0) < DB[mid].tablesVersion;
    });
  }

  /* ================= 官方代碼表下拉（datalist：可搜尋、仍可手動輸入） ================= */
  function buildDatalists() {
    function make(id, table, sep) {
      if (document.getElementById(id)) return;
      var dl = document.createElement("datalist");
      dl.id = id;
      Object.keys(table).forEach(function (code) {
        var o = document.createElement("option");
        o.value = code;
        o.label = code + sep + table[code];
        dl.appendChild(o);
      });
      document.body.appendChild(dl);
    }
    make("unit-datalist", DB.unitCodeTable, "－");
    make("agency-datalist", DB.agencyCodeTable, "－");
  }

  /* ================= 導覽 ================= */
  function bindNav() {
    $$(".nav-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        $$(".nav-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        $$(".view").forEach(function (v) { v.classList.add("hidden"); });
        $("#view-" + btn.dataset.view).classList.remove("hidden");
        if (btn.dataset.view === "history") renderHistoryView();
        if (btn.dataset.view === "stations") renderStationsView();
        if (btn.dataset.view === "projects") renderProjectsView();
        if (btn.dataset.view === "tables") renderTablesView();
        if (btn.dataset.view === "rules") renderRulesView();
        $("#action-bar").classList.toggle("hidden", btn.dataset.view !== "convert");
      });
    });
  }
  function showView(name) {
    $$(".nav-btn").forEach(function (b) {
      if (b.dataset.view === name) b.click();
    });
  }

  /* ================= 上傳與解析 ================= */
  function bindUpload() {
    var dz = $("#dropzone"), input = $("#file-input");
    dz.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      YangApp.handleFiles(Array.prototype.slice.call(input.files));
      input.value = "";
    });
    ["dragover", "dragenter"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragover"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragover"); });
    });
    dz.addEventListener("drop", function (e) {
      YangApp.handleFiles(Array.prototype.slice.call(e.dataTransfer.files));
    });
  }

  function handleFiles(files) {
    var enabled = enabledModules();
    if (!enabled.length) { toast("請先勾選至少一種分析種類", true); return Promise.resolve(); }
    var ok = [], bad = [];
    files.forEach(function (f) { (C.reader.isAccepted(f.name) ? ok : bad).push(f); });
    if (bad.length) toast("略過非 Excel 檔：" + bad.map(function (f) { return f.name; }).join("、"), true);
    if (!ok.length) return Promise.resolve();

    // 依序讀取，保持匯入順序 = 輸出列順序
    var models = [];
    var chain = Promise.resolve();
    ok.forEach(function (f) {
      chain = chain.then(function () {
        return C.reader.readFile(f).then(function (m) { models.push(m); });
      });
    });
    return chain.then(function () {
      // 每張工作表由第一個 detectSheet 命中的已勾選模組解析
      var jobs = enabled.map(function (mid) {
        return { config: cfgOf(mid), ctx: { stations: state.stations, tables: state.tables[mid] } };
      });
      var res = C.parser.parseFilesMulti(models, jobs);
      state.records = state.records.concat(res.records);
      state.warnings = state.warnings.concat(res.warnings);
      ok.forEach(function (f) { state.files.push({ name: f.name }); });
      refreshConvert();
      saveDraft();
      toast("已解析 " + res.records.length + " 個監測點");
    }).catch(function (e) {
      toast("讀取失敗：" + e.message, true);
    });
  }

  /* ================= 預覽表 ================= */
  /* records 依模組分組（保持出現順序） */
  function recordGroups() {
    var groups = [];
    state.records.forEach(function (rec) {
      var g = groups.find(function (x) { return x.mid === rec.module; });
      if (!g) { g = { mid: rec.module, recs: [] }; groups.push(g); }
      g.recs.push(rec);
    });
    return groups;
  }

  function refreshConvert() {
    state.missing = [];
    recordGroups().forEach(function (g) {
      state.missing = state.missing.concat(C.validator.validate(g.recs, cfgOf(g.mid)));
    });
    renderFileList(); renderWarnings(); renderPreview(); updateStatusBar();
  }

  function renderFileList() {
    var box = $("#file-list");
    box.innerHTML = "";
    state.files.forEach(function (f) { box.appendChild(el("span", "file-chip", f.name)); });
  }
  function renderWarnings() {
    var ul = $("#warnings");
    ul.innerHTML = "";
    state.warnings.forEach(function (w) { ul.appendChild(el("li", null, w)); });
  }

  function missingKeySet() {
    var s = new Set();
    state.missing.forEach(function (m) {
      s.add(m.uid + "|" + (m.itemIdx === null ? "s" : m.itemIdx) + "|" + m.key);
    });
    return s;
  }

  function displayVal(col, v) {
    if (v === null || v === undefined) return "";
    return String(v);
  }

  function renderPreview() {
    var wrap = $("#preview-wrap");
    $("#preview-legend").hidden = state.records.length === 0;
    wrap.innerHTML = "";
    if (!state.records.length) return;
    var miss = missingKeySet();
    recordGroups().forEach(function (g) {
      wrap.appendChild(el("div", "preview-mod-title", cfgOf(g.mid).label + "（" +
        g.recs.reduce(function (s, r) { return s + r.items.length; }, 0) + " 列）"));
      wrap.appendChild(buildPreviewTable(cfgOf(g.mid), g.recs, miss));
    });
  }

  function buildPreviewTable(CFG, records, miss) {
    var table = el("table", "preview");
    var thead = el("thead"), trh = el("tr");
    CFG.columns.forEach(function (col) { trh.appendChild(el("th", null, col.h)); });
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = el("tbody");

    records.forEach(function (rec) {
      var n = rec.items.length || 1;
      rec.items.forEach(function (it, idx) {
        var tr = el("tr");
        CFG.columns.forEach(function (col) {
          if (col.level === "station") {
            if (idx > 0) return; // rowspan 已涵蓋
            var f = rec.f[col.key] || { v: null, src: "parsed" };
            var td = el("td", "station-cell editable");
            td.rowSpan = n;
            var key = rec.uid + "|s|" + col.key;
            td.dataset.uid = rec.uid; td.dataset.key = col.key; td.dataset.item = "-1";
            if (typeof f.v === "number") td.classList.add("num");
            td.textContent = displayVal(col, f.v);
            if (miss.has(key)) {
              td.classList.add("missing");
              if (col.key === "timeEnd" && rec.hints.lastEndTime) {
                td.classList.add("has-hint");
                td.appendChild(el("span", "hint-last", "請輸入（上次 " + rec.hints.lastEndTime + "）"));
              }
            } else if (f.src === "manual") {
              td.classList.add(f.via === "memory" ? "src-memory" : "src-manual");
              td.title = f.via === "memory" ? "測站記憶自動帶入" : "手動輸入";
            }
            tr.appendChild(td);
          } else {
            var g = it[col.key] || { v: null, src: "parsed" };
            var td2 = el("td", "editable");
            var key2 = rec.uid + "|" + idx + "|" + col.key;
            td2.dataset.uid = rec.uid; td2.dataset.key = col.key; td2.dataset.item = String(idx);
            if (typeof g.v === "number") td2.classList.add("num");
            td2.textContent = displayVal(col, g.v);
            if (miss.has(key2)) td2.classList.add("missing");
            else if (g.src === "manual") { td2.classList.add("src-manual"); td2.title = "手動輸入"; }
            tr.appendChild(td2);
          }
        });
        tbody.appendChild(tr);
      });
    });
    table.appendChild(tbody);
    return table;
  }

  function updateStatusBar() {
    var info = $("#missing-info"), btn = $("#btn-export");
    if (!state.records.length) {
      info.textContent = ""; info.className = "";
      btn.disabled = true;
      return;
    }
    var rows = state.records.reduce(function (s, r) { return s + r.items.length; }, 0);
    if (state.missing.length) {
      info.textContent = "共 " + rows + " 列 — 尚有 " + state.missing.length +
        " 個欄位待補（紅色儲存格；點「匯出」可檢視清單並選擇以空白輸出）";
      info.className = "bad";
      btn.disabled = !state.activeProjectCode;   // 有缺漏仍可點，開啟匯出對話框
    } else if (!state.activeProjectCode) {
      info.textContent = "共 " + rows + " 列 — 請先選擇案場";
      info.className = "bad";
      btn.disabled = true;
    } else {
      info.textContent = "共 " + rows + " 列 — 欄位完整，可匯出";
      info.className = "ok";
      btn.disabled = false;
    }
  }

  /* ---------------- 儲存格編輯 ---------------- */
  document.addEventListener("click", function (e) {
    var td = e.target.closest && e.target.closest("#preview-wrap td.editable");
    if (!td || td.querySelector("input,select")) return;
    startEdit(td);
  });

  function startEdit(td) {
    var uid = td.dataset.uid, key = td.dataset.key, itemIdx = parseInt(td.dataset.item, 10);
    var rec = state.records.find(function (r) { return r.uid === uid; });
    if (!rec) return;
    var col = cfgOfRec(rec).columns.find(function (c) { return c.key === key; });
    var cur = (itemIdx < 0) ? (rec.f[key] ? rec.f[key].v : null) : (rec.items[itemIdx][key] ? rec.items[itemIdx][key].v : null);

    var editor;
    if (col.edit === "coordsys") {
      editor = el("select");
      editor.appendChild(new Option("— 請選 —", ""));
      Object.keys(DB.water.coordSystems).forEach(function (code) {
        editor.appendChild(new Option(code + "：" + DB.water.coordSystems[code], code));
      });
      if (cur !== null && cur !== undefined) editor.value = String(cur);
    } else if (col.edit === "category" || col.edit === "aircategory") {
      editor = el("select");
      editor.appendChild(new Option("— 請選 —", ""));
      var catList = (col.edit === "aircategory") ? DB.air.categories : DB.water.categories;
      catList.forEach(function (c) { editor.appendChild(new Option(c, c)); });
      if (cur) editor.value = cur;
    } else {
      editor = el("input");
      editor.type = "text";
      if (col.edit === "time") {
        editor.placeholder = "HH:MM";
        editor.value = cur || rec.hints.lastEndTime || "";
      } else if (col.edit === "date") {
        editor.placeholder = "YYYY-MM-DD";
        editor.value = cur || "";
      } else {
        editor.value = (cur === null || cur === undefined) ? "" : String(cur);
        // 官方代碼欄位掛可搜尋下拉（datalist），仍可手動輸入
        if (col.edit === "agency") editor.setAttribute("list", "agency-datalist");
        if (col.key === "unitCode") editor.setAttribute("list", "unit-datalist");
      }
    }

    td.textContent = "";
    td.appendChild(editor);
    editor.focus();
    if (editor.select) editor.select();

    var done = false;
    function commit() {
      if (done) return;
      var raw = editor.value, v;
      if (raw === "" || raw === null) v = null;
      else if (col.edit === "time") {
        v = C.helpers.normHM(raw);
        if (v === null) { toast("時間格式錯誤，請輸入 24 小時制 HH:MM，例如 08:43", true); editor.focus(); return; }
      } else if (col.edit === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) || isNaN(new Date(raw.trim()).getTime())) {
          toast("日期格式錯誤，請輸入 YYYY-MM-DD", true); editor.focus(); return;
        }
        v = raw.trim();
      } else if (col.edit === "number" || col.edit === "coordsys") {
        v = Number(raw);
        if (Number.isNaN(v)) { toast("請輸入數字", true); editor.focus(); return; }
      } else {
        v = String(raw).trim();
        if (v === "") v = null;
        else v = C.helpers.toNumber(v); // 數字字串自動轉數字（如許可證號、檢測數值）
        if (col.edit === "text" && (key === "compare" || key === "valueOut" || key === "mdl")) {
          // 保留 ND / 未檢測 等文字原樣
        }
      }
      done = true;
      applyEdit(rec, itemIdx, key, v);
    }
    function cancel() { if (!done) { done = true; renderPreview(); } }

    editor.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    editor.addEventListener("blur", commit);
    if (editor.tagName === "SELECT") editor.addEventListener("change", commit);
  }

  function applyEdit(rec, itemIdx, key, v) {
    if (itemIdx < 0) {
      rec.f[key] = { v: v, src: "manual" };
      if (key === "site" && v) {
        // 改測站名稱後，若測站記憶有這個名稱，補上還缺的座標
        var st = C.parser.findStation(state.stations, v);
        if (st) {
          ["coordSys", "x", "y"].forEach(function (k) {
            var stv = (k === "coordSys") ? st.coordSys : st[k];
            if ((!rec.f[k] || rec.f[k].v === null || rec.f[k].v === undefined) && stv != null) {
              rec.f[k] = { v: stv, src: "manual", via: "memory" };
            }
          });
          if (st.lastEndTime) rec.hints.lastEndTime = st.lastEndTime;
        }
      }
    } else {
      rec.items[itemIdx][key] = { v: v, src: "manual" };
    }
    refreshConvert();
    saveDraft();
  }

  /* ================= 匯出 / 空白範本 / 清除 ================= */
  function bindActions() {
    $("#btn-export").addEventListener("click", doExport);
    // 匯出對話框（缺漏時）
    $("#export-allow-blank").addEventListener("change", function () {
      $("#btn-export-confirm").disabled = !this.checked;
      C.storage.setSetting("exportAllowBlank", this.checked);   // 記住選擇，下次沿用
    });
    $("#btn-export-cancel").addEventListener("click", closeExportModal);
    $("#export-modal").addEventListener("click", function (e) {
      if (e.target === this) closeExportModal();
    });
    $("#btn-export-confirm").addEventListener("click", function () {
      var project = state.projects.find(function (p) { return p.code === state.activeProjectCode; });
      if (!project) { toast("請先選擇案場", true); return; }
      closeExportModal();
      performExport(project);
    });
    // 空白範本：官方五類範本選單
    $("#btn-blank").addEventListener("click", function (e) {
      e.stopPropagation();
      $("#tpl-menu").classList.toggle("hidden");
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest || !e.target.closest(".tpl-menu-wrap")) {
        $("#tpl-menu").classList.add("hidden");
      }
    });
    $("#tpl-menu").addEventListener("click", function () {
      $("#tpl-menu").classList.add("hidden");
    });
    $("#btn-clear").addEventListener("click", function () {
      if (state.records.length && !confirm("清除目前的解析結果？（已存於匯入紀錄的資料不受影響）")) return;
      state.files = []; state.records = []; state.warnings = []; state.missing = [];
      state.importId = null;
      refreshConvert();
    });
    $("#active-project").addEventListener("change", function () {
      state.activeProjectCode = this.value || null;
      C.storage.setSetting("activeProject", state.activeProjectCode);
      updateStatusBar();
    });

    // 設定/備份
    $("#btn-backup").addEventListener("click", function () {
      C.storage.backupAll().then(function (json) {
        var blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        var d = new Date(), pad = function (n) { return String(n).padStart(2, "0"); };
        a.href = URL.createObjectURL(blob);
        a.download = "yang-analyze-備份_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".json";
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    });
    $("#btn-restore").addEventListener("click", function () { $("#restore-input").click(); });
    $("#restore-input").addEventListener("change", function () {
      var f = this.files[0]; this.value = "";
      if (!f) return;
      if (!confirm("還原備份會覆蓋目前瀏覽器內的所有資料，確定？")) return;
      f.text().then(function (txt) {
        return C.storage.restoreAll(JSON.parse(txt));
      }).then(function () {
        toast("還原完成，重新載入…");
        setTimeout(function () { location.reload(); }, 800);
      }).catch(function (e) { toast("還原失敗：" + e.message, true); });
    });
    $("#btn-wipe").addEventListener("click", function () {
      if (!confirm("將清除案場、測站、匯入紀錄與對照表修改，且無法復原。確定？")) return;
      C.storage.clearAll().then(function () { location.reload(); });
    });
  }

  function doExport() {
    var project = state.projects.find(function (p) { return p.code === state.activeProjectCode; });
    if (!project) { toast("請先在「案場管理」建立並選擇案場", true); return; }
    if (!state.records.length) return;
    if (state.missing.length) { openExportModal(); return; }  // 有缺漏 → 對話框確認
    performExport(project);
  }

  /* ---- 匯出對話框：缺漏清單＋「缺漏欄位自動以空白輸出」 ---- */
  function openExportModal() {
    var list = $("#export-missing-list");
    list.innerHTML = "";
    var t = el("table", "mgmt");
    t.innerHTML = "<tr><th>測站 / 項目</th><th>缺漏欄位</th><th>備註</th></tr>";
    state.missing.forEach(function (m) {
      var rec = state.records.find(function (r) { return r.uid === m.uid; });
      var col = rec ? cfgOfRec(rec).columns.find(function (c) { return c.key === m.key; }) : null;
      var tr = el("tr");
      tr.appendChild(el("td", null, m.message));
      tr.appendChild(el("td", null, m.label));
      var td3 = el("td");
      if (col && col.official) {
        td3.appendChild(el("span", "req-badge", "申報必填，空白可能被系統退件"));
      }
      tr.appendChild(td3);
      t.appendChild(tr);
    });
    list.appendChild(t);
    C.storage.getSetting("exportAllowBlank").then(function (v) {
      var cb = $("#export-allow-blank");
      cb.checked = !!v;   // 預設不勾選；記住上次選擇
      $("#btn-export-confirm").disabled = !cb.checked;
      $("#export-modal").classList.remove("hidden");
    });
  }
  function closeExportModal() { $("#export-modal").classList.add("hidden"); }

  function performExport(project) {
    try {
      // 每個模組各出一份申報檔（分組維持出現順序）
      recordGroups().forEach(function (g, idx) {
        var cfg = cfgOf(g.mid);
        var bytes = C.exporter.buildWorkbook(cfg, g.recs, project);
        setTimeout(function () { C.exporter.download(bytes, cfg.exportFileName(project)); }, idx * 400);
      });
    } catch (e) {
      toast("匯出失敗：" + e.message, true);
      return;
    }
    // 匯出成功 → 更新測站記憶（座標、上次時間迄、別名）；缺漏(null)不覆蓋既有值
    var puts = state.records.map(function (rec) {
      var name = rec.f[cfgOfRec(rec).stationField].v;
      if (name === null || name === undefined || String(name).trim() === "") return Promise.resolve();
      var existing = state.stations.find(function (s) { return s.name === name; });
      var st = existing || { name: name, aliases: [] };
      if (rec.f.coordSys.v != null) st.coordSys = rec.f.coordSys.v;
      if (rec.f.x.v != null) st.x = rec.f.x.v;
      if (rec.f.y.v != null) st.y = rec.f.y.v;
      if (rec.f.timeEnd.v != null) st.lastEndTime = rec.f.timeEnd.v;
      st.aliases = st.aliases || [];
      if (rec.stationRaw && rec.stationRaw !== name && st.aliases.indexOf(rec.stationRaw) < 0) {
        st.aliases.push(rec.stationRaw);
      }
      return C.storage.put("stations", st);
    });
    Promise.all(puts).then(reloadStations).then(renderStationsView);
    saveDraft("exported");
    var rows = state.records.reduce(function (s, r) { return s + r.items.length; }, 0);
    var blanks = state.missing.length;
    toast("已匯出 " + rows + " 列（含監測點基本資料工作表）" +
      (blanks ? "，其中 " + blanks + " 個缺漏欄位以空白輸出" : ""));
  }

  /* ================= 匯入紀錄 ================= */
  var draftTimer = null;
  function saveDraft(status) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      if (!state.records.length) return;
      var obj = {
        ts: Date.now(),
        module: recordGroups().map(function (g) { return g.mid; }).join("+") || "water",
        projectCode: state.activeProjectCode,
        files: state.files.map(function (f) { return f.name; }),
        records: JSON.parse(JSON.stringify(state.records)),
        missingCount: state.missing.length,
        status: status === "exported" ? "exported" : "draft"
      };
      if (state.importId !== null) obj.id = state.importId;
      C.storage.put("imports", obj).then(function (id) {
        state.importId = id;
        renderHistoryView();
      });
    }, 400);
  }

  function renderHistoryView() {
    var box = $("#history-list");
    if (!box) return;
    C.storage.getAll("imports").then(function (rows) {
      box.innerHTML = "";
      if (!rows || !rows.length) {
        box.appendChild(el("div", "empty-note", "尚無匯入紀錄，到「資料轉換」上傳 raw data 即會自動建立。"));
        return;
      }
      rows.sort(function (a, b) { return b.ts - a.ts; });
      var t = el("table", "mgmt");
      t.innerHTML = "<tr><th>時間</th><th>案場</th><th>檔案</th><th>監測點</th><th>狀態</th><th></th></tr>";
      rows.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(el("td", null, new Date(r.ts).toLocaleString("zh-TW")));
        tr.appendChild(el("td", null, r.projectCode || "—"));
        tr.appendChild(el("td", null, (r.files || []).join("、")));
        tr.appendChild(el("td", "num", String((r.records || []).length)));
        var tdS = el("td");
        var badge = el("span", "hist-status " + (r.status === "exported" ? "ok" : "draft"),
          r.status === "exported" ? "已匯出" : (r.missingCount ? "缺 " + r.missingCount + " 欄" : "未匯出"));
        tdS.appendChild(badge); tr.appendChild(tdS);
        var tdOp = el("td");
        var bOpen = el("button", "btn small", "開啟");
        bOpen.addEventListener("click", function () {
          state.records = JSON.parse(JSON.stringify(r.records));
          state.files = (r.files || []).map(function (n) { return { name: n }; });
          state.warnings = [];
          state.importId = r.id;
          if (r.projectCode) {
            state.activeProjectCode = r.projectCode;
            $("#active-project").value = r.projectCode;
          }
          refreshConvert();
          showView("convert");
          toast("已載入 " + new Date(r.ts).toLocaleString("zh-TW") + " 的紀錄");
        });
        var bDel = el("button", "btn small danger", "刪除");
        bDel.addEventListener("click", function () {
          if (!confirm("刪除這筆匯入紀錄？")) return;
          C.storage.del("imports", r.id).then(renderHistoryView);
          if (state.importId === r.id) state.importId = null;
        });
        tdOp.appendChild(bOpen); tdOp.appendChild(document.createTextNode(" ")); tdOp.appendChild(bDel);
        tr.appendChild(tdOp);
        t.appendChild(tr);
      });
      box.appendChild(t);
    });
  }

  /* ================= 測站管理 ================= */
  function renderStationsView() {
    var t = $("#station-table");
    if (!t) return;
    t.innerHTML = "<tr><th>測站名稱（申報用）</th><th>座標系統</th><th>X</th><th>Y</th><th>上次時間(迄)</th><th>別名（raw data 名稱，逗號分隔）</th><th></th></tr>";
    state.stations.forEach(function (st) { t.appendChild(stationRow(st)); });
  }
  function stationRow(st) {
    var tr = el("tr");
    tr.dataset.original = st.name || "";
    function tdInput(val, cls) {
      var td = el("td"), inp = el("input");
      if (cls) inp.className = cls;
      inp.value = (val === null || val === undefined) ? "" : String(val);
      td.appendChild(inp); tr.appendChild(td);
      return inp;
    }
    var iName = tdInput(st.name);
    var tdSys = el("td"), sel = el("select");
    sel.appendChild(new Option("—", ""));
    Object.keys(DB.water.coordSystems).forEach(function (code) {
      sel.appendChild(new Option(code + "：" + DB.water.coordSystems[code], code));
    });
    if (st.coordSys != null) sel.value = String(st.coordSys);
    tdSys.appendChild(sel); tr.appendChild(tdSys);
    var iX = tdInput(st.x, "narrow"), iY = tdInput(st.y, "narrow"), iT = tdInput(st.lastEndTime, "narrow");
    var iA = tdInput((st.aliases || []).join("，"));
    var tdOp = el("td");
    var bSave = el("button", "btn small primary", "儲存");
    bSave.addEventListener("click", function () {
      var name = iName.value.trim();
      if (!name) { toast("測站名稱不可空白", true); return; }
      var lastT = iT.value.trim() ? C.helpers.normHM(iT.value) : null;
      if (iT.value.trim() && lastT === null) { toast("上次時間(迄)格式錯誤，請用 HH:MM", true); return; }
      var obj = {
        name: name,
        coordSys: sel.value ? Number(sel.value) : null,
        x: iX.value.trim() ? Number(iX.value) : null,
        y: iY.value.trim() ? Number(iY.value) : null,
        lastEndTime: lastT,
        aliases: iA.value.split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean)
      };
      if ((iX.value.trim() && Number.isNaN(obj.x)) || (iY.value.trim() && Number.isNaN(obj.y))) {
        toast("座標必須是數字", true); return;
      }
      var original = tr.dataset.original;
      var chain = (original && original !== name) ? C.storage.del("stations", original) : Promise.resolve();
      chain.then(function () { return C.storage.put("stations", obj); })
        .then(reloadStations).then(renderStationsView)
        .then(function () { toast("已儲存測站「" + name + "」"); });
    });
    var bDel = el("button", "btn small danger", "刪除");
    bDel.addEventListener("click", function () {
      var original = tr.dataset.original;
      if (!original) { tr.remove(); return; }
      if (!confirm("刪除測站「" + original + "」？")) return;
      C.storage.del("stations", original).then(reloadStations).then(renderStationsView);
    });
    tdOp.appendChild(bSave); tdOp.appendChild(document.createTextNode(" ")); tdOp.appendChild(bDel);
    tr.appendChild(tdOp);
    return tr;
  }
  document.addEventListener("DOMContentLoaded", function () {
    $("#btn-add-station").addEventListener("click", function () {
      $("#station-table").appendChild(stationRow({ name: "", aliases: [] }));
    });
  });

  /* ================= 案場管理 ================= */
  var editingProjectCode = null;
  function renderProjectsView() {
    var t = $("#project-table");
    if (!t) return;
    t.innerHTML = "<tr><th>計畫代碼</th><th>書件名稱</th><th>執行現況</th><th>使用中</th><th></th></tr>";
    state.projects.forEach(function (p) {
      var tr = el("tr");
      tr.appendChild(el("td", null, p.code));
      tr.appendChild(el("td", null, p.docName || ""));
      tr.appendChild(el("td", null, p.status || ""));
      tr.appendChild(el("td", null, p.code === state.activeProjectCode ? "✓" : ""));
      var tdOp = el("td");
      var bUse = el("button", "btn small", "設為使用中");
      bUse.addEventListener("click", function () {
        state.activeProjectCode = p.code;
        C.storage.setSetting("activeProject", p.code);
        renderProjectSelect(); renderProjectsView(); updateStatusBar();
      });
      var bEdit = el("button", "btn small", "編輯");
      bEdit.addEventListener("click", function () { openProjectForm(p); });
      var bDel = el("button", "btn small danger", "刪除");
      bDel.addEventListener("click", function () {
        if (!confirm("刪除案場「" + p.code + "」？")) return;
        C.storage.del("projects", p.code).then(reloadProjects).then(function () {
          if (state.activeProjectCode === p.code) {
            state.activeProjectCode = null;
            C.storage.setSetting("activeProject", null);
          }
          renderProjectSelect(); renderProjectsView(); updateStatusBar();
        });
      });
      [bUse, bEdit, bDel].forEach(function (b) {
        tdOp.appendChild(b); tdOp.appendChild(document.createTextNode(" "));
      });
      tr.appendChild(tdOp);
      t.appendChild(tr);
    });
  }
  function openProjectForm(p) {
    editingProjectCode = p ? p.code : null;
    $("#project-form-panel").hidden = false;
    $("#project-form-title").textContent = p ? "編輯案場：" + p.code : "新增案場";
    $("#pf-code").value = p ? p.code : "";
    $("#pf-docNo").value = p && p.docNo ? p.docNo : "";
    $("#pf-docName").value = p && p.docName ? p.docName : "";
    $("#pf-status").value = p && p.status ? p.status : "施工中";
    ["constructionDate", "completionDate", "operationDate"].forEach(function (k) {
      $("#pf-" + k).value = p && p[k] ? p[k] : "";
    });
    $("#pf-note").value = p && p.note ? p.note : "";
    $("#pf-basicRows").value = (p && Array.isArray(p.basicRows) && p.basicRows.length)
      ? JSON.stringify(p.basicRows) : "";
  }
  document.addEventListener("DOMContentLoaded", function () {
    $("#btn-add-project").addEventListener("click", function () { openProjectForm(null); });
    $("#btn-project-cancel").addEventListener("click", function () { $("#project-form-panel").hidden = true; });
    $("#btn-project-save").addEventListener("click", function () {
      var code = $("#pf-code").value.trim();
      if (!code) { toast("計畫代碼必填", true); return; }
      function dateOrNull(id) {
        var v = $(id).value.trim();
        if (!v) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { throw new Error($(id).previousElementSibling.textContent + " 格式須為 YYYY-MM-DD"); }
        return v;
      }
      var obj;
      try {
        obj = {
          code: code,
          docNo: $("#pf-docNo").value.trim() || null,
          docName: $("#pf-docName").value.trim() || null,
          status: $("#pf-status").value,
          constructionDate: dateOrNull("#pf-constructionDate"),
          completionDate: dateOrNull("#pf-completionDate"),
          operationDate: dateOrNull("#pf-operationDate"),
          note: $("#pf-note").value.trim() || null,
          basicRows: null
        };
        var rowsTxt = $("#pf-basicRows").value.trim();
        if (rowsTxt) {
          var parsedRows = JSON.parse(rowsTxt);
          if (!Array.isArray(parsedRows) || parsedRows.some(function (r) { return !Array.isArray(r) || r.length !== 8; })) {
            throw new Error("多列基本資料須為 JSON 陣列，每列 8 個值");
          }
          obj.basicRows = parsedRows;
        }
      } catch (e) { toast(e.message.indexOf("JSON") >= 0 ? "多列基本資料 JSON 格式錯誤" : e.message, true); return; }
      var chain = (editingProjectCode && editingProjectCode !== code)
        ? C.storage.del("projects", editingProjectCode) : Promise.resolve();
      chain.then(function () { return C.storage.put("projects", obj); })
        .then(reloadProjects)
        .then(function () {
          if (!state.activeProjectCode) {
            state.activeProjectCode = code;
            C.storage.setSetting("activeProject", code);
          }
          $("#project-form-panel").hidden = true;
          renderProjectSelect(); renderProjectsView(); updateStatusBar();
          toast("已儲存案場 " + code);
        });
    });
  });
  function renderProjectSelect() {
    var sel = $("#active-project");
    sel.innerHTML = "";
    sel.appendChild(new Option("— 請選擇 —", ""));
    state.projects.forEach(function (p) {
      sel.appendChild(new Option(p.code + "　" + (p.docName || ""), p.code));
    });
    sel.value = state.activeProjectCode || "";
  }

  /* ================= 對照表編輯 ================= */
  var TABLE_META = {
    "water.unitCodes": { label: "單位 → 代碼", kh: "單位文字（空白=無單位）", vh: "環境部代碼", numeric: true, list: "unit-datalist" },
    "water.sampleTypeMap": { label: "樣品特性 → 檢測類別", kh: "報告樣品特性", vh: "申報檢測類別", numeric: false },
    "water.itemNameMap": { label: "測項名稱對照", kh: "報告項目名稱", vh: "申報項目名稱", numeric: false },
    "water.methodOverrides": { label: "檢測方法覆寫", kh: "項目名稱", vh: "強制填寫的方法", numeric: false },
    "air.unitMap": { label: "測項 → 單位代碼", kh: "監測項目", vh: "環境部單位代碼", numeric: true, list: "unit-datalist" },
    "air.methodMap": { label: "測項 → 檢測方法", kh: "監測項目", vh: "申報檢測方法", numeric: false }
  };
  function allTableTabs() {
    var out = [];
    MODULE_IDS.forEach(function (mid) {
      cfgOf(mid).tableNames.forEach(function (name) {
        out.push({ mid: mid, name: name, key: mid + "." + name });
      });
    });
    return out;
  }
  function renderTablesView() {
    var tabs = $("#table-tabs");
    if (!tabs) return;
    var all = allTableTabs();
    if (!state.editingTable || !TABLE_META[state.editingTable]) state.editingTable = all[0].key;
    tabs.innerHTML = "";
    all.forEach(function (t) {
      var b = el("button", "tab" + (t.key === state.editingTable ? " active" : ""),
        cfgOf(t.mid).label + "｜" + TABLE_META[t.key].label);
      b.addEventListener("click", function () { state.editingTable = t.key; renderTablesView(); });
      tabs.appendChild(b);
    });
    var cur = all.find(function (t) { return t.key === state.editingTable; });
    renderTableEditor(cur.mid, cur.name);
    MODULE_IDS.forEach(renderTableUpdateBanner);
  }

  /* ---- 內建預設更新提示（逐模組）：合併 或 維持現狀（絕不靜默覆蓋） ---- */
  function renderTableUpdateBanner(mid) {
    var bannerId = "table-update-banner-" + mid;
    var old = document.getElementById(bannerId);
    if (old) old.remove();
    var names = outdatedTableNames(mid);
    if (!names.length) return;
    C.storage.getSetting("tablesVerDismissed." + mid).then(function (dismissed) {
      if ((dismissed || 0) >= DB[mid].tablesVersion) return;
      if (document.getElementById(bannerId)) return;
      var banner = el("div", "update-banner");
      banner.id = bannerId;
      banner.appendChild(el("strong", null,
        cfgOf(mid).label + "：內建預設對照表已更新（v" + DB[mid].tablesVersion + "）"));
      banner.appendChild(el("div", "update-banner-desc",
        "受影響：" + names.map(function (n) { return TABLE_META[mid + "." + n].label; }).join("、") +
        "。「合併」＝保留你自訂與修改過的列，只帶入新增的預設列；「維持現狀」＝完全不動你的表。"));
      var actions = el("div", "form-actions left");
      var bMerge = el("button", "btn primary", "合併");
      bMerge.addEventListener("click", function () {
        Promise.all(names.map(function (name) {
          var row = state.storedTables[mid + "." + name];
          var defaults = DB[mid][name];
          var base = row.base || {};
          var data = JSON.parse(JSON.stringify(row.data));
          var added = [];
          Object.keys(defaults).forEach(function (k) {
            if (!(k in base) && !(k in data)) { data[k] = defaults[k]; added.push(k); }
          });
          return C.storage.put("tables", {
            name: mid + "." + name, data: data,
            base: JSON.parse(JSON.stringify(defaults)),
            baseVersion: DB[mid].tablesVersion
          }).then(function () { return added.length; });
        })).then(function (counts) {
          var total = counts.reduce(function (s, n) { return s + n; }, 0);
          return loadTables().then(function () {
            renderTablesView();
            toast("合併完成，帶入 " + total + " 筆新增預設列（你的自訂列全數保留）");
          });
        });
      });
      var bKeep = el("button", "btn", "維持現狀");
      bKeep.addEventListener("click", function () {
        C.storage.setSetting("tablesVerDismissed." + mid, DB[mid].tablesVersion).then(function () {
          banner.remove();
          toast("已維持現狀（此版本不再提醒）");
        });
      });
      actions.appendChild(bMerge); actions.appendChild(bKeep);
      banner.appendChild(actions);
      var editor = $("#table-editor");
      editor.parentNode.insertBefore(banner, $("#table-tabs"));
    });
  }
  function renderTableEditor(mid, name) {
    var key = mid + "." + name;
    var meta = TABLE_META[key], box = $("#table-editor");
    box.innerHTML = "";
    var note = el("p", "kv-note");
    if (key === "water.unitCodes") {
      note.textContent = "此表只列 raw data 會出現的單位；完整官方代碼表請見";
      var link = el("a", "inline-link", "規範查閱");
      link.href = "#";
      link.addEventListener("click", function (e) { e.preventDefault(); showView("rules"); });
      note.appendChild(link);
      note.appendChild(document.createTextNode("。代碼欄可直接輸入，或從下拉（代碼－單位名稱）挑選。"));
    } else if (key === "water.methodOverrides") {
      note.textContent = "在此表中的項目，匯出時一律填指定方法（目前依歷次申報慣例：溶氧→NIEA W422）。刪除該列即改為照 raw data 去版次輸出。";
    } else if (key === "air.methodMap") {
      note.textContent = "空氣各測項申報時填的檢測方法（氣象項目照舊填儀器名）。注意：鉛的方法預設依檢驗報告備註（NIEA A306），歷史申報檔曾出現 A301/A103，未確認前請留意。";
    } else if (key === "air.unitMap") {
      note.textContent = "空氣各測項的環境部單位代碼（113=ppm、140=μg/m3、161=無、28=m/sec、4=℃、1=%）。代碼欄可從下拉挑選。";
    } else {
      note.textContent = "解析時查不到的值會列入警告並要求手動補填。";
    }
    box.appendChild(note);
    var t = el("table", "mgmt");
    t.innerHTML = "<tr><th>" + escHtml(meta.kh) + "</th><th>" + escHtml(meta.vh) + "</th><th></th></tr>";
    var data = state.tables[mid][name];
    var listId = meta.list || null;
    Object.keys(data).forEach(function (k) { t.appendChild(kvRow(t, k, data[k], listId)); });
    box.appendChild(t);
    var actions = el("div", "form-actions");
    var bAdd = el("button", "btn", "＋ 新增一列");
    bAdd.addEventListener("click", function () { t.appendChild(kvRow(t, "", "", listId)); });
    var bReset = el("button", "btn danger", "還原預設");
    bReset.addEventListener("click", function () {
      if (!confirm("將「" + meta.label + "」還原為出廠預設？")) return;
      C.storage.del("tables", key).then(loadTables).then(function () {
        renderTablesView(); toast("已還原預設");
      });
    });
    var bSave = el("button", "btn primary", "儲存此表");
    bSave.addEventListener("click", function () {
      var obj = {};
      var bad = false;
      $$("#table-editor table tr").slice(1).forEach(function (tr) {
        var inps = tr.querySelectorAll("input");
        if (!inps.length) return;
        var k = inps[0].value.trim(), v = inps[1].value.trim();
        if (!k && !v) return;
        if (meta.numeric) {
          var n = Number(v);
          if (v === "" || Number.isNaN(n)) { bad = true; return; }
          obj[k] = n;
        } else {
          if (!v) { bad = true; return; }
          obj[k] = v;
        }
      });
      if (bad) { toast("有列的值空白或格式錯誤", true); return; }
      C.storage.put("tables", {
        name: key, data: obj,
        base: JSON.parse(JSON.stringify(DB[mid][name])),   // 記住存檔當下的內建預設，供日後合併判斷
        baseVersion: DB[mid].tablesVersion
      })
        .then(loadTables)
        .then(function () { renderTablesView(); toast("已儲存（下次解析生效）"); });
    });
    [bAdd, bReset, bSave].forEach(function (b) { actions.appendChild(b); });
    box.appendChild(actions);
  }
  function kvRow(t, k, v, valueListId) {
    var tr = el("tr");
    var td1 = el("td"), i1 = el("input"); i1.value = k; td1.appendChild(i1);
    var td2 = el("td"), i2 = el("input"); i2.value = String(v); td2.appendChild(i2);
    if (valueListId) i2.setAttribute("list", valueListId);
    var td3 = el("td"), bDel = el("button", "btn small danger", "刪除列");
    bDel.addEventListener("click", function () { tr.remove(); });
    td3.appendChild(bDel);
    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    return tr;
  }

  /* ================= 規範查閱：官方代碼表 ================= */
  var rulesRendered = false;
  function renderRulesView() {
    if (rulesRendered) return;
    rulesRendered = true;
    fillCodeTable("#unit-code-table", "#unit-filter", DB.unitCodeTable);
    fillCodeTable("#agency-code-table", "#agency-filter", DB.agencyCodeTable);
  }
  function fillCodeTable(tableSel, filterSel, data) {
    var tbody = $(tableSel + " tbody");
    if (!tbody) return;
    Object.keys(data).forEach(function (code) {
      var tr = el("tr");
      tr.appendChild(el("td", "num", code));
      tr.appendChild(el("td", null, data[code]));
      tr.dataset.text = (code + " " + data[code]).toLowerCase();
      tbody.appendChild(tr);
    });
    $(filterSel).addEventListener("input", function () {
      var q = this.value.trim().toLowerCase();
      Array.prototype.forEach.call(tbody.children, function (tr) {
        tr.classList.toggle("hidden", q !== "" && tr.dataset.text.indexOf(q) < 0);
      });
    });
  }

  /* ================= 對外（測試/除錯用） ================= */
  window.YangApp = {
    state: state,
    handleFiles: handleFiles,
    refresh: refreshConvert
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
