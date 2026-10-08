/* =========================================================================
 * Yang-analyze web — fill/dict.js
 * 填表核對：詞彙表與文字工具（純邏輯，不碰 DOM，可於 Node 測試）。
 * 內容：監測項目（空氣／氣象／噪音／振動／水質／重金屬）之代碼、別名與
 * OCR 常見誤認；統計別（最大小時平均值、8 小時平均值、日平均值…）；
 * 單位辨識與換算；數值解析（<10、ND、小數逗號、科學記號）；民國日期與季別；
 * 測站名稱相似度與「監測位置：xxx」擷取；NIEA 方法編號 → 項目。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var CJK = "\u3400-\u9fff\uf900-\ufaff";
  var RE_CJK = new RegExp("[" + CJK + "]");
  var RE_CJK_SPACE = new RegExp("([" + CJK + "])\\s+(?=[" + CJK + "])", "g");

  /* ---------------- 文字正規化 ---------------- */
  /** 輕度正規化：NFKC、全形→半形、µ→μ、括號/波浪號統一、空白收斂（不刪中文字間空白） */
  function normLight(s) {
    if (s === null || s === undefined) return "";
    s = String(s);
    if (s.normalize) s = s.normalize("NFKC");
    return s
      .replace(/\u00b5/g, "\u03bc")
      .replace(/[〜∼∽～]/g, "~")
      .replace(/[【〔［]/g, "[").replace(/[】〕］]/g, "]")
      .replace(/[《〈«]/g, "(").replace(/[》〉»]/g, ")")
      .replace(/[\u2010-\u2015\u2212\ufe58\ufe63]/g, "-")
      .replace(/[\u00a0\u3000\s]+/g, " ")
      .trim();
  }
  /** 標準正規化：normLight + 移除中文字之間的空白 */
  function norm(s) {
    return normLight(s).replace(RE_CJK_SPACE, "$1");
  }
  function hasCJK(s) { return RE_CJK.test(String(s || "")); }

  /** 純填充符號（—、-、*、米、／ 等，代表「無資料」或 OCR 雜點） */
  function isFiller(s) {
    var t = norm(s);
    if (!t) return false;
    if (/^[\s\-–—―一二_~*※米·.。…\/\\|=+'"`:;,()]+$/.test(t)) return true;
    return /^[a-z]?\*+[a-z«»()]?$/i.test(t);
  }
  /** 星號類（空氣品質標準欄常以 * 表示「無標準」） */
  function isStarLike(s) {
    var t = norm(s);
    return /^[a-z]?[*※米]+[a-z«»()]?$/i.test(t);
  }

  /* ---------------- 編輯距離／相似度 ---------------- */
  function levenshtein(a, b) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1), cur = new Array(b.length + 1), i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }
  function levRatio(a, b) {
    var m = Math.max(a.length, b.length);
    return m ? 1 - levenshtein(a, b) / m : 1;
  }
  function bigrams(s) {
    var out = [];
    if (s.length < 2) { if (s) out.push(s); return out; }
    for (var i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
    return out;
  }
  function dice(a, b) {
    var A = bigrams(a), B = bigrams(b);
    if (!A.length || !B.length) return 0;
    var used = {}, hit = 0;
    for (var i = 0; i < A.length; i++) {
      for (var j = 0; j < B.length; j++) {
        if (!used[j] && A[i] === B[j]) { used[j] = 1; hit++; break; }
      }
    }
    return 2 * hit / (A.length + B.length);
  }

  /* =====================================================================
   * 監測項目
   * code：內部代碼；cat：類別；label：介面短名；zh：中文全名；unit：預設單位
   * aliases：正式寫法；ocr：OCR 常見誤認；weak：只在儲存格開頭、其後僅接單位/統計
   * 文字時才採用的弱別名（例：逐時表「O ppb」= O3）；generic：日間/夜間等通用詞
   * （遇「振動」上下文改判為振動項目）；ci：英數別名不分大小寫。
   * ===================================================================== */
  function it(code, cat, label, zh, unit, aliases, ocr, weak, o) {
    o = o || {};
    return {
      code: code, cat: cat, label: label, zh: zh, unit: unit,
      aliases: aliases || [], ocr: ocr || [], weak: weak || [],
      generic: o.generic || [], ci: !!o.ci, notAfter: o.notAfter || null, vib: o.vib || null
    };
  }
  var ITEMS = [
    /* ---- 空氣 ---- */
    it("SO2", "air", "SO₂", "二氧化硫", "ppm", ["SO2", "二氧化硫"], ["S02", "SO,", "SOz", "S0,", "S0z", "S02,", "SO 2"], ["SO"], { ci: true }),
    it("NO2", "air", "NO₂", "二氧化氮", "ppm", ["NO2", "二氧化氮"], ["N02", "NOz", "NO,", "N0,", "N0z", "NO 2"], []),
    it("NOx", "air", "NOx", "氮氧化物", "ppm", ["NOx", "氮氧化物"], ["NOX", "N0x", "N0X", "NO x"], [], { ci: true }),
    it("NO", "air", "NO", "一氧化氮", "ppm", ["NO", "一氧化氮"], [], []),
    it("CO", "air", "CO", "一氧化碳", "ppm", ["CO", "一氧化碳"], ["C0"], []),
    it("O3", "air", "O₃", "臭氧", "ppm", ["O3", "臭氧"], ["0O3", "O03", "OO3", "00 3", "O0", "Q3", "O 3"],
      ["O", "0", "03", "0;", "O;", "OQ;", "O5", "0O5", "OO5", "Os", "0s", "O,", "0,", "Q;"]),
    it("THC", "air", "THC", "總碳氫化合物", "ppm", ["THC", "總碳氫化合物"], ["TFHC", "THG", "TH C"], [], { ci: true }),
    it("NMHC", "air", "NMHC", "非甲烷碳氫化合物", "ppm", ["NMHC", "非甲烷碳氫化合物", "非甲烷總碳氫化合物"], ["NMHG", "NNHC", "NM HC"], [], { ci: true }),
    it("CH4", "air", "CH₄", "甲烷", "ppm", ["CH4", "甲烷"], ["CH,", "CH 4", "CHa", "CH;"], ["CH"], { ci: true }),
    it("PM10", "air", "PM10", "懸浮微粒", "ug/m3", ["PM10", "PM 10", "懸浮微粒"], ["PMio", "PMi0", "PMl0", "PM1o", "PMlo", "PMIO", "PM1O", "PM l0", "PM io"], [], { ci: true }),
    it("PM2.5", "air", "PM2.5", "細懸浮微粒", "ug/m3", ["PM2.5", "PM 2.5", "細懸浮微粒"], ["PM25", "PM2,5", "PM2.s", "PM2 5", "PM2,s", "PM 25"], [], { ci: true }),
    it("TSP", "air", "TSP", "總懸浮微粒", "ug/m3", ["TSP", "總懸浮微粒"], ["T.S.P", "T.S.P."], [], { ci: true }),
    it("H2S", "air", "H₂S", "硫化氫", "ppm", ["H2S", "硫化氫"], ["H,S", "HzS"], [], { ci: true }),
    it("NH3", "air", "NH₃", "氨", "ppm", ["NH3", "氨氣", "氨"], ["NH,"], [], { ci: true, notAfter: /^\s*-\s*N/i }),
    it("ODOR", "air", "臭氣", "臭氣（異味）", null, ["臭氣", "異味", "異味污染物", "異味污染", "臭氣強度", "臭度", "臭味", "臭氣濃度"], [], []),
    it("Pb", "metal", "Pb", "鉛", null, ["Pb", "鉛"], [], []),
    /* ---- 氣象 ---- */
    it("WS", "met", "風速", "風速", "m/s", ["風速", "平均風速"], [], []),
    it("WD", "met", "風向", "風向", "deg", ["風向", "最頻風向"], [], []),
    it("TEMP", "met", "溫度", "溫度", "℃", ["溫度", "氣溫", "平均氣溫"], [], []),
    it("RH", "met", "濕度", "相對濕度", "%", ["濕度", "溼度", "相對濕度", "相對溼度"], [], []),
    /* ---- 噪音 ---- */
    it("LEQ", "noise", "Leq", "均能音量", "dB(A)", ["Leq", "LAeq", "均能音量", "Leq24", "Leq(24)", "24小時均能音量"], ["L eq"], [], { ci: true }),
    it("LD", "noise", "L日", "日間均能音量", "dB(A)", ["L日", "L日間", "Ld", "LD", "Leq日", "日間均能音量"], ["L 日"], [], { generic: ["日間"], vib: "LVD" }),
    it("LE", "noise", "L晚", "晚間均能音量", "dB(A)", ["L晚", "L晚間", "Le", "LE", "Leq晚", "晚間均能音量"], ["L 晚"], [], { generic: ["晚間"], vib: "LVN" }),
    it("LN", "noise", "L夜", "夜間均能音量", "dB(A)", ["L夜", "L夜間", "Ln", "LN", "Leq夜", "夜間均能音量"], ["L 夜"], [], { generic: ["夜間"], vib: "LVN" }),
    it("LMAX", "noise", "Lmax", "最大音量", "dB(A)", ["Lmax", "LAmax", "L max", "最大音量"], [], [], { ci: true, vib: "LVMAX" }),
    it("LX", "noise", "Lx", "事件音量", "dB(A)", ["Lx", "LX"], [], []),
    it("L10", "noise", "L10", "L10", "dB(A)", ["L10"], [], [], { ci: true }),
    it("L50", "noise", "L50", "L50", "dB(A)", ["L50"], [], [], { ci: true }),
    it("L90", "noise", "L90", "L90", "dB(A)", ["L90"], [], [], { ci: true }),
    /* ---- 振動（使用者表格以「Lv晚」表示夜間振動） ---- */
    it("LVD", "vib", "Lv日", "日間振動", "dB", ["Lv日", "Lv日間", "Lvd", "LVd", "LVD", "Lv10日", "Lv10,日", "Lv10(日)", "日間振動", "日間振動位準"], ["Lv 日", "Lv10 日"], []),
    it("LVN", "vib", "Lv夜", "夜間振動", "dB", ["Lv夜", "Lv夜間", "Lvn", "LVn", "LVN", "Lv10夜", "Lv10,夜", "Lv10(夜)", "Lv晚", "Lv晚間", "夜間振動", "晚間振動", "夜間振動位準"], ["Lv 夜", "Lv 晚", "Lv10 夜"], []),
    it("LVMAX", "vib", "Lvmax", "最大振動", "dB", ["Lvmax", "Lv max", "LVmax", "Lv,max", "最大振動", "振動最大值"], [], [], { ci: true }),
    /* ---- 水質 ---- */
    it("WT", "water", "水溫", "水溫", "℃", ["水溫"], [], []),
    it("pH", "water", "pH", "氫離子濃度指數", null, ["pH", "氫離子濃度指數", "酸鹼值"], [], [], { ci: true }),
    it("DO", "water", "溶氧", "溶氧量", "mg/L", ["DO", "溶氧", "溶氧量", "溶解氧"], [], []),
    it("BOD", "water", "BOD", "生化需氧量", "mg/L", ["BOD", "BOD5", "生化需氧量"], [], [], { ci: true }),
    it("COD", "water", "COD", "化學需氧量", "mg/L", ["COD", "化學需氧量"], [], [], { ci: true }),
    it("SS", "water", "SS", "懸浮固體", "mg/L", ["SS", "懸浮固體", "懸浮固體物"], [], []),
    it("EC", "water", "導電度", "導電度", "uS/cm", ["導電度", "電導度", "比導電度", "EC"], [], []),
    it("TURB", "water", "濁度", "濁度", "NTU", ["濁度"], [], []),
    it("COLI", "water", "大腸桿菌群", "大腸桿菌群", "CFU/100mL", ["大腸桿菌群", "大腸菌群"], [], []),
    it("ECOLI", "water", "大腸桿菌", "大腸桿菌", "CFU/100mL", ["大腸桿菌", "E.coli", "E. coli"], [], []),
    it("NH3N", "water", "氨氮", "氨氮", "mg/L", ["氨氮", "氨態氮", "NH3-N", "NH3 -N", "NH3- N", "NH3 - N", "NH4-N"], [], [], { ci: true }),
    it("TP", "water", "總磷", "總磷", "mg/L", ["總磷", "TP"], [], []),
    it("NO3N", "water", "硝酸鹽氮", "硝酸鹽氮", "mg/L", ["硝酸鹽氮", "NO3-N", "硝酸鹽"], [], []),
    it("OIL", "water", "油脂", "油脂（正己烷抽出物）", "mg/L", ["油脂", "正己烷抽出物", "油脂類"], [], []),
    it("Cd", "metal", "Cd", "鎘", "mg/L", ["Cd", "鎘"], [], []),
    it("Cr", "metal", "Cr", "鉻", "mg/L", ["Cr", "鉻", "總鉻"], [], []),
    it("Cu", "metal", "Cu", "銅", "mg/L", ["Cu", "銅"], [], []),
    it("Zn", "metal", "Zn", "鋅", "mg/L", ["Zn", "鋅"], [], []),
    it("Hg", "metal", "Hg", "汞", "mg/L", ["Hg", "汞"], [], []),
    it("As", "metal", "As", "砷", "mg/L", ["As", "砷"], [], []),
    it("Ni", "metal", "Ni", "鎳", "mg/L", ["Ni", "鎳"], [], [])
  ];
  var ITEM_BY_CODE = {};
  ITEMS.forEach(function (x) { ITEM_BY_CODE[x.code] = x; });

  /* 別名索引：依首字（小寫）分組，組內長者優先 */
  var ALIAS_INDEX = {}, WEAK_LIST = [];
  (function buildAliasIndex() {
    function add(item, text, exact, generic) {
      var t = norm(text);
      if (!t) return;
      var ascii = /^[\x20-\x7e]+$/.test(t);
      var a = {
        code: item.code, text: t, lower: t.toLowerCase(), len: t.length, exact: exact,
        ci: item.ci && ascii, generic: !!generic, notAfter: item.notAfter
      };
      var k = t.charAt(0).toLowerCase();
      (ALIAS_INDEX[k] = ALIAS_INDEX[k] || []).push(a);
    }
    ITEMS.forEach(function (item) {
      item.aliases.forEach(function (s) { add(item, s, true, false); });
      item.ocr.forEach(function (s) { add(item, s, false, false); });
      item.generic.forEach(function (s) { add(item, s, true, true); });
      item.weak.forEach(function (s) {
        WEAK_LIST.push({ code: item.code, text: norm(s), len: norm(s).length });
      });
    });
    Object.keys(ALIAS_INDEX).forEach(function (k) {
      ALIAS_INDEX[k].sort(function (x, y) { return y.len - x.len; });
    });
    WEAK_LIST.sort(function (x, y) { return y.len - x.len; });
  })();

  var RE_WORD = /[A-Za-z0-9]/;
  function boundaryOk(t, i, len) {
    var first = t.charAt(i), last = t.charAt(i + len - 1);
    var prev = i > 0 ? t.charAt(i - 1) : "", next = t.charAt(i + len);
    if (RE_WORD.test(first)) {
      if (prev && RE_WORD.test(prev)) return false;
      if (/[0-9]/.test(first) && prev === ".") return false;
    }
    if (RE_WORD.test(last)) {
      if (next && RE_WORD.test(next)) return false;
      if (next === "." && /[0-9]/.test(t.charAt(i + len + 1))) return false;
    }
    return true;
  }
  /** 項目辨識前處理：正規化並移除引號類雜訊 */
  function prepItemText(text) {
    return norm(text).replace(/[“”"'‘’`]/g, "");
  }

  /**
   * findItems(text, opts?) → [{code, start, end, len, exact, generic, weak}]
   * 最長比對、英數字邊界判斷（NO 不會配到 NOx/NO2 內，CO 不配 CO2，O3 不配 NO3）。
   * opts.weak = true：若無正式命中，允許儲存格開頭的弱別名（O ppb → O3）。
   */
  function findItems(text, opts) {
    var t = prepItemText(text), hits = [], i = 0, n = t.length;
    while (i < n) {
      var list = ALIAS_INDEX[t.charAt(i).toLowerCase()], found = null;
      if (list) {
        for (var k = 0; k < list.length; k++) {
          var a = list[k];
          if (a.len > n - i) continue;
          var seg = t.substr(i, a.len);
          if (a.ci ? seg.toLowerCase() !== a.lower : seg !== a.text) continue;
          if (!boundaryOk(t, i, a.len)) continue;
          if (a.notAfter && a.notAfter.test(t.slice(i + a.len))) continue;
          found = a; break;
        }
      }
      if (found) {
        hits.push({ code: found.code, start: i, end: i + found.len, len: found.len, exact: found.exact, generic: found.generic, weak: false });
        i += found.len;
      } else i++;
    }
    if (!hits.length && opts && opts.weak) {
      for (var w = 0; w < WEAK_LIST.length; w++) {
        var wa = WEAK_LIST[w];
        if (t.substr(0, wa.len) !== wa.text) continue;
        var nx = t.charAt(wa.len);
        if (nx && !/[\s(]/.test(nx)) continue;
        var rest = t.slice(wa.len).trim();
        if (!rest || !(findUnit(rest) || findStat(rest))) continue;
        // 其餘文字只能是單位／統計（不可再有數字範圍，例：「0 ~ 5 m/s」）
        if (/~|(^|\s)[-–]/.test(rest)) continue;
        if (/\d/.test(rest.replace(/m\s*[3³]/gi, "").replace(/\d+\s*(小|hr|h(?![a-z]))/gi, ""))) continue;
        hits.push({ code: wa.code, start: 0, end: wa.len, len: wa.len, exact: false, generic: false, weak: true });
        break;
      }
    }
    return hits;
  }
  function itemInfo(code) { return ITEM_BY_CODE[code] || null; }
  /** 介面用項目名稱；long=true 時附中文全名 */
  function itemLabel(code, long) {
    var x = ITEM_BY_CODE[code];
    if (!x) return code ? String(code) : "";
    if (!long) return x.label;
    return x.label === x.zh ? x.zh : x.label + " " + x.zh;
  }

  /* =====================================================================
   * 統計別
   * ===================================================================== */
  var STATS = [
    { code: "max1h", label: "最大小時平均值", pats: ["最大小時平均值", "最大小時值", "小時最大值", "最大時平均值", "小時平均最大值", "小時平均值最大值", "最大1小時平均值", "最高小時平均值", "小時最大平均值", "最大時值", "最大小時平均"] },
    { code: "min1h", label: "最小小時平均值", pats: ["最小小時平均值", "最小小時值", "小時最小值", "最小時平均值", "小時平均最小值", "小時平均值最小值", "最低小時平均值", "小時最小平均值", "最小小時平均"] },
    { code: "max8h", label: "最大8小時平均值", pats: ["8小時最大平均值", "最大8小時平均值", "8小時平均值最大值", "8小時平均最大值", "8小時最大值", "最大8小時值", "8小時平均值之最大值", "最大8小時平均"] },
    { code: "min8h", label: "最小8小時平均值", pats: ["8小時最小平均值", "最小8小時平均值", "8小時平均值最小值", "8小時平均最小值", "8小時最小值"] },
    { code: "avg8h", label: "8小時平均值之日平均", pats: [] },
    { code: "maxDaily", label: "最大日平均值", pats: ["最大日平均值", "日平均最大值", "日平均值最大值", "最大24小時值", "最大24小時平均值"] },
    { code: "daily", label: "日平均值（24小時值）", pats: ["24小時平均值", "24小時平均", "24小時值", "24小時", "日平均值", "日平均", "日均值", "24hr", "24-hr"] },
    { code: "annual", label: "年平均值", pats: ["年平均值", "年平均", "年均值"] },
    { code: "h8", label: "8小時平均值", pats: ["8小時平均值", "8小時平均", "8小時值", "8hr"] },
    { code: "h1", label: "小時平均值", pats: ["1小時平均值", "小時平均值", "小時平均", "小時值", "時平均值", "1hr"] },
    { code: "max", label: "最大值", pats: ["最大值", "最高值"] },
    { code: "avg", label: "平均值", pats: ["平均值", "平均", "均值"] },
    { code: "min", label: "最小值", pats: ["最小值", "最低值"] },
    { code: "value", label: "測值", pats: ["實測值", "測值", "檢測值", "檢測結果", "分析結果", "測定值", "監測值", "測定結果", "監測結果"] },
    { code: "hourly", label: "逐時值", pats: [] }
  ];
  var STAT_BY_CODE = {};
  STATS.forEach(function (s) { STAT_BY_CODE[s.code] = s; });
  var STAT_PATS = [];
  STATS.forEach(function (s) { s.pats.forEach(function (p) { STAT_PATS.push({ code: s.code, p: p.toLowerCase(), len: p.length }); }); });
  STAT_PATS.sort(function (a, b) { return b.len - a.len; });

  /** 統計文字前處理：去空白、修正 OCR 常見誤認（值→什/直/佳、時→崎、8→$） */
  function statNorm(text) {
    return norm(text).replace(/\s+/g, "").toLowerCase()
      .replace(/(平均|小時|測|大|小|日均|年均)[什直佳舍植恒倌]/g, "$1值")
      .replace(/小[崎峙畤時]/g, "小時")
      .replace(/[$§s]小時/g, "8小時")
      .replace(/二十四小時/g, "24小時").replace(/八小時/g, "8小時").replace(/一小時/g, "1小時");
  }
  var statCache = {};
  /** findStat(text) → {code, start, end, fuzzy?} | null */
  function findStat(text) {
    var key = String(text === null || text === undefined ? "" : text);
    if (Object.prototype.hasOwnProperty.call(statCache, key)) return statCache[key];
    var res = findStatRaw(key);
    statCache[key] = res;
    return res;
  }
  function findStatRaw(text) {
    var t = statNorm(text);
    if (!t) return null;
    var exact = null;
    for (var i = 0; i < STAT_PATS.length; i++) {
      var k = t.indexOf(STAT_PATS[i].p);
      if (k >= 0) { exact = { code: STAT_PATS[i].code, start: k, end: k + STAT_PATS[i].len, len: STAT_PATS[i].len }; break; }
    }
    if (!exact && /^24[^0-9.]{0,4}$/.test(t)) {
      // 弱規則：只剩「24」＋少量雜訊（OCR 把「24 小時值」讀成「24 oh」）
      return { code: "daily", start: 0, end: t.length, fuzzy: true };
    }
    if (t.length > 30) return exact ? { code: exact.code, start: exact.start, end: exact.end } : null;
    // 編輯距離 ≤ 1（樣式 ≥ 4 字）；已有精確命中時，只找「更長」的樣式
    // （「最犬小時平均值」不可只因含「小時平均值」就判為小時平均值；最大/最小並列則不確定）
    var minLen = exact ? exact.len + 2 : 4;
    var best = null, tie = false;
    for (var j = 0; j < STAT_PATS.length; j++) {
      var P = STAT_PATS[j];
      if (P.len < minLen) break;
      if (best && P.len < best.len) break;
      for (var L = P.len - 1; L <= P.len + 1; L++) {
        var hit = false;
        for (var s = 0; s + L <= t.length; s++) {
          var win = t.substr(s, L);
          // 數字（8、24、1）具區別性：模糊比對時數字必須完全相同（「SO2小時平均值」≠「24小時平均值」）
          if (win.replace(/[^0-9]/g, "") !== P.p.replace(/[^0-9]/g, "")) continue;
          if (levenshtein(win, P.p) <= 1) {
            if (!best) best = { code: P.code, start: s, end: s + L, len: P.len, fuzzy: true };
            else if (best.code !== P.code && P.len === best.len) tie = true;
            hit = true; break;
          }
        }
        if (hit) break;
      }
    }
    if (best && tie) return null;
    if (best) return { code: best.code, start: best.start, end: best.end, fuzzy: true };
    return exact ? { code: exact.code, start: exact.start, end: exact.end } : null;
  }
  /** 合併兩處標題的統計別（near：較靠近數值的標題） */
  function combineStats(near, far) {
    if (!near) return far || null;
    if (!far || near === far) return near;
    if (near === "hourly" || far === "hourly") return "hourly";
    if (near === "value") return far;
    if (far === "value") return near;
    if (near === "avg" || far === "avg") {
      var o = near === "avg" ? far : near;
      return o === "h8" ? "avg8h" : o === "h1" ? "daily" : o;
    }
    var s = {}; s[near] = 1; s[far] = 1;
    function has(c) { return !!s[c]; }
    if (has("h8") || has("max8h") || has("min8h")) {
      if (has("max1h") || has("max") || has("max8h")) return "max8h";
      if (has("min1h") || has("min") || has("min8h")) return "min8h";
      if (has("daily")) return "avg8h";
    }
    if (has("h1")) {
      if (has("max1h") || has("max")) return "max1h";
      if (has("min1h") || has("min")) return "min1h";
      if (has("daily")) return "daily";
    }
    if (has("daily") || has("maxDaily")) {
      if (has("max") || has("maxDaily")) return "maxDaily";
    }
    if (has("max") && (has("max1h") || has("max8h") || has("maxDaily"))) return has("max1h") ? "max1h" : has("max8h") ? "max8h" : "maxDaily";
    if (has("min") && (has("min1h") || has("min8h"))) return has("min1h") ? "min1h" : "min8h";
    return near;
  }
  function statLabel(code) { return STAT_BY_CODE[code] ? STAT_BY_CODE[code].label : (code || ""); }

  /* =====================================================================
   * 單位
   * ===================================================================== */
  var UNITS = {
    "ppm": { label: "ppm" }, "ppb": { label: "ppb" },
    "ug/m3": { label: "μg/m³" }, "mg/m3": { label: "mg/m³" },
    "dB(A)": { label: "dB(A)" }, "dB": { label: "dB" },
    "%": { label: "%" }, "℃": { label: "℃" }, "m/s": { label: "m/s" }, "deg": { label: "度(Deg)" },
    "mg/L": { label: "mg/L" }, "ug/L": { label: "μg/L" }, "NTU": { label: "NTU" },
    "uS/cm": { label: "μS/cm" }, "CFU/100mL": { label: "CFU/100mL" }, "MPN/100mL": { label: "MPN/100mL" }
  };
  var UNIT_RULES = [
    ["CFU/100mL", /CFU\s*\/\s*100\s*m?l/i], ["MPN/100mL", /MPN\s*\/\s*100\s*m?l/i],
    ["mg/L", /mg\s*\/\s*l(?![a-z])/i], ["ug/L", /[μu]\s*g\s*\/\s*l(?![a-z])/i],
    ["mg/m3", /mg\s*\/\s*N?m\s*[3³]?(?![a-z\/])/i],
    ["ug/m3", /[μu]\s*g\s*\/\s*N?m(?![a-z\/])/i],
    ["uS/cm", /[μu]\s*(S|mho)\s*\/\s*cm/i],
    ["ppm", /pp\s*m/i], ["ppb", /pp\s*b/i],
    ["dB(A)", /dB\s*\(?\s*A\s*\)?(?![a-z])/i], ["dB", /dB(?![a-z])/i],
    ["NTU", /NTU/i], ["m/s", /m\s*\/\s*(s(ec)?|8)(?![a-z])/i],
    ["℃", /℃|°\s*C(?![a-z])|º\s*C|\?\s*C(?![a-z])|。\s*C(?![a-z])/],
    ["%", /%/], ["deg", /(?:^|[^a-z])deg(?![a-z])/i]
  ];
  /* OCR 版 μg/m³（jg/m、ne/m?、Cugim?、gm? …），排除 mg、kg */
  var RE_UGM_SLASH = /(?:^|[^a-z])([a-zμ]{0,2})[gqe9]\s*\/\s*m(?![a-z\/])/i;
  var RE_UGM_NOSLASH = /(?:^|[^a-z])([a-zμ]{0,2})[gq9]\s*[il|]?\s*m\s*[?³32]/i;
  /** findUnit(text) → 單位代碼 | null */
  function findUnit(text) {
    var t = norm(text);
    if (!t) return null;
    for (var i = 0; i < UNIT_RULES.length; i++) if (UNIT_RULES[i][1].test(t)) return UNIT_RULES[i][0];
    var m = RE_UGM_SLASH.exec(t) || RE_UGM_NOSLASH.exec(t);
    if (m && !/[mk]$/i.test(m[1])) return "ug/m3";
    return null;
  }
  function unitLabel(code) { return UNITS[code] ? UNITS[code].label : (code || ""); }
  var CONV = {
    "ppb>ppm": 0.001, "ppm>ppb": 1000, "ug/m3>mg/m3": 0.001, "mg/m3>ug/m3": 1000,
    "ug/L>mg/L": 0.001, "mg/L>ug/L": 1000
  };
  /** convert(num, from, to) → number | null（不可換算回傳 null） */
  function convert(num, from, to) {
    if (num === null || num === undefined || isNaN(num)) return null;
    if (from === to) return num;
    var f = CONV[from + ">" + to];
    return f ? num * f : null;
  }
  function convFactor(from, to) {
    if (from === to) return 1;
    return CONV[from + ">" + to] || null;
  }

  /* =====================================================================
   * 數值解析
   * ===================================================================== */
  /**
   * parseValue(text) → {ok, value, num, cmp, nd, decimals, mark}
   * value：正規化後的數值文字（"<10"、"ND"、"0.060"）；cmp："" | "<" | ">" | "ND"
   */
  function parseValue(text) {
    var t0 = norm(text);
    var res = { ok: false, value: t0, num: null, cmp: "", nd: false, decimals: 0, mark: false };
    var t = t0.replace(/^[\s_'"`|]+/, "").replace(/[\s_'"`|~\-一]+$/, "");
    if (!t) return res;
    if (/^(N\.?\s*D\.?|未檢出|低於偵測極限|<\s*MDL|<\s*偵測極限)(\s*[(<].*)?$/i.test(t)) {
      return { ok: true, value: "ND", num: null, cmp: "ND", nd: true, decimals: 0, mark: false };
    }
    if (isFiller(t)) return res;
    if (/^\d{1,2}\s*[:;]\s*\d{2}/.test(t)) return res;                       // 時間 10:00
    if (/^\d{2,4}\s*[.\/\-年]\s*\d{1,2}\s*[.\/\-月]\s*\d{1,2}/.test(t)) return res; // 日期
    var cmp = "", m = /^(<=|>=|[<>≦≧≤≥])\s*(.*)$/.exec(t);
    if (m) { cmp = /[<≦≤]/.test(m[1]) ? "<" : ">"; t = m[2]; }
    if (!t) return res;
    if (/\d\s+[\d.,]/.test(t) || /[\d.]\s+\d/.test(t)) return res;          // 兩組數字 → 不確定
    var mark = false;
    if (/\*+$/.test(t)) { mark = true; t = t.replace(/\*+$/, ""); }
    t = t.replace(/\s+/g, "");
    var pct = false;
    if (/%$/.test(t)) { pct = true; t = t.slice(0, -1); }
    // 科學記號：6.0×10^4、6.0×104（上標流失）、1.2E3
    var sci = /^(-?\d+(?:[.,]\d+)?)(?:[×xX*]10\^?([\-+]?\d{1,3})|[eE]([\-+]?\d{1,3}))$/.exec(t);
    if (sci) {
      var mant = parseFloat(sci[1].replace(",", ".")), ex = parseInt(sci[2] !== undefined ? sci[2] : sci[3], 10);
      var nn = mant * Math.pow(10, ex);
      if (isFinite(nn)) {
        return { ok: true, value: (cmp || "") + t.replace(/[xX*]/, "×"), num: nn, cmp: cmp, nd: false, decimals: 0, mark: mark };
      }
      return res;
    }
    // OCR 誤認（只在其餘皆為數字時修正）：O/o→0、l/I/|→1、S→5
    if (/^-?[\dOoIl|S.,]+$/.test(t) && /\d/.test(t) && /[OoIl|S]/.test(t)) {
      var body = t.charAt(0) === "-" ? t.slice(1) : t;
      if (/^[OoIl|S][0-9]/.test(body)) return res;                           // O3、S02 等項目名稱
      if (/[OoIl|S]{2}/.test(body) || (body.match(/[OoIl|S]/g) || []).length > 2) return res;
      if (findItems(body).length) return res;
      t = t.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5");
    }
    // 小數逗號 vs 千分位
    if (/,/.test(t)) {
      if (/^-?\d+,\d{1,2}$/.test(t) || /^-?0,\d+$/.test(t)) t = t.replace(",", ".");
      else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
      else return res;
    }
    if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return res;
    if (t.charAt(0) === ".") t = "0" + t;
    if (t.slice(0, 2) === "-.") t = "-0" + t.slice(1);
    t = t.replace(/\.$/, "");
    var num = parseFloat(t);
    if (!isFinite(num)) return res;
    var dec = (t.split(".")[1] || "").length;
    return { ok: true, value: (cmp || "") + t, num: num, cmp: cmp, nd: false, decimals: dec, mark: mark, pct: pct };
  }
  /** 數值後接單位（「0.012 ppm」「25.3 ℃」「30 dB(A)」）→ {pv, unit} | null */
  function parseValueUnit(text) {
    var t = norm(text);
    var m = /^(.*?[\d.]\*?)\s*([^\d\s][^\d]{0,11}|m\s*[\/]?\s*s|μ?g\/m3|mg\/m3)$/.exec(t);
    if (!m) return null;
    var tail = m[2].replace(/^[(]|[)]$/g, "").trim();
    var unit = findUnit(tail);
    if (!unit) return null;
    if (/[\u3400-\u9fff]/.test(tail.replace(/[℃度]/g, ""))) return null;
    // 單位以外不可有其他文字（「PM2.5 μg/m3」不是數值）
    var rest = tail.replace(/(CFU|MPN)\s*\/\s*100\s*m?l|mg\s*\/\s*N?m\s*[3³]?|[μu]\s*g\s*\/\s*N?m\s*[3³]?|mg\s*\/\s*l|[μu]\s*g\s*\/\s*l|[μu]\s*(s|mho)\s*\/\s*cm|pp[mb]|dB\s*\(?\s*A?\s*\)?|NTU|m\s*\/\s*s(ec)?|℃|°\s*C|%|deg|度/ig, "");
    if (rest.replace(/[\s()]/g, "")) return null;
    var pv = parseValue(m[1]);
    return pv.ok ? { pv: pv, unit: unit } : null;
  }
  /** 數值格式化：保留 decimals 位小數 */
  function formatNum(num, decimals) {
    if (num === null || num === undefined || !isFinite(num)) return "";
    var d = Math.max(0, Math.min(10, decimals | 0));
    return num.toFixed(d);
  }

  /* =====================================================================
   * 時間／日期／季別
   * ===================================================================== */
  /** 純時段或時刻文字：10:00 ~ 11:00、05;00-06:00、10時~11時、10:00 */
  function isTimeRange(text) {
    var t = norm(text).replace(/\s+/g, "");
    if (!t) return false;
    // OCR 雜點（°、'、_ 等）不影響判斷
    if (/^[\d:;.~\-至到時hHr°'`_,]+$/.test(t.replace(/[°'`_]/g, ""))) t = t.replace(/[°'`_]/g, "");
    var hm = "\\d{1,2}[:;.]\\d{2}", sep = "[~\\-至到]+";
    if (new RegExp("^" + hm + sep + hm + "$").test(t)) return true;
    if (/^\d{1,2}[:;]\d{2}$/.test(t)) return true;
    if (/^\d{1,2}時?[~\-至到]+\d{1,2}時$/.test(t)) return true;
    if (/^\d{1,2}[~\-至到]+\d{1,2}(h|hr)$/i.test(t)) return true;
    if (/^\d{1,2}~\d{1,2}$/.test(t) && +t.split("~")[0] <= 24 && +t.split("~")[1] <= 24) return true;   // 「10 ~ 11」時段
    return false;
  }
  /** parseRocDate(text) → {y, m, d} | null（民國 2~3 位或西元 4 位年） */
  function parseRocDate(text) {
    var t = normLight(text);
    var re = /(?:^|[^0-9])(\d{2,4})\s*[.\/\-年]\s*(\d{1,2})\s*[.\/\-月]\s*(\d{1,2})(?![0-9])/g, m;
    while ((m = re.exec(t))) {
      var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && ((y >= 60 && y <= 200) || (y >= 1970 && y <= 2100))) {
        return { y: y, m: mo, d: d };
      }
    }
    return null;
  }
  function formatDate(o) {
    if (!o) return null;
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return o.y + "." + p2(o.m) + "." + p2(o.d);
  }
  var CN_NUM = { "一": 1, "二": 2, "三": 3, "四": 4, "1": 1, "2": 2, "3": 3, "4": 4 };
  /** parsePeriod(text) → {y, q?, m?} | null：115年第三季、115Q3、115年7月、115.07~115.09 */
  function parsePeriod(text) {
    var t = norm(text).replace(/\s+/g, "");
    if (!t) return null;
    var m = /(\d{2,4})年度?第?([一二三四1-4])季/.exec(t);
    if (m) return { y: parseInt(m[1], 10), q: CN_NUM[m[2]] };
    m = /(\d{2,4})[Qq]([1-4])(?![0-9])/.exec(t);
    if (m) return { y: parseInt(m[1], 10), q: parseInt(m[2], 10) };
    m = /(\d{2,4})年度?(\d{1,2})月/.exec(t);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { y: parseInt(m[1], 10), m: parseInt(m[2], 10) };
    m = /(?:^|[^0-9.])(\d{2,3})\.(\d{1,2})[~\-至到]+(\d{2,3})\.(\d{1,2})(?![0-9.])/.exec(t);
    if (m) {
      var y1 = +m[1], m1 = +m[2], y2 = +m[3], m2 = +m[4];
      if (y1 === y2 && m1 >= 1 && m2 <= 12 && m1 <= m2) {
        var q1 = quarterOf({ y: y1, m: m1 }), q2 = quarterOf({ y: y2, m: m2 });
        if (q1 === q2) return { y: y1, q: q1 };
        return { y: y1, m: m1, m2: m2 };
      }
    }
    m = /第([一二三四1-4])季/.exec(t);
    var y = /(\d{2,4})年/.exec(t);
    if (m && y) return { y: parseInt(y[1], 10), q: CN_NUM[m[1]] };
    return null;
  }
  function quarterOf(o) { return o && o.m ? Math.floor((o.m - 1) / 3) + 1 : null; }
  /** 民國/西元年統一為民國 */
  function rocYear(y) { return y > 1911 ? y - 1911 : y; }
  /** 日期是否落在期間內（期間或日期不明時回傳 null） */
  function dateInPeriod(date, period) {
    if (!date || !period) return null;
    var d = typeof date === "string" ? parseRocDate(date) : date;
    var p = typeof period === "string" ? parsePeriod(period) : period;
    if (!d || !p) return null;
    if (rocYear(d.y) !== rocYear(p.y)) return false;
    if (p.q) return quarterOf(d) === p.q;
    if (p.m && p.m2) return d.m >= p.m && d.m <= p.m2;
    if (p.m) return d.m === p.m;
    return true;
  }

  /* =====================================================================
   * 測站名稱
   * ===================================================================== */
  var GENERIC_SUFFIX = ["社區活動中心", "活動中心", "監測站", "監測點", "測站", "測點", "社區", "站"];
  /** 測站比對用正規化：去空白／標點／括號內英數代碼，小寫 */
  function normStation(s) {
    var t = norm(s);
    var noParen = t.replace(/[(\[][^)\]]*[)\]]/g, "");
    if (noParen.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "")) t = noParen;
    return t.replace(/[\s\-_.,:;!?'"“”‘’`~、，。．：；（）()\[\]{}<>|\/\\#*+=]/g, "").toLowerCase();
  }
  function stationCore(s) {
    var t = s, changed = true;
    while (changed && t) {
      changed = false;
      for (var i = 0; i < GENERIC_SUFFIX.length; i++) {
        var g = GENERIC_SUFFIX[i];
        if (t.length > g.length && t.slice(-g.length) === g) { t = t.slice(0, -g.length); changed = true; break; }
        if (t === g) { t = ""; changed = true; break; }
      }
    }
    return t;
  }
  /** stationSim(a, b) → 0..1（白河新村~白和新村 0.75；青山社區~青山社區活動中心 0.95；東湖~西林 0） */
  var RE_NUMS = /[0-9]+|[一二三四五六七八九十]+/g;
  var simMemo = new Map();
  function stationSim(a, b) {
    var key = String(a) + "\u0001" + String(b);
    var hit = simMemo.get(key);
    if (hit !== undefined) return hit;
    var v = stationSimCalc(a, b);
    if (simMemo.size > 50000) simMemo.clear();
    simMemo.set(key, v);
    return v;
  }
  function stationSimCalc(a, b) {
    var A = normStation(a), B = normStation(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    // 編號不同（AQ-1 / AQ-2、第一測站 / 第二測站）視為不同測站
    var nA = (A.match(RE_NUMS) || []).join(","), nB = (B.match(RE_NUMS) || []).join(",");
    if (nA && nB && nA !== nB) return 0.25;
    return stationSimRaw(A, B);
  }
  function stationSimRaw(A, B) {
    var cA = stationCore(A), cB = stationCore(B);
    if (cA && cB && cA === cB) return 0.95;
    if (cA && cB) {
      var sh = cA.length <= cB.length ? cA : cB, lg = sh === cA ? cB : cA;
      if (sh.length >= 2 && lg.indexOf(sh) >= 0) return 0.85 + 0.1 * sh.length / lg.length;
    }
    var full = Math.max(levRatio(A, B), dice(A, B));
    if (cA === A && cB === B) return full;
    var core = (cA && cB) ? Math.max(levRatio(cA, cB), dice(cA, cB)) : 0;
    return 0.5 * full + 0.5 * core;
  }
  var RE_STATION_CAPTURE = /(檢測位置|監測位置|採樣地點|採樣位置|監測地點|檢測地點|測站名稱|測點名稱|監測站名|採樣點|監測點位)\s*[:]?\s*([^\s:,，;；]+)|(?:^|[\s(])(測站|站名|地點|位置|測點)\s*:\s*([^\s:,，;；]+)/;
  var RE_CAPTURE_STOP = /(監測日期|檢測日期|採樣日期|測日期|日期|現場編號|編號|執行單位|委託單位|計畫名稱|監測時間|檢測時間)/;
  /** findStationCapture(text) → 測站文字 | null（「監測位置：白河新村 監測日期…」→ 白河新村） */
  function findStationCapture(text) {
    var t = normLight(text).replace(/：/g, ":");
    var m = RE_STATION_CAPTURE.exec(t);
    if (!m) return null;
    var v = m[2] !== undefined ? m[2] : m[4];
    var stop = RE_CAPTURE_STOP.exec(v);
    if (stop) v = v.slice(0, stop.index);
    v = v.replace(/^[\-_.、(\[]+|[\-_.、)\]]+$/g, "");
    if (!v || !/[\u3400-\u9fffA-Za-z0-9]/.test(v)) return null;
    return v;
  }

  /* =====================================================================
   * NIEA 方法編號 → 項目
   * ===================================================================== */
  var METHOD_ITEMS = {
    A201: ["ODOR"], A416: ["SO2"], A417: ["NOx", "NO2"], A421: ["CO"], A420: ["O3"],
    A740: ["THC", "NMHC", "CH4"], A206: ["PM10"], A205: ["PM2.5"], A102: ["TSP"],
    P201: ["LEQ"], P203: ["LEQ"], P204: ["LVD", "LVN"]
  };
  var RE_METHOD = /N\s*[I1l|]\s*[EB]\s*A\s*-?\s*([APW])\s*(\d{3})/i;
  /** findMethodItem(text) → {method, codes: [...], code: 唯一時之代碼 | null} | null */
  function findMethodItem(text) {
    var m = RE_METHOD.exec(norm(text));
    if (!m) return null;
    var key = m[1].toUpperCase() + m[2];
    var codes = METHOD_ITEMS[key];
    if (!codes) return { method: key, codes: [], code: null };
    return { method: key, codes: codes.slice(), code: codes.length === 1 ? codes[0] : null };
  }

  YF.dict = {
    norm: norm, normLight: normLight, hasCJK: hasCJK, isFiller: isFiller, isStarLike: isStarLike,
    levenshtein: levenshtein, levRatio: levRatio, dice: dice,
    ITEMS: ITEMS, itemInfo: itemInfo, itemLabel: itemLabel, findItems: findItems,
    STATS: STATS, findStat: findStat, combineStats: combineStats, statLabel: statLabel,
    UNITS: UNITS, findUnit: findUnit, unitLabel: unitLabel, convert: convert, convFactor: convFactor,
    parseValue: parseValue, parseValueUnit: parseValueUnit, formatNum: formatNum,
    isTimeRange: isTimeRange, parseRocDate: parseRocDate, formatDate: formatDate,
    parsePeriod: parsePeriod, quarterOf: quarterOf, rocYear: rocYear, dateInPeriod: dateInPeriod,
    normStation: normStation, stationCore: stationCore, stationSim: stationSim,
    findStationCapture: findStationCapture,
    METHOD_ITEMS: METHOD_ITEMS, findMethodItem: findMethodItem
  };
})(typeof window !== "undefined" ? window : globalThis);
