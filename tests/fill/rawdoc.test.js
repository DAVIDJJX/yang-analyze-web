/* fill/rawdoc.js 單元測試（純邏輯部分）：node tests/fill/rawdoc.test.js
 * 無框線文字型 PDF 的欄位推估、原始 Word 報告的頁首／前段測站脈絡。合成資料，測站名稱皆為虛構。 */
"use strict";
const assert = require("node:assert");
const path = require("node:path");
const H = require("./semantic_helpers.js");
const YF = H.load();
require(path.join(__dirname, "..", "..", "js", "fill", "rawdoc.js"));
const R = YF.raw, X = YF.extract;
const T = H.harness();

/* 文字項目：x 為左緣，字高 20（200 dpi 約 7 pt） */
function it(str, x, y, w) { return { str: str, x0: x, x1: x + (w || str.length * 11), y0: y, y1: y + 20 }; }
function lines(rows) {
  return R._groupLines([].concat.apply([], rows));
}

T.test("三線表／無框線表：依文字位置推估欄位，可擷取數值", () => {
  const L = lines([
    [it("表1 空氣品質監測結果", 100, 40, 220)],
    [it("監測位置：西林", 100, 80, 160)],
    [it("項目", 100, 140), it("單位", 400, 140), it("最大小時平均值", 600, 140, 150), it("日平均值", 850, 140)],
    [it("SO2", 100, 180), it("ppm", 400, 180), it("0.003", 620, 180), it("0.002", 860, 180)],
    [it("NO2", 100, 220), it("ppm", 400, 220), it("0.015", 620, 220), it("0.008", 860, 220)],
    [it("O3", 100, 260), it("ppm", 400, 260), it("0.045", 620, 260), it("0.030", 860, 260)]
  ]);
  const ts = R._layoutTables(L, 1, 200);
  assert.strictEqual(ts.length, 1);
  assert.strictEqual(ts[0].nCols, 4);
  assert.strictEqual(ts[0].nRows, 4);
  assert.strictEqual(ts[0].title, "監測位置：西林");
  const doc = { id: "d1", name: "t.pdf", role: "raw", tables: ts, warnings: [] };
  const f = X.facts(doc, { stations: ["西林"] });
  assert.deepStrictEqual(f.map((x) => x.item + "/" + x.stat + "/" + x.value + "/" + x.station).sort(),
    ["NO2/daily/0.008/西林", "NO2/max1h/0.015/西林", "O3/daily/0.030/西林", "O3/max1h/0.045/西林",
      "SO2/daily/0.002/西林", "SO2/max1h/0.003/西林"]);
});

T.test("純文字頁（沒有多欄文字列）不當成表格", () => {
  const L = lines([[it("本報告僅供參考", 100, 40, 200)], [it("第二段說明文字", 100, 80, 200)]]);
  assert.deepStrictEqual(R._layoutTables(L, 1, 200), []);
});

T.test("原始 Word：頁首的監測位置、同段前一表格的監測位置與日期帶到後續表格", () => {
  const t1 = { id: "t0", title: "表1 空氣品質", context: ["監測位置：西林", "監測日期：115年08月20日", "表1 空氣品質"], cells: [] };
  const t2 = { id: "t1", title: "表2 異味污染物檢測結果", context: ["表2 異味污染物檢測結果"], cells: [] };
  const t3 = { id: "t2", title: "表3", context: ["監測位置：東湖", "表3"], cells: [] };
  R._rawDocxContext([t1, t2, t3], []);
  assert.ok(t2.context.indexOf("監測位置：西林") >= 0, JSON.stringify(t2.context));
  assert.ok(t2.context.some((l) => /監測日期/.test(l)), JSON.stringify(t2.context));
  assert.ok(t3.context.indexOf("監測位置：西林") < 0, JSON.stringify(t3.context));
  const h = { id: "t0", title: "表1 空氣品質監測結果", context: ["表1 空氣品質監測結果"], cells: [] };
  R._rawDocxContext([h], ["監測位置：南港社區活動中心　　報告編號：TEST-001"]);
  assert.ok(h.context.some((l) => /南港社區活動中心/.test(l)), JSON.stringify(h.context));
});

T.test("可選取文字：表格以 Tab 分隔、合併格只留左上角、整份文字同頁脈絡只列一次", () => {
  const t = { nRows: 2, nCols: 3, cells: [
    { r0: 0, r1: 0, c0: 0, c1: 1, text: "項目\n名稱" },
    { r0: 0, r1: 0, c0: 2, c1: 2, text: "單位" },
    { r0: 1, r1: 1, c0: 0, c1: 0, text: "SO2" },
    { r0: 1, r1: 1, c0: 1, c1: 1, text: "0.003" },
    { r0: 1, r1: 1, c0: 2, c1: 2, text: "ppm" }
  ] };
  assert.strictEqual(R.tableText(t), "項目 名稱\t\t單位\nSO2\t0.003\tppm");
  const doc = { tables: [
    { page: 3, index: 0, context: ["監測位置：甲", "表1"], nRows: 1, nCols: 1, cells: [{ r0: 0, r1: 0, c0: 0, c1: 0, text: "A" }] },
    { page: 3, index: 1, context: ["監測位置：甲", "表1"], nRows: 1, nCols: 1, cells: [{ r0: 0, r1: 0, c0: 0, c1: 0, text: "B" }] },
    { sheet: "表2", index: 0, context: [], nRows: 1, nCols: 2, cells: [{ r0: 0, r1: 0, c0: 1, c1: 1, text: "C" }] }
  ] };
  const s = R.docText(doc);
  assert.strictEqual(s.split("監測位置：甲").length - 1, 1, s);
  assert.ok(s.indexOf("【第 3 頁 表格 1】") >= 0 && s.indexOf("【第 3 頁 表格 2】") >= 0, s);
  assert.ok(s.indexOf("【工作表「表2」 表格 3】") >= 0 && s.indexOf("\tC") >= 0, s);
  assert.strictEqual(R.tableText({ nRows: 0, nCols: 0, cells: [] }), "");
});

T.done("rawdoc.test.js");
