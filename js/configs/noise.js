/* =========================================================================
 * Yang-analyze web — configs/noise.js
 * 噪音模組設定檔：檢驗室噪音 24hr 檢測報告（N 表）＋環境振動測定報告（V 表）
 * 的解析規則＋環境部申報輸出規格（21 欄，見 docs/noise_module_spec.md）。
 *
 * 規則由 raw 內建「環評申報表」與手工預期輸出逆向驗證（欄位對應表經使用者確認）：
 *  - 每站每日輸出 5 列：噪音 日/晚/夜 均能音量(Leq) 3 列＋振動 Lvd(10)日、Lvn(10)夜 2 列
 *  - N 表：B11=監測地點、L8=監測日期(民國)、B8=樣品特性→檢測類別、
 *          C42/G42/K42=日/晚/夜均能音量、T13/T14=TWD97 座標、B10=方法、
 *          備註2(A47)→管制區與環境音量標準、N3=許可證號
 *  - V 表：B5=監測地點、J6=監測日期、C34=Lv日(Lv10)、I34=Lv夜(Lv10)、
 *          備註內 NIEA P204→方法；座標/許可證號由同站同日 N 表帶入（postProcess）
 *  - 監測數值一律四捨五入至 1 位小數；時間固定 00:00~23:59
 * ========================================================================= */
(function () {
  "use strict";
  window.YangConfigs = window.YangConfigs || {};

  var S = { HDR1: 1, BODY1: 2, DATE1: 3, HDR2: 4, BODY2: 5, DATE2: 6, TIME2: 7 };

  function cellTypeFor(colType) {
    return function (v) {
      if (v === null || v === undefined) return "s";
      if (colType === "date") return "d";
      if (colType === "time") return "tm";
      return (typeof v === "number") ? "n" : "s";
    };
  }

  /* ---------------- 申報「噪音檢測項目」21 欄定義（官方欄序） ---------------- */
  var COLUMNS = [
    { key: "dateStart", h: "日期(起)", level: "station", type: "date", required: true, official: true, bodyStyle: S.DATE2, edit: "date" },
    { key: "timeStart", h: "時間(起)", level: "station", type: "time", required: true, official: true, bodyStyle: S.TIME2, edit: "time" },
    { key: "dateEnd", h: "日期(迄)", level: "station", type: "date", required: true, official: true, bodyStyle: S.DATE2, edit: "date" },
    { key: "timeEnd", h: "時間(迄)", level: "station", type: "time", required: true, official: true, bodyStyle: S.TIME2, edit: "time" },
    { key: "site", h: "監測地點", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "coordSys", h: "座標系統", level: "station", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "coordsys" },
    { key: "x", h: "採樣座標-經度 X", level: "station", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "y", h: "採樣座標-緯度 Y", level: "station", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "ctrlStd", h: "管制標準", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "ctrlZone", h: "管制區", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "envStd", h: "環境音量標準", level: "station", type: "number", bodyStyle: S.BODY2, edit: "number" },
    { key: "freqRange", h: "頻率範圍", level: "station", type: "text", bodyStyle: S.BODY2, edit: "text" },
    { key: "charType", h: "音源發聲特性", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "category", h: "檢測類別", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "noisecategory" },
    { key: "period", h: "監測時段", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "valueOut", h: "監測數值", level: "item", type: "auto", required: true, official: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "unitCode", h: "監測單位", level: "item", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "unitOther", h: "其他監測單位", level: "item", type: "text", bodyStyle: S.BODY2, edit: "text" },
    { key: "methodOut", h: "監測方法", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "license", h: "檢測機構許可證號", level: "station", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "agency" },
    { key: "agencyOther", h: "其他檢測機構名稱", level: "item", type: "text", bodyStyle: S.BODY2, edit: "text" }
  ];
  COLUMNS.forEach(function (c) { c.cellType = cellTypeFor(c.type); });

  var ZONE_MAP = { "一": "第1類", "二": "第2類", "三": "第3類", "四": "第4類",
                   "1": "第1類", "2": "第2類", "3": "第3類", "4": "第4類" };

  /* 民國「115.01.19(平日)」→ 'YYYY-MM-DD' */
  function parseRocDot(s, H) {
    var m = /(\d{2,3})\s*[.]\s*(\d{1,2})\s*[.]\s*(\d{1,2})/.exec(String(s));
    return m ? H.rocToISO(m[1], m[2], m[3]) : null;
  }
  function stripNIEA(s) {
    var m = /(NIEA\s+[A-Z]+\d+)/.exec(String(s));
    return m ? m[1] : null;
  }
  function mkItem(charType, period, value, unitCode, method) {
    return {
      rawName: charType + "/" + period,
      charType: { v: charType, src: "parsed" },
      period: { v: period, src: "parsed" },
      valueOut: { v: value, src: "parsed" },
      unitCode: { v: unitCode, src: "parsed" },
      unitOther: { v: null, src: "parsed" },
      methodOut: { v: method, src: "parsed" },
      agencyOther: { v: null, src: "parsed" }
    };
  }

  YangConfigs.noise = {
    id: "noise",
    label: "噪音",
    stationField: "site",
    manualFields: [],   // 座標/日期皆在 raw 內；缺漏時仍可於預覽表補
    columns: COLUMNS,
    tableNames: ["constMap"],

    /* N 表：監測成果列 C41 含「L日」；V 表：A3=環境振動測定報告 */
    detectSheet: function (acc) {
      return acc.str("C41").indexOf("L日") >= 0 ||
             acc.str("A3").indexOf("環境振動測定報告") >= 0;
    },

    parseSheet: function (acc, H, tables) {
      var db = window.YangDB.noise;
      var isVib = acc.str("A3").indexOf("環境振動測定報告") >= 0;
      return isVib ? parseVib(acc, H, tables, db) : parseNoise(acc, H, tables, db);
    },

    /* ---- 振動紀錄的座標/許可證號：由同站同日的噪音紀錄帶入 ---- */
    postProcess: function (records, warnings) {
      var noiseRecs = records.filter(function (r) { return r.f.category.v !== "振動"; });
      records.forEach(function (rec) {
        if (rec.f.category.v !== "振動") return;
        var mate = noiseRecs.find(function (n) {
          return n.f.site.v === rec.f.site.v && n.f.dateStart.v === rec.f.dateStart.v;
        });
        if (mate) {
          ["coordSys", "x", "y", "license"].forEach(function (k) {
            if ((rec.f[k].v === null || rec.f[k].v === undefined) && mate.f[k].v != null) {
              rec.f[k] = { v: mate.f[k].v, src: "parsed" };
            }
          });
        } else {
          warnings.push("[" + rec.sheetName + "] 振動表找不到同站同日（" + rec.f.site.v + " " +
            rec.f.dateStart.v + "）的噪音表，座標與許可證號請手動補");
        }
      });
    },

    /* ---------------- 匯出規格（樣式沿用；基本資料支援多工程列） ---------------- */
    output: {
      fonts: [
        { name: "新細明體", size: 11 },
        { name: "微軟正黑體", size: 14 },
        { name: "微軟正黑體", size: 12 },
        { name: "新細明體", size: 12 }
      ],
      styles: [
        { font: 1, center: true },
        { font: 0 },
        { font: 0, numFmt: 14 },
        { font: 2, center: true },
        { font: 3 },
        { font: 3, numFmt: 14 },
        { font: 3, numFmt: 20 }
      ],
      basicSheet: {
        name: "監測點基本資料",
        headers: ["計畫代碼", "書件案號", "書件名稱", "執行現況", "施工日期", "竣工日期", "營運日期", "備註"],
        headerStyle: S.HDR1,
        cols: {},
        buildRows: function (p) {
          function sCell(v) { return { v: (v == null ? null : v), t: "s", style: S.BODY1 }; }
          function dCell(v) { return { v: (v == null ? null : v), t: "d", style: S.DATE1 }; }
          function mapRow(arr) {
            return arr.map(function (v, i) {
              return (i >= 4 && i <= 6) ? dCell(v) : sCell(v);
            });
          }
          if (Array.isArray(p.basicRows) && p.basicRows.length) return p.basicRows.map(mapRow);
          return [[sCell(p.code), sCell(p.docNo), sCell(p.docName), sCell(p.status),
                   dCell(p.constructionDate), dCell(p.completionDate), dCell(p.operationDate), sCell(p.note)]];
        }
      },
      itemSheetName: "噪音檢測項目",
      itemHeaderStyle: S.HDR2,
      itemCols: {}
    },

    exportFileName: function (project) {
      var d = new Date(), pad = function (n) { return String(n).padStart(2, "0"); };
      var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
      return "噪音監測資料_" + (project ? project.code : "未設定案場") + "_" + stamp + ".xlsx";
    }
  };

  /* ================= N 表（噪音 24hr） ================= */
  function parseNoise(acc, H, tables, db) {
    var warnings = [];
    var site = acc.str("B11");
    if (!site) warnings.push("無法從 B11 解析監測地點");
    var category = acc.str("B8") || null;
    if (!category) warnings.push("無法從 B8 解析檢測類別（樣品特性）");

    var dateISO = parseRocDot(acc.str("L8"), H);
    if (!dateISO) warnings.push("無法解析監測日期（L8），請手動補");

    var licMatch = /第0*(\d+)號/.exec(acc.str("N3"));
    var license = licMatch ? parseInt(licMatch[1], 10) : null;
    if (license === null) warnings.push("無法從 N3 解析檢測機構許可證號");

    var x = H.toNumber(acc.get("T13")), y = H.toNumber(acc.get("T14"));
    if (typeof x !== "number") { x = null; warnings.push("T13 無座標 X"); }
    if (typeof y !== "number") { y = null; warnings.push("T14 無座標 Y"); }

    /* 備註2（A47）→ 管制區、環境音量標準 */
    var note = acc.str("A47");
    var zoneM = /第([一二三四1234])類/.exec(note);
    var ctrlZone = zoneM ? ZONE_MAP[zoneM[1]] : null;
    if (!ctrlZone) warnings.push("無法從備註（A47）解析管制區，請手動補");
    var envStd = 0;
    if (category === "道路交通噪音") {
      if (note.indexOf("八公尺以上") >= 0) envStd = 2;
      else if (note.indexOf("未滿八公尺") >= 0) envStd = 1;
      else { envStd = 0; warnings.push("備註未註明道路寬度別，環境音量標準暫填 0"); }
    }

    var method = stripNIEA(acc.str("B10"));
    if (!method) warnings.push("無法從 B10 解析監測方法");

    var items = [];
    [["C42", "日間"], ["G42", "晚間"], ["K42", "夜間"]].forEach(function (p) {
      var v = H.round1(acc.get(p[0]));
      if (v === null) warnings.push(p[1] + "均能音量（" + p[0] + "）無數值，請確認");
      items.push(mkItem("均能音量(Leq)", p[1], v, db.unitNoise, method));
    });

    return {
      stationRaw: site,
      fields: {
        dateStart: dateISO, timeStart: "00:00", dateEnd: dateISO, timeEnd: "23:59",
        coordSys: (x !== null && y !== null) ? 3 : null, x: x, y: y,   // 報告載明 TWD97
        ctrlStd: tables.constMap["管制標準"] || null,
        ctrlZone: ctrlZone, envStd: envStd,
        freqRange: tables.constMap["頻率範圍(噪音)"] || null,
        category: category, license: license
      },
      items: items,
      warnings: warnings
    };
  }

  /* ================= V 表（環境振動） ================= */
  function parseVib(acc, H, tables, db) {
    var warnings = [];
    var site = acc.str("B5");
    if (!site) warnings.push("無法從 B5 解析監測地點");

    var dateISO = parseRocDot(acc.str("J6"), H);
    if (!dateISO) warnings.push("無法解析監測日期（J6），請手動補");

    /* 方法：備註列（B36~B42）中的 NIEA 編號 */
    var method = null;
    for (var r = 36; r <= 42 && !method; r++) method = stripNIEA(acc.str("B" + r));
    if (!method) warnings.push("備註中找不到振動監測方法（NIEA 編號）");

    var items = [];
    [["C34", "Lvd(10)", "日間"], ["I34", "Lvn(10)", "夜間"]].forEach(function (p) {
      var v = H.round1(acc.get(p[0]));
      if (v === null) warnings.push(p[1] + "（" + p[0] + "）無數值，請確認");
      items.push(mkItem(p[1], p[2], v, db.unitVib, method));
    });

    return {
      stationRaw: site,
      fields: {
        dateStart: dateISO, timeStart: "00:00", dateEnd: dateISO, timeEnd: "23:59",
        coordSys: null, x: null, y: null,        // postProcess 由同站同日噪音表帶入
        ctrlStd: tables.constMap["管制標準"] || null,
        ctrlZone: "無", envStd: 0, freqRange: "無",
        category: "振動", license: null          // postProcess 帶入
      },
      items: items,
      warnings: warnings
    };
  }
})();
