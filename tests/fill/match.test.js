/* fill/match.js 單元測試：node tests/fill/match.test.js
 * 合成資料（虛構測站）＋真實樣本驗收（test_data/fill/ 存在時；期望值讀自不進版控的 semantic_expected.json）。 */
"use strict";
const assert = require("node:assert");
const H = require("./semantic_helpers.js");
const YF = H.load();
const M = YF.match, X = YF.extract, D = YF.dict;
const T = H.harness();
const { grid, doc } = H;

let seq = 0;
function fact(o) {
  const pv = D.parseValue(o.value);
  const f = Object.assign({
    id: "f" + (++seq), docId: "d1", docName: "raw.pdf", tableId: "t" + seq, page: 1, r: 0, c: 0, cellText: o.value,
    item: "SO2", stat: "max1h", unit: "ppm", station: "白河新村", pointNo: null,
    value: pv.value, num: pv.num, cmp: pv.cmp, nd: pv.nd, decimals: pv.decimals, date: "115.08.31",
    conf: 90, bbox: null, source: "pivot", where: "第1頁"
  }, o, { value: pv.ok ? pv.value : o.value, num: pv.num, cmp: pv.cmp, decimals: pv.decimals });
  f.stationKey = M.stationKeyOf(f);
  return f;
}
function slot(o) {
  return Object.assign({
    id: "s" + (++seq), docId: "tpl", tableId: "t0", r: 2, c: 1, ref: null, item: "SO2", stat: "h1", unit: "ppm",
    unitFrom: "header", station: "白河新村", stationKey: "白河新村", period: "115年第三季", periodInfo: { y: 115, q: 3 },
    headers: [], rowLabels: [], label: ""
  }, o);
}
const run1 = (s, facts, opts) => M.run([s], facts, opts)[0];

T.test("OCR 低信心度／負值的單一來源 → 需核對；文字來源不受影響", () => {
  const low = run1(slot({}), [fact({ value: "0.0111", conf: 38 })]);
  assert.deepStrictEqual([low.value, low.status], ["0.0111", "conflict"]);
  assert.ok(/信心度 38/.test(low.note), low.note);
  const neg = run1(slot({ item: "CO", unit: "ppm" }), [fact({ item: "CO", value: "-0.4", conf: 92 })]);
  assert.deepStrictEqual([neg.value, neg.status], ["-0.4", "conflict"]);
  const txt = run1(slot({}), [fact({ value: "0.003", conf: null })]);
  assert.strictEqual(txt.status, "auto");
});

T.test("無測站數值過多（逐時數列）不要求逐點對應；文件字串為 Object 原型成員也不出錯", () => {
  const many = [];
  for (let i = 1; i <= 60; i++) many.push(fact({ station: null, pointNo: i, value: "0.00" + (i % 9 + 1) }));
  const a = run1(slot({}), many);
  assert.strictEqual(a.status, "missing");
  assert.ok(/無法判斷/.test(a.note), a.note);
  const few = run1(slot({}), many.slice(0, 4));
  assert.strictEqual(few.status, "mapping");
  ["constructor", "__proto__", "toString", "hasOwnProperty"].forEach((nm) => {
    const r = M.run([slot({ station: nm, stationKey: nm }), slot({})], [fact({ station: nm }), fact({ value: "0.002" })], { aliases: {} });
    assert.strictEqual(r.length, 2, nm);
    M.unmatchedGroups([slot({})], [fact({ station: nm, item: "NO2" })], r);
  });
});

T.test("consistent：規格範例", () => {
  assert.ok(M.consistent("0.001", { num: 0.0011, decimals: 5 }));          // 1.10 ppb
  assert.ok(M.consistent("0.012", { num: 0.0115, decimals: 5 }));          // 11.50 ppb（邊界）
  assert.ok(M.consistent("0.006", { num: 0.0065, decimals: 5 }));          // 邊界（浮點誤差）
  assert.ok(M.consistent("2.2", "2.20"));
  assert.ok(M.consistent("0.2", "0.25"));
  assert.ok(M.consistent("9", "8.67"));
  assert.ok(!M.consistent("0.012", "0.100"));
  assert.ok(!M.consistent("0.2", "0.26"));
  assert.ok(!M.consistent("0.001", "1.10"));
  assert.ok(M.consistent("ND", "ND"));
  assert.ok(M.consistent("ND", "<0.5"));
  assert.ok(!M.consistent("ND", "0.3"));
  assert.ok(M.consistent("<10", "5"));
  assert.ok(!M.consistent("<10", "12"));
  assert.ok(M.consistent("<10", "<10"));
  assert.ok(M.consistent(">100", "150"));
  assert.ok(M.consistent(0.5, "0.5"));
  assert.ok(!M.consistent(null, "1"));
  assert.ok(!M.consistent("abc", "1"));
});

T.test("convertValue：ppb→ppm 保留小數位、≤4 位有效數字", () => {
  const cv = (v, f) => M.convertValue(Object.assign({ value: v }, D.parseValue(v)), f).value;
  assert.strictEqual(cv("1.10", 0.001), "0.00110");
  assert.strictEqual(cv("11.50", 0.001), "0.01150");
  assert.strictEqual(cv("28.93", 0.001), "0.02893");
  assert.strictEqual(cv("123.456", 0.001), "0.1235");
  assert.strictEqual(cv("<1.0", 0.001), "<0.0010");
  assert.strictEqual(cv("ND", 0.001), "ND");
  assert.strictEqual(cv("0.012", 1000), "12");
  assert.strictEqual(cv("1.5", 1000), "1500");
  assert.strictEqual(cv("0.034", 1), "0.034");
});

T.test("基本：總表 ppm + 逐時表 ppb 一致 → checked，取單位相同者", () => {
  const s = slot({});
  const a = fact({ value: "0.003", tableId: "sum" });
  const b = fact({ value: "3.10", unit: "ppb", tableId: "hr", source: "context", where: "第9頁 表1" });
  const r = run1(s, [b, a]);
  assert.deepStrictEqual([r.value, r.status, r.factId], ["0.003", "checked", a.id]);
  assert.strictEqual(r.candidates.length, 2);
  assert.ok(r.candidates.every((c) => c.agrees));
  assert.ok(/一致/.test(r.note), r.note);
  assert.strictEqual(r.slotId, s.id);
});

T.test("只有 ppb → 換算為 ppm、auto、註明換算", () => {
  const r = run1(slot({}), [fact({ value: "1.10", unit: "ppb" })]);
  assert.deepStrictEqual([r.value, r.status], ["0.00110", "auto"]);
  assert.ok(/單位換算 ppb→ppm/.test(r.note), r.note);
});

T.test("同優先序不一致 → conflict；不同表格", () => {
  const r = run1(slot({}), [fact({ value: "0.003", tableId: "a" }), fact({ value: "0.009", tableId: "b" })]);
  assert.strictEqual(r.status, "conflict");
  assert.strictEqual(r.value, "0.003");
  assert.ok(/不一致/.test(r.note));
});

T.test("統計別對照：小時平均值=最大小時平均值；日平均不取最大值；8 小時取最大 8 小時", () => {
  const facts = [
    fact({ value: "0.004", stat: "max1h", tableId: "a" }), fact({ value: "0.002", stat: "daily", tableId: "a" }),
    fact({ value: "0.003", stat: "max8h", tableId: "a" }), fact({ value: "0.001", stat: "min1h", tableId: "a" }),
    fact({ value: "0.0025", stat: "avg8h", tableId: "a" })
  ];
  assert.strictEqual(run1(slot({ stat: "h1" }), facts).value, "0.004");
  assert.strictEqual(run1(slot({ stat: "daily" }), facts).value, "0.002");
  assert.strictEqual(run1(slot({ stat: "h8" }), facts).value, "0.003");
  assert.strictEqual(run1(slot({ stat: "max8h" }), facts).value, "0.003");
  assert.strictEqual(run1(slot({ stat: "min1h" }), facts).value, "0.001");
  assert.strictEqual(run1(slot({ stat: "annual" }), facts).status, "missing");
  const r = run1(slot({ stat: "h1" }), facts.concat([fact({ value: "0.0020", stat: "h1", tableId: "b" })]));
  assert.strictEqual(r.status, "auto", "不同優先序不算衝突：" + r.note);
});

T.test("項目必須相同（NOx 不可填 NO2）", () => {
  const r = run1(slot({ item: "NO2" }), [fact({ item: "NOx", value: "0.029" })]);
  assert.strictEqual(r.status, "missing");
  assert.strictEqual(r.value, "");
  const r2 = run1(slot({ item: "NO2" }), [fact({ item: "NOx", value: "0.029" })], { rules: { itemMap: { NO2: ["NOx"] } } });
  assert.strictEqual(r2.value, "0.029", "規則可明確放寬");
});

T.test("測站：不同測站不互相填入；模糊相符取最相近的範本測站", () => {
  const slots = [slot({ station: "城頭" }), slot({ station: "南港社區活動中心" }), slot({ station: "北港社區活動中心" })];
  const facts = [
    fact({ station: "南港社區活動中心", value: "0.001" }),
    fact({ station: "北港社區活動中心", value: "0.002" }),
    fact({ station: "埔頭", value: "0.009" })
  ];
  const r = M.run(slots, facts);
  assert.deepStrictEqual(r.map((x) => x.value), ["", "0.001", "0.002"]);
  assert.strictEqual(r[0].status, "mapping", "「埔頭」對不到任何範本測站 → 交由使用者對應，不自動填入");
  // OCR 變體（南淋）只配到最相近的「南港」
  const r2 = M.run(slots, [fact({ station: "南淋社區活動中心", value: "0.004" })]);
  assert.deepStrictEqual(r2.map((x) => x.value), ["", "0.004", ""]);
});

T.test("同一測站的兩種寫法（社區 / 社區活動中心）皆可配到", () => {
  const slots = [slot({ station: "青山社區" }), slot({ station: "青山社區活動中心", item: "LEQ", stat: "value", unit: "dB(A)" })];
  const facts = [fact({ station: "青山社區", value: "0.003" }), fact({ station: "青山社區", item: "LEQ", stat: "value", unit: "dB(A)", value: "58.2" })];
  const r = M.run(slots, facts);
  assert.deepStrictEqual(r.map((x) => x.value), ["0.003", "58.2"]);
});

T.test("無測站測點 → mapping；指定對應後填入", () => {
  const slots = [slot({ station: "白河新村", item: "ODOR", stat: "value", unit: null }), slot({ station: "東湖", item: "ODOR", stat: "value", unit: null })];
  const facts = [1, 2].map((n) => fact({ item: "ODOR", stat: "value", unit: null, station: null, pointNo: n, value: n === 1 ? "25" : "<10", source: "point", date: null }));
  const r = M.run(slots, facts);
  assert.deepStrictEqual(r.map((x) => x.status), ["mapping", "mapping"]);
  assert.ok(/測點對應/.test(r[0].note));
  assert.strictEqual(r[0].candidates.length, 2);
  const r2 = M.run(slots, facts, { aliases: { "#ODOR#1": "東湖", "#ODOR#2": "白河新村" } });
  assert.deepStrictEqual(r2.map((x) => [x.value, x.status]), [["<10", "auto"], ["25", "auto"]]);
  assert.ok(/測點對應/.test(r2[0].note));
  // 已指定到別的測站的測點不再算待對應
  const r3 = M.run(slots, facts, { aliases: { "#ODOR#1": "東湖", "#ODOR#2": "東湖" } });
  assert.strictEqual(r3[0].status, "missing");
});

T.test("別名可覆寫測站名稱比對（原始測站文字無法自動辨識時）", () => {
  const f = fact({ station: "XYZ", value: "0.005" });
  assert.strictEqual(run1(slot({}), [f]).status, "mapping", "測站對不到任何範本測站 → 待對應");
  const r = run1(slot({}), [f], { aliases: { XYZ: "白河新村" } });
  assert.deepStrictEqual([r.value, r.status], ["0.005", "auto"]);
  const r2 = run1(slot({}), [fact({ station: "白河新村", value: "0.005" })], { aliases: { "白河新村": "東湖" } });
  assert.strictEqual(r2.status, "missing", "別名指到別站時不再以名稱比對");
});

T.test("單位不可換算 → 不採用", () => {
  const r = run1(slot({ item: "PM10", stat: "daily", unit: "ug/m3" }), [fact({ item: "PM10", stat: "daily", unit: "ppm", value: "35" })]);
  assert.strictEqual(r.status, "missing");
  assert.ok(/單位/.test(r.note), r.note);
  const r2 = run1(slot({ item: "PM10", stat: "daily", unit: "ug/m3" }), [fact({ item: "PM10", stat: "daily", unit: "mg/m3", value: "0.035" })]);
  assert.strictEqual(r2.value, "35");
  const r3 = run1(slot({ item: "PM10", stat: "daily", unit: null }), [fact({ item: "PM10", stat: "daily", unit: "mg/m3", value: "0.035" })]);
  assert.strictEqual(r3.value, "0.035", "範本單位不明 → 照原值");
});

T.test("季別：日期不在範本季別內不採用；同表多季空格需日期佐證", () => {
  const r = run1(slot({}), [fact({ value: "0.003", date: "115.05.20" })]);
  assert.strictEqual(r.status, "missing");
  assert.ok(/季別|日期/.test(r.note), r.note);
  const r2 = run1(slot({}), [fact({ value: "0.003", date: null })]);
  assert.strictEqual(r2.value, "0.003", "日期不明但只有一季 → 採用");
  const s3 = slot({ period: "115年第二季", periodInfo: { y: 115, q: 2 }, r: 3 });
  const both = M.run([slot({}), s3], [fact({ value: "0.003", date: null }), fact({ value: "0.004", date: "115.05.02" })]);
  assert.deepStrictEqual(both.map((x) => x.value), ["", "0.004"], "多季時日期不明的數值不填");
});

T.test("範本未標示測站：單一測站 → 填入；多測站 → conflict", () => {
  const s = slot({ station: null, stationKey: null });
  assert.strictEqual(run1(s, [fact({ value: "0.003" })]).status, "auto");
  const r = run1(s, [fact({ value: "0.003" }), fact({ value: "0.004", station: "東湖" })]);
  assert.strictEqual(r.status, "conflict");
});

T.test("統計別不明（value）可作為最後手段，且不算交叉核對", () => {
  const r = run1(slot({}), [fact({ value: "0.003", stat: "value" })]);
  assert.deepStrictEqual([r.value, r.status], ["0.003", "auto"]);
  assert.ok(/統計別不明/.test(r.note));
  const r2 = run1(slot({}), [fact({ value: "0.003", stat: "value" })], { rules: { valueFallback: false } });
  assert.strictEqual(r2.status, "missing");
  const r3 = run1(slot({}), [fact({ value: "0.003", tableId: "a" }), fact({ value: "0.003", stat: "value", tableId: "b" })]);
  assert.strictEqual(r3.status, "auto");
});

T.test("一致的候選中優先採用正式來源（總表單位 OCR 失敗仍優先於逐時表）", () => {
  const s = slot({ item: "PM10", stat: "daily", unit: "ug/m3" });
  const sum = fact({ item: "PM10", stat: "daily", unit: null, value: "10", source: "pivot", tableId: "sum" });
  const hr = fact({ item: "PM10", stat: "daily", unit: "ug/m3", value: "9.54", source: "context", tableId: "hr" });
  const r = run1(s, [hr, sum]);
  assert.deepStrictEqual([r.value, r.status, r.factId], ["10", "checked", sum.id]);
  // 不一致時仍依單位排序（單位相同者優先），並標示衝突
  const bad = fact({ item: "PM10", stat: "daily", unit: null, value: "25", source: "pivot", tableId: "sum2" });
  const r2 = run1(s, [hr, bad]);
  assert.strictEqual(r2.value, "9.54");
});

T.test("單位不明但差 1000 倍一致 → 視為一致（標註疑似單位不同）", () => {
  const r = run1(slot({}), [fact({ value: "0.003", tableId: "a" }), fact({ value: "3.0", unit: null, tableId: "b", source: "context" })]);
  assert.strictEqual(r.status, "checked");
  assert.ok(r.candidates.some((c) => /疑似單位不同/.test(c.note)));
});

T.test("既有模組解析與同檔案表格擷取一致 → 不算兩來源（auto）", () => {
  const a = fact({ value: "0.003", docId: "x", tableId: "s:A:b0", source: "row" });
  const m = fact({ value: "0.003", docId: "x", tableId: null, source: "module" });
  assert.strictEqual(run1(slot({}), [a, m]).status, "auto");
  const other = fact({ value: "3.0", unit: "ppb", docId: "y", tableId: "p9t0", source: "context" });
  assert.strictEqual(run1(slot({}), [a, m, other]).status, "checked");
});

T.test("統計別不明的數列（同表 ≥3 筆）不作為候選；不明且多值 → conflict", () => {
  const series = [1, 2, 3, 4].map((i) => fact({ value: "0.00" + i, stat: "value", tableId: "ser" }));
  const r = run1(slot({}), series);
  assert.strictEqual(r.status, "missing", r.note);
  const two = [fact({ value: "0.003", stat: "value", tableId: "a" }), fact({ value: "0.008", stat: "value", tableId: "b" })];
  assert.strictEqual(run1(slot({}), two).status, "conflict");
});

T.test("單位不明的兩個數值不一致（且非 1000 倍）→ conflict", () => {
  const r = run1(slot({ item: "PM10", stat: "daily", unit: "ug/m3" }), [
    fact({ item: "PM10", stat: "daily", unit: null, value: "35", tableId: "a" }),
    fact({ item: "PM10", stat: "daily", unit: null, value: "52", tableId: "b" })]);
  assert.strictEqual(r.status, "conflict");
});

T.test("manual / picks 選項", () => {
  const s = slot({});
  const a = fact({ value: "0.003", tableId: "a" }), b = fact({ value: "0.009", tableId: "b" });
  const r = M.run([s], [a, b], { picks: { [s.id]: b.id } })[0];
  assert.deepStrictEqual([r.value, r.status, r.factId], ["0.009", "manual", b.id]);
  const r2 = M.run([s], [a, b], { manual: { [s.id]: "0.005" } })[0];
  assert.deepStrictEqual([r2.value, r2.status, r2.factId], ["0.005", "manual", null]);
});

T.test("異常輸入：空陣列、無項目空格、缺欄位", () => {
  assert.deepStrictEqual(M.run([], []), []);
  assert.deepStrictEqual(M.run(null, null), []);
  const r = M.run([slot({ item: null })], [fact({})]);
  assert.strictEqual(r[0].status, "missing");
  const r2 = M.run([slot({})], [null, {}, { item: "SO2" }, fact({ value: "0.002" })]);
  assert.strictEqual(r2[0].value, "0.002");
  const input = [fact({ value: "0.002" })];
  const snap = JSON.stringify(input);
  M.run([slot({})], input);
  assert.strictEqual(JSON.stringify(input), snap, "不修改輸入");
});

T.test("unmatchedGroups：只列出未使用、且範本有該項目的測站／測點", () => {
  const slots = [slot({ station: "白河新村", item: "ODOR", stat: "value", unit: null }), slot({ station: "白河新村" })];
  const facts = [
    fact({ item: "ODOR", stat: "value", unit: null, station: null, pointNo: 1, value: "25", source: "point", docName: "odor.pdf" }),
    fact({ item: "ODOR", stat: "value", unit: null, station: null, pointNo: 2, value: "12", source: "point", docName: "odor.pdf" }),
    fact({ station: "白河新村", value: "0.003" }),
    fact({ station: "白和新邨", value: "0.004", stationRaw: "白和新邨" }),
    fact({ item: "WS", stat: "value", unit: "m/s", station: null, pointNo: 1, value: "1.2" })
  ];
  facts[3].stationKey = M.stationKeyOf(facts[3]);
  const as = M.run(slots, facts);
  const g = M.unmatchedGroups(slots, facts, as);
  const keys = g.map((x) => x.stationKey);
  assert.ok(keys.indexOf("#ODOR#1") >= 0 && keys.indexOf("#ODOR#2") >= 0, JSON.stringify(keys));
  assert.ok(keys.indexOf("白河新村") < 0, "已使用的測站不列");
  assert.ok(keys.indexOf("#WS#1") < 0, "範本沒有的項目不列");
  const od = g.filter((x) => x.stationKey === "#ODOR#1")[0];
  assert.deepStrictEqual([od.item, od.pointNo, od.station], ["ODOR", 1, null]);
  assert.ok(/臭氣/.test(od.label) && /odor\.pdf/.test(od.label), od.label);
  assert.strictEqual(od.facts.length, 1);
  const as2 = M.run(slots, facts, { aliases: { "#ODOR#1": "白河新村" } });
  const keys2 = M.unmatchedGroups(slots, facts, as2).map((x) => x.stationKey);
  assert.ok(keys2.indexOf("#ODOR#1") < 0);
  assert.deepStrictEqual(M.unmatchedGroups([], [], []), []);
});

T.test("stationKeyOf / DEFAULT_RULES", () => {
  assert.strictEqual(M.stationKeyOf({ station: " 白河 新村 " }), "白河新村");
  assert.strictEqual(M.stationKeyOf({ station: null, item: "ODOR", pointNo: 3 }), "#ODOR#3");
  assert.deepStrictEqual(M.DEFAULT_RULES.statMap.h1, ["max1h", "h1"]);
  assert.deepStrictEqual(M.DEFAULT_RULES.statMap.value, ["value", "daily", "max1h"]);
});

/* ---------------- 合成端到端：掃描總表 + 逐時表 + 異味 + 範本 ---------------- */
T.test("端到端（合成）：extract → match", () => {
  const sum = grid("p1t0", [
    ["測項 (單位)", "現場編號", "1150101AQ-1", "空氣品質標準", "檢測方法編號"],
    ["^", "檢測位置", "白和新村", "^", "^"],
    ["^", "檢測日期/時間", "115.08.05/10:00 至 115.08.06/10:00", "^", "^"],
    ["SO2 (ppm)", "最大小時平均值", "0.003", "0.075", "NIEA A416.14C"],
    ["NOx (ppm)", "最大小時平均值", "0.021", "*", "NIEA A417.13C"],
    ["PMio (ug/m3)", "日平均值", "31", "100", "NIEA A206.11C"]
  ], { page: 1 });
  const hr = grid("p2t0", [
    ["計畫名稱：測試 現場編號：1150101AQ-1 監測位置：白河新村 監測日期：115.08.05~115.08.06", "<", "<", "<"],
    ["項目 時間", "So, ppb", "NOz ppb", "PMio ug/m3"],
    ["10:00 ~ 11:00", "2.90", "8.80", "30.00"],
    ["11:00 ~ 12:00", "3.10", "9.40", "29.00"],
    ["12:00 ~ 13:00", "2.70", "7.10", "33.00"],
    ["最大小時平均值", "3.10", "9.40", "33.00"],
    ["日平均值", "2.90", "8.43", "30.67"]
  ], { page: 2 });
  const od = grid("p1t0", [
    ["測點", "項目", "實測值", "排放標準"],
    ["①", "臭氣濃度", "18", "50"],
    ["②", "臭氣濃度", "<10", "50"]
  ], { page: 1 });
  const tpl = doc("tpl", [grid("t0", [
    ["檢測項目", "SO2", "NO2", "PM10", "臭氣"],
    ["單位\n檢測季別", "小時平均值(ppm)", "小時平均值(ppm)", "24小時平均值(μg/m3)", "-"],
    ["115年第三季", "", "", "", ""],
    ["空氣品質標準", "0.075", "0.1", "100", "30"]
  ], { title: "表2-1 白河新村空氣品質歷次調查結果彙整" })], "template");
  const stations = X.templateStations(tpl);
  assert.deepStrictEqual(stations, ["白河新村"]);
  const slots = X.slots(tpl, { stations });
  assert.strictEqual(slots.length, 4);
  const facts = X.facts(doc("a", [sum, hr]), { stations }).concat(X.facts(doc("o", [od]), { stations }));
  const as = M.run(slots, facts);
  assert.deepStrictEqual(as.map((a) => [a.value, a.status]),
    [["0.003", "checked"], ["0.00940", "auto"], ["31", "checked"], ["", "mapping"]]);
  assert.ok(/ppb→ppm/.test(as[1].note));
  const as2 = M.run(slots, facts, { aliases: { "#ODOR#2": "白河新村" } });
  assert.deepStrictEqual([as2[3].value, as2[3].status], ["<10", "auto"]);
  const g = M.unmatchedGroups(slots, facts, as2);
  assert.deepStrictEqual(g.map((x) => x.stationKey), ["#ODOR#1"]);
});

/* ---------------- 真實樣本驗收 ---------------- */
if (H.haveReal()) {
  const R = H.realDocs();
  const EXP = H.realExpected();
  const stations = X.templateStations(R.template);
  const slots = X.slots(R.template, { stations });
  const facts = X.facts(R.adata, { stations }).concat(X.facts(R.odor, { stations }));
  const slotById = {}; slots.forEach((s) => { slotById[s.id] = s; });
  const factById = {}; facts.forEach((f) => { factById[f.id] = f; });
  const as = M.run(slots, facts, {});
  const AIR = ["SO2", "NO2", "CO", "O3", "CH4", "NMHC", "THC", "TSP", "PM10", "PM2.5"];

  T.test("真實樣本：107 個空格（35 噪音振動、72 空氣）", () => {
    assert.strictEqual(slots.length, 107);
    assert.strictEqual(as.length, 107);
    assert.strictEqual(slots.filter((s) => ["LEQ", "LD", "LE", "LN", "LVD", "LVN", "LVMAX"].indexOf(s.item) >= 0).length, 35);
    assert.strictEqual(slots.filter((s) => s.tableIndex >= 5).length, 72);
  });
  T.test("真實樣本：60 個空氣數值與標準答案完全相同、多數兩來源一致", () => {
    const air = as.filter((a) => AIR.indexOf(slotById[a.slotId].item) >= 0);
    assert.strictEqual(air.length, 60);
    let checked = 0;
    air.forEach((a) => {
      const s = slotById[a.slotId];
      assert.ok(a.value !== "", s.station + " " + s.item + " " + s.stat + " 未填：" + a.note);
      assert.ok(["checked", "auto"].indexOf(a.status) >= 0, s.station + " " + s.item + " " + a.status + " " + a.note);
      if (a.status === "checked") checked++;
    });
    assert.ok(checked >= 40, "checked=" + checked);
    if (EXP) {
      assert.strictEqual(EXP.air.length, 60);
      EXP.air.forEach((e) => {
        const hits = air.filter((a) => {
          const s = slotById[a.slotId];
          return s.item === e.item && s.stat === e.stat && D.stationSim(s.station, e.station) >= 0.95;
        });
        assert.strictEqual(hits.length, 1, e.station + " " + e.item + " " + e.stat);
        assert.strictEqual(hits[0].value, e.value, e.station + " " + e.item + " " + e.stat + "：" + hits[0].value + "（" + hits[0].note + "）");
      });
    }
  });
  T.test("真實樣本：臭氣 4 格待對應，4 個無測站測點；指定對應後填入", () => {
    const odorSlots = slots.filter((s) => s.item === "ODOR");
    assert.strictEqual(odorSlots.length, 4);
    odorSlots.forEach((s) => assert.strictEqual(as.filter((a) => a.slotId === s.id)[0].status, "mapping"));
    const od = facts.filter((f) => f.item === "ODOR");
    assert.strictEqual(od.length, 4);
    assert.ok(od.every((f) => !f.station));
    assert.deepStrictEqual(od.map((f) => f.pointNo), [1, 2, 3, 4]);
    if (EXP) assert.deepStrictEqual(od.map((f) => f.value), EXP.odor.values);
    const aliases = {};
    odorSlots.forEach((s, i) => { aliases["#ODOR#" + (i + 1)] = s.station; });
    const as2 = M.run(slots, facts, { aliases });
    odorSlots.forEach((s, i) => {
      const a = as2.filter((x) => x.slotId === s.id)[0];
      assert.strictEqual(a.value, od[i].value, s.station);
      assert.strictEqual(a.status, "auto");
    });
    const g = M.unmatchedGroups(slots, facts, as);
    assert.deepStrictEqual(g.map((x) => x.stationKey).sort(), ["#ODOR#1", "#ODOR#2", "#ODOR#3", "#ODOR#4"]);
    assert.strictEqual(M.unmatchedGroups(slots, facts, as2).length, 0);
  });
  T.test("真實樣本：硫化氫／氨（8 格）與噪音振動（35 格）→ missing", () => {
    const miss = as.filter((a) => ["H2S", "NH3", "LEQ", "LD", "LE", "LN", "LVD", "LVN", "LVMAX"].indexOf(slotById[a.slotId].item) >= 0);
    assert.strictEqual(miss.length, 43);
    miss.forEach((a) => assert.deepStrictEqual([a.status, a.value], ["missing", ""], slotById[a.slotId].label));
  });
  T.test("真實樣本：無錯填（同項目、同測站、非標準值）", () => {
    as.forEach((a) => {
      if (!a.factId) return;
      const s = slotById[a.slotId], f = factById[a.factId];
      assert.strictEqual(f.item, s.item, s.label);
      assert.ok(D.stationSim(f.station, s.station) >= 0.95, s.label + " ← " + f.station);
      assert.ok(!/標準/.test(f.labels), f.labels);
      a.candidates.forEach((c) => {
        const cf = factById[c.factId];
        assert.strictEqual(cf.item, s.item);
        assert.ok(D.stationSim(cf.station, s.station) >= 0.95, s.label + " 候選 " + cf.station);
      });
    });
    // 只有 12 格的那張表（沒有臭氣／硫化氫／氨）不可取得別站數值
    const t12 = slots.filter((s) => s.tableIndex >= 5).reduce((m, s) => { m[s.tableId] = (m[s.tableId] || 0) + 1; return m; }, {});
    const tid = Object.keys(t12).filter((k) => t12[k] === 12)[0];
    assert.ok(tid);
    as.filter((a) => slotById[a.slotId].tableId === tid).forEach((a) => {
      const f = factById[a.factId];
      assert.strictEqual(f.station, slotById[a.slotId].station);
    });
  });
  T.test("真實樣本：效能（擷取＋比對）< 3 秒", () => {
    const t0 = Date.now();
    const f2 = X.facts(R.adata, { stations }).concat(X.facts(R.odor, { stations }));
    M.run(X.slots(R.template, { stations }), f2, {});
    assert.ok(Date.now() - t0 < 3000, (Date.now() - t0) + "ms");
  });
}

T.done("match.test.js" + (H.haveReal() ? "（含真實樣本驗收）" : "（未找到真實樣本，略過驗收）"));
