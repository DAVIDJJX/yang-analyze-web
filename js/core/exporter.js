/* =========================================================================
 * Yang-analyze web — core/exporter.js
 * 通用匯出引擎：依模組設定檔的 output 規格，把解析結果組成申報用 .xlsx。
 * 字型/欄寬/日期時間格式完全依設定檔（對齊 analyze_water.py 的 write_output）。
 * ========================================================================= */
(function () {
  "use strict";
  window.YangCore = window.YangCore || {};

  /**
   * buildWorkbook(config, records, project) → Uint8Array (.xlsx)
   *   records 可為空陣列（= 下載空白範本，只有標題列與基本資料）。
   *   project 可為 null（基本資料工作表只有標題列）。
   */
  function buildWorkbook(config, records, project) {
    var out = config.output;

    /* ---- 樣式表（見 config.output.fonts / styles 定義） ---- */
    var spec = { fonts: out.fonts, styles: out.styles, sheets: [] };

    /* ---- 工作表 1：監測點基本資料 ----
     * 預設一列（basic.build）；模組可定義 basic.buildRows 回傳多列
     * （如空氣模組的多工程列），皆回傳 cell 定義陣列 {v, t, style}。 */
    var basic = out.basicSheet;
    var rows1 = [];
    rows1.push(basic.headers.map(function (h) {
      return { v: h, t: "s", s: basic.headerStyle };
    }));
    if (project) {
      var dataRows = basic.buildRows ? basic.buildRows(project) : [basic.build(project)];
      dataRows.forEach(function (cells) {
        rows1.push(cells.map(function (cellDef) {
          return { v: cellDef.v, t: cellDef.t, s: cellDef.style };
        }));
      });
    }
    spec.sheets.push({ name: basic.name, cols: basic.cols || {}, rows: rows1 });

    /* ---- 工作表 2：檢測項目 ---- */
    var rows2 = [];
    rows2.push(config.columns.map(function (col) {
      return { v: col.h, t: "s", s: out.itemHeaderStyle };
    }));
    records.forEach(function (rec) {
      rec.items.forEach(function (it) {
        rows2.push(config.columns.map(function (col) {
          var f = (col.level === "station") ? rec.f[col.key] : it[col.key];
          var v = f ? f.v : null;
          return { v: (v === undefined ? null : v), t: col.cellType(v), s: col.bodyStyle };
        }));
      });
    });
    spec.sheets.push({ name: out.itemSheetName, cols: out.itemCols, rows: rows2 });

    return YangCore.xlsxwriter.build(spec);
  }

  function download(bytes, fileName) {
    var blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  YangCore.exporter = { buildWorkbook: buildWorkbook, download: download };
})();
