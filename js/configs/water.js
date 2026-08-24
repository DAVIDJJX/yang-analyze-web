/* =========================================================================
 * Yang-analyze web — configs/water.js
 * 水質模組設定檔：檢驗室「水質檢測報告」的解析規則＋環境部申報輸出規格。
 * 由 analyze_water.py（已通過 55 列逐格比對驗證）等價移植。
 * 引擎（js/core/）只吃這份設定，不含水質專屬邏輯。
 * ========================================================================= */
(function () {
  "use strict";
  window.YangConfigs = window.YangConfigs || {};

  var ITEM_START_ROW = 15; // 檢驗項目表格自第 15 列起

  /* ---------------- 欄位樣式索引（見 output.styles 順序） ----------------
   * 1: 基本資料標題（微軟正黑體14 置中）   2: 基本資料內文（新細明體11）
   * 3: 基本資料日期（新細明體11 + mm-dd-yy）
   * 4: 檢測項目標題（微軟正黑體12 置中）   5: 檢測項目內文（新細明體12）
   * 6: 內文+mm-dd-yy                       7: 內文+h:mm
   * （numFmt 14=mm-dd-yy、20=h:mm，與成品檔內部編碼一致） */
  var S = { HDR1: 1, BODY1: 2, DATE1: 3, HDR2: 4, BODY2: 5, DATE2: 6, TIME2: 7 };

  function cellTypeFor(colType) {
    return function (v) {
      if (v === null || v === undefined) return "s";
      if (colType === "date") return "d";
      if (colType === "time") return "tm";
      return (typeof v === "number") ? "n" : "s";
    };
  }

  /* ---------------- 申報「水質檢測項目」21 欄定義 ----------------
   * level: station=測站層級(同測站各列相同, 預覽以合併儲存格顯示) / item=逐項
   * required: 匯出前必須有值；manual: raw data 一定沒有, 需手動補
   * width: 欄寬(照成品)；fmt/樣式照 analyze_water.py write_output */
  var COLUMNS = [
    { key: "dateStart", h: "日期(起)", level: "station", type: "date", required: true, official: true, width: 12.0, bodyStyle: S.DATE2, edit: "date" },
    { key: "timeStart", h: "時間(起)", level: "station", type: "time", required: true, official: true, bodyStyle: S.TIME2, edit: "time" },
    { key: "dateEnd", h: "日期(迄)", level: "station", type: "date", required: true, official: true, bodyStyle: S.DATE2, edit: "date" },
    { key: "timeEnd", h: "時間(迄)", level: "station", type: "time", required: true, official: true, manual: true, bodyStyle: S.TIME2, edit: "time" },
    { key: "site", h: "採樣地點", level: "station", type: "text", required: true, official: true, width: 13.1, bodyStyle: S.TIME2, edit: "text" },
    { key: "coordSys", h: "座標系統", level: "station", type: "number", required: true, official: true, manual: true, width: 15.1, bodyStyle: S.BODY2, edit: "coordsys" },
    { key: "x", h: "採樣座標-經度 X", level: "station", type: "number", required: true, official: true, manual: true, width: 23.2, bodyStyle: S.BODY2, edit: "number" },
    { key: "y", h: "採樣座標-緯度 Y", level: "station", type: "number", required: true, official: true, manual: true, width: 23.1, bodyStyle: S.BODY2, edit: "number" },
    { key: "depth", h: "採樣深度(公尺)", level: "station", type: "number", width: 21.1, bodyStyle: S.BODY2, edit: "number" },
    { key: "waterDepth", h: "採樣水深(公尺)", level: "station", type: "number", bodyStyle: S.BODY2, edit: "number" },
    { key: "ems", h: "管制編號", level: "station", type: "text", width: 13.1, bodyStyle: S.BODY2, edit: "text" },
    { key: "category", h: "檢測類別", level: "station", type: "text", required: true, official: true, width: 13.1, bodyStyle: S.BODY2, edit: "category" },
    { key: "itemName", h: "檢測項目", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "unitCode", h: "檢測濃度/質量單位", level: "item", type: "number", required: true, official: true, width: 26.8, bodyStyle: S.BODY2, edit: "number" },
    { key: "unitOther", h: "其他檢測濃度/質量單位", level: "item", type: "text", width: 32.8, bodyStyle: S.BODY2, edit: "text" },
    { key: "compare", h: "比較關係", level: "item", type: "text", width: 13.1, bodyStyle: S.BODY2, edit: "text" },
    { key: "valueOut", h: "檢測數值", level: "item", type: "auto", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "mdl", h: "檢測極限", level: "item", type: "auto", bodyStyle: S.BODY2, edit: "text" },
    { key: "methodOut", h: "檢測方法", level: "item", type: "text", required: true, official: true, bodyStyle: S.BODY2, edit: "text" },
    { key: "license", h: "檢測機構許可證號", level: "station", type: "number", required: true, official: true, width: 25.4, bodyStyle: S.BODY2, edit: "agency" },
    { key: "agencyOther", h: "其他檢測機構名稱", level: "item", type: "text", width: 25.4, bodyStyle: S.BODY2, edit: "text" }
  ];
  COLUMNS.forEach(function (c) { c.cellType = cellTypeFor(c.type); });

  /* ---------------- 檢測方法：去版次 + 覆寫 ---------------- */
  function methodCode(itemName, method, tables) {
    var ov = tables.methodOverrides || {};
    if (Object.prototype.hasOwnProperty.call(ov, itemName)) return ov[itemName];
    var m = /^(NIEA\s+[A-Z]+\d+)/.exec(method);
    return m ? m[1] : method;
  }

  YangConfigs.water = {
    id: "water",
    label: "水質",
    stationField: "site",
    manualFields: ["timeEnd", "coordSys", "x", "y"],
    columns: COLUMNS,
    tableNames: ["unitCodes", "sampleTypeMap", "itemNameMap", "methodOverrides"],

    /* ---- 判斷工作表是否為水質檢測報告 ---- */
    detectSheet: function (acc) {
      return acc.str("A3").indexOf("水質檢測報告") >= 0;
    },

    /* ----------------------------------------------------------------
     * 解析一張檢驗報告工作表（規則與 analyze_water.py parse_sheet 一致）
     *   F8=採樣地點  B11=樣品特性  A2=許可證字號
     *   J9~N9=採樣時間 民國年/月/日/時/分（J9~L9 為外部參照公式的快取值）
     *   第15列起：A=項目 C=檢測值(快取) D=偵測極限 E=單位 F=檢測方法
     * ---------------------------------------------------------------- */
    parseSheet: function (acc, H, tables) {
      var warnings = [];
      var stationRaw = acc.str("F8");
      var sampleType = acc.str("B11");
      var category = tables.sampleTypeMap[sampleType];
      if (category === undefined) {
        category = sampleType;
        warnings.push("樣品特性「" + sampleType + "」不在對照表中，檢測類別暫填原文");
      }

      var dateStart = null, timeStart = null;
      try {
        dateStart = H.rocToISO(acc.get("J9"), acc.get("K9"), acc.get("L9"));
        timeStart = H.toHM(acc.get("M9"), acc.get("N9"));
      } catch (e) { /* 落到下方檢查 */ }
      if (!dateStart || /NaN/.test(dateStart) || !timeStart || /NaN/.test(timeStart)) {
        dateStart = null; timeStart = null;
        warnings.push("無法解析採樣時間（J9~N9），請手動補日期/時間");
      }

      var licMatch = /第0*(\d+)號/.exec(acc.str("A2"));
      var license = licMatch ? parseInt(licMatch[1], 10) : null;
      if (license === null) warnings.push("無法從 A2 解析檢測機構許可證號");

      /* ---- 檢驗項目 ---- */
      var items = [];
      for (var r = ITEM_START_ROW; r <= 200; r++) {
        var nameV = acc.get("A" + r);
        if (nameV === null) break;
        var name = String(nameV).trim();
        if (name.indexOf("備註") === 0) break;

        var cval = acc.get("C" + r);
        var mdl = acc.get("D" + r);
        var unit = acc.str("E" + r);
        var method = acc.str("F" + r);

        var sci = H.parseSciText(cval);
        var value = (sci !== null) ? sci : H.toNumber(cval);

        var compare = null, valueOut = value;
        if (typeof value === "string") {
          var s = value.trim();
          if (s.toUpperCase() === "ND") { compare = "ND"; valueOut = "ND"; }
          else if (s.toUpperCase() === "NA" || s === "未檢測") { compare = "未檢測"; valueOut = "未檢測"; }
          else if (s.charAt(0) === "<") { compare = "<"; valueOut = H.toNumber(s.slice(1)); }
        }

        var mdlOut = (mdl === null || ["--", "─", "-"].indexOf(String(mdl).trim()) >= 0) ? null : mdl;

        var unitCode = tables.unitCodes[unit];
        if (unitCode === undefined) {
          unitCode = null;
          warnings.push("「" + name + "」單位「" + unit + "」無對應代碼，請補填（可於對照表編輯新增）");
        }

        var nameOut = tables.itemNameMap[name] || name;

        items.push({
          rawName: name, unitRaw: unit, rawMethod: method,
          itemName: { v: nameOut, src: "parsed" },
          unitCode: { v: unitCode, src: "parsed" },
          unitOther: { v: null, src: "parsed" },
          compare: { v: compare, src: "parsed" },
          valueOut: { v: valueOut, src: "parsed" },
          mdl: { v: mdlOut, src: "parsed" },
          methodOut: { v: methodCode(name, method, tables), src: "parsed" },
          agencyOther: { v: null, src: "parsed" }
        });
      }
      if (!items.length) warnings.push("找不到任何檢驗項目（第 " + ITEM_START_ROW + " 列起為空）");

      return {
        stationRaw: stationRaw,
        fields: {
          dateStart: dateStart, timeStart: timeStart, dateEnd: dateStart,
          category: category, license: license,
          depth: null, waterDepth: null, ems: null
        },
        items: items,
        warnings: warnings
      };
    },

    /* ---------------- 匯出規格（照 analyze_water.py write_output） ---------------- */
    output: {
      fonts: [
        { name: "新細明體", size: 11 },     // 0: 預設/基本資料內文
        { name: "微軟正黑體", size: 14 },   // 1: 基本資料標題
        { name: "微軟正黑體", size: 12 },   // 2: 檢測項目標題
        { name: "新細明體", size: 12 }      // 3: 檢測項目內文
      ],
      styles: [
        { font: 1, center: true },            // 1 HDR1
        { font: 0 },                          // 2 BODY1
        { font: 0, numFmt: 14 },              // 3 DATE1
        { font: 2, center: true },            // 4 HDR2
        { font: 3 },                          // 5 BODY2
        { font: 3, numFmt: 14 },              // 6 DATE2
        { font: 3, numFmt: 20 }               // 7 TIME2
      ],
      basicSheet: {
        name: "監測點基本資料",
        headers: ["計畫代碼", "書件案號", "書件名稱", "執行現況", "施工日期", "竣工日期", "營運日期", "備註"],
        headerStyle: S.HDR1,
        cols: {},
        build: function (p) {
          function s(v) { return { v: (v == null ? null : v), t: "s", style: S.BODY1 }; }
          function d(v) { return { v: (v == null ? null : v), t: "d", style: S.DATE1 }; }
          return [s(p.code), s(p.docNo), s(p.docName), s(p.status),
                  d(p.constructionDate), d(p.completionDate), d(p.operationDate), s(p.note)];
        }
      },
      itemSheetName: "水質檢測項目",
      itemHeaderStyle: S.HDR2,
      itemCols: { A: 12.0, E: 13.1, F: 15.1, G: 23.2, H: 23.1, I: 21.1, K: 13.1, L: 13.1, N: 26.8, O: 32.8, P: 13.1, T: 25.4, U: 25.4 }
    },

    exportFileName: function (project) {
      var d = new Date(), pad = function (n) { return String(n).padStart(2, "0"); };
      var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
      return "水質檢測資料_" + (project ? project.code : "未設定案場") + "_" + stamp + ".xlsx";
    },
    blankTemplateName: "水質檢測資料_空白範本.xlsx"
  };
})();
