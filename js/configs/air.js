/* =========================================================================
 * Yang-analyze web — configs/air.js
 * 空氣品質模組設定檔：檢驗室「空氣品質檢測報告」(24hr 連續監測, .xls) 的
 * 解析規則＋環境部申報輸出規格（23 欄，見 docs/air_module_spec.md）。
 *
 * 規則由舊版 Python/Excel COM 工具之輸出逆向驗證（5 測站全數吻合）：
 *  - 一工作表＝一測站；M6=監測地點、A3=許可證號
 *  - 連續測項（SO2/NO2/NOx/NO/CO/O3/PM10/風向/風速/溫度/溼度）取第 41 列日平均
 *  - TSP=Q18、PM2.5=W16（報告第二頁）、鉛=Q40（MDL 於 Q45）
 *  - 監測起日=A19~A25（民國年/月/日）、迄日=A30~A36、起始小時=B17「HH ~ HH」
 *  - 時間(起)=HH:00、時間(迄)=HH-1:59（隔日）
 *  - 依舊工具輸出慣例：日期(起)/時間(起) 為文字（Y/M/D、HH:00），
 *    日期(迄) 為日期值、時間(迄) 為時間值
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

  /* ---------------- 申報「空品檢測項目」23 欄定義 ---------------- */
  var COLUMNS = [
    { key: "dateStart", h: "日期(起)", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "timeStart", h: "時間(起)", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "dateEnd", h: "日期(迄)", level: "station", type: "date", required: true, official: true, bodyStyle: S.DATE2, edit: "date" },
    { key: "timeEnd", h: "時間(迄)", level: "station", type: "time", required: true, official: true, bodyStyle: S.TIME2, edit: "time" },
    { key: "site", h: "採樣地點", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "coordSys", h: "座標系統", level: "station", type: "number", required: true, official: true, manual: true, bodyStyle: S.BODY2, edit: "coordsys" },
    { key: "x", h: "採樣座標-經度 X", level: "station", type: "number", required: true, official: true, manual: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "y", h: "採樣座標-緯度 Y", level: "station", type: "number", required: true, official: true, manual: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "placeNo", h: "場所編號", level: "station", type: "number", bodyStyle: S.BODY2, edit: "number" },
    { key: "siteHeight", h: "採樣地點高度(公尺)", level: "station", type: "number", bodyStyle: S.BODY2, edit: "number" },
    { key: "samplingHeight", h: "污染物採樣高度(公尺)", level: "station", type: "number", bodyStyle: S.BODY2, edit: "number" },
    { key: "ems", h: "管制編號", level: "station", type: "text", bodyStyle: S.BODY2, edit: "text" },
    { key: "stackNo", h: "煙道編號", level: "station", type: "text", bodyStyle: S.BODY2, edit: "text" },
    { key: "category", h: "檢測類別", level: "station", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "aircategory" },
    { key: "itemName", h: "檢測項目", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "unitCode", h: "檢測濃度/質量單位", level: "item", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "number" },
    { key: "unitOther", h: "其他檢測濃度/質量單位", level: "item", type: "text", bodyStyle: S.BODY2, edit: "text" },
    { key: "compare", h: "比較關係", level: "item", type: "text", bodyStyle: S.BODY2, edit: "text" },
    { key: "valueOut", h: "檢測數值", level: "item", type: "auto", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "mdl", h: "檢測極限", level: "item", type: "auto", bodyStyle: S.BODY2, edit: "text" },
    { key: "methodOut", h: "檢測方法", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "license", h: "檢測機構許可證號", level: "station", type: "number", required: true, official: true, bodyStyle: S.BODY2, edit: "agency" },
    { key: "agencyOther", h: "其他檢測機構名稱", level: "item", type: "text", bodyStyle: S.BODY2, edit: "text" }
  ];
  COLUMNS.forEach(function (c) { c.cellType = cellTypeFor(c.type); });

  function pad2(n) { return String(n).padStart(2, "0"); }
  function intOf(v) { return parseInt(String(v).trim(), 10); }

  YangConfigs.air = {
    id: "air",
    label: "空氣品質",
    stationField: "site",
    manualFields: ["coordSys", "x", "y"],
    columns: COLUMNS,
    tableNames: ["unitMap", "methodMap"],

    detectSheet: function (acc) {
      return acc.str("A2").indexOf("空氣品質檢測報告") >= 0 ||
             acc.str("S2").indexOf("空氣品質檢測報告") >= 0;
    },

    parseSheet: function (acc, H, tables) {
      var warnings = [];
      var db = window.YangDB.air;

      var mSite = /監測地點[：:]\s*(.+)/.exec(acc.str("M6"));
      var stationRaw = mSite ? mSite[1].trim() : acc.str("M6");
      if (!stationRaw) warnings.push("無法從 M6 解析監測地點");

      var licMatch = /第0*(\d+)號/.exec(acc.str("A3"));
      var license = licMatch ? parseInt(licMatch[1], 10) : null;
      if (license === null) warnings.push("無法從 A3 解析檢測機構許可證號");

      /* 監測起迄：A19/A22/A25＝起（民國年/月/日）、A30/A33/A36＝迄；B17＝起始小時 */
      var dateStartText = null, dateEnd = null, timeStartText = null, timeEnd = null;
      try {
        var y1 = intOf(acc.get("A19")) + 1911, m1 = intOf(acc.get("A22")), d1 = intOf(acc.get("A25"));
        var y2 = intOf(acc.get("A30")) + 1911, m2 = intOf(acc.get("A33")), d2 = intOf(acc.get("A36"));
        var hh = intOf((acc.str("B17").split("~")[0] || "").trim());
        if ([y1, m1, d1, y2, m2, d2, hh].some(function (n) { return Number.isNaN(n); })) throw new Error("NaN");
        dateStartText = y1 + "/" + m1 + "/" + d1;                        // 文字（照舊工具輸出）
        dateEnd = y2 + "-" + pad2(m2) + "-" + pad2(d2);                  // 日期值
        timeStartText = pad2(hh) + ":00";                                // 文字
        timeEnd = pad2(hh === 0 ? 23 : hh - 1) + ":59";                  // 時間值
        if (hh === 0) warnings.push("起始小時為 00，時間(迄) 以 23:59 推算，請人工確認");
      } catch (e) {
        warnings.push("無法解析監測起迄日期（A19~A36/B17），請手動補");
      }

      /* 鉛的 MDL（Q45 如 'MDL：0.0036'） */
      var mdlMatch = /MDL[：:]\s*([\d.]+)/.exec(acc.str("Q45"));
      var pbMDL = mdlMatch ? H.toNumber(mdlMatch[1]) : null;

      /* ---- 14 個監測項目（位置見 db.itemPlan） ---- */
      var items = [];
      db.itemPlan.forEach(function (plan) {
        var raw = acc.get(plan.cell);
        var compare = null, valueOut = null, mdlOut = null;
        if (raw === null || String(raw).trim() === "" || String(raw).trim() === "--") {
          warnings.push("「" + plan.name + "」（" + plan.cell + "）無測值，請確認");
        } else if (typeof raw === "string") {
          var s = raw.trim();
          if (s.toUpperCase() === "ND") {
            valueOut = "ND";                       // 舊工具慣例：ND 填數值欄，比較關係留空
            if (plan.mdlCell) mdlOut = pbMDL;
          } else if (s.charAt(0) === "<") {
            compare = "<";
            valueOut = H.toNumber(s.slice(1).trim());
          } else {
            valueOut = H.toNumber(s);              // 風向等文字照填
          }
        } else {
          valueOut = raw;
        }

        var unitCode = tables.unitMap[plan.name];
        if (unitCode === undefined) {
          unitCode = null;
          warnings.push("「" + plan.name + "」不在單位對照表中，單位代碼留空");
        }
        var method = tables.methodMap[plan.name];
        if (method === undefined) {
          method = null;
          warnings.push("「" + plan.name + "」不在方法對照表中，檢測方法留空");
        }

        items.push({
          rawName: plan.name,
          itemName: { v: plan.name, src: "parsed" },
          unitCode: { v: unitCode, src: "parsed" },
          unitOther: { v: null, src: "parsed" },
          compare: { v: compare, src: "parsed" },
          valueOut: { v: valueOut, src: "parsed" },
          mdl: { v: mdlOut, src: "parsed" },
          methodOut: { v: method, src: "parsed" },
          agencyOther: { v: null, src: "parsed" }
        });
      });

      return {
        stationRaw: stationRaw,
        fields: {
          dateStart: dateStartText, timeStart: timeStartText,
          dateEnd: dateEnd, timeEnd: timeEnd,
          category: db.defaultCategory, license: license,
          placeNo: null, siteHeight: null, samplingHeight: null, ems: null, stackNo: null
        },
        items: items,
        warnings: warnings
      };
    },

    /* ---------------- 匯出規格（樣式沿用水質；基本資料支援多工程列） ---------------- */
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
        /* project.basicRows（陣列，每列 8 值，日期用 YYYY-MM-DD）優先；
           無則退回單列（同水質格式） */
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
      itemSheetName: "空品檢測項目",
      itemHeaderStyle: S.HDR2,
      itemCols: {}
    },

    exportFileName: function (project) {
      var d = new Date(), pad = function (n) { return String(n).padStart(2, "0"); };
      var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
      return "空氣品質檢測資料_" + (project ? project.code : "未設定案場") + "_" + stamp + ".xlsx";
    }
  };
})();
