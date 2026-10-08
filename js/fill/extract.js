/* =========================================================================
 * Yang-analyze web — fill/extract.js
 * 填表核對：表格語意判讀（純邏輯，不碰 DOM）。
 * 原始資料表格 → Fact（每個量測數值：項目／統計別／單位／測站／日期／來源位置）；
 * 待填表格空白儲存格 → Slot（要填的項目／統計別／單位／測站／季別）。
 * 共用「列標題／欄標題」推論：向左找列標題、向上找欄標題（跳過數值、
 * 資料區內的 OCR 雜訊），合併儲存格依跨距涵蓋；排除標準值、方法、偵測極限、
 * 日期時間等欄；逐時列不擷取。測站依序取自：標題儲存格（與已知測站模糊比對）、
 * 「檢測位置」欄位、表頭大字串「監測位置：…」、同頁其他表、頁面文字、
 * 「現場編號」對照（同一份報告其他頁已知測站者），皆無則為無測站測點（pointNo）。
 * 掃描報告逐頁重複的同版面表格，空白（OCR 漏字）的表頭可向同構表格借用；
 * 同頁緊接在下方、欄位對齊且無表頭的表格（例：備註 NO2 表）沿用上方表頭。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};
  function D() {
    if (!YF.dict) throw new Error("fill/extract.js 需要先載入 fill/dict.js");
    return YF.dict;
  }

  /* ---------------- 規則 ---------------- */
  var RE_EXCL_COL = /標準|限值|法規|方法|偵測極限|檢測極限|定量極限|MDL|合格|排放量|基準|管制值|規範值/i;
  var RE_EXCL_COL_WEAK = /單位$|日期|時間|頁次|備註|削減率|編號/;   // 「監測日期：115.01.05」這類鍵值或整列標題不算
  var RE_EXCL_EMIT = /排放(?!濃度|速率|管道|口)/;      // 「排放標準」OCR 殘缺（排放 BR）亦排除
  var RE_EXCL_ROW = /標準|限值|基準|法規|管制值/;
  var RE_KV_STATION = /^(檢測|監測|採樣|量測)(位置|地點|點位|站名|站)$|^(測站|測點|監測點|採樣點|監測站)(名稱)?$|^站名$/;
  var RE_KV_ID = /^(現場|樣品|採樣)?[編綸給]號$|^(現場|樣品)(編號|代號)$/;
  var RE_KV_DATE = /^(檢測|監測|採樣|量測)(日期|時間)|^日期/;
  var RE_ID_CAPTURE = /(現場|樣品)\s*[編綸給]\s*號\s*[:]?\s*([A-Za-z0-9][A-Za-z0-9\-_.]{3,})/;
  var RE_DATE_KEY = /(監測|檢測|採樣|量測)\s*(日期|時間)/;
  var RE_PERIOD = /\d{2,4}\s*年.*季|\d{2,4}\s*[Qq][1-4]|\d{2,4}\s*年\s*\d{1,2}\s*月|\d{2,3}\.\d{1,2}\s*[~\-至]\s*\d{2,3}\.\d{1,2}/;
  var RE_TITLE_CUT = /空氣品質|噪音|振動|水質|河川|地下水|放流水|監測|歷次|調查|彙整|結果|檢測|測定|分析/;
  var RE_STATION_HEADER = /測站|站名|地點|位置|監測點|測點|採樣點|station/i;
  var RE_GENERIC_HEADER = /項目|測項|監測|檢測|單位|季別|數值|結果|日期|時間|名稱|備註|類別|方法|頻率|地點|位置|測站|站名|編號|說明|合計|平均|最大|最小|標準|限值|噪音|振動|空氣|水質|品質|狀況|天氣|氣象|條件|風向|風速|溫度|濕度|溼度|單位|說明|合格|附註|註|其他|計畫|委託|執行|頁|濃度|污染|值$|含量|數據|資料|紀錄|記錄|樣品|採樣|分析|檢驗|量測|測定|報告|總表|表$|統計|季$|月$|年$|合計|小計|總計|範圍|規定/;
  var RE_META_KEYS = /計畫名稱|現場[編綸給]號|監測位置|檢測位置|監測日期|檢測日期|委託單位|執行單位|報告編號/g;
  var NOTE_LEN = 48;
  var RE_POINT_LABEL = /^(測點|點位|採樣點|監測點|測站|點)\s*(No\.?|#)?\s*([一二三四五六七八九十]|\d{1,2})$|^#\s*\d{1,2}$|^No\.?\s*\d{1,2}$/i;
  var RE_CIRCLED = /[\u2460-\u2473\u2474-\u2487\u2488-\u249b\u24f5-\u24fe\u2776-\u2793\u3251-\u325f]/;
  function circledNo(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 0x2460 && c <= 0x2473) return c - 0x2460 + 1;
    if (c >= 0x2474 && c <= 0x2487) return c - 0x2474 + 1;
    if (c >= 0x2488 && c <= 0x249b) return c - 0x2488 + 1;
    if (c >= 0x24f5 && c <= 0x24fe) return c - 0x24f5 + 1;
    if (c >= 0x2776 && c <= 0x277f) return c - 0x2776 + 1;
    if (c >= 0x2780 && c <= 0x2789) return c - 0x2780 + 1;
    if (c >= 0x278a && c <= 0x2793) return c - 0x278a + 1;
    if (c >= 0x3251 && c <= 0x325f) return c - 0x3251 + 21;
    return null;
  }
  var CN_DIGIT = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

  function compact(s) { return D().norm(s).replace(/\s+/g, ""); }
  function stripLead(s) { return s.replace(/^[^\u3400-\u9fffA-Za-z0-9]+/, "").replace(/[^\u3400-\u9fffA-Za-z0-9)\]]+$/, ""); }

  /* =====================================================================
   * 已知測站
   * ===================================================================== */
  function knownList(stations) {
    var out = [], seen = {};
    (stations || []).forEach(function (s) {
      var name = typeof s === "string" ? s : (s && s.name);
      if (!name) return;
      name = D().norm(name);
      var key = D().normStation(name);
      if (!key || seen[key]) return;
      seen[key] = 1;
      var aliases = (s && typeof s === "object" && Array.isArray(s.aliases)) ? s.aliases.filter(Boolean).map(String) : [];
      out.push({ name: name, key: key, aliases: aliases });
    });
    return out;
  }
  function makeKnownMatcher(known) {
    var cache = {};
    return function bestKnown(text) {
      var k = String(text || "");
      if (Object.prototype.hasOwnProperty.call(cache, k)) return cache[k];
      var best = null;
      if (known.length && D().normStation(k)) {
        for (var i = 0; i < known.length; i++) {
          var s = D().stationSim(k, known[i].name);
          for (var j = 0; j < known[i].aliases.length; j++) s = Math.max(s, D().stationSim(k, known[i].aliases[j]));
          if (!best || s > best.sim) best = { name: known[i].name, sim: s };
        }
        if (best && best.sim < 0.6) best = null;
      }
      cache[k] = best;
      return best;
    };
  }

  /* =====================================================================
   * 表格前處理
   * ===================================================================== */
  var MAX_AREA = 20000000;
  function prepTable(table, role, warn) {
    var src = (table && table.cells) || [];
    var nR = 0, nC = 0;      // 依實際儲存格推算（不信任可能過大的 nRows/nCols）
    var cells = [];
    src.forEach(function (c) {
      if (!c) return;
      var r0 = c.r0 | 0, c0 = c.c0 | 0;
      var r1 = (c.r1 === undefined || c.r1 === null) ? r0 : c.r1 | 0, c1 = (c.c1 === undefined || c.c1 === null) ? c0 : c.c1 | 0;
      if (r0 < 0 || c0 < 0) return;
      if (r1 < r0) r1 = r0;
      if (c1 < c0) c1 = c0;
      if (r0 > 200000 || c0 > 4000) return;
      r1 = Math.min(r1, r0 + 2000); c1 = Math.min(c1, c0 + 500);
      cells.push({ cell: c, r0: r0, r1: r1, c0: c0, c1: c1 });
      if (r1 + 1 > nR) nR = r1 + 1;
      if (c1 + 1 > nC) nC = c1 + 1;
    });
    // 面積上限（約 80 MB 以內）：超過者只處理前段列
    if (nR * nC > MAX_AREA) {
      var keepR = Math.max(1, Math.floor(MAX_AREA / Math.max(1, nC)));
      cells = cells.filter(function (X) { return X.r0 < keepR; });
      cells.forEach(function (X) { if (X.r1 >= keepR) X.r1 = keepR - 1; });
      nR = keepR;
      if (warn) warn("表格過大，只判讀前 " + keepR + " 列");
    }
    var owner = new Int32Array(nR * nC);
    owner.fill(-1);
    var dict = D();
    cells.forEach(function (X, i) {
      X.idx = i;
      X.text = X.cell.text === null || X.cell.text === undefined ? "" : String(X.cell.text);
      X.n = dict.norm(X.text);
      var circ = RE_CIRCLED.exec(X.text);
      if (circ) X.circled = circledNo(circ[0]);
      if (!X.n) X.kind = "blank";
      else if (circ && X.n.replace(/[\s()（）.．、]/g, "").length <= 3) X.kind = "label";   // ①、(1) 等測點編號（NFKC 會變成數字）
      else if (dict.isFiller(X.n)) X.kind = "filler";
      else {
        X.pv = dict.parseValue(X.text);
        if (!X.pv.ok && /\d/.test(X.n) && X.n.length <= 24 && !/^0\d/.test(X.n) &&
          !dict.findItems(X.n, { weak: true }).length) {               // 「0 ppb」「03 (ppm)」是 O3 表頭
          var vu = dict.parseValueUnit(X.text);
          if (vu) { X.pv = vu.pv; X.unitInline = vu.unit; }
        }
        if (X.pv.ok) X.kind = "value";
        else {
          var meta = (X.n.match(RE_META_KEYS) || []).length;
          X.kind = (X.n.replace(/\s+/g, "").length > NOTE_LEN || meta >= 2) ? "note" : "label";
        }
      }
      for (var r = X.r0; r <= X.r1; r++) {
        for (var c = X.c0; c <= X.c1; c++) {
          if (owner[r * nC + c] < 0) owner[r * nC + c] = i;
        }
      }
    });
    var T = {
      table: table, role: role, nR: nR, nC: nC, cells: cells, owner: owner,
      parent: null, borrowed: 0
    };
    computeRows(T);
    return T;
  }
  function cellAt(T, r, c) {
    if (r < 0 || c < 0 || r >= T.nR || c >= T.nC) return null;
    var i = T.owner[r * T.nC + c];
    return i >= 0 ? T.cells[i] : null;
  }
  /** 資料列判定：raw＝該列有數值；template＝有數值或「內部空格」（左有標題、上有標題） */
  function computeRows(T) {
    var nR = T.nR, r;
    T.dataRow = new Array(nR);
    for (r = 0; r < nR; r++) T.dataRow[r] = false;
    T.cells.forEach(function (X) {
      var data = X.kind === "value" || (T.role === "template" && X.kind === "blank" && interiorBlank(T, X));
      X.dataCell = data;
      if (!data) return;
      for (var rr = X.r0; rr <= X.r1; rr++) T.dataRow[rr] = true;
    });
    T.firstDataRow = nR;
    for (r = 0; r < nR; r++) if (T.dataRow[r]) { T.firstDataRow = r; break; }
  }
  function interiorBlank(T, X) {
    if (X.r0 === 0 || X.c0 === 0) return false;
    var left = false, up = false, c, r;
    for (c = X.c0 - 1; c >= 0 && !left; c--) {
      var A = cellAt(T, X.r0, c);
      if (A && A !== X && A.kind === "label") left = true;
    }
    for (r = X.r0 - 1; r >= 0 && !up; r--) {
      var B = cellAt(T, r, X.c0);
      if (B && B !== X && B.kind === "label") up = true;
    }
    return left && up;
  }
  function isHeaderCell(T, X) { return X.r1 < T.firstDataRow; }
  function allRowsData(T, X) {
    for (var r = X.r0; r <= X.r1; r++) if (!T.dataRow[r]) return false;
    return true;
  }

  /* ---------------- 儲存格特徵（延遲計算） ---------------- */
  function feat(X) {
    if (X.f) return X.f;
    var dict = D(), n = X.n, f = {};
    f.items = dict.findItems(n, { weak: true });
    var st = dict.findStat(n);
    f.stat = st ? st.code : null;
    f.unit = dict.findUnit(n);
    f.time = dict.isTimeRange(n);
    f.method = dict.findMethodItem(n);
    f.period = RE_PERIOD.test(n) ? dict.parsePeriod(n) : null;
    var c = compact(n);
    f.capture = dict.findStationCapture(X.text);
    var kvish = /:\S/.test(c) || !!f.capture;      // 「監測日期：115.01.05」「方法：如下表」等鍵值文字
    f.exclCol = (RE_EXCL_COL.test(c) || RE_EXCL_EMIT.test(c)) && !(kvish && !/標準|限值/.test(c));
    f.exclColWeak = RE_EXCL_COL_WEAK.test(c) && !kvish;
    f.exclRow = RE_EXCL_ROW.test(c) && !kvish;
    var key = stripLead(c);
    f.kvStation = RE_KV_STATION.test(key);
    f.kvId = RE_KV_ID.test(key);
    f.kvDate = RE_KV_DATE.test(key);
    f.unitHeader = /^[(]?單位[)]?$|^unit$/i.test(key);
    X.f = f;
    return f;
  }
  /** 測站樣式的標題文字（無已知測站清單時使用） */
  function stationish(X) {
    if (X.kind !== "label") return false;
    var f = feat(X), c = compact(X.n);
    if (c.length < 2 || c.length > 24 || !D().hasCJK(c)) return false;
    if (f.items.length || f.stat || f.unit || f.period || f.time || f.method) return false;
    if (f.exclCol || f.exclRow || f.kvStation || f.kvId || f.kvDate) return false;
    if (RE_GENERIC_HEADER.test(c)) return false;
    if (X.circled || RE_POINT_LABEL.test(c)) return false;          // 「測點一」「#2」是測點序號，不是測站名
    if (/[:=]/.test(c)) return false;
    if (D().parseRocDate(c)) return false;
    return true;
  }

  /* ---------------- 列標題／欄標題 ---------------- */
  function rowLabelsOf(T, X) {
    var out = [], seen = {};
    for (var r = X.r0; r <= X.r1; r++) {
      for (var c = X.c0 - 1; c >= 0; c--) {
        var Y = cellAt(T, r, c);
        if (!Y || Y === X || seen[Y.idx]) continue;
        seen[Y.idx] = 1;
        if (Y.kind === "label" || Y.kind === "note") out.push({ X: Y, dist: X.c0 - Y.c1, axis: "row", T: T });
      }
    }
    out.sort(function (a, b) { return a.dist - b.dist || a.X.r0 - b.X.r0; });
    return out;
  }
  /** 欄 c 的跳表：J[r] = 列 r 以上最近一個「值得看」的列（表頭列，或資料區內的註記／跨列標題）。
   *  資料區內的數值與 OCR 雜訊一次跳過，大型工作表也不必逐列往上掃。 */
  function upJump(T, c) {
    var cache = T._up || (T._up = {});
    if (cache[c]) return cache[c];
    var nR = T.nR, J = new Int32Array(nR + 1), last = -1;
    for (var r = 0; r <= nR; r++) {
      J[r] = last;
      if (r === nR) break;
      var Y = cellAt(T, r, c);
      if (!T.dataRow[r] || (Y && (Y.kind === "note" || (Y.kind === "label" && !allRowsData(T, Y))))) last = r;
    }
    cache[c] = J;
    return J;
  }
  function headerLabelsOfColumn(T, c, fromRow, seen, out, baseDist) {
    if (fromRow < 0 || c >= T.nC) return;
    var J = upJump(T, c), phase = 0, prev = fromRow + 1;
    var r = J[Math.min(fromRow + 1, T.nR)];
    while (r >= 0) {
      if (phase === 1 && r < prev - 1) return;   // 已過表頭又跨過上一區塊的資料列 → 停止
      prev = r;
      var next = J[r], Y = cellAt(T, r, c);
      if (!Y) { r = next; continue; }
      if (seen[Y.idx]) { if (!T.dataRow[r] && Y.kind !== "note") phase = 1; r = next; continue; }
      seen[Y.idx] = 1;
      if (T.dataRow[r]) {
        if (phase === 1) return;
      } else if (Y.kind !== "note") phase = 1;    // 表頭中的長註記不構成表頭區（可穿過）
      if (Y.kind === "label" || Y.kind === "note") out.push({ X: Y, dist: baseDist + (fromRow + 1 - Y.r1), axis: "col", T: T });
      r = next;
    }
  }
  function colLabelsOf(T, X) {
    var out = [], seen = {};
    for (var c = X.c0; c <= X.c1; c++) {
      seen[X.idx] = 1;
      headerLabelsOfColumn(T, c, X.r0 - 1, seen, out, 0);
    }
    // 延續表格：沿用上方表格（同欄位）的表頭
    if (T.parent) {
      var P = T.parent, pseen = {};
      for (var c2 = X.c0; c2 <= X.c1 && c2 < P.nC; c2++) {
        headerLabelsOfColumn(P, c2, P.firstDataRow - 1, pseen, out, 1000);
      }
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }

  /* ---------------- 語意推論 ---------------- */
  function itemFrom(T, rl, cl, allLabels, X) {
    // secondary：非主軸（逐時表的列標題「日平均值或最頻風向」）中同時含統計別的標題不提供項目
    function first(list, secondary) {
      for (var i = 0; i < list.length; i++) {
        var L = list[i];
        if (L.X.kind !== "label") continue;
        var f = feat(L.X), h = f.items;
        if (h.length && !(secondary && f.stat)) return { code: h[0].code, generic: h[0].generic, L: L };
      }
      return null;
    }
    var rh = first(rl, T.orient === "cols"), ch = first(cl, T.orient === "rows"), hit = null;
    if (rh && ch && (rh.generic !== ch.generic)) {
      // 時段（日間/晚間/夜間）× 噪音指標：Leq → L日/L晚/L夜；其他指標（Lmax、L10…）取指標本身
      var per = rh.generic ? rh : ch, met = rh.generic ? ch : rh;
      hit = met.code === "LEQ" ? per : met;
    } else if (rh && ch) {
      if (T.orient === "cols") hit = ch;
      else if (T.orient === "rows") hit = rh;
      else hit = ch.L.dist < rh.L.dist ? ch : rh;
    } else hit = rh || ch;
    if (!hit) {
      var lists = [rl, cl];
      for (var k = 0; k < 2 && !hit; k++) {
        for (var i = 0; i < lists[k].length; i++) {
          var m = feat(lists[k][i].X).method;
          if (m && m.code) { hit = { code: m.code, generic: false, L: lists[k][i], viaMethod: true }; break; }
        }
      }
    }
    // 同列右側的「檢測方法編號」（例：值 4 → 同列 NIEA A205.11C → PM2.5），項目標籤 OCR 失敗時的備援
    if (!hit && X) {
      for (var rr = X.r0; rr <= X.r1 && !hit; rr++) {
        for (var cc = X.c1 + 1; cc < T.nC && !hit; cc++) {
          var Y = cellAt(T, rr, cc);
          if (!Y || Y === X || (Y.kind !== "label" && Y.kind !== "note")) continue;
          var mm = feat(Y).method;
          if (mm && mm.code) hit = { code: mm.code, generic: false, L: { X: Y, dist: 500 + cc - X.c1, axis: "row", T: T }, viaMethod: true };
        }
      }
    }
    if (!hit) return null;
    // 日間／夜間等通用詞：遇「振動」上下文改判振動項目
    var info = D().itemInfo(hit.code);
    if (hit.generic && info && info.vib) {
      var vib = allLabels.some(function (L) { return /振動|Lv/i.test(L.X.n); }) ||
        (/振動/.test(T.table.title || "") && !/噪音/.test(T.table.title || ""));
      if (vib) hit.code = info.vib;
    }
    return hit;
  }
  function statFrom(T, labels) {
    var list = labels.filter(function (L) { return L.X.kind === "label"; })
      .map(function (L) { return { s: feat(L.X).stat, d: L.dist }; })
      .filter(function (x) { return x.s; })
      .sort(function (a, b) { return a.d - b.d; });
    var acc = null;
    list.forEach(function (x) { acc = acc ? D().combineStats(acc, x.s) : x.s; });
    if ((acc === "max" || acc === "min") && T.hasTimeRows) acc = acc === "max" ? "max1h" : "min1h";
    if (acc === "avg") acc = T.hasTimeRows ? "daily" : "value";
    return acc || "value";
  }
  function unitFrom(T, X, itemHit, labels) {
    if (X.unitInline) return X.unitInline;
    if (itemHit && itemHit.L) {
      var u0 = feat(itemHit.L.X).unit;
      if (u0) return u0;
    }
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].X.kind !== "label") continue;
      var u = feat(labels[i].X).unit;
      if (u) return u;
    }
    // 「單位」欄
    for (var k = 0; k < T.unitCols.length; k++) {
      var Y = cellAt(T, X.r0, T.unitCols[k]);
      if (Y && Y !== X && Y.kind !== "blank") {
        var u2 = D().findUnit(Y.n);
        if (u2) return u2;
      }
    }
    return null;
  }
  function exclusionOf(T, X, rl, cl) {
    for (var i = 0; i < cl.length; i++) {
      var L = cl[i].X;
      if (L.kind !== "label") continue;
      var lf = feat(L);
      if (lf.exclCol) return "欄標題「" + L.n + "」";
      var wide = cl[i].T.nC >= 3 && (L.c1 - L.c0 + 1) >= 0.8 * cl[i].T.nC;
      if (lf.exclColWeak && !wide) return "欄標題「" + L.n + "」";
    }
    for (var j = 0; j < rl.length; j++) {
      if (rl[j].X.kind === "label" && feat(rl[j].X).exclRow) return "列標題「" + rl[j].X.n + "」";
    }
    if (T.limitCols && T.limitCols[X.c0]) return "標準值欄（多為 *）";
    return null;
  }
  function isTimeCell(labels) {
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].X.kind === "label" && feat(labels[i].X).time) return true;
    }
    return false;
  }

  /* ---------------- 表格層級分析 ---------------- */
  function analyzeTable(T) {
    var dict = D();
    T.unitCols = [];
    T.kvStations = [];
    T.sampleIds = [];
    T.dates = [];
    T.captures = [];
    T.hasTimeRows = false;
    T.timeRow = {};
    var rowItems = {}, colItems = {}, i;
    T.cells.forEach(function (X) {
      if (X.kind !== "label" && X.kind !== "note") return;
      var f = feat(X);
      if (X.kind === "label") {
        if (isHeaderCell(T, X)) {
          if (f.items.length) colItems[f.items[0].code] = 1;
          if (f.unitHeader && X.c0 === X.c1) T.unitCols.push(X.c0);
        } else if (f.items.length) {
          // 列標題區：該列第一個資料格左側
          var firstVal = T.nC;
          for (var c = 0; c < T.nC; c++) {
            var Y = cellAt(T, X.r0, c);
            if (Y && Y.dataCell) { firstVal = c; break; }
          }
          if (X.c1 < firstVal) rowItems[f.items[0].code] = 1;
        }
        if (f.time && !isHeaderCell(T, X)) {
          T.hasTimeRows = true;
          for (var tr = X.r0; tr <= X.r1; tr++) T.timeRow[tr] = true;
        }
      }
      // 鍵值對（檢測位置｜某測站、現場編號｜1150101AQ-1、檢測日期｜115.01.01…）
      if (f.kvStation || f.kvId || f.kvDate) {
        var V = kvValueCell(T, X);
        if (V) {
          if (f.kvStation && V.kind === "label" && kvStationValueOk(V)) { V.kvStation = true; T.kvStations.push(V); }
          if (f.kvId) T.sampleIds.push(normId(V.text));
          if (f.kvDate) { var d = dict.parseRocDate(V.text); if (d) T.dates.push({ d: d, w: 3 }); }
        }
      }
      if (f.capture) T.captures.push(f.capture);
      var idm = RE_ID_CAPTURE.exec(dict.normLight(X.text).replace(/：/g, ":"));
      if (idm) T.sampleIds.push(normId(idm[2]));
      if (RE_DATE_KEY.test(X.n) || (X.kind === "note" && /日\s*期/.test(X.n))) {
        var at = X.n.search(RE_DATE_KEY);
        if (at < 0) at = X.n.search(/日\s*期/);
        var d2 = dict.parseRocDate(X.n.slice(at));
        if (d2) T.dates.push({ d: d2, w: 2 });
      } else if (isHeaderCell(T, X) && X.kind === "label") {
        var d3 = dict.parseRocDate(X.n);
        if (d3) T.dates.push({ d: d3, w: 1 });
      }
    });
    var nc = Object.keys(colItems).length, nr = Object.keys(rowItems).length;
    T.orient = (nc >= 2 && nc > nr) ? "cols" : (nr >= 2 && nr > nc) ? "rows" : "dist";
    T.sampleIds = uniq(T.sampleIds.filter(Boolean));
    T.captures = uniq(T.captures);
    T.dates.sort(function (a, b) { return b.w - a.w; });
    // 逐時區段：第一個到最後一個時段列之間的列（時段文字 OCR 失敗者亦視為逐時）
    var trs = Object.keys(T.timeRow).map(Number).sort(function (a, b) { return a - b; });
    T.timeSpan = trs.length >= 3 ? [trs[0], trs[trs.length - 1]] : null;
    T.date = T.dates.length ? T.dates[0].d : null;
    // 標準值欄：非逐時資料列中，「*」等符號多於數值（raw）
    T.limitCols = {};
    T.keyCol = -1;
    if (T.role !== "template") {
      var stars = {}, vals = {}, ints = {};
      T.cells.forEach(function (Z) {
        if (Z.c0 !== Z.c1 || !allRowsData(T, Z) || T.timeRow[Z.r0]) return;
        if (Z.kind === "value") {
          vals[Z.c0] = (vals[Z.c0] || 0) + 1;
          (ints[Z.c0] = ints[Z.c0] || []).push(Z);
        } else if (D().isStarLike(Z.n)) stars[Z.c0] = (stars[Z.c0] || 0) + 1;
      });
      Object.keys(stars).forEach(function (c) { if (stars[c] >= 3 && stars[c] >= (vals[c] || 0)) T.limitCols[c] = true; });
      T.keyCol = findKeyColumn(T, ints);
    }
  }
  /** 以整數（時序 1~24、序號、年份）當列鍵的欄：其右側數值為時間序列，不擷取 */
  function findKeyColumn(T, ints) {
    var cols = Object.keys(ints).map(Number).sort(function (a, b) { return a - b; });
    for (var k = 0; k < cols.length; k++) {
      var c = cols[k], list = ints[c].slice().sort(function (a, b) { return a.r0 - b.r0; });
      if (list.length < 3) continue;
      if (!list.every(function (Z) { return Z.pv.decimals === 0 && !Z.pv.cmp && Z.pv.num >= 0 && Z.pv.num <= 9999; })) continue;
      // 這些列在此欄左側不可有標題（否則是一般的數值欄）
      var keyed = list.every(function (Z) {
        for (var cc = 0; cc < c; cc++) { var Y = cellAt(T, Z.r0, cc); if (Y && (Y.kind === "label" || Y.kind === "note")) return false; }
        return true;
      });
      if (!keyed) continue;
      var seq = 0;
      for (var i = 1; i < list.length; i++) if (list[i].pv.num - list[i - 1].pv.num === 1) seq++;
      var hdr = "";
      for (var r = 0; r < T.firstDataRow; r++) { var H = cellAt(T, r, c); if (H && H.kind === "label") hdr += H.n; }
      var timeHdr = /時間|小時|時段|時刻|hour|hr/i.test(compact(hdr));
      if (seq >= (list.length - 1) * 0.8 || timeHdr || /日期|序號|編號|項次|^no/i.test(compact(hdr))) {
        // 時序（1~24 時、或標題為時間）→ 本表的「平均」「最大值」列為日平均／最大小時值
        if (timeHdr || (list.length >= 12 && list[list.length - 1].pv.num <= 24)) T.hasTimeRows = true;
        return c;
      }
      return -1;
    }
    return -1;
  }
  /** 「檢測位置」右側的值須像測站名稱（記錄式表頭「測站｜項目｜…」的「項目」不是） */
  function kvStationValueOk(V) {
    var f = feat(V), c = compact(V.n);
    if (f.items.length || f.stat || f.unit || f.kvStation || f.kvId || f.kvDate || f.time) return false;
    return !RE_GENERIC_HEADER.test(c) || D().findStationCapture(V.n) !== null;
  }
  function kvValueCell(T, K) {
    for (var c = K.c1 + 1; c < T.nC; c++) {
      var V = cellAt(T, K.r0, c);
      if (!V || V === K) continue;
      if (V.kind === "blank" || V.kind === "filler") continue;
      return V;
    }
    // 直式：鍵在上、值在下
    var B = cellAt(T, K.r1 + 1, K.c0);
    if (B && B.kind === "label" && B.c0 === K.c0) return B;
    return null;
  }
  function normId(s) {
    return D().norm(s).replace(/\s+/g, "").toUpperCase().replace(/[^A-Z0-9\-]/g, "");
  }
  function uniq(a) {
    var out = [];
    a.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  /* ---------------- 同構表格借用表頭、延續表格 ---------------- */
  function spanKeys(T) {
    var s = {};
    T.cells.forEach(function (X) { s[X.r0 + "," + X.r1 + "," + X.c0 + "," + X.c1] = X; });
    return s;
  }
  function linkSiblings(Ts) {
    var groups = {};
    Ts.forEach(function (T) {
      var k = T.nR + "x" + T.nC;
      (groups[k] = groups[k] || []).push(T);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      var sigs = g.map(spanKeys);
      g.forEach(function (T, ti) {
        var blanks = T.cells.filter(function (X) { return X.kind === "blank" && isHeaderCell(T, X); });
        if (!blanks.length) return;
        var mine = sigs[ti], mineKeys = Object.keys(mine);
        var sibs = [];
        g.forEach(function (S, si) {
          if (si === ti) return;
          var other = sigs[si], shared = 0, ok = Object.keys(other);
          mineKeys.forEach(function (key) { if (other[key]) shared++; });
          if (shared / Math.max(mineKeys.length, ok.length) >= 0.9) sibs.push(other);
        });
        if (!sibs.length) return;
        blanks.forEach(function (X) {
          var key = X.r0 + "," + X.r1 + "," + X.c0 + "," + X.c1, votes = {}, best = null;
          sibs.forEach(function (o) {
            var Y = o[key];
            if (Y && Y.kind === "label") {
              var t = Y.n;
              votes[t] = (votes[t] || 0) + 1;
              if (!best || votes[t] > votes[best]) best = t;
            }
          });
          if (best) {
            X.borrowed = best; X.n = best; X.kind = "label"; X.f = null;
            T.borrowed++;
          }
        });
        if (T.borrowed) computeRows(T);
      });
    });
  }
  function bboxOf(T) {
    var b = null;
    T.cells.forEach(function (X) {
      var bb = X.cell.bbox;
      if (!bb) return;
      if (!b) b = { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 };
      else { b.x0 = Math.min(b.x0, bb.x0); b.y0 = Math.min(b.y0, bb.y0); b.x1 = Math.max(b.x1, bb.x1); b.y1 = Math.max(b.y1, bb.y1); }
    });
    return b;
  }
  function colEdges(T) {
    var xs = [];
    for (var c = 0; c < T.nC; c++) {
      var v = [];
      T.cells.forEach(function (X) { if (X.c0 === c && X.cell.bbox) v.push(X.cell.bbox.x0); });
      v.sort(function (a, b) { return a - b; });
      xs.push(v.length ? v[v.length >> 1] : null);
    }
    return xs;
  }
  function linkContinuations(Ts) {
    for (var i = 1; i < Ts.length; i++) {
      var T = Ts[i], P = Ts[i - 1];
      if (T.firstDataRow !== 0 || T.nC !== P.nC || T.nC < 2) continue;
      if (T.table.page === null || T.table.page === undefined || T.table.page !== P.table.page) continue;
      if (P.firstDataRow < 1) continue;                     // 上方表格須有表頭可沿用
      var bt = bboxOf(T), bp = bboxOf(P);
      if (!bt || !bp) {
        // 無座標（PDF 文字層等）：同頁緊接的下一個表格即視為延續
        if (!bt && !bp && T.table.index === P.table.index + 1) T.parent = P;
        continue;
      }
      var gap = bt.y0 - bp.y1;
      if (gap < -10 || gap > 300) continue;
      var et = colEdges(T), ep = colEdges(P), tol = Math.max(14, 0.015 * (bp.x1 - bp.x0)), n = 0, ok = true;
      for (var c = 0; c < T.nC; c++) {
        if (et[c] === null || ep[c] === null) continue;
        n++;
        if (Math.abs(et[c] - ep[c]) > tol) { ok = false; break; }
      }
      if (ok && n >= Math.max(2, Math.ceil(T.nC * 0.7))) T.parent = P;
    }
  }

  /* =====================================================================
   * Fact 擷取
   * ===================================================================== */
  function tableNo(table) {
    return (typeof table.index === "number" ? table.index : 0) + 1;
  }
  function whereOf(table, X) {
    var rc = "第" + (X.r0 + 1) + "列第" + (X.c0 + 1) + "欄";
    var ref = X.cell.ref;
    if (table.page !== null && table.page !== undefined) return "第" + table.page + "頁 表" + tableNo(table) + " " + rc;
    if (table.sheet) return "工作表「" + table.sheet + "」" + (ref && ref.addr ? " " + ref.addr : " 表" + tableNo(table) + " " + rc);
    return "表" + tableNo(table) + " " + rc;
  }
  function labelSummary(rl, cl) {
    var a = [];
    rl.concat(cl).forEach(function (L) {
      if (L.X.kind === "label" && a.length < 6 && a.indexOf(L.X.n) < 0) a.push(L.X.n);
    });
    return a.join(" / ");
  }
  function pointNoFrom(labels) {
    for (var i = 0; i < labels.length; i++) {
      var t = labels[i].X.n;
      if (labels[i].X.circled) return labels[i].X.circled;
      var m = /(測點|點位|採樣點|監測點|測站)\s*(?:No\.?|#)?\s*([一二三四五六七八九十]|\d{1,2})(?![0-9])/i.exec(t);
      if (m) return CN_DIGIT[m[2]] || parseInt(m[2], 10);
      m = /(?:^|[^A-Za-z0-9])#\s*(\d{1,2})(?![0-9])/.exec(t);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function extractTableFacts(T, doc, bestKnown, knownOn, out) {
    var table = T.table, dict = D();
    // 表格預設測站
    var tableStation = null;
    var kvTexts = uniq(T.kvStations.map(function (V) { return V.n; }));
    if (kvTexts.length === 1) tableStation = { raw: kvTexts[0], via: "kv", source: "pivot", cols: T.kvStations[0] };
    else if (!kvTexts.length && T.captures.length === 1) tableStation = { raw: T.captures[0], via: "note", source: "context" };
    else if (!kvTexts.length && T.captures.length > 1) {
      var kc = uniq(T.captures.map(function (c) { var b = bestKnown(c); return b ? b.name : null; }).filter(Boolean));
      if (kc.length === 1) tableStation = { raw: kc[0], via: "note", source: "context" };
    }
    if (!tableStation && T.parent && T.parent.tableStation) {
      tableStation = { raw: T.parent.tableStation.raw, via: "parent", source: "context", cols: T.parent.tableStation.cols };
    }
    T.tableStation = tableStation;
    if (!T.date && T.parent && T.parent.date) T.date = T.parent.date;
    if (!T.sampleIds.length && T.parent) T.sampleIds = T.parent.sampleIds.slice();

    var order = T.cells.slice().sort(function (a, b) { return a.r0 - b.r0 || a.c0 - b.c0; });
    order.forEach(function (X) {
      if (X.kind !== "value") return;
      var rl = rowLabelsOf(T, X), cl = colLabelsOf(T, X);
      if (isTimeCell(rl) || isTimeCell(cl)) return;          // 逐時資料不擷取
      if (exclusionOf(T, X, rl, cl)) return;
      if (T.keyCol >= 0 && X.c0 >= T.keyCol && !rl.some(function (L) { return L.X.kind === "label"; })) {
        if (X.c0 === T.keyCol) return;                        // 列鍵本身（時序 1~24、序號）
        var key = cellAt(T, X.r0, T.keyCol);
        if (key && key.kind === "value") return;           // 時序列（列鍵為整數）
      }
      var all = rl.concat(cl);
      var ih = itemFrom(T, rl, cl, all, X);
      if (!ih) return;
      var stat = statFrom(T, all);
      if (stat === "hourly") return;
      if (stat === "value" && T.timeSpan && X.r0 >= T.timeSpan[0] && X.r1 <= T.timeSpan[1]) return;
      var unit = unitFrom(T, X, ih, all.slice().sort(function (a, b) { return a.dist - b.dist; }));
      // 測站：標題儲存格（鍵值或與已知測站相符者，近者優先）
      var st = null;
      var lab = all.slice().sort(function (a, b) { return a.dist - b.dist; });
      for (var i = 0; i < lab.length && !st; i++) {
        var L = lab[i].X;
        if (L.kind !== "label" || L === ih.L.X) continue;
        if (L.kvStation) { st = { raw: L.n, via: "kv", source: "pivot" }; break; }
        var lf = feat(L);
        if (lf.items.length || lf.stat || lf.time || lf.unit) continue;
        if (knownOn) {
          var b = bestKnown(L.n);
          if (b) st = { raw: L.n, via: "label", source: rowStationSource(T, lab[i]) };
        } else if (stationish(L) && (lab[i].axis === "col" || RE_STATION_HEADER.test(colHeaderText(T, L)))) {
          st = { raw: L.n, via: "label", source: rowStationSource(T, lab[i]) };
        }
      }
      // 表格預設測站（「檢測位置」只套用到其值所在欄）
      if (!st && tableStation && (!tableStation.cols || (X.c1 >= tableStation.cols.c0 && X.c0 <= tableStation.cols.c1))) {
        st = { raw: tableStation.raw, via: tableStation.via, source: tableStation.source };
      }
      var fact = {
        id: null, docId: doc.id, docName: doc.name, tableId: table.id, page: table.page === undefined ? null : table.page,
        sheet: table.sheet || null, r: X.r0, c: X.c0, r1: X.r1, c1: X.c1, cellText: X.text,
        item: ih.code, stat: stat, unit: unit,
        station: null, stationRaw: st ? st.raw : null, stationKey: null, stationVia: st ? st.via : null, pointNo: null,
        value: X.pv.value, num: X.pv.num, cmp: X.pv.cmp, nd: !!X.pv.nd, decimals: X.pv.decimals,
        date: T.date ? dict.formatDate(T.date) : null,
        conf: X.cell.conf === undefined ? null : X.cell.conf, bbox: X.cell.bbox || null,
        source: st ? st.source : "point", where: whereOf(table, X), labels: labelSummary(rl, cl),
        ref: X.cell.ref || null
      };
      fact._T = T;
      fact._cols = cl.map(function (L) { return (L.T === T ? "" : "p") + L.X.idx; });
      fact._pointHint = pointNoFrom(rl.concat(cl));
      out.push(fact);
    });
  }
  function colHeaderText(T, L) {
    // 該儲存格所在欄最上方的表頭文字（記錄式表格「測站」欄）
    for (var r = 0; r < T.firstDataRow; r++) {
      var Y = cellAt(T, r, L.c0);
      if (Y && Y.kind === "label") return Y.n;
    }
    return "";
  }
  function rowStationSource(T, L) {
    if (L.axis === "row" && RE_STATION_HEADER.test(colHeaderText(T, L.X))) return "row";
    return "pivot";
  }

  /** 測站文字 → 已知測站（或保留原文） */
  function resolveStation(f, bestKnown, knownOn) {
    if (!f.stationRaw) { f.station = null; f.stationSim = null; return; }
    if (knownOn) {
      var b = bestKnown(f.stationRaw);
      if (b) { f.station = b.name; f.stationSim = b.sim; f._known = true; return; }
      f.station = f.stationRaw; f.stationSim = 0; f._known = false;
      return;
    }
    f.station = f.stationRaw;
    f.stationSim = 1;
    f._known = D().hasCJK(f.stationRaw) && D().normStation(f.stationRaw).length >= 2;
  }

  /** 現場編號 → 測站（同一文件內，已知測站的表格學得對照） */
  function applySampleIds(Ts, facts, bestKnown, knownOn) {
    var map = {}, conflict = {};
    Ts.forEach(function (T) {
      if (T.sampleIds.length !== 1) return;
      var names = uniq(facts.filter(function (f) { return f._T === T && f._known; }).map(function (f) { return f.station; }));
      if (names.length !== 1) return;
      var id = T.sampleIds[0];
      if (map[id] && map[id] !== names[0]) conflict[id] = 1;
      map[id] = names[0];
    });
    Object.keys(conflict).forEach(function (k) { delete map[k]; });
    var ids = Object.keys(map);
    if (!ids.length) return;
    function splitId(id) {
      var m = /^(.*[A-Za-z0-9])[\-_]([A-Za-z0-9]+)$/.exec(id);
      return m ? { head: m[1], tail: m[2] } : null;
    }
    function lookup(id) {
      if (map[id]) return map[id];
      if (id.length < 6) return null;
      // 容許 1 字 OCR 差異，但必須唯一指向同一測站；有「-序號」者序號須完全相同
      var sp = splitId(id), names = {};
      ids.forEach(function (k) {
        if (Math.abs(k.length - id.length) > 1) return;
        var d;
        if (sp) {
          var sk = splitId(k);
          if (!sk || sk.tail !== sp.tail) return;
          d = D().levenshtein(sk.head, sp.head);
        } else d = D().levenshtein(k, id);
        if (d <= 1) names[map[k]] = 1;
      });
      var list = Object.keys(names);
      return list.length === 1 ? list[0] : null;
    }
    Ts.forEach(function (T) {
      if (T.sampleIds.length !== 1) return;
      var name = lookup(T.sampleIds[0]);
      if (!name) return;
      facts.forEach(function (f) {
        if (f._T !== T || f._known) return;
        f.stationRaw = f.stationRaw || name;
        f.station = name; f.stationSim = 1; f._known = true;
        // 測站欄位本身在表頭（只是 OCR 失敗）→ 保留版面來源等級
        if (f.source !== "pivot" && f.source !== "row") f.source = "context";
        f.stationVia = "sampleId";
        f.sampleId = T.sampleIds[0];
      });
    });
  }

  /** 表名／工作表名稱／頁面文字 → 無測站的數值
   *  （不沿用同頁其他表格的測站：同頁可能是不同報告，寧可交由使用者對應） */
  function applyContextStations(facts, bestKnown, knownOn) {
    facts.forEach(function (f) {
      if (f.station) return;
      var ctx = contextStation(f._T, bestKnown, knownOn);
      if (ctx) {
        f.stationRaw = ctx.raw; f.stationVia = "context"; f.source = "context";
        resolveStation(f, bestKnown, knownOn);
      }
    });
  }
  /* 同一頁其他表格恰好只出現一個測站 → 本頁無測站的數值（例：測定條件表的風速/溫濕度）歸該測站 */
  function applyPageStations(facts, bestKnown, knownOn) {
    var byPage = {};
    facts.forEach(function (f) {
      if (f.page === null || f.page === undefined) return;
      var g = byPage[f.page] || (byPage[f.page] = { st: {}, n: 0, orphans: [] });
      if (f.station) { if (!g.st[f.station]) { g.st[f.station] = f; g.n++; } }
      else g.orphans.push(f);
    });
    Object.keys(byPage).forEach(function (pg) {
      var g = byPage[pg];
      if (g.n !== 1 || !g.orphans.length) return;
      var name = Object.keys(g.st)[0], src = g.st[name];
      g.orphans.forEach(function (f) {
        // 同項目已有該測站數值時不併入（避免把同頁其他測點誤歸同一測站）
        if (facts.some(function (o) { return o.station === name && o.item === f.item && o.page === f.page; })) return;
        f.stationRaw = src.stationRaw || name; f.stationVia = "page"; f.source = "context";
        resolveStation(f, bestKnown, knownOn);
      });
    });
  }
  function contextStation(T, bestKnown, knownOn) {
    if (T._ctxStation !== undefined) return T._ctxStation;
    var res = null, table = T.table;
    var lines = [];
    if (table.title) lines.push(table.title);
    if (table.sheet) lines.push(table.sheet);
    (table.context || []).forEach(function (l) { if (l) lines.push(typeof l === "string" ? l : (l.text || "")); });
    var caps = [];
    lines.forEach(function (l) {
      var c = D().findStationCapture(l);
      if (c) caps.push(c);
    });
    caps = uniq(caps);
    if (caps.length === 1) res = { raw: caps[0] };
    else if (caps.length > 1 && knownOn) {
      var kn = uniq(caps.map(function (c) { var b = bestKnown(c); return b ? b.name : null; }).filter(Boolean));
      if (kn.length === 1) res = { raw: kn[0] };
    }
    if (!res && knownOn) {
      // 標題／工作表名稱／頁面短句恰含一個已知測站
      var found = [];
      lines.forEach(function (l) {
        var t = D().normStation(l);
        if (!t) return;
        var hits = [];
        T._knownList.forEach(function (k) { if (k.key.length >= 2 && t.indexOf(k.key) >= 0) hits.push(k); });
        if (hits.length) {
          hits.sort(function (a, b) { return b.key.length - a.key.length; });
          var distinct = hits.filter(function (h) { return hits[0].key.indexOf(h.key) < 0; });
          if (!distinct.length) found.push(hits[0].name);
          else found.push(null);
        } else if (t.length <= 20) {
          var b = bestKnown(l);
          if (b && b.sim >= 0.75) found.push(b.name);
        }
      });
      found = uniq(found);
      if (found.length === 1 && found[0]) res = { raw: found[0] };
    }
    T._ctxStation = res;
    return res;
  }

  /** 同列重複（同項目/統計/單位，右側欄沒有自己的表頭，測站相同或不明）→ 保留最左者
   *  （表頭 OCR 漏字的「空氣品質標準」欄等） */
  function dedupeRows(facts) {
    var groups = {}, drop = {};
    facts.forEach(function (f, i) {
      var k = [f.docId, f.tableId, f.r, f.item, f.stat, f.unit || ""].join("|");
      (groups[k] = groups[k] || []).push(i);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      g.sort(function (a, b) { return facts[a].c - facts[b].c; });
      var keep = facts[g[0]], keepCols = {};
      keep._cols.forEach(function (c) { keepCols[c] = 1; });
      for (var j = 1; j < g.length; j++) {
        var f = facts[g[j]];
        var own = f._cols.some(function (c) { return !keepCols[c]; });
        if (!own && (!f.station || !keep.station || f.station === keep.station)) drop[g[j]] = 1;
      }
    });
    return facts.filter(function (f, i) { return !drop[i]; });
  }

  function stationKeyOf(f) {
    if (f.station) return D().norm(f.station);
    return "#" + f.item + "#" + (f.pointNo || 0);
  }
  /** 無測站數值：測點序號（標籤內 ①②、測點一… 優先，否則依出現順序） */
  function assignPoints(facts) {
    var groups = {};
    facts.forEach(function (f) {
      if (f.station) return;
      var k = f.docId + "|" + f.item + "|" + f.stat;
      (groups[k] = groups[k] || []).push(f);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var explicit = g.every(function (f) { return f._pointHint; });
      var used = {};
      if (explicit) {
        g.forEach(function (f) { if (used[f._pointHint]) explicit = false; used[f._pointHint] = 1; });
      }
      g.forEach(function (f, i) { f.pointNo = explicit ? f._pointHint : i + 1; });
    });
  }

  function facts(doc, opts) {
    opts = opts || {};
    if (!doc || !doc.tables) return [];
    var known = knownList(opts.stations), knownOn = known.length > 0;
    var bestKnown = makeKnownMatcher(known);
    var warn = function (m) { if (Array.isArray(doc.warnings) && doc.warnings.indexOf(m) < 0) doc.warnings.push(m); };
    var Ts = doc.tables.map(function (t) {
      var T = prepTable(t, "raw", warn);
      T._knownList = known;
      return T;
    });
    linkSiblings(Ts);
    Ts.forEach(analyzeTable);
    linkContinuations(Ts);
    var out = [];
    Ts.forEach(function (T) { extractTableFacts(T, doc, bestKnown, knownOn, out); });
    out.forEach(function (f) { resolveStation(f, bestKnown, knownOn); });
    applySampleIds(Ts, out, bestKnown, knownOn);
    applyContextStations(out, bestKnown, knownOn);
    applyPageStations(out, bestKnown, knownOn);
    out = dedupeRows(out);
    assignPoints(out);
    var seen = {};
    out.forEach(function (f) {
      if (!f.station) { f.source = "point"; f.stationVia = null; }
      f.stationKey = stationKeyOf(f);
      var id = f.docId + "|" + f.tableId + "|" + f.r + "," + f.c;
      while (seen[id]) id += "'";
      seen[id] = 1;
      f.id = id;
      delete f._T; delete f._cols; delete f._pointHint; delete f._known;
    });
    return out;
  }

  /* =====================================================================
   * Slot 擷取（待填表格）
   * ===================================================================== */
  function stationFromText(text, known, bestKnown) {
    var t = D().norm(text);
    if (!t) return null;
    if (known.length) {
      var key = D().normStation(t), hits = [];
      known.forEach(function (k) { if (k.key.length >= 2 && key.indexOf(k.key) >= 0) hits.push(k); });
      if (hits.length) {
        hits.sort(function (a, b) { return b.key.length - a.key.length; });
        return hits[0].name;
      }
    }
    var s = t.replace(/^\s*附?(表|圖)\s*[\dA-Za-z.\-－–一二三四五六七八九十、]+(\s*[(][^)]*[)])?\s*/, "")
      .replace(/^[(]?[一二三四五六七八九十\d]{1,3}[)、.]\s*/, "");
    var cut = s.search(RE_TITLE_CUT);
    if (cut < 0) {
      if (known.length && s.length <= 20) { var w = bestKnown(s); if (w && w.sim >= 0.75) return w.name; }
      return null;
    }
    s = s.slice(0, cut).replace(/[\s:：,，、\-–_()]+$/g, "").replace(/^[\s:：,，、\-–_()]+/g, "");
    if (s.length < 2 || s.length > 24 || !D().hasCJK(s)) return null;
    if (known.length) {
      var b = bestKnown(s);
      if (b) return b.name;
    }
    return s;
  }
  function tableTitleStation(table, known, bestKnown) {
    var cands = [];
    if (table.title) cands.push(table.title);
    var ctx = (table.context || []).map(function (l) { return typeof l === "string" ? l : (l && l.text) || ""; });
    for (var i = ctx.length - 1; i >= 0; i--) if (ctx[i] && ctx[i] !== table.title) cands.push(ctx[i]);
    if (table.sheet) cands.push(table.sheet);
    for (var j = 0; j < cands.length; j++) {
      var s = stationFromText(cands[j], known, bestKnown);
      if (s) return s;
    }
    return null;
  }
  function slots(doc, opts) {
    opts = opts || {};
    if (!doc || !doc.tables) return [];
    var known = knownList(opts.stations), knownOn = known.length > 0;
    var bestKnown = makeKnownMatcher(known);
    var out = [], dict = D();
    var warn = function (m) { if (Array.isArray(doc.warnings) && doc.warnings.indexOf(m) < 0) doc.warnings.push(m); };
    doc.tables.forEach(function (table, ti) {
      var T = prepTable(table, "template", warn);
      analyzeTable(T);
      var titleSt = tableTitleStation(table, known, bestKnown);
      var kvSt = uniq(T.kvStations.map(function (V) { return V.n; }));
      var title = table.title || ((table.context || [])[0]) || ("表格 " + (ti + 1));
      if (typeof title !== "string") title = String(title.text || "");
      T.cells.slice().sort(function (a, b) { return a.r0 - b.r0 || a.c0 - b.c0; }).forEach(function (X) {
        if (X.kind !== "blank") return;
        var rl = rowLabelsOf(T, X), cl = colLabelsOf(T, X);
        if (!rl.length && !cl.length) return;
        if (exclusionOf(T, X, rl, cl)) return;
        if (isTimeCell(rl) || isTimeCell(cl)) return;
        var all = rl.concat(cl);
        var ih = itemFrom(T, rl, cl, all);
        if (!ih) return;
        var byDist = all.slice().sort(function (a, b) { return a.dist - b.dist; });
        var stat = statFrom(T, all);
        var unit = unitFrom(T, X, ih, byDist), unitSrc = "header";
        if (!unit) {
          var info = dict.itemInfo(ih.code);
          unit = info ? info.unit : null;
          unitSrc = unit ? "default" : null;
        }
        var period = null, periodInfo = null;
        for (var p = 0; p < byDist.length && !period; p++) {
          var pf = byDist[p].X.kind === "label" ? feat(byDist[p].X).period : null;
          if (pf) { period = byDist[p].X.n; periodInfo = pf; }
        }
        // 測站：表內標題（樞紐/記錄式）> 表名 > 「檢測位置」欄位
        var station = null, stSrc = null;
        for (var i = 0; i < byDist.length && !station; i++) {
          var L = byDist[i].X;
          if (L.kind !== "label" || L === ih.L.X) continue;
          if (L.kvStation) { station = L.n; stSrc = "kv"; break; }
          var lf = feat(L);
          if (lf.items.length || lf.stat || lf.unit || lf.period || lf.time) continue;
          if (knownOn) {
            var b = bestKnown(L.n);
            if (b && b.sim >= 0.75) { station = b.name; stSrc = "label"; }
          } else if (stationish(L) && (RE_STATION_HEADER.test(colHeaderText(T, L)) ||
            (byDist[i].axis !== ih.L.axis && (byDist[i].axis === "col" || T.orient === "cols")))) {
            station = L.n; stSrc = "label";
          }
        }
        if (!station && T.captures.length === 1) {
          var cb = knownOn ? bestKnown(T.captures[0]) : null;
          station = cb ? cb.name : T.captures[0]; stSrc = "note";
        }
        if (!station && titleSt) { station = titleSt; stSrc = "title"; }
        if (!station && kvSt.length === 1) {
          station = knownOn && bestKnown(kvSt[0]) ? bestKnown(kvSt[0]).name : kvSt[0]; stSrc = "kv";
        }
        if (station && knownOn && stSrc === "kv") {
          var kb = bestKnown(station);
          if (kb) station = kb.name;
        }
        var headers = cl.filter(function (L) { return L.X.kind === "label"; })
          .sort(function (a, b) { return b.dist - a.dist; }).map(function (L) { return L.X.n; });
        var rowLabels = rl.filter(function (L) { return L.X.kind === "label"; })
          .sort(function (a, b) { return b.dist - a.dist; }).map(function (L) { return L.X.n; });
        out.push({
          id: doc.id + "|" + table.id + "|" + X.r0 + "," + X.c0,
          docId: doc.id, docName: doc.name, tableId: table.id, tableIndex: ti,
          r: X.r0, c: X.c0, r1: X.r1, c1: X.c1, ref: X.cell.ref === undefined ? null : X.cell.ref,
          item: ih.code, stat: stat, unit: unit, unitFrom: unitSrc,
          station: station, stationKey: station ? dict.norm(station) : null, stationFrom: stSrc,
          period: period, periodInfo: periodInfo,
          headers: headers, rowLabels: rowLabels, title: title,
          label: title + "｜" + headers.join(" ") + (rowLabels.length ? "｜" + rowLabels.join(" ") : "")
        });
      });
    });
    return out;
  }
  /** 待填表格推得的測站名稱（表名、表內測站標題），依出現順序 */
  function templateStations(doc, opts) {
    opts = opts || {};
    if (!doc || !doc.tables) return [];
    var known = knownList(opts.stations), bestKnown = makeKnownMatcher(known);
    var names = [];
    function add(n) {
      if (!n) return;
      var key = D().normStation(n);
      if (!key) return;
      for (var i = 0; i < names.length; i++) if (D().normStation(names[i]) === key) return;
      names.push(n);
    }
    var sl = slots(doc, opts);
    doc.tables.forEach(function (table) {
      add(tableTitleStation(table, known, bestKnown));
      sl.forEach(function (s) { if (s.tableId === table.id) add(s.station); });
    });
    return names;
  }

  /* ---------------- 除錯 ---------------- */
  function explainCell(table, r, c, opts) {
    opts = opts || {};
    var T = prepTable(table, opts.role || "raw");
    analyzeTable(T);
    var X = cellAt(T, r, c);
    if (!X) return null;
    var rl = rowLabelsOf(T, X), cl = colLabelsOf(T, X), all = rl.concat(cl);
    var ih = itemFrom(T, rl, cl, all);
    return {
      kind: X.kind, text: X.text, value: X.pv ? X.pv.value : null,
      rowLabels: rl.map(function (L) { return L.X.n; }), colLabels: cl.map(function (L) { return L.X.n; }),
      item: ih ? ih.code : null, stat: statFrom(T, all),
      unit: unitFrom(T, X, ih, all.slice().sort(function (a, b) { return a.dist - b.dist; })),
      excluded: exclusionOf(T, X, rl, cl), time: isTimeCell(rl) || isTimeCell(cl),
      orient: T.orient, firstDataRow: T.firstDataRow, tableStation: T.kvStations.map(function (V) { return V.n; }),
      captures: T.captures, sampleIds: T.sampleIds
    };
  }

  YF.extract = {
    facts: facts, slots: slots, templateStations: templateStations, explainCell: explainCell,
    stationKeyOf: stationKeyOf,
    _internal: { prepTable: prepTable, analyzeTable: analyzeTable, rowLabelsOf: rowLabelsOf, colLabelsOf: colLabelsOf }
  };
})(typeof window !== "undefined" ? window : globalThis);
