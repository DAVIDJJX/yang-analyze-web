/* fill/extract.js 單元測試：node tests/fill/extract.test.js
 * 合成表格（測站名稱皆為虛構）；若 test_data/fill/ 有使用者真實樣本（不進版控），另跑真實資料檢查。 */
"use strict";
const assert = require("node:assert");
const H = require("./semantic_helpers.js");
const YF = H.load();
const X = YF.extract;
const T = H.harness();
const { grid, doc } = H;

const KNOWN = ["白河新村", "南港社區活動中心", "東湖", "西林"];
const find = (facts, pred) => facts.filter(pred);
const one = (facts, pred, msg) => {
  const r = facts.filter(pred);
  assert.strictEqual(r.length, 1, (msg || "") + " 找到 " + r.length + " 筆：" + JSON.stringify(r.map((f) => [f.id, f.item, f.stat, f.value])));
  return r[0];
};
const at = (facts, tableId, r, c) => facts.filter((f) => f.tableId === tableId && f.r === r && f.c === c)[0];

/* ---------------- A：掃描總表（同構兩頁＋下方延續表格） ---------------- */
function summaryPage(page, id, station, vals, stdHeader) {
  const geom0 = { xs: [100, 300, 500, 700, 900, 1100], y0: 500, rowH: 40 };
  const geom1 = { xs: [100, 300, 500, 700, 900, 1100], y0: 990, rowH: 40 };
  const t0 = grid("p" + page + "t0", [
    ["測項 (單位)", "現場編號", id, stdHeader, "檢測方法編號"],
    ["^", "檢測位置", station, "^", "^"],
    ["^", "檢測日期/時間", "115.01.05/ 10:00 至 115.01.06/10:00", "^", "^"],
    ["SO2 (ppm)", "最大小時平均值", vals[0], "0.075", "NIEA A416.14C"],
    ["^", "日平均值", vals[1], "*", "^"],
    ["NOx (ppm)", "最大小時平均什", vals[2], "0.21", "NIEA A417.13C"],
    ["^", "日平均值", vals[3], "0.11", "^"],
    ["CO (ppm)", "最大小時平均值", vals[4], "35", "NIEA A421.14C"],
    ["^", "8小時最大平均值", vals[5], "9", "^"],
    ["PMio (ug/m³)", "日平均值", vals[6], "100", "NIEA A206.11C"],
    ["TSP (μg/m3)", "24 小時值", vals[7], "250", "NIEA A102.13A"]
  ], { page, index: 0, geom: geom0, context: ["檢測報告", "報告日期：115.04.20"] });
  const t1 = grid("p" + page + "t1", [
    ["NO2 (ppm)", "最大小時平均值", vals[8], "0.100", "NIEA A417.13C"],
    ["^", "日平均值", vals[9], "*", "^"],
    ["測定條件", "平均風速(m/s)", "1.2", "平均氣溫(°C)", "25.1"]
  ], { page, index: 1, geom: geom1 });
  return [t0, t1];
}
const SUMMARY = doc("sum", summaryPage(1, "1150101AQ-1", "白和新村",
  ["0.003", "0.002", "0.021", "0.011", "0.5", "0.3", "28,5", "45", "0.015", "0.008"], "")
  .concat(summaryPage(2, "1150101AQ-2", "南港社區活動中心",
    ["0.004", "0.001", "0.030", "0.012", "0.6", "0.4", "31", "52", "0.019", "0.009"], "空氣品質標準")), "raw", "summary.xdw");

T.test("總表：項目/統計別/單位/測站（OCR 變體對到已知測站）", () => {
  const f = X.facts(SUMMARY, { stations: KNOWN });
  const so2 = at(f, "p1t0", 3, 2);
  assert.ok(so2, "SO2 max1h");
  assert.deepStrictEqual([so2.item, so2.stat, so2.unit, so2.station, so2.stationRaw, so2.source, so2.value, so2.date],
    ["SO2", "max1h", "ppm", "白河新村", "白和新村", "pivot", "0.003", "115.01.05"]);
  assert.strictEqual(at(f, "p1t0", 4, 2).stat, "daily");
  assert.deepStrictEqual([at(f, "p1t0", 5, 2).item, at(f, "p1t0", 5, 2).stat], ["NOx", "max1h"]);
  assert.deepStrictEqual([at(f, "p1t0", 8, 2).item, at(f, "p1t0", 8, 2).stat], ["CO", "max8h"]);
  const pm = at(f, "p1t0", 9, 2);
  assert.deepStrictEqual([pm.item, pm.stat, pm.unit, pm.value, pm.num], ["PM10", "daily", "ug/m3", "28.5", 28.5]);
  assert.deepStrictEqual([at(f, "p1t0", 10, 2).item, at(f, "p1t0", 10, 2).stat], ["TSP", "daily"]);
  assert.strictEqual(at(f, "p2t0", 3, 2).station, "南港社區活動中心");
  assert.strictEqual(so2.where, "第1頁 表1 第4列第3欄");
  assert.strictEqual(so2.docName, "summary.xdw");
  assert.ok(so2.bbox && so2.bbox.x0 > 0);
  assert.ok(/SO2/.test(so2.labels));
});

T.test("總表：標準值欄（表頭空白→向同構頁借用）、方法欄不成為數值", () => {
  const f = X.facts(SUMMARY, { stations: KNOWN });
  assert.strictEqual(find(f, (x) => x.c >= 3 && /t0$/.test(x.tableId)).length, 0, "標準值/方法欄");
  ["0.075", "0.21", "0.11", "35", "9", "100", "250", "0.100"].forEach((v) =>
    assert.strictEqual(find(f, (x) => x.value === v).length, 0, "標準值 " + v));
  assert.strictEqual(find(f, (x) => /NIEA/.test(x.cellText)).length, 0);
  // 單頁（沒有同構表格可借）時，p1 的空白表頭欄只有 1 個 * → 不會被判為標準欄；但列內重複規則仍會剔除
  const single = X.facts(doc("one", summaryPage(1, "1150101AQ-1", "白河新村",
    ["0.003", "0.002", "0.021", "0.011", "0.5", "0.3", "28", "45", "0.015", "0.008"], "")), { stations: KNOWN });
  assert.strictEqual(find(single, (x) => x.c === 3).length, 0, "同列重複（右側欄無表頭）應剔除");
});

T.test("延續表格（同頁下方、欄位對齊、無表頭）：沿用上方表頭與測站", () => {
  const f = X.facts(SUMMARY, { stations: KNOWN });
  const no2 = at(f, "p1t1", 0, 2);
  assert.deepStrictEqual([no2.item, no2.stat, no2.unit, no2.station, no2.value], ["NO2", "max1h", "ppm", "白河新村", "0.015"]);
  assert.strictEqual(at(f, "p1t1", 0, 3), undefined, "延續表格的標準值");
  assert.strictEqual(at(f, "p1t1", 2, 4), undefined, "延續表格「檢測方法編號」欄");
  const ws = at(f, "p1t1", 2, 2);
  assert.deepStrictEqual([ws.item, ws.unit, ws.station], ["WS", "m/s", "白河新村"]);
  assert.strictEqual(at(f, "p2t1", 0, 2).station, "南港社區活動中心");
  // NOx 不可當 NO2
  find(f, (x) => x.item === "NO2").forEach((x) => assert.ok(!/NOx/.test(x.labels.split(" / ")[0]), x.labels));
});

T.test("延續表格：無座標（PDF 文字層）時，同頁緊接的下一表亦沿用表頭", () => {
  const pages = summaryPage(5, "1150101AQ-1", "白河新村",
    ["0.003", "0.002", "0.021", "0.011", "0.5", "0.3", "28", "45", "0.015", "0.008"], "空氣品質標準");
  pages.forEach((t) => t.cells.forEach((c) => { c.bbox = null; }));
  const f = X.facts(doc("nobox", pages), { stations: KNOWN });
  assert.strictEqual(at(f, "p5t1", 0, 2).station, "白河新村");
  assert.strictEqual(at(f, "p5t1", 0, 3), undefined);
  // 不同頁不沿用
  pages[1].page = 6;
  const g = X.facts(doc("nobox2", pages), { stations: KNOWN });
  assert.strictEqual(at(g, "p5t1", 0, 2).station, null);
});

T.test("無已知測站清單：仍以「檢測位置」欄位為測站", () => {
  const f = X.facts(SUMMARY, {});
  assert.strictEqual(at(f, "p1t0", 3, 2).station, "白和新村");
  assert.strictEqual(at(f, "p2t0", 3, 2).station, "南港社區活動中心");
});

/* ---------------- B：逐時紀錄表 ---------------- */
function hourly(page, note, opts) {
  opts = opts || {};
  const hdr = ["項目 時間", "So, ppb", "NOz ppb", "NOx ppb", "CO ppm", "CO 8小時平均 ppm", "O ppb", "O; 8小時平均 ppb", "TSP μg/m3"];
  const rows = [[note, "<", "<", "<", "<", "<", "<", "<", "<"], hdr];
  for (let h = 0; h < 24; h++) {
    const a = String((10 + h) % 24).padStart(2, "0"), b = String((11 + h) % 24).padStart(2, "0");
    const lab = h === 17 ? a + ":00 ~ °" + b + ":00" : a + ":00 ~ " + b + ":00";
    const v = (x) => (x + h * 0.1).toFixed(2);
    rows.push([lab, v(1), v(5), v(9), v(0.2), h < 7 ? "*" : v(0.25), v(20), h < 7 ? "*" : v(18), h === 0 ? "40.00" : "^"]);
  }
  rows.push(["最大小時平均什", "3.40", "7.30", "11.30", "2.50", "2.10", "22.30", "19.90", "*"]);
  rows.push(["最小小時平均值", "1.00", "5.00", "9.00", "0.20", "0.95", "20.00", "18.70", "*"]);
  rows.push(["日平均值或 最頻風向", "2.15", "6.15", "10.15", "1.35", "1.50", "21.15", "19.30", "40.00"]);
  return grid("p" + page + "t0", rows, { page, index: 0, context: opts.context || ["空氣品質監測逐時結果紀錄表(1/2)"] });
}
const HOURLY = doc("hr", [hourly(9, "計畫名稱：測試計畫 現場編號：1150101AQ-1 監測位置：白和新村 監測日期：115.01.05~115.01.06 執行單位：測試實驗室")]);

T.test("逐時表：只取統計列，逐時列（含 OCR 雜點時段）不擷取", () => {
  const f = X.facts(HOURLY, { stations: KNOWN });
  assert.strictEqual(f.length, 22, "3 列 × 7 欄 + TSP 日平均：" + f.map((x) => x.r + "," + x.c).join(" "));
  assert.ok(f.every((x) => x.r >= 26));
  assert.strictEqual(find(f, (x) => x.item === "TSP").length, 1);
});

T.test("逐時表：項目（So,→SO2、NOz→NO2、O ppb→O3）、統計別組合、單位、測站", () => {
  const f = X.facts(HOURLY, { stations: KNOWN });
  const exp = {
    "26,1": ["SO2", "max1h", "ppb"], "26,2": ["NO2", "max1h", "ppb"], "26,3": ["NOx", "max1h", "ppb"],
    "26,4": ["CO", "max1h", "ppm"], "26,5": ["CO", "max8h", "ppm"], "26,6": ["O3", "max1h", "ppb"],
    "26,7": ["O3", "max8h", "ppb"], "27,5": ["CO", "min8h", "ppm"], "27,1": ["SO2", "min1h", "ppb"],
    "28,1": ["SO2", "daily", "ppb"], "28,5": ["CO", "avg8h", "ppm"], "28,8": ["TSP", "daily", "ug/m3"]
  };
  Object.keys(exp).forEach((k) => {
    const [r, c] = k.split(",").map(Number);
    const x = at(f, "p9t0", r, c);
    assert.ok(x, k);
    assert.deepStrictEqual([x.item, x.stat, x.unit], exp[k], k);
    assert.strictEqual(x.station, "白河新村", k);
    assert.strictEqual(x.source, "context");
    assert.strictEqual(x.date, "115.01.05");
  });
  assert.ok(find(f, (x) => x.item === "WD").length === 0, "日平均值或最頻風向 不應成為風向");
});

/* ---------------- C：記錄式（Excel）表格 ---------------- */
const RECORD_RAW = doc("rec", [grid("s:測站資料:b0", [
  ["測站", "項目", "統計", "數值", "單位"],
  ["白河新村", "SO2", "最大小時平均值", "1.2", "ppb"],
  ["白河新村", "PM10", "日平均值", "35", "μg/m3"],
  ["南港社區活動中心", "SO2", "最大小時平均值", "0.004", "ppm"],
  ["南港社區活動中心", "PM2.5", "日平均值", "ND", "μg/m3"]
], { sheet: "測站資料" })]);
const RECORD_TPL = doc("rect", [grid("s:填報:b0", [
  ["測站", "項目", "統計", "數值", "單位"],
  ["白河新村", "SO2", "小時平均值", "", "ppm"],
  ["南港社區活動中心", "PM2.5", "24小時值", "", "μg/m3"],
  ["白河新村", "NO2", "小時平均值", "", ""]
], { sheet: "填報", title: "填報" })], "template");

T.test("記錄式原始資料：測站/項目/統計/單位欄", () => {
  [KNOWN, []].forEach((st) => {
    const f = X.facts(RECORD_RAW, { stations: st });
    assert.strictEqual(f.length, 4);
    const a = at(f, "s:測站資料:b0", 1, 3);
    assert.deepStrictEqual([a.item, a.stat, a.unit, a.station, a.source, a.value], ["SO2", "max1h", "ppb", "白河新村", "row", "1.2"]);
    const b = at(f, "s:測站資料:b0", 4, 3);
    assert.deepStrictEqual([b.item, b.stat, b.unit, b.station, b.value, b.cmp], ["PM2.5", "daily", "ug/m3", "南港社區活動中心", "ND", "ND"]);
    assert.strictEqual(a.where, "工作表「測站資料」 表1 第2列第4欄");
  });
});

T.test("記錄式待填表格：空白「數值」欄為空格，「單位」欄空白不算", () => {
  [KNOWN, []].forEach((st) => {
    const s = X.slots(RECORD_TPL, { stations: st });
    assert.strictEqual(s.length, 3, JSON.stringify(s.map((x) => x.id)));
    assert.deepStrictEqual([s[0].item, s[0].stat, s[0].unit, s[0].unitFrom, s[0].station], ["SO2", "h1", "ppm", "header", "白河新村"]);
    assert.deepStrictEqual([s[1].item, s[1].stat, s[1].unit, s[1].station], ["PM2.5", "daily", "ug/m3", "南港社區活動中心"]);
    assert.deepStrictEqual([s[2].item, s[2].unit, s[2].unitFrom], ["NO2", "ppm", "default"]);
    assert.deepStrictEqual(s[0].ref, { r: 1, c: 3 });
    assert.strictEqual(s[0].id, "rect|s:填報:b0|1,3");
  });
});

/* ---------------- D：樞紐表（測站為欄） ---------------- */
const PIVOT_RAW = doc("piv", [grid("t0", [
  ["項目", "白河新村", "南港社區活動中心"],
  ["SO2 小時平均值 (ppm)", "0.003", "0.002"],
  ["PM10 日平均值 (μg/m3)", "40", "38"]
])]);
const PIVOT_TPL = doc("pivt", [grid("t0", [
  ["項目＼測站", "白河新村", "南港社區活動中心"],
  ["SO2 小時平均值 (ppm)", "", ""],
  ["PM10 24小時值 (μg/m3)", "", ""]
], { title: "表1 空氣品質監測結果" })], "template");

T.test("樞紐表：測站為欄標題（raw / 範本）", () => {
  const f = X.facts(PIVOT_RAW, { stations: KNOWN });
  assert.strictEqual(f.length, 4);
  assert.deepStrictEqual([at(f, "t0", 1, 2).station, at(f, "t0", 1, 2).item, at(f, "t0", 1, 2).stat, at(f, "t0", 1, 2).source],
    ["南港社區活動中心", "SO2", "h1", "pivot"]);
  assert.strictEqual(at(f, "t0", 2, 1).station, "白河新村");
  const fn = X.facts(PIVOT_RAW, {});
  assert.strictEqual(at(fn, "t0", 1, 2).station, "南港社區活動中心", "無已知測站時以欄標題為測站");
  [KNOWN, []].forEach((st) => {
    const s = X.slots(PIVOT_TPL, { stations: st });
    assert.strictEqual(s.length, 4);
    assert.deepStrictEqual(s.map((x) => x.station), ["白河新村", "南港社區活動中心", "白河新村", "南港社區活動中心"]);
    assert.deepStrictEqual(s.map((x) => x.item + "/" + x.stat), ["SO2/h1", "SO2/h1", "PM10/daily", "PM10/daily"]);
  });
  assert.deepStrictEqual(X.templateStations(PIVOT_TPL), ["白河新村", "南港社區活動中心"]);
});

/* ---------------- E：噪音振動範本（合併表頭、季別列、標準值列） ---------------- */
const NOISE_TPL = doc("noise", [grid("t0", [
  ["監測項目\n檢測季別", "噪音dB(A)", "<", "<", "<", "振動dB", "<", "<"],
  ["^", "Leq", "L日", "L晚", "L夜", "Lv日", "Lv晚", "Lvmax"],
  ["115年第三季", "", "", "", "", "", "", ""],
  ["標準值", "—", "60", "55", "50", "65", "60", "—"],
  ["108.03.14後\n適用標準值[1]", "—", "65", "60", "55", "70", "65", "—"]
], { title: "表3-1 東湖社區活動中心噪音振動監測歷次調查結果彙整(2/2)" }),
grid("t1", [
  ["時段", "噪音", "<", "振動", "<"],
  ["^", "日間", "夜間", "日間", "夜間"],
  ["115年第三季", "", "", "", ""]
], { title: "表3-2 西林噪音振動監測結果" })], "template");

T.test("噪音振動範本：合併表頭、季別、測站取自表名、Lv晚=夜間振動", () => {
  const s = X.slots(NOISE_TPL, {});
  const t0 = s.filter((x) => x.tableId === "t0");
  assert.deepStrictEqual(t0.map((x) => x.item), ["LEQ", "LD", "LE", "LN", "LVD", "LVN", "LVMAX"]);
  assert.deepStrictEqual(t0.map((x) => x.unit), ["dB(A)", "dB(A)", "dB(A)", "dB(A)", "dB", "dB", "dB"]);
  t0.forEach((x) => {
    assert.strictEqual(x.station, "東湖社區活動中心");
    assert.strictEqual(x.period, "115年第三季");
    assert.deepStrictEqual(x.periodInfo, { y: 115, q: 3 });
    assert.strictEqual(x.stat, "value");
  });
  assert.deepStrictEqual(t0[0].headers, ["噪音dB(A)", "Leq"]);
  assert.deepStrictEqual(t0[0].rowLabels, ["115年第三季"]);
  assert.ok(/^表3-1 東湖.*｜噪音dB\(A\) Leq｜115年第三季$/.test(t0[0].label), t0[0].label);
});

T.test("通用詞「日間/夜間」依合併表頭判斷噪音或振動", () => {
  const s = X.slots(NOISE_TPL, {}).filter((x) => x.tableId === "t1");
  assert.deepStrictEqual(s.map((x) => x.item), ["LD", "LN", "LVD", "LVN"]);
  assert.ok(s.every((x) => x.station === "西林"));
});

T.test("templateStations：表名推得測站", () => {
  assert.deepStrictEqual(X.templateStations(NOISE_TPL), ["東湖社區活動中心", "西林"]);
  // 已知測站清單有「東湖」時，回傳已知（標準化）名稱，便於與原始資料一致
  const st = X.templateStations(NOISE_TPL, { stations: ["東湖"] });
  assert.strictEqual(st[0], "東湖");
});

/* ---------------- F：小數逗號、ND、<x ---------------- */
T.test("數值格式：小數逗號、ND、<x、科學記號", () => {
  const d = doc("vals", [grid("t0", [
    ["項目", "結果", "單位"],
    ["SO2 小時平均值", "1,10", "ppb"],
    ["PM2.5 日平均值", "<2", "μg/m3"],
    ["臭氣", "N.D.", "-"],
    ["大腸桿菌群", "6.0×10^4", "CFU/100mL"],
    ["NO2 小時平均值", "28,90", "ppb"]
  ], { title: "白河新村檢測結果" })]);
  const f = X.facts(d, { stations: KNOWN });
  assert.strictEqual(f.length, 5);
  assert.deepStrictEqual(f.map((x) => x.value), ["1.10", "<2", "ND", "6.0×10^4", "28.90"]);
  assert.deepStrictEqual(f.map((x) => x.unit), ["ppb", "ug/m3", null, "CFU/100mL", "ppb"]);
  assert.ok(f.every((x) => x.station === "白河新村" && x.source === "context"), "表名測站");
  assert.strictEqual(f[1].cmp, "<");
  assert.strictEqual(f[3].num, 60000);
});

/* ---------------- G：無測站的異味報告（測點編號） ---------------- */
function odorTable(labels) {
  return grid("p1t0", [
    ["測點", "項目／方法", "污染物濃度值", "排放 BR"],
    ["^", "^", "寅測值", "^"],
    [labels[0], "異味污染物", "25", "30"],
    ["^", "NIEA A201.15A", "^", "^"],
    [labels[1], "BRIG RA", "12", "30"],
    ["^", "NIEA A201.15A", "^", "^"],
    [labels[2], "Mok is", "<10", "10"],
    ["^", "NIBA A201, 154", "^", "^"]
  ], { page: 1, context: ["周界異味檢測結果摘要", "地點 OK"] });
}
T.test("異味：方法編號推得項目、排放標準欄排除、無測站→測點序號", () => {
  const f = X.facts(doc("od", [odorTable(["x", "*", "*"])]), { stations: KNOWN });
  assert.strictEqual(f.length, 3, JSON.stringify(f.map((x) => [x.r, x.c, x.value])));
  assert.deepStrictEqual(f.map((x) => x.item), ["ODOR", "ODOR", "ODOR"]);
  assert.deepStrictEqual(f.map((x) => x.value), ["25", "12", "<10"]);
  assert.deepStrictEqual(f.map((x) => x.pointNo), [1, 2, 3]);
  assert.deepStrictEqual(f.map((x) => x.stationKey), ["#ODOR#1", "#ODOR#2", "#ODOR#3"]);
  assert.ok(f.every((x) => x.station === null && x.source === "point"));
  const g = X.facts(doc("od2", [odorTable(["③", "①", "②"])]), { stations: KNOWN });
  assert.deepStrictEqual(g.map((x) => x.pointNo), [3, 1, 2], "圈號優先");
  const h = X.facts(doc("od3", [odorTable(["測點一", "測點二", "測點四"])]), {});
  assert.deepStrictEqual(h.map((x) => x.pointNo), [1, 2, 4]);
});

/* ---------------- H：現場編號對照測站 ---------------- */
function kvTable(page, id, station, item, stat, value) {
  return grid("p" + page + "t0", [
    ["測項 (單位)", "現場編號", id],
    ["^", "檢測位置", station],
    [item, stat, value]
  ], { page });
}
function noteTable(page, note) {
  return grid("p" + page + "t0", [
    [note, "<", "<"],
    ["項目 時間", "SO2 ppb", "NO2 ppb"],
    ["最大小時平均值", "1.30", "8.10"]
  ], { page });
}
T.test("現場編號：同文件已知測站的編號 → 測站 OCR 失敗頁面", () => {
  const d = doc("ids", [
    kvTable(10, "1150101AQ-1", "白河新村", "SO2 (ppm)", "最大小時平均值", "0.003"),
    kvTable(11, "1150101AQ-2", "南港社區活動中心", "SO2 (ppm)", "最大小時平均值", "0.004"),
    kvTable(12, "1150101AQ-1", "BARR", "PM2.5 (ug/m3)", "24小時值", "12"),
    noteTable(13, "現場編號:1150181AQ-2 監測位置:城頭 監測日期:115.01.05"),
    noteTable(14, "現場編號:1150101AQ-9 監測位置:XX 監測日期:115.01.05"),
    noteTable(15, "現場編號:1150101AQ-1 監測日期:115.01.05")
  ]);
  const f = X.facts(d, { stations: KNOWN });
  const p12 = at(f, "p12t0", 2, 2);
  assert.deepStrictEqual([p12.station, p12.stationRaw, p12.stationVia], ["白河新村", "BARR", "sampleId"]);
  assert.strictEqual(at(f, "p13t0", 2, 1).station, "南港社區活動中心", "編號差一字（非區別碼）");
  assert.strictEqual(at(f, "p14t0", 2, 1).station, "XX", "區別碼不明 → 不猜");
  assert.strictEqual(at(f, "p15t0", 2, 1).station, "白河新村", "無測站文字、編號相符");
});

/* ---------------- I：排除欄位 ---------------- */
T.test("排除：方法、偵測極限、單位、日期、備註、標準列", () => {
  const d = doc("ex", [grid("t0", [
    ["項目", "檢測結果", "偵測極限", "檢測方法", "採樣日期", "備註", "單位"],
    ["SO2 (ppm)", "0.003", "0.0006", "NIEA A416", "115.01.05", "1", "ppm"],
    ["空氣品質標準", "0.075", "", "", "", "", ""]
  ], { title: "白河新村" })]);
  const f = X.facts(d, { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.value), ["0.003"]);
  const tpl = doc("ext", [grid("t0", [
    ["項目", "數值", "單位", "檢測方法", "備註", "採樣日期"],
    ["SO2 小時平均值", "", "", "", "", ""],
    ["空氣品質標準", "", "", "", "", ""]
  ], { title: "表1 白河新村空氣品質" })], "template");
  const s = X.slots(tpl, {});
  assert.deepStrictEqual(s.map((x) => x.r + "," + x.c), ["1,1"]);
});

/* ---------------- J：同工作表上下兩區塊 ---------------- */
T.test("堆疊區塊：第二區塊用自己的表頭", () => {
  const d = doc("stack", [grid("s:S:b0", [
    ["項目", "白河新村", "南港社區活動中心"],
    ["SO2 (ppm) 小時平均值", "0.003", "0.002"],
    ["", "", ""],
    ["項目", "東湖", "西林"],
    ["SO2 (ppm) 小時平均值", "0.006", "0.007"]
  ], { sheet: "S" })]);
  const f = X.facts(d, { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.station), ["白河新村", "南港社區活動中心", "東湖", "西林"]);
});

/* ---------------- N / O：標準值欄（*）啟發式、同列重複 ---------------- */
T.test("單頁：多數為 * 的無表頭欄判為標準值欄", () => {
  const d = doc("star", [grid("t0", [
    ["測項", "統計", "結果", ""],
    ["SO2 (ppm)", "最大小時平均值", "0.003", "0.075"],
    ["^", "日平均值", "0.002", "*"],
    ["NO2 (ppm)", "最大小時平均值", "0.010", "*"],
    ["^", "日平均值", "0.005", "*"],
    ["CO (ppm)", "最大小時平均值", "0.4", "35"]
  ], { title: "白河新村" })]);
  const f = X.facts(d, { stations: KNOWN });
  assert.ok(f.every((x) => x.c === 2), JSON.stringify(f.map((x) => [x.c, x.value])));
  assert.strictEqual(f.length, 5);
});

/* ---------------- P：表名／工作表名稱測站 ---------------- */
T.test("測站取自表名或工作表名稱；頁面列有多個測站時不猜", () => {
  const a = X.facts(doc("ta", [grid("t0", [["項目", "結果"], ["SO2 小時平均值(ppm)", "0.003"]],
    { title: "表1 南港社區活動中心空氣品質檢測結果" })]), { stations: KNOWN });
  assert.strictEqual(a[0].station, "南港社區活動中心");
  const b = X.facts(doc("tb", [grid("s:白河新村:b0", [["項目", "結果"], ["SO2 小時平均值(ppm)", "0.003"]], { sheet: "白河新村" })]), { stations: KNOWN });
  assert.strictEqual(b[0].station, "白河新村");
  const c = X.facts(doc("tc", [grid("p1t0", [["項目", "結果"], ["SO2 小時平均值(ppm)", "0.003"]],
    { page: 1, context: ["檢測位置：", "白河新村、南港社區活動中心、東湖"] })]), { stations: KNOWN });
  assert.strictEqual(c[0].station, null);
  assert.strictEqual(c[0].pointNo, 1);
});

/* ---------------- Q：Excel 逐時報告（HH ~ HH 時段、整數時序列、平均/最大值列） ---------------- */
function excelHourly(labelOf) {
  const rows = [
    ["空氣品質檢測報告", "<", "<", "<"],
    ["監測地點：白河新村", "<", "<", "<"],
    ["時間", "SO2(ppb)", "NO2(ppb)", "PM10(μg/m3)"]
  ];
  for (let h = 0; h < 24; h++) rows.push([labelOf(h), (1 + h / 100).toFixed(2), (5 + h / 10).toFixed(1), String(30 + h)]);
  rows.push(["平均", "1.12", "6.2", "41"]);
  rows.push(["最大值", "1.23", "7.3", "53"]);
  return doc("xh", [grid("s:白河:b0", rows, { sheet: "白河" })]);
}
T.test("Excel 逐時報告：「10 ~ 11」時段列不擷取，平均→日平均、最大值→最大小時值", () => {
  const f = X.facts(excelHourly((h) => (h + 10) % 24 + " ~ " + (h + 11) % 24), { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.item + "/" + x.stat + "/" + x.value),
    ["SO2/daily/1.12", "NO2/daily/6.2", "PM10/daily/41", "SO2/max1h/1.23", "NO2/max1h/7.3", "PM10/max1h/53"]);
  assert.ok(f.every((x) => x.station === "白河新村" && x.unit !== null));
});
T.test("Excel 逐時報告：整數時序（1~24）列不擷取", () => {
  const f = X.facts(excelHourly((h) => String(h + 1)), { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.stat + "/" + x.value), ["daily/1.12", "daily/6.2", "daily/41", "max1h/1.23", "max1h/7.3", "max1h/53"]);
});
T.test("整列「監測日期：…」不會排除數值；整列「空氣品質標準」標題仍排除", () => {
  const a = X.facts(doc("kv", [grid("t0", [
    ["監測日期：115.01.05　監測位置：白河新村", "<", "<"],
    ["項目", "日平均值", "最大小時平均值"],
    ["SO2 (ppm)", "0.002", "0.004"]
  ])]), { stations: KNOWN });
  assert.deepStrictEqual(a.map((x) => x.stat + "/" + x.value + "/" + x.station + "/" + x.date), ["daily/0.002/白河新村/115.01.05", "max1h/0.004/白河新村/115.01.05"]);
  const b = X.facts(doc("std", [grid("t0", [
    ["空氣品質標準", "<", "<"],
    ["項目", "日平均值", "小時平均值"],
    ["SO2 (ppm)", "0.05", "0.075"]
  ], { title: "白河新村" })]), { stations: KNOWN });
  assert.strictEqual(b.length, 0);
});
T.test("表中長註記列不阻斷上方表頭", () => {
  const f = X.facts(doc("note", [grid("t0", [
    ["項目", "白河新村"],
    ["SO2 小時平均值(ppm)", "0.003"],
    ["註：以下為補充測值，係依據環境部公告方法於現場以手持式儀器量測所得之結果，僅供內部參考使用，不作為法規判定依據", "<"],
    ["NO2 小時平均值(ppm)", "0.010"]
  ])]), { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.item + "/" + x.station), ["SO2/白河新村", "NO2/白河新村"]);
});

T.test("噪音原始資料：時段列 × 指標欄（日間×Leq→L日；夜間×Lmax→Lmax）、振動時段", () => {
  const f = X.facts(doc("nz", [grid("t0", [
    ["時段", "均能音量 Leq dB(A)", "最大音量 Lmax dB(A)"],
    ["日間", "58.3", "70.1"],
    ["晚間", "55.0", "66.2"],
    ["夜間", "50.4", "62.0"]
  ], { title: "白河新村噪音監測結果" }), grid("t1", [
    ["時段", "振動 Lv10 dB"],
    ["日間", "35.1"],
    ["夜間", "30.2"]
  ], { title: "白河新村振動監測結果" })]), { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.item + "/" + x.value + "/" + x.unit),
    ["LD/58.3/dB(A)", "LMAX/70.1/dB(A)", "LE/55.0/dB(A)", "LMAX/66.2/dB(A)", "LN/50.4/dB(A)", "LMAX/62.0/dB(A)", "LVD/35.1/dB", "LVN/30.2/dB"]);
  assert.ok(f.every((x) => x.station === "白河新村"));
});

T.test("數值後接單位（Word 報告「0.012 ppm」「25.3 ℃」）", () => {
  const f = X.facts(doc("wu", [grid("t0", [
    ["檢驗項目", "檢驗結果", "備註"],
    ["二氧化氮", "0.012 ppm", ""],
    ["水溫", "25.3 ℃", ""],
    ["PM2.5", "12 μg/m3", ""]
  ], { title: "表1 南港社區活動中心檢測結果" })]), { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.item + "/" + x.value + "/" + x.unit), ["NO2/0.012/ppm", "WT/25.3/℃", "PM2.5/12/ug/m3"]);
});

T.test("範本表內「監測位置：…」列與中文編號表名", () => {
  const s1 = X.slots(doc("tc", [grid("t0", [
    ["監測位置：東湖", "<", "<"],
    ["項目", "SO2", "NO2"],
    ["小時平均值(ppm)", "", ""]
  ], { title: "附表一 歷次監測結果" })], "template"), {});
  assert.deepStrictEqual(s1.map((x) => x.station + "/" + x.item), ["東湖/SO2", "東湖/NO2"]);
  const s2 = X.slots(doc("tc2", [grid("t0", [["項目", "SO2"], ["小時平均值(ppm)", ""]], { title: "表七 西林空氣品質監測結果" })], "template"), {});
  assert.strictEqual(s2[0].station, "西林");
  const s3 = X.slots(doc("tc3", [grid("t0", [["項目", "SO2"], ["小時平均值(ppm)", ""]], { title: "(二) 南港社區活動中心監測結果" })], "template"), {});
  assert.strictEqual(s3[0].station, "南港社區活動中心");
});

T.test("範本非數值列（備註、檢測日期、歷次平均值、註：…）不填；表名季別不當測站", () => {
  const s = X.slots(doc("tr", [grid("t0", [
    ["檢測季別", "SO2\n小時平均值(ppm)", "PM10\n24小時平均值(μg/m3)"],
    ["115年第三季", "", ""],
    ["備註", "", ""],
    ["歷次平均值", "", ""],
    ["歷次最大值", "", ""],
    ["檢測日期", "", ""],
    ["天氣狀況", "", ""],
    ["說明", "", ""],
    ["執行單位", "", ""]
  ], { title: "表2.1-1 東湖空氣品質歷次調查結果彙整" })], "template"), { stations: KNOWN });
  assert.deepStrictEqual(s.map((x) => x.r + "/" + x.item + "/" + x.station), ["1/SO2/東湖", "1/PM10/東湖"]);
  const s2 = X.slots(doc("tr2", [grid("t0", [
    ["測站名稱", "SO2", "NO2"],
    ["^", "小時平均值(ppm)", "小時平均值(ppm)"],
    ["東湖", "", ""],
    ["西林", "", ""],
    ["空氣品質標準", "0.075", "0.1"],
    ["註：本表由示範顧問公司彙整。", "", ""]
  ], { title: "表2 115年第三季空氣品質監測結果" })], "template"), {});
  assert.deepStrictEqual(s2.map((x) => x.r + "/" + x.station), ["2/東湖", "2/東湖", "3/西林", "3/西林"]);
  const s3 = X.slots(doc("tr3", [grid("t0", [["項目", "SO2"], ["小時平均值(ppm)", ""]], { title: "表2 115年第三季空氣品質監測結果" })], "template"), {});
  assert.strictEqual(s3[0].station, null);
});

T.test("OCR 誤認：項目欄「03」＝O3、「$02」＝SO2、Hg/m3 不是汞、小數點讀成冒號、監測位置.:", () => {
  const d = doc("ocr", [grid("p1t0", [
    ["項目", "單位", "測值"], ["$02", "ppm", "0.003"], ["NO2", "ppm", "0.011"], ["03", "ppm", "0.045"],
    ["CO", "ppm", "0:5"], ["PM10", "Hg/m3", "28"]
  ], { page: 1, context: ["監測位置.: 西林"] })], "raw", "scan.pdf");
  const f = X.facts(d, { stations: KNOWN });
  assert.deepStrictEqual(f.map((x) => x.item + "/" + x.value + "/" + x.station),
    ["SO2/0.003/西林", "NO2/0.011/西林", "O3/0.045/西林", "CO/0.5/西林", "PM10/28/西林"]);
  assert.ok(f[3].conf <= 50, "冒號小數需核對");
  assert.strictEqual(f[4].unit, "ug/m3");
});

T.test("表格內無日期時採用頁面文字「檢測日期：…」（不採用報告日期）", () => {
  const f = X.facts(doc("dt", [grid("p1t0", [["項目", "測值"], ["SO2 小時平均值(ppm)", "0.003"]],
    { page: 1, context: ["報告日期：115.09.30", "檢測日期：115.05.12~115.05.13", "監測位置：西林"] })], "raw", "q2.pdf"), { stations: KNOWN });
  assert.strictEqual(f[0].date, "115.05.12");
  const g = X.facts(doc("dt2", [grid("p1t0", [["項目", "測值"], ["SO2 小時平均值(ppm)", "0.003"]],
    { page: 1, context: ["報告日期：115.09.30", "生效日期：115.01.01"] })], "raw", "x.pdf"), { stations: KNOWN });
  assert.strictEqual(g[0].date, null);
});

T.test("超大稀疏表格（宣告 nRows 很大）不爆記憶體", () => {
  const t = { id: "huge", nRows: 1e7, nCols: 5000, cells: [
    { r0: 0, c0: 0, text: "項目" }, { r0: 0, c0: 1, text: "白河新村" },
    { r0: 1, c0: 0, text: "SO2 小時平均值(ppm)" }, { r0: 1, c0: 1, text: "0.003" }] };
  const f = X.facts(doc("h", [t]), { stations: KNOWN });
  assert.strictEqual(f.length, 1);
  const wide = { id: "w", cells: [{ r0: 0, c0: 0, text: "x" }, { r0: 199999, c0: 3999, text: "1" }] };
  const d = doc("w", [wide]);
  X.facts(d, {});
  assert.ok(d.warnings.some((w) => /過大/.test(w)), JSON.stringify(d.warnings));
});

/* ---------------- K：異常輸入 ---------------- */
T.test("異常輸入不拋例外", () => {
  assert.deepStrictEqual(X.facts(null), []);
  assert.deepStrictEqual(X.slots({}), []);
  assert.deepStrictEqual(X.templateStations(undefined), []);
  const bad = doc("bad", [
    { id: "t0", nRows: 0, nCols: 0, cells: [] },
    { id: "t1", nRows: 1, nCols: 1, cells: [null, { r0: 0, c0: 0, text: null }, { r0: -1, c0: 0, text: "x" }] },
    { id: "t2", nRows: 1, nCols: 1, cells: [{ r0: 0, r1: 3, c0: 0, c1: 2, text: "SO2" }, { r0: 2, r1: 1, c0: 3, c1: 3, text: "0.1" }] },
    { id: "t3", cells: [{ r0: 0, c0: 0, text: "SO2 (ppm)" }, { r0: 0, c0: 1, text: "0.003" }, { r0: 0, c0: 1, text: "0.004" }] },
    { id: "t4", nRows: 2, nCols: 2, cells: [{ r0: 0, r1: 0, c0: 0, c1: 0, text: 12345 }, { r0: 1, c0: 1, text: "<<<" }] }
  ]);
  const f = X.facts(bad, { stations: ["", null, { name: "白河新村", aliases: ["白河"] }, 5] });
  assert.ok(Array.isArray(f));
  const s = X.slots(Object.assign({}, bad, { role: "template" }), { stations: [] });
  assert.ok(Array.isArray(s));
  assert.strictEqual(X.explainCell(bad.tables[0], 5, 5), null);
});

T.test("explainCell：除錯資訊", () => {
  const e = X.explainCell(SUMMARY.tables[0], 3, 2);
  assert.strictEqual(e.kind, "value");
  assert.strictEqual(e.item, "SO2");
  assert.strictEqual(e.stat, "max1h");
  assert.deepStrictEqual(e.rowLabels.slice(0, 2), ["最大小時平均值", "SO2 (ppm)"]);
  assert.ok(e.colLabels.indexOf("白和新村") >= 0);
  assert.strictEqual(e.excluded, null);
  const std = X.explainCell(SUMMARY.tables[2], 3, 3);
  assert.ok(/標準/.test(std.excluded), std.excluded);
});

T.test("Fact／Slot 欄位完整", () => {
  const f = X.facts(SUMMARY, { stations: KNOWN })[0];
  ["id", "docId", "docName", "tableId", "page", "r", "c", "cellText", "item", "stat", "unit", "station", "stationKey",
    "pointNo", "value", "num", "cmp", "date", "conf", "bbox", "source", "where"].forEach((k) => assert.ok(k in f, k));
  const s = X.slots(NOISE_TPL, {})[0];
  ["id", "docId", "tableId", "r", "c", "ref", "item", "stat", "unit", "station", "stationKey", "period", "headers", "rowLabels", "label"]
    .forEach((k) => assert.ok(k in s, k));
  const ids = X.facts(SUMMARY, { stations: KNOWN }).map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, "Fact id 唯一");
});

T.test("效能：400 列 × 20 欄記錄表 < 1.5 秒", () => {
  const rows = [["測站", "項目", "統計"].concat(Array.from({ length: 17 }, (_, i) => "數值" + i))];
  for (let r = 0; r < 400; r++) {
    rows.push([r % 2 ? "白河新村" : "南港社區活動中心", ["SO2", "NO2", "CO", "PM10"][r % 4], "日平均值"]
      .concat(Array.from({ length: 17 }, (_, i) => String((r * 17 + i) / 100))));
  }
  const t0 = Date.now();
  const f = X.facts(doc("big", [grid("s:big:b0", rows, { sheet: "big" })]), { stations: KNOWN });
  const ms = Date.now() - t0;
  assert.ok(f.length > 6000, "facts=" + f.length);
  assert.ok(ms < 1500, ms + "ms");
});

/* ---------------- 真實樣本（僅在 test_data/fill/ 存在時） ---------------- */
if (H.haveReal()) {
  const R = H.realDocs();
  const stations = X.templateStations(R.template);
  T.test("真實樣本：範本測站與 107 個空格", () => {
    assert.strictEqual(stations.length, 7, JSON.stringify(stations));
    const s = X.slots(R.template, { stations });
    assert.strictEqual(s.length, 107);
    const noise = s.filter((x) => x.tableIndex <= 4), air = s.filter((x) => x.tableIndex >= 5);
    assert.strictEqual(noise.length, 35);
    assert.strictEqual(air.length, 72);
    for (let t = 0; t <= 4; t++) {
      assert.deepStrictEqual(noise.filter((x) => x.tableIndex === t).map((x) => x.item), ["LEQ", "LD", "LE", "LN", "LVD", "LVN", "LVMAX"]);
    }
    assert.ok(s.every((x) => x.station && x.period && x.periodInfo && x.periodInfo.q === 3));
    assert.strictEqual(air.filter((x) => x.item === "ODOR").length, 4);
    assert.ok(new Set(s.map((x) => x.id)).size === 107);
  });
  T.test("真實樣本：Fact 不含標準值、方法編號、逐時列", () => {
    const fa = X.facts(R.adata, { stations });
    assert.ok(fa.length > 250, "facts=" + fa.length);
    fa.forEach((f) => {
      assert.ok(!/NIEA|NIBA/.test(f.cellText), f.id);
      assert.ok(!/標準/.test(f.labels), f.id + " " + f.labels);
      assert.ok(f.stat !== "hourly" && f.stat !== "value" || ["WS", "TEMP", "RH", "WD"].indexOf(f.item) >= 0, f.id + " " + f.stat);
    });
    // 總表（含「檢測方法編號」的表格與其延續表）只有第 3 欄是數值
    const summaryIds = new Set(R.adata.tables.filter((t) => t.cells.some((c) => /檢測方法/.test(c.text))).map((t) => t.id));
    fa.filter((f) => summaryIds.has(f.tableId)).forEach((f) => assert.strictEqual(f.c, 2, f.id + " " + f.value));
    fa.filter((f) => /t1$/.test(f.tableId) && f.page <= 7).forEach((f) => assert.ok(f.c === 2, f.id));
    // NO2 不可取自 NOx 列/欄
    fa.filter((f) => f.item === "NO2").forEach((f) => assert.ok(!/NOx/i.test(f.labels.split(" / ").slice(0, 2).join(" ")), f.id + " " + f.labels));
    // 空氣污染物皆對到範本測站
    const set = new Set(stations);
    fa.filter((f) => ["SO2", "NO2", "CO", "O3", "THC", "NMHC", "CH4", "PM10", "PM2.5", "TSP"].indexOf(f.item) >= 0)
      .forEach((f) => assert.ok(set.has(f.station), f.id + " station=" + f.station));
  });
  T.test("真實樣本：異味 4 個無測站測點", () => {
    const fo = X.facts(R.odor, { stations });
    const od = fo.filter((f) => f.item === "ODOR");
    assert.strictEqual(od.length, 4);
    const exp = H.realExpected();
    if (exp) assert.deepStrictEqual(od.map((f) => f.value), exp.odor.values);
    assert.deepStrictEqual(od.map((f) => f.pointNo), [1, 2, 3, 4]);
    assert.ok(od.every((f) => !f.station && f.stationKey === "#ODOR#" + f.pointNo));
  });
  T.test("真實樣本：效能 < 3 秒", () => {
    const t0 = Date.now();
    X.facts(R.adata, { stations }); X.facts(R.odor, { stations }); X.slots(R.template, { stations });
    assert.ok(Date.now() - t0 < 3000);
  });
}

T.done("extract.test.js" + (H.haveReal() ? "（含真實樣本）" : "（未找到真實樣本，略過）"));
