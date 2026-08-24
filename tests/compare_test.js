/* =========================================================================
 * Yang-analyze web — 黃金樣本測試框架（通用）
 *
 * 1) 單元測試：解析工具函式（不需任何測試資料）
 * 2) 黃金樣本：讀 ../test_data/manifest.json 列出的每一個 case：
 *      raw data 解析 → 套用 setup.json（測站記憶、手動「時間(迄)」、案場）
 *      → 匯出 → 與成品檔逐格比對
 *
 * 真實監測數據（raw/成品/setup）一律放 test_data/（已被 .gitignore 排除）；
 * 本框架內不得寫死任何真實案件資料。
 * ========================================================================= */
(function () {
  "use strict";
  var C = window.YangCore, CONFIGS = window.YangConfigs;
  var report = document.getElementById("report");
  var banner = document.getElementById("banner");

  /* ---------------- 報表工具 ---------------- */
  function h2(t) { var e = document.createElement("h2"); e.textContent = t; report.appendChild(e); }
  function table(headers) {
    var t = document.createElement("table"); t.className = "rpt";
    var tr = document.createElement("tr");
    headers.forEach(function (h) { var th = document.createElement("th"); th.textContent = h; tr.appendChild(th); });
    t.appendChild(tr); report.appendChild(t);
    return t;
  }
  function row(t, cells) {
    var tr = document.createElement("tr");
    cells.forEach(function (c, i) {
      var td = document.createElement("td");
      if (i === cells.length - 1 && (c === "PASS" || c === "FAIL")) td.className = c === "PASS" ? "ok" : "ng";
      td.textContent = c;
      tr.appendChild(td);
    });
    t.appendChild(tr);
  }

  /* ---------------- 單元測試（通用） ---------------- */
  function runUnitTests() {
    var H = C.helpers;
    var cases = [
      ["民國年轉西元 rocToISO(115,'02','05')", H.rocToISO(115, "02", "05"), "2026-02-05"],
      ["時分組合 toHM(10,43)", H.toHM(10, 43), "10:43"],
      ["時分補零 toHM('08',30)", H.toHM("08", 30), "08:30"],
      ["科學記號還原 parseSciText('6.0×104')", H.parseSciText("6.0×104"), 60000],
      ["parseSciText('3.8×105')", H.parseSciText("3.8×105"), 380000],
      ["parseSciText('6.5×102')", H.parseSciText("6.5×102"), 650],
      ["一般數字不套用 parseSciText('25.4')", H.parseSciText("25.4"), null],
      ["toNumber('25.4')", H.toNumber("25.4"), 25.4],
      ["toNumber('ND') 保留原字串", H.toNumber("ND"), "ND"],
      ["時間輸入正規化 normHM('8:43')", H.normHM("8:43"), "08:43"],
      ["無效時間 normHM('24:00')", H.normHM("24:00"), null]
    ];
    h2("單元測試");
    var t = table(["項目", "實際值", "預期值", "結果"]);
    var fails = 0;
    cases.forEach(function (c) {
      var ok = (c[1] === c[2]);
      if (!ok) fails++;
      row(t, [c[0], String(c[1]), String(c[2]), ok ? "PASS" : "FAIL"]);
    });
    return fails;
  }

  /* ---------------- 載入工具 ---------------- */
  function fetchBuf(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(path + " HTTP " + r.status);
      return r.arrayBuffer();
    });
  }
  function fetchJson(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(path + " HTTP " + r.status);
      return r.json();
    });
  }
  function fakeFile(name, buf) {
    return { name: name, arrayBuffer: function () { return Promise.resolve(buf); } };
  }

  /* ---------------- 逐格比對 ---------------- */
  function normFmt(z) { return z === undefined ? "General" : String(z).replace(/;@$/, ""); }
  /* 規格有定義顯示格式的欄位（模組設定檔 fmt 欄）：目前各模組皆為
     檢測項目表 A~E（mm-dd-yy / h:mm）、基本資料表 E~G（mm-dd-yy）。
     成品檔上零星的殘留格式（字串儲存格不受數字格式影響）不列入比對。 */
  var FMT_COLS_BASIC = [4, 5, 6], FMT_COLS_ITEM = [0, 1, 2, 3, 4];
  function compareSheets(wsExp, wsGot, sheetName, isBasic, diffs, stats) {
    var fmtCols = isBasic ? FMT_COLS_BASIC : FMT_COLS_ITEM;
    var refExp = wsExp["!ref"] || "A1:A1", refGot = wsGot["!ref"] || "A1:A1";
    var rngE = XLSX.utils.decode_range(refExp), rngG = XLSX.utils.decode_range(refGot);
    if (rngE.e.r !== rngG.e.r || rngE.e.c !== rngG.e.c) diffs.push([sheetName, "(範圍)", refExp, refGot]);
    var maxR = Math.max(rngE.e.r, rngG.e.r), maxC = Math.max(rngE.e.c, rngG.e.c);
    for (var r = 0; r <= maxR; r++) {
      for (var c = 0; c <= maxC; c++) {
        var addr = XLSX.utils.encode_cell({ r: r, c: c });
        var ce = wsExp[addr], cg = wsGot[addr];
        var ve = ce ? ce.v : undefined, vg = cg ? cg.v : undefined;
        stats.compared++;
        var same;
        if (ve === undefined && vg === undefined) same = true;
        else if (typeof ve === "number" && typeof vg === "number") same = Math.abs(ve - vg) < 1e-9;
        else same = (ve === vg);
        if (!same) diffs.push([sheetName, addr, String(ve), String(vg)]);
        else if (ve !== undefined) stats.valued++;
        if (fmtCols.indexOf(c) >= 0 && ce && cg && ce.t === "n" && cg.t === "n") {
          var ze = normFmt(ce.z), zg = normFmt(cg.z);
          if (ze !== zg) stats.fmtDiffs.push([sheetName, addr, String(ce.z), String(cg.z)]);
        }
      }
    }
  }

  /* ---------------- 單一黃金樣本 ---------------- */
  function runCase(kase, bufs, setup, expectedBuf) {
    var config = CONFIGS[kase.module];
    if (!config) return Promise.reject(new Error("未知模組: " + kase.module));

    var models = [];
    var chain = Promise.resolve();
    kase.files.forEach(function (fn, i) {
      chain = chain.then(function () {
        return C.reader.readFile(fakeFile(fn, bufs[i])).then(function (m) { models.push(m); });
      });
    });
    return chain.then(function () {
      var ctx = { stations: setup.stations || [], tables: window.YangDB[kase.module] };
      var res = C.parser.parseFiles(models, config, ctx);

      h2("樣本「" + (kase.label || kase.id) + "」解析結果");
      var t1 = table(["檔案", "工作表", "測站（申報名）", "類別", "日期時間", "項目數"]);
      res.records.forEach(function (rec) {
        row(t1, [rec.fileName, rec.sheetName, rec.f[config.stationField].v, rec.f.category.v,
          rec.f.dateStart.v + " " + rec.f.timeStart.v, String(rec.items.length)]);
      });

      // 套用 setup 的手動欄位（模擬使用者在預覽表補「時間(迄)」）
      res.records.forEach(function (rec) {
        var et = (setup.endTimes || {})[rec.f[config.stationField].v];
        if (et) rec.f.timeEnd = { v: et, src: "manual" };
      });

      var missing = C.validator.validate(res.records, config);
      var rowsCount = res.records.reduce(function (s, r) { return s + r.items.length; }, 0);
      var t2 = table(["檢查", "結果", "判定"]);
      row(t2, ["監測點數（預期 " + setup.expectRecords + "）", String(res.records.length),
        res.records.length === setup.expectRecords ? "PASS" : "FAIL"]);
      row(t2, ["資料列數（預期 " + setup.expectRows + "）", String(rowsCount),
        rowsCount === setup.expectRows ? "PASS" : "FAIL"]);
      row(t2, ["補值後缺漏欄位數（預期 0）", String(missing.length), missing.length === 0 ? "PASS" : "FAIL"]);
      var setupFails = (res.records.length === setup.expectRecords ? 0 : 1) +
        (rowsCount === setup.expectRows ? 0 : 1) + (missing.length === 0 ? 0 : 1);

      var bytes = C.exporter.buildWorkbook(config, res.records, setup.project);
      var wbGot = XLSX.read(bytes, { type: "array", cellDates: false, cellNF: true });
      var wbExp = XLSX.read(expectedBuf, { type: "array", cellDates: false, cellNF: true });

      var diffs = [], stats = { compared: 0, valued: 0, fmtDiffs: [] };
      var sheetsOk = JSON.stringify(wbExp.SheetNames) === JSON.stringify(wbGot.SheetNames);
      wbExp.SheetNames.forEach(function (sn, i) {
        if (wbGot.Sheets[sn]) compareSheets(wbExp.Sheets[sn], wbGot.Sheets[sn], sn, i === 0, diffs, stats);
      });

      var t3 = table(["逐格比對", "結果", "判定"]);
      row(t3, ["工作表名稱", wbGot.SheetNames.join("、"), sheetsOk ? "PASS" : "FAIL"]);
      row(t3, ["比對儲存格總數", String(stats.compared), ""]);
      row(t3, ["其中有值且一致", String(stats.valued), ""]);
      row(t3, ["值不一致數（預期 0）", String(diffs.length), diffs.length === 0 ? "PASS" : "FAIL"]);
      row(t3, ["日期/時間欄顯示格式差異（規格定義欄位）", String(stats.fmtDiffs.length),
        stats.fmtDiffs.length === 0 ? "PASS" : "FAIL"]);

      if (diffs.length) {
        h2("差異明細（最多 60 筆）");
        var t4 = table(["工作表", "儲存格", "預期（成品）", "實際（匯出）"]);
        diffs.slice(0, 60).forEach(function (d) { row(t4, d); });
      }
      if (stats.fmtDiffs.length) {
        h2("格式差異明細");
        var t5 = table(["工作表", "儲存格", "預期格式", "實際格式"]);
        stats.fmtDiffs.slice(0, 30).forEach(function (d) { row(t5, d); });
      }

      var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "測試匯出_" + kase.id + ".xlsx";
      a.textContent = "下載「" + (kase.label || kase.id) + "」匯出結果（人工核對用）";
      report.appendChild(a);

      return setupFails + diffs.length + (sheetsOk ? 0 : 1) + stats.fmtDiffs.length;
    });
  }

  /* ---------------- 主流程 ---------------- */
  function runAll(caseRuns) {
    report.innerHTML = "";
    var totalFails = runUnitTests();
    var chain = Promise.resolve();
    caseRuns.forEach(function (cr) {
      chain = chain.then(function () {
        return runCase(cr.kase, cr.bufs, cr.setup, cr.expectedBuf).then(function (f) { totalFails += f; });
      });
    });
    return chain.then(function () {
      banner.className = totalFails === 0 ? "pass" : "fail";
      banner.textContent = totalFails === 0
        ? "✅ 全部黃金樣本通過 — 匯出內容與成品逐格一致（共 " + caseRuns.length + " 個樣本）"
        : "❌ 未通過 — 共 " + totalFails + " 項差異，明細見下方";
      window.__TEST_RESULT__ = { pass: totalFails === 0, fails: totalFails, cases: caseRuns.length };
    }).catch(function (e) {
      banner.className = "fail";
      banner.textContent = "❌ 測試執行錯誤：" + e.message;
      window.__TEST_RESULT__ = { pass: false, error: e.message };
      throw e;
    });
  }

  /* 自動載入 ../test_data/（本機開發用；線上部署不含測試資料，改用手動選檔） */
  fetchJson("../test_data/manifest.json").then(function (manifest) {
    var chain = Promise.resolve();
    var caseRuns = [];
    manifest.cases.forEach(function (kase) {
      chain = chain.then(function () {
        var base = "../test_data/" + kase.dir + "/";
        return Promise.all([
          Promise.all(kase.files.map(function (f) { return fetchBuf(base + f); })),
          fetchJson(base + kase.setup),
          fetchBuf(base + kase.expected)
        ]).then(function (r) {
          caseRuns.push({ kase: kase, bufs: r[0], setup: r[1], expectedBuf: r[2] });
        });
      });
    });
    return chain.then(function () { return runAll(caseRuns); });
  }).catch(function (e) {
    banner.className = "fail";
    banner.textContent = "找不到 test_data/（" + e.message + "）— 測試資料不隨網站公開；請在本機以 serve.bat 執行，或於下方手動選檔";
    document.getElementById("manual").hidden = false;
  });

  /* 手動選檔（單一水質樣本）：兩個 raw、成品、setup.json */
  document.getElementById("btn-run-manual").addEventListener("click", function () {
    var fs = ["pick-raw1", "pick-raw2", "pick-expected", "pick-setup"].map(function (id) {
      return document.getElementById(id).files[0];
    });
    if (fs.some(function (f) { return !f; })) { alert("四個檔案都要選（含 setup.json）"); return; }
    Promise.all([fs[0].arrayBuffer(), fs[1].arrayBuffer(), fs[2].arrayBuffer(), fs[3].text()]).then(function (r) {
      banner.className = "running"; banner.textContent = "測試執行中…";
      var setup = JSON.parse(r[3]);
      var kase = { id: "manual", label: "手動選檔", module: "water",
        files: [fs[0].name, fs[1].name], expected: fs[2].name };
      return runAll([{ kase: kase, bufs: [r[0], r[1]], setup: setup, expectedBuf: r[2] }]);
    });
  });
})();
