/* =========================================================================
 * Yang-analyze web — fill/match.js
 * 填表核對：空格（Slot）與原始數值（Fact）配對（純邏輯，不碰 DOM）。
 * 條件：同項目、統計別相容（範本「小時平均值」= 原始「最大小時平均值」…）、
 * 同測站（模糊比對，且須為該數值最相符的範本測站；或使用者指定的測點對應）、
 * 日期落在範本季別內。單位不同時換算（ppb→ppm、mg/m³→μg/m³），不可換算者不採用。
 * 排序：單位相同 > 可換算 > 單位不明；統計別優先序；測站相似度；
 * 來源（表頭測站 > 既有模組 > 記錄式 > 頁面文字 > 測點）；OCR 信心。
 * 交叉核對：另一張表格的數值在較粗精度的半個單位內一致 → checked；
 * 同優先序但數值不一致 → conflict；僅一個來源 → auto；
 * 沒有候選但有無測站的同項目數值 → mapping（待使用者指定測點）；其餘 → missing。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};
  function D() {
    if (!YF.dict) throw new Error("fill/match.js 需要先載入 fill/dict.js");
    return YF.dict;
  }

  var DEFAULT_RULES = {
    statMap: {
      h1: ["max1h", "h1"], max1h: ["max1h"], h8: ["max8h", "h8"], max8h: ["max8h"],
      daily: ["daily"], min1h: ["min1h"], annual: ["annual"], value: ["value", "daily", "max1h"],
      min8h: ["min8h"], avg8h: ["avg8h"], maxDaily: ["maxDaily"], max: ["max", "max1h"], min: ["min", "min1h"]
    },
    itemMap: {},            // 範本項目 → 也可接受的原始項目，例：{ NMHC: ["NMHC"] }
    minStationSim: 0.6,
    lowConf: 60,            // OCR 信心度低於此值的單一來源 → 需核對
    maxMappingPoints: 40,   // 無測站的「測點」超過此數（多為逐時／逐日數列）不要求使用者逐點對應
    valueFallback: true,    // 無相容統計別時，可用「統計別不明」（value）的數值（狀態不會是 checked）
    sourceRank: { pivot: 0, module: 1, row: 2, context: 3, point: 4 }
  };
  function mergeRules(r) {
    var out = {}, k;
    for (k in DEFAULT_RULES) out[k] = DEFAULT_RULES[k];
    if (r) for (k in r) if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k];
    return out;
  }

  function stationKeyOf(f) {
    if (!f) return "";
    if (f.station) return D().norm(f.station);
    return "#" + f.item + "#" + (f.pointNo || 0);
  }
  function keyOf(f) { return f.stationKey || stationKeyOf(f); }
  function sameStation(a, b) {
    if (!a || !b) return false;
    return D().normStation(a) === D().normStation(b) || D().stationSim(a, b) >= 0.95;
  }

  /* ---------------- 數值一致性 ---------------- */
  function decimalsOf(s) {
    var m = /\.(\d+)/.exec(String(s));
    return m ? m[1].length : 0;
  }
  function toNumObj(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === "number") return isFinite(x) ? { num: x, decimals: decimalsOf(x), cmp: "" } : null;
    if (typeof x === "string") {
      var pv = D().parseValue(x);
      return pv.ok ? { num: pv.num, decimals: pv.decimals, cmp: pv.cmp } : null;
    }
    if (typeof x === "object") {
      if (x.cmp === "ND") return { num: null, decimals: 0, cmp: "ND" };
      if (typeof x.num === "number" && isFinite(x.num)) {
        return { num: x.num, decimals: x.decimals !== undefined && x.decimals !== null ? x.decimals : decimalsOf(x.value || x.num), cmp: x.cmp || "" };
      }
      if (x.value !== undefined) return toNumObj(String(x.value));
    }
    return null;
  }
  /** consistent(a, b)：數值在較粗精度的半個單位內（0.012 vs 0.0115 一致；2.2 vs 2.20 一致） */
  function consistent(a, b) {
    var A = toNumObj(a), B = toNumObj(b);
    if (!A || !B) return false;
    if (A.cmp === "ND" || B.cmp === "ND") {
      return A.cmp === B.cmp || A.cmp === "<" || B.cmp === "<";
    }
    var tol = 0.5 * Math.pow(10, -Math.min(A.decimals || 0, B.decimals || 0));
    tol = tol * (1 + 1e-6) + 1e-12;
    if (A.cmp === "<" && B.cmp === "<") return Math.abs(A.num - B.num) <= tol;
    if (A.cmp === "<") return !B.cmp && B.num < A.num + tol;
    if (B.cmp === "<") return !A.cmp && A.num < B.num + tol;
    if (A.cmp === ">" && B.cmp === ">") return Math.abs(A.num - B.num) <= tol;
    if (A.cmp === ">") return !B.cmp && B.num > A.num - tol;
    if (B.cmp === ">") return !A.cmp && A.num > B.num - tol;
    return Math.abs(A.num - B.num) <= tol;
  }

  /* ---------------- 單位換算後的數值文字 ---------------- */
  function sigDigits(s) {
    var t = String(s).replace(/^[<>-]/, "").replace(".", "").replace(/^0+/, "");
    return t.length;
  }
  function convertValue(f, factor) {
    if (factor === 1) return { value: f.value, num: f.num, decimals: f.decimals || 0, cmp: f.cmp || "" };
    if (f.cmp === "ND" || f.nd) return { value: "ND", num: null, decimals: 0, cmp: "ND" };
    if (typeof f.num !== "number" || !isFinite(f.num)) return null;
    var n = f.num * factor;
    var shift = Math.round(-Math.log(factor) / Math.LN10);
    var dec = Math.max(0, Math.min(10, (f.decimals || 0) + shift));
    var s = n.toFixed(dec);
    var sd = sigDigits(s);
    if (sd > 4 && dec > 0) { dec = Math.max(0, dec - (sd - 4)); s = n.toFixed(dec); }
    return { value: (f.cmp === "<" || f.cmp === ">" ? f.cmp : "") + s, num: n, decimals: dec, cmp: f.cmp || "" };
  }

  /* =====================================================================
   * 配對
   * ===================================================================== */
  function run(slots, facts, opts) {
    opts = opts || {};
    var rules = mergeRules(opts.rules);
    var aliases = opts.aliases || {};
    var manual = opts.manual || {}, picks = opts.picks || {};
    var dict = D();
    slots = slots || [];
    facts = (facts || []).filter(function (f) { return f && f.item; });

    var ordOf = new Map();
    facts.forEach(function (f, i) { ordOf.set(f, i); });
    var slotStations = [];
    slots.forEach(function (s) {
      if (s.station && !slotStations.some(function (x) { return x === s.station; })) slotStations.push(s.station);
    });
    function aliasOf(f) {
      var k = keyOf(f);
      var a = Object.prototype.hasOwnProperty.call(aliases, k) ? aliases[k] : null;
      return (typeof a === "string" && a) ? a : null;
    }
    var sim = dict.stationSim;   // 內建快取
    // 測站名稱中的編號（AQ-1、第二測站）：編號不同者必不相同，先行過濾以免大量兩兩比對
    function digitsOf(name) { return (dict.normStation(name).match(/[0-9]+|[一二三四五六七八九十]+/g) || []).join(","); }
    var slotInfo = slotStations.map(function (st) { return { name: st, digits: digitsOf(st) }; });
    function comparable(f) {
      var d = digitsOf(f.station);
      return slotInfo.filter(function (x) { return !d || !x.digits || x.digits === d; });
    }
    // 數值的測站 → 最相符的範本測站
    var bestCache = Object.create(null);
    function bestFor(f) {
      var k = f.station || "";
      if (bestCache[k]) return bestCache[k];
      var best = { sim: 0, name: null };
      if (f.station) {
        comparable(f).forEach(function (x) {
          var v = sim(f.station, x.name);
          if (v > best.sim) best = { sim: v, name: x.name };
        });
      }
      bestCache[k] = best;
      return best;
    }
    function stationMatch(f, slot) {
      var al = aliasOf(f);
      if (al) return (sameStation(al, slot.station) || !slot.station) ? { sim: 1, via: "alias" } : null;
      if (!slot.station) return { sim: f.station ? 0.5 : 0.3, via: "nostation" };
      if (!f.station) return null;
      var s = sim(f.station, slot.station);
      if (s < rules.minStationSim) return null;
      var b = bestFor(f);
      if (s >= b.sim - 0.05 || (b.name && sim(slot.station, b.name) >= 0.9)) return { sim: s, via: "name" };
      return null;
    }
    // 索引：項目 → { all, byStation: {範本測站: [facts]}, unmapped: [無測站或對不到任何範本測站者] }
    var eligCache = Object.create(null), aliasElig = Object.create(null), index = Object.create(null);
    function eligibleStations(f) {
      var al = aliasOf(f);
      if (al) {
        if (!aliasElig[al]) aliasElig[al] = slotStations.filter(function (s) { return sameStation(al, s); });
        return aliasElig[al];
      }
      if (!f.station) return null;
      if (eligCache[f.station]) return eligCache[f.station];
      var b = bestFor(f), out = [];
      comparable(f).forEach(function (x) {
        var s = x.name, v = sim(f.station, s);
        if (v >= rules.minStationSim && (v >= b.sim - 0.05 || (b.name && sim(s, b.name) >= 0.9))) out.push(s);
      });
      eligCache[f.station] = out;
      return out;
    }
    facts.forEach(function (f) {
      var ix = index[f.item] || (index[f.item] = { all: [], byStation: Object.create(null), unmapped: [] });
      ix.all.push(f);
      var el = eligibleStations(f);
      if (el === null || (!aliasOf(f) && bestFor(f).sim < rules.minStationSim)) ix.unmapped.push(f);
      (el || []).forEach(function (st) { (ix.byStation[st] = ix.byStation[st] || []).push(f); });
    });
    function itemsFor(slot) {
      var list = [slot.item];
      var extra = rules.itemMap && rules.itemMap[slot.item];
      if (extra) extra.forEach(function (c) { if (list.indexOf(c) < 0) list.push(c); });
      return list;
    }
    function statRankOf(slot, f) {
      var list = rules.statMap[slot.stat] || [slot.stat];
      var r = list.indexOf(f.stat);
      if (r >= 0) return { rank: r, fallback: false };
      if (rules.valueFallback && f.stat === "value") return { rank: list.length, fallback: true };
      return null;
    }
    // 同表同項目同測站但季別不同的空格 → 需日期佐證
    var periodGroups = Object.create(null);
    slots.forEach(function (s) {
      if (!s.period) return;
      var k = [s.docId, s.tableId, s.item, s.stat, s.station || ""].join("|");
      (periodGroups[k] = periodGroups[k] || {})[s.period] = 1;
    });
    function strictPeriod(slot) {
      if (!slot.period) return false;
      var k = [slot.docId, slot.tableId, slot.item, slot.stat, slot.station || ""].join("|");
      return Object.keys(periodGroups[k] || {}).length > 1;
    }
    var srcRank = rules.sourceRank || DEFAULT_RULES.sourceRank;

    return slots.map(function (slot) {
      var res = { slotId: slot.id, value: "", status: "missing", factId: null, note: "", candidates: [] };
      if (!slot.item) { res.note = "無法判讀此空格的項目"; return res; }
      var cands = [], periodRejected = 0, periodUnknown = 0, unitRejected = 0, otherStation = 0, pool = [];
      var items = itemsFor(slot);
      items.forEach(function (code) {
        var ix = index[code];
        if (!ix) return;
        pool = pool.concat(slot.station ? (ix.byStation[slot.station] || []) : ix.all);
      });
      var strict = strictPeriod(slot);
      pool.forEach(function (f) {
        var sr = statRankOf(slot, f);
        if (!sr) return;
        var sm = stationMatch(f, slot);
        if (!sm) { otherStation++; return; }
        var inP = dict.dateInPeriod(f.date, slot.periodInfo || slot.period);
        if (inP === false) { periodRejected++; return; }
        if (inP === null && strict) { periodUnknown++; return; }
        var unitRank, factor = 1;
        if (slot.unit && f.unit) {
          if (slot.unit === f.unit) unitRank = 0;
          else {
            factor = dict.convFactor(f.unit, slot.unit);
            if (!factor) { unitRejected++; return; }
            unitRank = 1;
          }
        } else unitRank = f.unit ? 1 : 2;
        var cv = convertValue(f, factor);
        if (!cv) return;
        var notes = [];
        if (factor !== 1) notes.push("單位換算 " + dict.unitLabel(f.unit) + "→" + dict.unitLabel(slot.unit));
        if (sr.fallback) notes.push("統計別不明");
        if (sm.via === "alias") notes.push("測點對應");
        if (sm.via === "nostation") notes.push("表格未標示測站");
        var conf = typeof f.conf === "number" ? f.conf : 100;
        cands.push({
          f: f, value: cv.value, num: cv.num, decimals: cv.decimals, cmp: cv.cmp,
          unitRank: unitRank, statRank: sr.rank, fallback: sr.fallback, sim: sm.sim,
          src: srcRank[f.source] !== undefined ? srcRank[f.source] : 5, conf: conf,
          tableKey: f.docId + "|" + f.tableId, note: notes.join("；"),
          score: Math.round(100 - unitRank * 15 - sr.rank * 10 - (1 - sm.sim) * 20 -
            (srcRank[f.source] !== undefined ? srcRank[f.source] : 5) * 3 + conf / 100)
        });
      });
      // 統計別不明的數值若同一表格有 ≥ 3 筆 → 視為數列（逐時/逐日），不作為候選
      var fbCount = Object.create(null);
      cands.forEach(function (c) { if (c.fallback) fbCount[c.tableKey] = (fbCount[c.tableKey] || 0) + 1; });
      cands = cands.filter(function (c) { return !c.fallback || fbCount[c.tableKey] < 3; });
      cands.sort(function (a, b) {
        return a.unitRank - b.unitRank || a.statRank - b.statRank || b.sim - a.sim ||
          a.src - b.src || b.conf - a.conf || ordOf.get(a.f) - ordOf.get(b.f);
      });

      if (!cands.length) {
        // 待對應：有同項目、統計別相容，但沒有測站（或測站無法對到任何範本測站）的數值
        var unmapped = [];
        items.forEach(function (code) {
          if (index[code]) unmapped = unmapped.concat(index[code].unmapped.filter(function (f) { return !!statRankOf(slot, f); }));
        });
        otherStation = 0;
        items.forEach(function (code) {
          if (index[code]) otherStation += index[code].all.filter(function (f) { return !!statRankOf(slot, f); }).length;
        });
        var pointKeys = Object.create(null), nPoints = 0;
        unmapped.forEach(function (f) { var k = keyOf(f); if (!pointKeys[k]) { pointKeys[k] = 1; nPoints++; } });
        if (unmapped.length && nPoints > (rules.maxMappingPoints || 40)) {
          // 上千個無測站的「測點」（逐時數列等）：無法逐點對應，視為無對應資料
          res.status = "missing";
          res.note = "原始資料有 " + unmapped.length + " 筆未標示測站的「" + dict.itemLabel(slot.item) +
            "」數值（疑似逐時／逐日數列），無法判斷屬於哪個測站";
        } else if (unmapped.length) {
          res.status = "mapping";
          res.note = "有 " + unmapped.length + " 筆「" + dict.itemLabel(slot.item) + "」數值未標示測站，請在「測點對應」指定";
          res.candidates = unmapped.slice(0, 12).map(function (f) {
            return { factId: f.id, value: f.value, score: 0, agrees: false, note: "未對應測點" };
          });
        } else {
          res.status = "missing";
          var why = [];
          if (periodRejected) why.push(periodRejected + " 筆資料日期不在" + (slot.period || "表格季別") + "內");
          if (periodUnknown) why.push(periodUnknown + " 筆資料日期不明（表格有多個季別，無法判斷）");
          if (unitRejected) why.push(unitRejected + " 筆單位無法換算");
          if (!why.length && otherStation && slot.station) why.push("原始資料沒有「" + slot.station + "」的此項目");
          if (!why.length && !otherStation) why.push("原始資料沒有此項目");
          res.note = why.join("；");
        }
        return finish(res, slot);
      }

      // 彼此一致的同優先序候選中，改取來源較正式者（報告總表 > 逐時紀錄表），
      // 例：總表 PM10 單位 OCR 失敗（單位不明）但與逐時表日平均一致 → 仍填總表的「10」
      var lead = cands[0];
      var group = cands.filter(function (c) {
        return c.statRank === lead.statRank && !c.fallback && !lead.fallback && (c === lead || consistent(c, lead));
      });
      if (group.length > 1) {
        group.sort(function (a, b) {
          return a.src - b.src || a.unitRank - b.unitRank || b.sim - a.sim || b.conf - a.conf || ordOf.get(a.f) - ordOf.get(b.f);
        });
        if (group[0] !== lead) {
          cands.splice(cands.indexOf(group[0]), 1);
          cands.unshift(group[0]);
        }
      }
      var best = cands[0];
      cands.forEach(function (c) {
        if (c === best) { c.agrees = true; return; }
        c.agrees = consistent(c, best);
        if (!c.agrees && (c.unitRank === 2 || best.unitRank === 2)) {
          // 單位不明：容許 ×1000 / ÷1000 後一致（疑似 ppb/ppm 差異）
          var up = { num: c.num * 1000, decimals: Math.max(0, c.decimals - 3), cmp: c.cmp };
          var dn = { num: c.num / 1000, decimals: c.decimals + 3, cmp: c.cmp };
          if (consistent(up, best) || consistent(dn, best)) { c.agrees = true; c.note = (c.note ? c.note + "；" : "") + "疑似單位不同"; }
        }
      });
      var others = cands.slice(1);
      var agreeOther = others.filter(function (c) { return c.agrees && independent(c, best) && !c.fallback && !best.fallback; });
      // 不一致（單位不明者已先容許 ×1000 差異）且同統計優先序 → 需人工核對
      var conflictOther = others.filter(function (c) {
        return !c.agrees && c.statRank === best.statRank && !c.fallback;
      });
      var stationsSeen = Object.create(null);
      if (!slot.station) cands.forEach(function (c) { stationsSeen[keyOf(c.f)] = 1; });
      res.value = best.value;
      res.factId = best.f.id;
      var notes = best.note ? [best.note] : [];
      if (!slot.station && Object.keys(stationsSeen).length > 1) {
        res.status = "conflict";
        notes = notes.map(function (n) { return n.replace(/(^|；)表格未標示測站(?=；|$)/, "$1").replace(/^；|；$/g, ""); }).filter(Boolean);
        notes.push("表格未標示測站，原始資料有多個測站");
      } else if (best.fallback && others.some(function (c) { return c.fallback && !c.agrees; })) {
        res.status = "conflict";
        notes.push("統計別不明且有多個不同數值");
      } else if (conflictOther.length) {
        res.status = "conflict";
        notes.push("與" + conflictOther.slice(0, 2).map(function (c) { return describe(c); }).join("、") + "不一致");
      } else if (agreeOther.length) {
        res.status = "checked";
        notes.push("與" + describe(agreeOther[0]) + "一致");
      } else {
        res.status = "auto";
      }
      // OCR 單一來源的可疑值：信心度低、或負值（「-」常是印章或框線殘影）→ 需核對
      var bc = typeof best.f.conf === "number" ? best.f.conf : null;
      if (res.status === "auto" && bc !== null && bc < (rules.lowConf || 60)) {
        res.status = "conflict";
        notes.push("OCR 信心度 " + Math.round(bc) + "，請對照原始影像");
      }
      if (bc !== null && typeof best.num === "number" && best.num < 0 && res.status !== "conflict") {
        res.status = "conflict";
        notes.push("辨識為負值，請對照原始影像（「-」可能是印章或框線殘影）");
      }
      if (periodRejected) notes.push("另有 " + periodRejected + " 筆其他季別資料未採用");
      res.note = notes.join("；");
      res.candidates = cands.map(function (c) {
        return { factId: c.f.id, value: c.value, score: c.score, agrees: !!c.agrees, note: c.note };
      });
      return finish(res, slot);
    });

    /** 兩個候選是否為獨立來源（不同表格；既有模組解析與表格擷取來自同一檔案者不算） */
    function independent(a, b) {
      if (a.tableKey === b.tableKey) return false;
      if (a.f.docId === b.f.docId && (a.f.source === "module" || b.f.source === "module")) return false;
      return true;
    }
    function describe(c) {
      return (c.f.where || c.f.tableId || "") + "「" + c.f.value + (c.f.unit ? " " + D().unitLabel(c.f.unit) : "") + "」";
    }
    function finish(res, slot) {
      if (Object.prototype.hasOwnProperty.call(picks, slot.id)) {
        var p = res.candidates.filter(function (c) { return c.factId === picks[slot.id]; })[0];
        if (p) { res.value = p.value; res.factId = p.factId; res.status = "manual"; res.note = "改選來源"; }
      }
      if (Object.prototype.hasOwnProperty.call(manual, slot.id)) {
        res.value = String(manual[slot.id]);
        res.factId = null; res.status = "manual"; res.note = "手動輸入";
      }
      return res;
    }
  }

  /* =====================================================================
   * 未使用的原始測站／測點（供「測點對應」介面）
   * ===================================================================== */
  function unmatchedGroups(slots, facts, assignments) {
    var dict = D();
    slots = slots || []; facts = facts || []; assignments = assignments || [];
    var slotItems = Object.create(null);
    slots.forEach(function (s) { if (s.item) slotItems[s.item] = 1; });
    var used = Object.create(null);
    assignments.forEach(function (a) {
      if (a.factId) used[a.factId] = 1;
      if (a.status === "mapping") return;          // 待對應的候選不算「已使用」
      (a.candidates || []).forEach(function (c) { used[c.factId] = 1; });
    });
    var slotStations = [];
    slots.forEach(function (s) { if (s.station && slotStations.indexOf(s.station) < 0) slotStations.push(s.station); });
    var groups = Object.create(null), order = [], usedKeys = Object.create(null);
    facts.forEach(function (f) {
      if (!f || !f.item) return;
      var k = keyOf(f);
      if (used[f.id]) { usedKeys[k] = 1; return; }
      if (!slotItems[f.item]) return;
      if (!groups[k]) { groups[k] = { stationKey: k, facts: [], items: [] }; order.push(k); }
      groups[k].facts.push(f);
      if (groups[k].items.indexOf(f.item) < 0) groups[k].items.push(f.item);
    });
    return order.filter(function (k) { return !usedKeys[k]; }).map(function (k) {
      var g = groups[k], f0 = g.facts[0];
      g.item = g.items.length === 1 ? g.items[0] : null;
      g.station = f0.station || null;
      g.pointNo = f0.station ? null : (f0.pointNo || null);
      g.docName = f0.docName || "";
      if (f0.station) {
        g.label = (f0.stationRaw && f0.stationRaw !== f0.station ? f0.stationRaw : f0.station) + (g.docName ? "（" + g.docName + "）" : "");
        var best = null;
        slotStations.forEach(function (s) {
          var v = dict.stationSim(f0.station, s);
          if (v >= 0.3 && (!best || v > best.sim)) best = { name: s, sim: v };
        });
        g.suggest = best ? best.name : null;
      } else {
        g.label = (g.docName ? g.docName + " " : "") + dict.itemLabel(f0.item) + " 第" + (f0.pointNo || "?") + "測點";
        g.suggest = null;
      }
      return g;
    });
  }

  YF.match = {
    run: run, DEFAULT_RULES: DEFAULT_RULES, stationKeyOf: stationKeyOf,
    unmatchedGroups: unmatchedGroups, consistent: consistent, convertValue: convertValue
  };
})(typeof window !== "undefined" ? window : globalThis);
