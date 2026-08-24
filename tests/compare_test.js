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
  function compareSheets(wsExp, wsGot, sheetName, isBasic, diffs, stats, checkFormats) {
    var fmtCols = (checkFormats === false) ? [] : (isBasic ? FMT_COLS_BASIC : FMT_COLS_ITEM);
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

  /* ----------------------------------------------------------------------
   * byStation 比對模式（setup.compare === "byStation"）：
   * 適用「預期檔為手工維護、列順序不定」的情況（如空氣舊檔）。
   * 逐測站×逐測項對齊比對；setup.knownDeviations 白名單記錄預期檔的既知
   * 手工不一致（列為「既知偏差」，不計失敗；白名單外的差異一律 FAIL）。
   * ---------------------------------------------------------------------- */
  function colLetter(i) { return String.fromCharCode(65 + i); } // 0→A（此範圍夠用）
  function rowsBySite(ws, siteCol, itemCol) {
    var rng = XLSX.utils.decode_range(ws["!ref"]);
    var map = {};
    for (var r = 1; r <= rng.e.r; r++) {
      var cells = [];
      for (var c = 0; c <= rng.e.c; c++) {
        var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
        var v = cell ? cell.v : undefined;
        if (typeof v === "string" && v.trim() === "") v = undefined; // ''≡空白
        cells.push(v);
      }
      var site = cells[siteCol];
      if (site === undefined) continue;
      (map[site] = map[site] || []).push({ item: cells[itemCol], cells: cells });
    }
    return map;
  }
  function compareByStation(wsExp, wsGot, setup, diffs, devs, stats) {
    var dv = setup.knownDeviations || {};
    var SITE = 4, ITEM = 14, R = 17, S = 18;
    var expMap = rowsBySite(wsExp, SITE, ITEM);
    var gotMap = rowsBySite(wsGot, SITE, ITEM);

    // 預期檔獨有的測站（raw data 無對應工作表）
    Object.keys(expMap).forEach(function (site) {
      if (gotMap[site]) return;
      if ((dv.ignoreExpectedSites || []).indexOf(site) >= 0) {
        devs.push(["測站「" + site + "」", "-", "預期檔獨有（raw data 無對應工作表），不比對",
          expMap[site].length + " 列"]);
      } else {
        diffs.push(["(byStation)", site, "預期檔有此測站，匯出沒有", "-"]);
      }
    });

    Object.keys(gotMap).forEach(function (site) {
      var expRows = expMap[site];
      if (!expRows) { diffs.push(["(byStation)", site, "-", "匯出有此測站，預期檔沒有"]); return; }
      var legacy = (dv.legacyLtSites || []).indexOf(site) >= 0;
      gotMap[site].forEach(function (gRow) {
        var eRow = expRows.find(function (x) { return x.item === gRow.item; });
        if (!eRow) { diffs.push([site, String(gRow.item), "預期檔無此測項列", "-"]); return; }
        var e = eRow.cells.slice(), g = gRow.cells;
        // 既知偏差 1：舊式「< 值」寫在數值欄（比較關係留空）→ 正規化後比對
        if (legacy && typeof e[S] === "string" && /^<\s*/.test(e[S]) && e[R] === undefined) {
          var num = Number(e[S].replace(/^<\s*/, ""));
          if (!Number.isNaN(num)) {
            e[R] = "<"; e[S] = num;
            devs.push([site, String(gRow.item), "舊式「< 值」寫法（正規化後比對）", String(eRow.cells[S])]);
          }
        }
        for (var c = 0; c < g.length || c < e.length; c++) {
          var ve = e[c], vg = g[c];
          stats.compared++;
          var same;
          if (ve === undefined && vg === undefined) same = true;
          else if (typeof ve === "number" && typeof vg === "number") same = Math.abs(ve - vg) < 1e-9;
          else same = (ve === vg);
          if (same) { if (ve !== undefined) stats.valued++; continue; }
          var L = colLetter(c);
          // 既知偏差 2：預期檔漏填——整站整欄（missingCols）或特定測項儲存格（missingCells）
          var missByCol = dv.missingCols && (dv.missingCols[site] || []).indexOf(L) >= 0;
          var missByCell = dv.missingCells && dv.missingCells[site] &&
            (dv.missingCells[site][gRow.item] || []).indexOf(L) >= 0;
          if (ve === undefined && vg !== undefined && (missByCol || missByCell)) {
            devs.push([site, String(gRow.item), "預期檔 " + L + " 欄漏填（匯出補齊為 " + vg + "）", "-"]);
            continue;
          }
          // 既知偏差 3：檢測方法歷史寫法不一（待使用者裁定）
          if (c === 20 && dv.methodVariants && dv.methodVariants[gRow.item] &&
              dv.methodVariants[gRow.item].indexOf(String(ve)) >= 0 &&
              dv.methodVariants[gRow.item].indexOf(String(vg)) >= 0) {
            devs.push([site, String(gRow.item), "方法寫法不一：預期=" + ve + "／匯出=" + vg, "待確認"]);
            continue;
          }
          diffs.push([site + " / " + gRow.item, L, String(ve), String(vg)]);
        }
      });
      if (expRows.length !== gotMap[site].length) {
        diffs.push([site, "(列數)", String(expRows.length), String(gotMap[site].length)]);
      }
    });
  }

  /* ----------------------------------------------------------------------
   * byBlock 比對模式（setup.compare === "byBlock"）：
   * 區塊鍵（setup.blockKeyCols，如 站×日期）先分組，區塊內再以列鍵
   * （setup.rowKeyCols，如 特性×時段）對齊逐欄比對。
   * 適用一站多日、預期檔列順序不定的情況（如噪音）。
   * 預期檔獨有的區塊 → 既知偏差（他月檔案的資料）；
   * 匯出獨有的區塊 → 站名在 knownDeviations.ignoreOutputBlockSites 才算偏差
   * （raw 檔內的它月殘留工作表），否則 FAIL。
   * ---------------------------------------------------------------------- */
  function rowsPlain(ws) {
    var rng = XLSX.utils.decode_range(ws["!ref"]);
    var list = [];
    for (var r = 1; r <= rng.e.r; r++) {
      var cells = [], any = false;
      for (var c = 0; c <= rng.e.c; c++) {
        var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
        var v = cell ? cell.v : undefined;
        if (typeof v === "string" && v.trim() === "") v = undefined;
        if (v !== undefined) any = true;
        cells.push(v);
      }
      if (any) list.push(cells);
    }
    return list;
  }
  function compareByBlocks(wsExp, wsGot, setup, diffs, devs, stats) {
    var dv = setup.knownDeviations || {};
    var bk = setup.blockKeyCols, rk = setup.rowKeyCols;
    function keyOf(cells, cols) { return cols.map(function (c) { return String(cells[c]); }).join(" ⁄ "); }
    function group(list) {
      var m = {};
      list.forEach(function (cells) {
        var k = keyOf(cells, bk);
        (m[k] = m[k] || []).push(cells);
      });
      return m;
    }
    var expMap = group(rowsPlain(wsExp)), gotMap = group(rowsPlain(wsGot));

    Object.keys(expMap).forEach(function (k) {
      if (!gotMap[k]) devs.push([k, "-", "預期檔獨有區塊（他月檔案資料，本檔無對應 raw 工作表）", expMap[k].length + " 列"]);
    });
    Object.keys(gotMap).forEach(function (k) {
      var gRows = gotMap[k], eRows = expMap[k];
      if (!eRows) {
        var site = gRows[0][bk[0]];
        if ((dv.ignoreOutputBlockSites || []).indexOf(String(site)) >= 0) {
          devs.push([k, "-", "匯出獨有區塊（raw 檔內它月殘留工作表）", gRows.length + " 列"]);
        } else {
          diffs.push([k, "(區塊)", "預期檔無此區塊", gRows.length + " 列"]);
        }
        return;
      }
      gRows.forEach(function (g) {
        var rKey = keyOf(g, rk);
        var e = eRows.find(function (x) { return keyOf(x, rk) === rKey; });
        if (!e) { diffs.push([k, rKey, "預期檔無此列", "-"]); return; }
        for (var c = 0; c < Math.max(g.length, e.length); c++) {
          var ve = e[c], vg = g[c];
          stats.compared++;
          var same;
          if (ve === undefined && vg === undefined) same = true;
          else if (typeof ve === "number" && typeof vg === "number") same = Math.abs(ve - vg) < 1e-9;
          else same = (ve === vg);
          if (same) { if (ve !== undefined) stats.valued++; }
          else diffs.push([k + " / " + rKey, colLetter(c), String(ve), String(vg)]);
        }
      });
      eRows.forEach(function (e) {
        var rKey = keyOf(e, rk);
        if (!gRows.find(function (x) { return keyOf(x, rk) === rKey; })) {
          diffs.push([k, rKey, "-", "匯出缺此列"]);
        }
      });
    });
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

      var diffs = [], devs = [], stats = { compared: 0, valued: 0, fmtDiffs: [] };
      var sheetsOk = JSON.stringify(wbExp.SheetNames) === JSON.stringify(wbGot.SheetNames);
      if (setup.compare === "byStation" || setup.compare === "byBlock") {
        // 基本資料表照位置比；檢測項目表逐測站/逐區塊對齊比（預期檔列順序不定）
        var basicName = wbExp.SheetNames[0], itemName = wbExp.SheetNames[1];
        if (wbGot.Sheets[basicName]) {
          compareSheets(wbExp.Sheets[basicName], wbGot.Sheets[basicName], basicName, true, diffs, stats, setup.checkFormats);
        }
        if (wbGot.Sheets[itemName]) {
          if (setup.compare === "byBlock") {
            compareByBlocks(wbExp.Sheets[itemName], wbGot.Sheets[itemName], setup, diffs, devs, stats);
          } else {
            compareByStation(wbExp.Sheets[itemName], wbGot.Sheets[itemName], setup, diffs, devs, stats);
          }
        }
        // 基本資料表白名單：預期檔漏掉的欄（如手工檔少了「備註」標題欄）
        var bm = (setup.knownDeviations || {}).basicMissing || [];
        if (bm.length) {
          for (var di = diffs.length - 1; di >= 0; di--) {
            var d = diffs[di];
            if (d[0] !== basicName) continue;
            if (bm.indexOf(String(d[1]).charAt(0)) >= 0 && d[2] === "undefined") {
              devs.push([basicName, d[1], "預期檔漏此欄（匯出補齊為 " + d[3] + "）", "-"]);
              diffs.splice(di, 1);
            } else if (d[1] === "(範圍)") {
              // 範圍差異僅因預期檔缺白名單欄（如 A1:G12 vs A1:H12，差在 H 欄）→ 視為同一偏差
              var lastGot = String(d[3]).replace(/\d+$/, "").slice(-1);
              if (bm.indexOf(lastGot) >= 0) {
                devs.push([basicName, "(範圍)", "預期檔少了 " + bm.join("/") + " 欄（" + d[2] + " vs " + d[3] + "）", "-"]);
                diffs.splice(di, 1);
              }
            }
          }
        }
      } else {
        wbExp.SheetNames.forEach(function (sn, i) {
          if (wbGot.Sheets[sn]) compareSheets(wbExp.Sheets[sn], wbGot.Sheets[sn], sn, i === 0, diffs, stats, setup.checkFormats);
        });
      }

      var t3 = table(["逐格比對", "結果", "判定"]);
      row(t3, ["工作表名稱", wbGot.SheetNames.join("、"), sheetsOk ? "PASS" : "FAIL"]);
      row(t3, ["比對儲存格總數", String(stats.compared), ""]);
      row(t3, ["其中有值且一致", String(stats.valued), ""]);
      row(t3, ["值不一致數（預期 0，不含既知偏差）", String(diffs.length), diffs.length === 0 ? "PASS" : "FAIL"]);
      if (setup.checkFormats !== false) {
        row(t3, ["日期/時間欄顯示格式差異（規格定義欄位）", String(stats.fmtDiffs.length),
          stats.fmtDiffs.length === 0 ? "PASS" : "FAIL"]);
      }
      if (devs.length) {
        row(t3, ["既知偏差（預期檔手工不一致，白名單，不計失敗）", String(devs.length), ""]);
      }

      if (diffs.length) {
        h2("差異明細（最多 60 筆）");
        var t4 = table(["位置", "欄", "預期（成品）", "實際（匯出）"]);
        diffs.slice(0, 60).forEach(function (d) { row(t4, d); });
      }
      if (devs.length) {
        h2("既知偏差明細（預期檔的手工不一致，詳 setup.json knownDeviations）");
        var t6 = table(["測站", "測項", "說明", "備考"]);
        devs.forEach(function (d) { row(t6, d); });
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
