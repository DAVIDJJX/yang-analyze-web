/* =========================================================================
 * 地下水水質報告（逐站一份、項目為列、檢測結果為欄）的合成測試。
 * 名稱皆為虛構（示範村、甲乙民宅…），不含任何真實監測資料。
 * 執行：node tests/fill/groundwater.test.js
 * ========================================================================= */
"use strict";
const assert = require("node:assert");
const H = require("./semantic_helpers.js");
const Y = H.load();
const T = H.harness();
const D = Y.dict, X = Y.extract;

/* ---------------- 詞庫：樣品名稱、OCR 誤讀、地下水項目、方法編號 ---------------- */
T.test("樣品名稱：取值、亂碼不採用", () => {
  assert.strictEqual(D.findSampleName("樣品名稱: 示範村     聯 絡 人: RRB"), "示範村");
  assert.strictEqual(D.findSampleName("樣品名稱：甲乙民宅"), "甲乙民宅");
  assert.strictEqual(D.findSampleName("樣品名稱: GK PR BEA"), null, "無中文不採用");
  assert.strictEqual(D.findSampleName("採樣地點: 某縣某鎮某路99號"), null);
});
T.test("地下水項目：氨氮不是氨；硫酸鹽、總溶解固體物、水位可辨識", () => {
  assert.deepStrictEqual(D.findItems("氨氮").map((h) => h.code), ["NH3N"]);
  assert.deepStrictEqual(D.findItems("氨").map((h) => h.code), ["NH3"]);
  assert.deepStrictEqual(D.findItems("硫酸鹽").map((h) => h.code), ["SO4"]);
  assert.deepStrictEqual(D.findItems("總溶解固體物").map((h) => h.code), ["TDS"]);
  assert.deepStrictEqual(D.findItems("水位").map((h) => h.code), ["GWL"]);
  assert.deepStrictEqual(D.findItems("硫化所").map((h) => h.code), ["H2S"], "OCR 誤讀");
});
T.test("檢測方法編號 W 系列 → 地下水項目（單一項目才指定）", () => {
  assert.strictEqual(D.findMethodItem("NIEA W436.53C").code, "NO3N");
  assert.strictEqual(D.findMethodItem("NIEA W311.54C").code, null, "多金屬共用方法，不指定");
});
T.test("IND（ND 的 OCR 誤讀）→ ND；02 之類前導零不是數值", () => {
  assert.strictEqual(D.parseValue("IND").value, "ND");
  assert.strictEqual(D.parseValue("“IND").value, "ND");
  assert.strictEqual(D.parseValue("02").ok, false);
  assert.strictEqual(D.parseValue("<0.040").value, "<0.040");
});

/* ---------------- 擷取：頁首樣品名稱、同一樣品連結、地址不當測站 ---------------- */
function reportPage(page, lines, rows) {
  // rows: [項目, 單位, 檢測結果, 檢驗方法]
  const grid = H.grid("p" + page + "t0",
    [["檢測項目", "單位", "檢測結果", "檢驗方法"]].concat(rows), { page });
  grid.context = lines;
  return grid;
}
const WELL = "嘉義縣某鎮某路99號";     // 採樣地點（地址）
const ROWS_A = [["水溫", "℃", "30.1", "NIEA W217.52A"], ["生化需氧量", "mg/L", "4.4", "NIEA W510.56B"], ["氨氮", "mg/L", "<0.05", "NIEA W437.52C"]];
const ROWS_B = [["硫酸鹽", "mg/L", "24.5", "NIEA W465.50B"], ["鎘", "mg/L", "ND", "NIEA W311.54C"]];
T.test("樣品名稱優先於採樣地點；同一樣品的其他頁面依採樣時間連結", () => {
  const p1 = reportPage(1, ["樣品名稱: 示範村", "採樣地點: " + WELL, "樣品編號: IJ115U0996-001", "採樣時間: 115.09.15 09:07~ 09:33"], ROWS_A);
  // 第 2 頁：樣品編號 OCR 有一字誤讀，名稱缺漏，但採樣時間相同
  const p2 = reportPage(2, ["採樣地點: " + WELL, "樣品編號: 1UJ119U0996-001", "採樣時間: 115.09.15 09:07~ 09:33"], ROWS_B);
  const d = H.doc("gw", [p1, p2], "raw", "gw.xdw");
  const tpl = H.doc("tpl", [H.grid("tt0", [["監測項目", "水溫", "硫酸鹽", "氨氮"], ["115年第三季", "", "", ""]], { page: null })], "template", "tpl.docx");
  tpl.tables[0].title = "表2.6-1 示範村(下游)地下水質監測歷次調查結果彙整(3/3)";
  const stations = X.templateStations(tpl);
  const f = X.facts(d, { stations });
  const f1 = f.filter((x) => x.page === 1), f2 = f.filter((x) => x.page === 2);
  assert.ok(f1.length && f2.length, "兩頁皆有擷取到數值");
  f1.forEach((x) => assert.strictEqual(x.stationRaw, "示範村"));
  f2.forEach((x) => assert.strictEqual(x.station, "示範村(下游)", "第 2 頁依採樣時間連結到同一樣品的測站"));
  assert.ok(!f.some((x) => x.station && /某路|99號/.test(x.station)), "地址不作為測站");
});
T.test("亂碼樣品名稱不連結；無法判定者保留為待對應（樣品為單位）", () => {
  const p1 = reportPage(1, ["樣品名稱: GK PR", "樣品編號: IJ115U0990-001", "採樣時間: 115.09.14 09:09~ 10:18"], ROWS_A);
  const d = H.doc("gw2", [p1], "raw", "gw2.xdw");
  const f = X.facts(d, { stations: ["示範村(下游)"] });
  assert.ok(f.length > 0);
  f.forEach((x) => {
    assert.ok(!x.station, "不得猜測測站");
    assert.strictEqual(x.stationKey, "樣品:0990-001", "同一樣品編號共用一個對應");
  });
});
T.test("模板測站：同段落含備註與表名時，取最後一個表名之後的測站", () => {
  const t = H.grid("tt1", [["監測項目", "水溫"], ["115年第三季", ""]], { page: null });
  t.title = "[2]：「數據」表超過第二類地下水污染監測標準。表2.6-5 甲乙民宅(下游)地下水質監測歷次調查結果彙整(3/3)";
  const names = X.templateStations(H.doc("tp", [t], "template", "tp.docx"));
  assert.deepStrictEqual(names, ["甲乙民宅(下游)"]);
});

T.done("groundwater.test.js");
