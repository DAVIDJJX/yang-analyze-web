/* =========================================================================
 * Yang-analyze web — core/reader.js
 * SheetJS 包裝：讀取 .xls/.xlsx/.xlsm，一律取公式的「快取計算結果」
 * （等同 openpyxl data_only=True；SheetJS 對公式儲存格的 .v 即快取值）。
 * ========================================================================= */
(function () {
  "use strict";
  window.YangCore = window.YangCore || {};

  var ACCEPTED = /\.(xls|xlsx|xlsm)$/i;

  function makeAccessor(ws) {
    return {
      /** 取原始值（數字→number、文字→string、公式→快取結果）；無值→null */
      get: function (addr) {
        var c = ws[addr];
        if (!c || c.v === undefined || c.v === null) return null;
        return c.v;
      },
      /** 取字串並去頭尾空白；無值→'' */
      str: function (addr) {
        var v = this.get(addr);
        return v === null ? "" : String(v).trim();
      }
    };
  }

  YangCore.reader = {
    isAccepted: function (fileName) { return ACCEPTED.test(fileName); },

    /** File → { fileName, sheetNames, sheet(name)→accessor } */
    readFile: function (file) {
      return file.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(buf, { type: "array", cellDates: false });
        return {
          fileName: file.name,
          sheetNames: wb.SheetNames.slice(),
          sheet: function (name) { return makeAccessor(wb.Sheets[name]); }
        };
      });
    }
  };
})();
