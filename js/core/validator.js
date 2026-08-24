/* =========================================================================
 * Yang-analyze web — core/validator.js
 * 通用驗證引擎：依模組設定檔的欄位定義檢查缺漏。未補完不能匯出。
 * ========================================================================= */
(function () {
  "use strict";
  window.YangCore = window.YangCore || {};

  function isEmpty(v) {
    return v === null || v === undefined || String(v).trim() === "";
  }

  /**
   * validate(records, config) → [{uid, itemIdx|null, key, label, message}]
   * 檢查 config.columns 中 required 欄位；station 層級每筆 record 檢查一次，
   * item 層級逐項檢查。
   */
  function validate(records, config) {
    var missing = [];
    records.forEach(function (rec) {
      config.columns.forEach(function (col) {
        if (!col.required) return;
        if (col.level === "station") {
          var f = rec.f[col.key];
          if (!f || isEmpty(f.v)) {
            missing.push({
              uid: rec.uid, itemIdx: null, key: col.key, label: col.h,
              message: rec.f[config.stationField] ? rec.f[config.stationField].v : rec.stationRaw
            });
          }
        } else {
          rec.items.forEach(function (it, idx) {
            var f = it[col.key];
            if (!f || isEmpty(f.v)) {
              missing.push({
                uid: rec.uid, itemIdx: idx, key: col.key, label: col.h,
                message: (rec.f[config.stationField] ? rec.f[config.stationField].v : "") +
                  " / " + (it.itemName ? it.itemName.v : "項目" + (idx + 1))
              });
            }
          });
        }
      });
    });
    return missing;
  }

  YangCore.validator = { validate: validate, isEmpty: isEmpty };
})();
