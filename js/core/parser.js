/* =========================================================================
 * Yang-analyze web — core/parser.js
 * 通用解析引擎：吃「模組設定檔」(js/configs/*.js) 解析 raw data。
 * 引擎本身不含任何水質/空氣/噪音的專屬規則。
 *
 * 資料模型：每個可編輯欄位都是 {v, src}，src = 'parsed' | 'manual'
 *   - parsed  : 由 raw data 解析取得
 *   - manual  : 手動輸入（含測站記憶自動帶入者，via:'memory' 標記來源）
 *
 * 模組設定檔可選定義 postProcess(records, warnings, ctx)：
 * 在該模組全部工作表解析完後呼叫一次，供跨紀錄補值
 * （如噪音模組：振動表無座標/許可證號，需由同站同日的噪音表帶入）。
 * ========================================================================= */
(function () {
  "use strict";
  window.YangCore = window.YangCore || {};

  /* ---------------- 共用解析工具（各模組設定檔皆可用） ---------------- */
  var helpers = {
    /** 民國年月日 → 'YYYY-MM-DD'（民國年 + 1911 = 西元） */
    rocToISO: function (y, m, d) {
      var yy = parseInt(String(y).trim(), 10) + 1911;
      var mm = String(parseInt(String(m).trim(), 10)).padStart(2, "0");
      var dd = String(parseInt(String(d).trim(), 10)).padStart(2, "0");
      return yy + "-" + mm + "-" + dd;
    },
    /** 時、分 → 'HH:MM' */
    toHM: function (h, m) {
      return String(parseInt(String(h).trim(), 10)).padStart(2, "0") + ":" +
             String(parseInt(String(m).trim(), 10)).padStart(2, "0");
    },
    /** '25.4' → 25.4；非數字回傳原值 */
    toNumber: function (v) {
      if (typeof v === "number") return v;
      if (v === null || v === undefined) return v;
      var s = String(v).trim();
      if (s === "") return v;
      var n = Number(s);
      return Number.isNaN(n) ? v : n;
    },
    /** 四捨五入至 1 位小數（噪音/振動申報值慣例）；非數字回傳 null */
    round1: function (v) {
      return (typeof v === "number") ? Math.round(v * 10) / 10 : null;
    },
    /** '6.0×104' → 60000（科學記號上標流失的還原）；不符合格式回傳 null */
    parseSciText: function (v) {
      var m = /^([\d.]+)\s*[×xX]\s*10(\d+)$/.exec(String(v).trim());
      if (!m) return null;
      var n = parseFloat(m[1]) * Math.pow(10, parseInt(m[2], 10));
      return n;
    },
    /** 'HH:MM' 格式檢查（24 小時制） */
    isValidHM: function (s) {
      return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s).trim());
    },
    /** 使用者輸入的時間正規化 '8:43'→'08:43'；無效回傳 null */
    normHM: function (s) {
      s = String(s).trim().replace("：", ":");
      if (!helpers.isValidHM(s)) return null;
      var p = s.split(":");
      return p[0].padStart(2, "0") + ":" + p[1];
    }
  };

  /* ---------------- 測站記憶比對 ---------------- */
  function findStation(stations, rawName) {
    for (var i = 0; i < stations.length; i++) {
      var st = stations[i];
      if (st.name === rawName) return st;
      if (Array.isArray(st.aliases) && st.aliases.indexOf(rawName) >= 0) return st;
    }
    return null;
  }

  /* ---------------- 單一工作表 → record（共用內部流程） ---------------- */
  var uidSeq = 1;
  function parseOneSheet(fm, sn, config, ctx, records, warnings) {
    var acc = fm.sheet(sn);
    var parsed = config.parseSheet(acc, helpers, ctx.tables);
    parsed.warnings.forEach(function (w) {
      warnings.push(fm.fileName + " [" + sn + "]：" + w);
    });

    var rec = {
      uid: "r" + (uidSeq++), module: config.id,
      fileName: fm.fileName, sheetName: sn,
      stationRaw: parsed.stationRaw,
      f: {}, items: parsed.items, hints: {}
    };
    Object.keys(parsed.fields).forEach(function (k) {
      rec.f[k] = { v: parsed.fields[k], src: "parsed" };
    });

    // 手動欄位：raw data 一定沒有，初始為空、標記 manual
    config.manualFields.forEach(function (k) {
      if (!(k in rec.f)) rec.f[k] = { v: null, src: "manual" };
    });

    // 測站記憶：同名（或別名）測站自動帶入座標與申報名稱（不覆蓋已解析的值）
    var st = findStation(ctx.stations || [], parsed.stationRaw);
    if (st) {
      rec.f[config.stationField] = { v: st.name, src: "parsed" };
      ["coordSys", "x", "y"].forEach(function (k) {
        var sv = (k === "coordSys") ? st.coordSys : st[k];
        if (rec.f[k] && (rec.f[k].v === null || rec.f[k].v === undefined) && sv != null) {
          rec.f[k] = { v: sv, src: "manual", via: "memory" };
        }
      });
      rec.hints.lastEndTime = st.lastEndTime || null;
    } else {
      rec.f[config.stationField] = { v: parsed.stationRaw, src: "parsed" };
      var needCoords = ["coordSys", "x", "y"].some(function (k) {
        return rec.f[k] && (rec.f[k].v === null || rec.f[k].v === undefined);
      });
      if (needCoords) {
        warnings.push(fm.fileName + " [" + sn + "]：測站「" + parsed.stationRaw +
          "」不在測站記憶中，請補座標（將自動存入測站管理）");
      }
    }
    records.push(rec);
  }

  /* ----------------------------------------------------------------------
   * parseFiles(fileModels, config, ctx) → {records, warnings}（單模組）
   * ---------------------------------------------------------------------- */
  function parseFiles(fileModels, config, ctx) {
    var records = [], warnings = [];
    fileModels.forEach(function (fm) {
      fm.sheetNames.forEach(function (sn) {
        if (!config.detectSheet(fm.sheet(sn))) {
          warnings.push(fm.fileName + " [" + sn + "]：非" + config.label + "報告格式，已略過");
          return;
        }
        parseOneSheet(fm, sn, config, ctx, records, warnings);
      });
    });
    if (config.postProcess) config.postProcess(records, warnings, ctx);
    return { records: records, warnings: warnings };
  }

  /* ----------------------------------------------------------------------
   * parseFilesMulti(fileModels, jobs) → {records, warnings}
   *   jobs: [{config, ctx}] — 每張工作表由第一個 detectSheet 命中的模組解析；
   *   全部未命中才列警告。各模組的 postProcess 於該模組全部紀錄解析完後呼叫。
   * ---------------------------------------------------------------------- */
  function parseFilesMulti(fileModels, jobs) {
    var records = [], warnings = [];
    fileModels.forEach(function (fm) {
      fm.sheetNames.forEach(function (sn) {
        var acc = fm.sheet(sn);
        var job = null;
        for (var i = 0; i < jobs.length; i++) {
          if (jobs[i].config.detectSheet(acc)) { job = jobs[i]; break; }
        }
        if (!job) {
          warnings.push(fm.fileName + " [" + sn + "]：無法辨識的工作表格式，已略過");
          return;
        }
        parseOneSheet(fm, sn, job.config, job.ctx, records, warnings);
      });
    });
    jobs.forEach(function (job) {
      if (job.config.postProcess) {
        job.config.postProcess(records.filter(function (r) { return r.module === job.config.id; }),
          warnings, job.ctx);
      }
    });
    return { records: records, warnings: warnings };
  }

  YangCore.helpers = helpers;
  YangCore.parser = { parseFiles: parseFiles, parseFilesMulti: parseFilesMulti, findStation: findStation };
})();
