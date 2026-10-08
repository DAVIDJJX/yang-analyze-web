/* fill/dict.js 單元測試：node tests/fill/dict.test.js（僅用合成資料） */
"use strict";
const assert = require("node:assert");
const H = require("./semantic_helpers.js");
const YF = H.load();
const D = YF.dict;
const T = H.harness();
const codes = (s, o) => D.findItems(s, o).map((h) => h.code);

T.test("norm：全形/上下標/µ/括號/波浪號/中文字間空白", () => {
  assert.strictEqual(D.norm("ＳＯ₂（ｐｐｍ）"), "SO2(ppm)");
  assert.strictEqual(D.norm("µg/m³"), "μg/m3");
  assert.strictEqual(D.norm("檢 測 位 置："), "檢測位置:");
  assert.strictEqual(D.norm("10:00 ～ 11:00"), "10:00 ~ 11:00");
  assert.strictEqual(D.norm("10:00 〜 11:00"), "10:00 ~ 11:00");
  assert.strictEqual(D.norm("《PM10》【a】"), "(PM10)[a]");
  assert.strictEqual(D.norm("  a \n\t b  "), "a b");
  assert.strictEqual(D.norm(null), "");
  assert.strictEqual(D.norm("24 小時值"), "24 小時值");
});

T.test("findItems：正式名稱、中文名稱、OCR 誤認", () => {
  assert.deepStrictEqual(codes("SO2 (ppm)"), ["SO2"]);
  assert.deepStrictEqual(codes("S02"), ["SO2"]);
  assert.deepStrictEqual(codes("SO,"), ["SO2"]);
  assert.deepStrictEqual(codes("SOz ppb"), ["SO2"]);
  assert.deepStrictEqual(codes("So, ppb"), ["SO2"]);
  assert.deepStrictEqual(codes("N02"), ["NO2"]);
  assert.deepStrictEqual(codes("NOz ppb"), ["NO2"]);
  assert.deepStrictEqual(codes("NO, ppb"), ["NO2"]);
  assert.deepStrictEqual(codes("“NO2 (ppm )"), ["NO2"]);
  assert.deepStrictEqual(codes("NOX"), ["NOx"]);
  assert.deepStrictEqual(codes("N0x"), ["NOx"]);
  assert.deepStrictEqual(codes("C0"), ["CO"]);
  assert.deepStrictEqual(codes("0O3"), ["O3"]);
  assert.deepStrictEqual(codes("O03 (ppm )"), ["O3"]);
  assert.deepStrictEqual(codes("O0"), ["O3"]);
  assert.deepStrictEqual(codes("CH, ppm"), ["CH4"]);
  assert.deepStrictEqual(codes("PMio"), ["PM10"]);
  assert.deepStrictEqual(codes("PMi0"), ["PM10"]);
  assert.deepStrictEqual(codes("PMl0"), ["PM10"]);
  assert.deepStrictEqual(codes("PM1o"), ["PM10"]);
  assert.deepStrictEqual(codes("PM2.5"), ["PM2.5"]);
  assert.deepStrictEqual(codes("PM25 (ug/m3)"), ["PM2.5"]);
  assert.deepStrictEqual(codes("PM2,5"), ["PM2.5"]);
  assert.deepStrictEqual(codes("總懸浮微粒"), ["TSP"]);
  assert.deepStrictEqual(codes("細懸浮微粒"), ["PM2.5"]);
  assert.deepStrictEqual(codes("懸浮微粒"), ["PM10"]);
  assert.deepStrictEqual(codes("二氧化硫"), ["SO2"]);
  assert.deepStrictEqual(codes("硫化氫"), ["H2S"]);
  assert.deepStrictEqual(codes("氨"), ["NH3"]);
  assert.deepStrictEqual(codes("氨氣"), ["NH3"]);
  ["臭氣", "異味", "異味污染物", "臭氣強度", "臭度"].forEach((s) => assert.deepStrictEqual(codes(s), ["ODOR"], s));
  assert.deepStrictEqual(codes("異味污染物CD"), ["ODOR"]);
  assert.deepStrictEqual(codes("鉛"), ["Pb"]);
  assert.deepStrictEqual(codes("風速"), ["WS"]);
  assert.deepStrictEqual(codes("溼度"), ["RH"]);
  assert.deepStrictEqual(codes("風向"), ["WD"]);
});

T.test("findItems：英數字邊界（NO/NOx/NO2、CO/CO2、O3/NO3、NH3/NH3-N）", () => {
  assert.deepStrictEqual(codes("NOx"), ["NOx"]);
  assert.deepStrictEqual(codes("NO2"), ["NO2"]);
  assert.deepStrictEqual(codes("NO ppb"), ["NO"]);
  assert.deepStrictEqual(codes("CO2"), []);
  assert.deepStrictEqual(codes("COD"), ["COD"]);
  assert.deepStrictEqual(codes("NO3-N"), ["NO3N"]);
  assert.deepStrictEqual(codes("NO3"), []);
  assert.deepStrictEqual(codes("NH3-N"), ["NH3N"]);
  assert.deepStrictEqual(codes("NH3 - N"), ["NH3N"]);
  assert.deepStrictEqual(codes("氨氮"), ["NH3N"]);
  assert.deepStrictEqual(codes("NH3 (ppm)"), ["NH3"]);
  assert.deepStrictEqual(codes("mmHg"), []);
  assert.deepStrictEqual(codes("Cug/m?"), []);
  assert.deepStrictEqual(codes("PM10.5"), []);
  assert.deepStrictEqual(codes("SO2、NOx、CO"), ["SO2", "NOx", "CO"]);
  assert.deepStrictEqual(codes("TSS"), []);
  assert.deepStrictEqual(codes("TSP"), ["TSP"]);
  assert.deepStrictEqual(codes("測點No.1"), []);
  assert.deepStrictEqual(codes("Level"), []);
});

T.test("findItems：弱別名只在儲存格開頭且其後為單位/統計文字", () => {
  assert.deepStrictEqual(codes("O ppb", { weak: true }), ["O3"]);
  assert.deepStrictEqual(codes("0 ppb", { weak: true }), ["O3"]);
  assert.deepStrictEqual(codes("O; 8小時平均 ppb", { weak: true }), ["O3"]);
  assert.deepStrictEqual(codes("0O5 8小時平均 ppb", { weak: true }), ["O3"]);
  assert.deepStrictEqual(codes("03 (ppm )", { weak: true }), ["O3"]);
  assert.deepStrictEqual(codes("CH ppm", { weak: true }), ["CH4"]);
  assert.deepStrictEqual(codes("O ppb"), []);                       // 未開啟 weak
  assert.deepStrictEqual(codes("0 ~ 5 m/s", { weak: true }), []);
  assert.deepStrictEqual(codes("O", { weak: true }), []);
  assert.deepStrictEqual(codes("0»", { weak: true }), []);
  assert.deepStrictEqual(codes("10:03 (ppm)", { weak: true }), []);
  assert.ok(D.findItems("O ppb", { weak: true })[0].weak);
});

T.test("findItems：噪音／振動（Lv晚 = 夜間振動）", () => {
  assert.deepStrictEqual(codes("Leq"), ["LEQ"]);
  assert.deepStrictEqual(codes("均能音量"), ["LEQ"]);
  assert.deepStrictEqual(codes("L日"), ["LD"]);
  assert.deepStrictEqual(codes("L晚"), ["LE"]);
  assert.deepStrictEqual(codes("L夜"), ["LN"]);
  assert.deepStrictEqual(codes("Lmax"), ["LMAX"]);
  assert.deepStrictEqual(codes("L10"), ["L10"]);
  assert.deepStrictEqual(codes("Lv日"), ["LVD"]);
  assert.deepStrictEqual(codes("Lvd"), ["LVD"]);
  assert.deepStrictEqual(codes("Lv10日"), ["LVD"]);
  assert.deepStrictEqual(codes("Lv夜"), ["LVN"]);
  assert.deepStrictEqual(codes("Lv晚"), ["LVN"]);
  assert.deepStrictEqual(codes("Lvn"), ["LVN"]);
  assert.deepStrictEqual(codes("Lvmax"), ["LVMAX"]);
  assert.deepStrictEqual(codes("日間振動"), ["LVD"]);
  assert.deepStrictEqual(codes("日間"), ["LD"]);
  assert.ok(D.findItems("夜間")[0].generic);
});

T.test("findItems：水質與重金屬（大小寫敏感者不誤配）", () => {
  assert.deepStrictEqual(codes("生化需氧量"), ["BOD"]);
  assert.deepStrictEqual(codes("BOD5"), ["BOD"]);
  assert.deepStrictEqual(codes("化學需氧量 COD"), ["COD", "COD"]);
  assert.deepStrictEqual(codes("溶氧"), ["DO"]);
  assert.deepStrictEqual(codes("懸浮固體"), ["SS"]);
  assert.deepStrictEqual(codes("pH"), ["pH"]);
  assert.deepStrictEqual(codes("水溫"), ["WT"]);
  assert.deepStrictEqual(codes("大腸桿菌群"), ["COLI"]);
  assert.deepStrictEqual(codes("大腸桿菌"), ["ECOLI"]);
  assert.deepStrictEqual(codes("總磷"), ["TP"]);
  assert.deepStrictEqual(codes("硝酸鹽氮"), ["NO3N"]);
  assert.deepStrictEqual(codes("油脂"), ["OIL"]);
  assert.deepStrictEqual(codes("鎘 Cd"), ["Cd", "Cd"]);
  assert.deepStrictEqual(codes("CD"), []);
  assert.deepStrictEqual(codes("導電度"), ["EC"]);
});

T.test("itemLabel / statLabel / unitLabel", () => {
  assert.strictEqual(D.itemLabel("SO2"), "SO₂");
  assert.strictEqual(D.itemLabel("SO2", true), "SO₂ 二氧化硫");
  assert.strictEqual(D.itemLabel("ODOR"), "臭氣");
  assert.strictEqual(D.itemLabel("LVN"), "Lv夜");
  assert.strictEqual(D.itemLabel("XYZ"), "XYZ");
  assert.strictEqual(D.itemLabel(null), "");
  assert.strictEqual(D.statLabel("max1h"), "最大小時平均值");
  assert.strictEqual(D.statLabel("daily"), "日平均值（24小時值）");
  assert.strictEqual(D.unitLabel("ug/m3"), "μg/m³");
  assert.strictEqual(D.unitLabel("ppm"), "ppm");
  assert.strictEqual(D.unitLabel("zzz"), "zzz");
  D.ITEMS.forEach((it) => assert.ok(it.code && it.label && it.zh && it.cat, it.code));
});

T.test("findStat：統計別與 OCR 容錯（值→什/直/佳、8→$、時→崎）", () => {
  const st = (s) => { const r = D.findStat(s); return r ? r.code : null; };
  assert.strictEqual(st("最大小時平均值"), "max1h");
  assert.strictEqual(st("最大小時平均什"), "max1h");
  assert.strictEqual(st("最大小時平均直"), "max1h");
  assert.strictEqual(st("最大小時值"), "max1h");
  assert.strictEqual(st("小時最大值"), "max1h");
  assert.strictEqual(st("最大時平均值"), "max1h");
  assert.strictEqual(st("最小小時平均值"), "min1h");
  assert.strictEqual(st("8小時最大平均值"), "max8h");
  assert.strictEqual(st("$小時最大平均值"), "max8h");
  assert.strictEqual(st("最大8小時平均值"), "max8h");
  assert.strictEqual(st("8小時平均值最大值"), "max8h");
  assert.strictEqual(st("日平均值"), "daily");
  assert.strictEqual(st("日平均什"), "daily");
  assert.strictEqual(st("24小時值"), "daily");
  assert.strictEqual(st("24 小時什"), "daily");
  assert.strictEqual(st("24小時平均值(μg/m3)"), "daily");
  assert.strictEqual(st("24 oh"), "daily");
  assert.strictEqual(st("日平均值或 最頻風向"), "daily");
  assert.strictEqual(st("小時平均值(ppm)"), "h1");
  assert.strictEqual(st("小時值"), "h1");
  assert.strictEqual(st("8小時平均值(ppm)"), "h8");
  assert.strictEqual(st("8小時平\n均值(ppm)"), "h8");
  assert.strictEqual(st("CO 8小時平均 ppm"), "h8");
  assert.strictEqual(st("0; 8小崎平均 ppb"), "h8");
  assert.strictEqual(st("年平均值"), "annual");
  assert.strictEqual(st("實測值"), "value");
  assert.strictEqual(st("寅測值"), "value");
  assert.strictEqual(st("最大小時平均債"), "max1h");          // 編輯距離 1
  assert.strictEqual(st("最犬小時平均值"), null);             // 最大/最小並列 → 不確定
  assert.strictEqual(st("平均氣溫"), "avg");
  assert.strictEqual(st("平均"), "avg");
  assert.strictEqual(st(""), null);
  assert.strictEqual(st("SO2 (ppm)"), null);
});

T.test("combineStats", () => {
  assert.strictEqual(D.combineStats("max1h", "h8"), "max8h");
  assert.strictEqual(D.combineStats("h8", "max"), "max8h");
  assert.strictEqual(D.combineStats("min1h", "h8"), "min8h");
  assert.strictEqual(D.combineStats("daily", "h8"), "avg8h");
  assert.strictEqual(D.combineStats("h1", "max1h"), "max1h");
  assert.strictEqual(D.combineStats("max1h", "h1"), "max1h");
  assert.strictEqual(D.combineStats("h1", "daily"), "daily");
  assert.strictEqual(D.combineStats("value", "daily"), "daily");
  assert.strictEqual(D.combineStats(null, "h1"), "h1");
  assert.strictEqual(D.combineStats("max", "daily"), "maxDaily");
  assert.strictEqual(D.combineStats("hourly", "max1h"), "hourly");
  assert.strictEqual(D.combineStats("daily", "annual"), "daily");
  assert.strictEqual(D.combineStats("avg", "h8"), "avg8h");
  assert.strictEqual(D.combineStats("h1", "avg"), "daily");
});

T.test("findUnit：單位與 OCR 版 μg/m³", () => {
  const u = D.findUnit;
  assert.strictEqual(u("SO2 (ppm)"), "ppm");
  assert.strictEqual(u("NO2 ppb"), "ppb");
  assert.strictEqual(u("CO Ppm"), "ppm");
  assert.strictEqual(u("μg/m3"), "ug/m3");
  assert.strictEqual(u("µg/m³"), "ug/m3");
  assert.strictEqual(u("ug/m³"), "ug/m3");
  assert.strictEqual(u("ug/Nm3"), "ug/m3");
  assert.strictEqual(u("PMio jg/m"), "ug/m3");
  assert.strictEqual(u("pg/m3"), "ug/m3");
  assert.strictEqual(u("hg/m"), "ug/m3");
  assert.strictEqual(u("TSP (Cug/m? )"), "ug/m3");
  assert.strictEqual(u("PMio Cugim?)"), "ug/m3");
  assert.strictEqual(u("(gm? )"), "ug/m3");
  assert.strictEqual(u("ne/m?"), "ug/m3");
  assert.strictEqual(u("mg/m3"), "mg/m3");
  assert.strictEqual(u("mg/Nm3"), "mg/m3");
  assert.strictEqual(u("kg/m3"), null);
  assert.strictEqual(u("噪音dB(A)"), "dB(A)");
  assert.strictEqual(u("dBA"), "dB(A)");
  assert.strictEqual(u("振動dB"), "dB");
  assert.strictEqual(u("平均濕度(%)"), "%");
  assert.strictEqual(u("溫度(℃)"), "℃");
  assert.strictEqual(u("平均氣溫(°C)"), "℃");
  assert.strictEqual(u("平均氣溫(?C》"), "℃");
  assert.strictEqual(u("風速 m/s"), "m/s");
  assert.strictEqual(u("平均風速(m/8)"), "m/s");
  assert.strictEqual(u("風向 Deg"), "deg");
  assert.strictEqual(u("mg/L"), "mg/L");
  assert.strictEqual(u("NTU"), "NTU");
  assert.strictEqual(u("μS/cm"), "uS/cm");
  assert.strictEqual(u("CFU/100mL"), "CFU/100mL");
  assert.strictEqual(u("MPN/100 mL"), "MPN/100mL");
  assert.strictEqual(u("檢測項目"), null);
  assert.strictEqual(u("time/min"), null);
  assert.strictEqual(u(""), null);
});

T.test("convert / convFactor", () => {
  assert.ok(Math.abs(D.convert(1.1, "ppb", "ppm") - 0.0011) < 1e-12);
  assert.strictEqual(D.convert(0.012, "ppm", "ppb"), 12);
  assert.strictEqual(D.convert(1, "mg/m3", "ug/m3"), 1000);
  assert.strictEqual(D.convert(1500, "ug/m3", "mg/m3"), 1.5);
  assert.strictEqual(D.convert(5, "ppm", "ppm"), 5);
  assert.strictEqual(D.convert(5, "ppm", "ug/m3"), null);
  assert.strictEqual(D.convert(null, "ppb", "ppm"), null);
  assert.strictEqual(D.convFactor("ppb", "ppm"), 0.001);
  assert.strictEqual(D.convFactor("dB", "dB(A)"), null);
});

T.test("parseValue：接受的格式", () => {
  const pv = D.parseValue;
  const ok = (s, value, num, cmp, dec) => {
    const r = pv(s);
    assert.ok(r.ok, "應可解析：" + s);
    assert.strictEqual(r.value, value, s);
    if (num !== undefined) assert.ok(num === null ? r.num === null : Math.abs(r.num - num) < 1e-9, s + " num=" + r.num);
    if (cmp !== undefined) assert.strictEqual(r.cmp, cmp, s);
    if (dec !== undefined) assert.strictEqual(r.decimals, dec, s);
  };
  ok("0.001", "0.001", 0.001, "", 3);
  ok(".5", "0.5", 0.5, "", 1);
  ok("0.060", "0.060", 0.06, "", 3);
  ok("<10", "<10", 10, "<");
  ok("＜10", "<10", 10, "<");
  ok("< 10", "<10", 10, "<");
  ok(">100", ">100", 100, ">");
  ok("≦0.5", "<0.5", 0.5, "<");
  ["ND", "N.D.", "N.D", "nd", "未檢出", "N.D.(<0.1)"].forEach((s) => ok(s, "ND", null, "ND"));
  ok("6.0×10^4", "6.0×10^4", 60000);
  ok("6.0×104", "6.0×104", 60000);
  ok("6.0x10^4", "6.0×10^4", 60000);
  ok("1.2E3", "1.2E3", 1200);
  ok("1.2e-3", "1.2e-3", 0.0012);
  ok("0.0O1", "0.001", 0.001);
  ok("l.5", "1.5", 1.5);
  ok("1S", "15", 15);
  ok("28,90", "28.90", 28.9, "", 2);
  ok("1,10", "1.10", 1.1, "", 2);
  ok("0,000", "0.000", 0, "", 3);
  ok("1,200", "1200", 1200, "", 0);
  ok("12,345.6", "12345.6", 12345.6);
  ok("-0.5", "-0.5", -0.5);
  ok("0.42 一", "0.42", 0.42);
  ok("19.00", "19.00", 19, "", 2);
  ok("0.065*", "0.065", 0.065);
  ok(" 4 ", "4", 4, "", 0);
  ok("98.0%", "98.0", 98);
  assert.strictEqual(pv("0.065*").mark, true);
});

T.test("parseValue：拒絕的格式（保留原文）", () => {
  const no = (s) => { const r = D.parseValue(s); assert.ok(!r.ok, "不應解析：" + s); return r; };
  ["", "-", "—", "*", "米", "o*", "一", "/", "--", "未檢測", "10:00", "10：00", "115.08.31", "115/08/31",
    "10:00 ~ 11:00", "NIEA A416.14C", "NIEAA416.14C", "O3", "S02", "SO2", "CO", "NO2", "26.8 7", "26.2 國",
    "0.0001234 ppml", "1150101AQ-1", "8 5", "1 200", "1,2,3", "12.3±0.5", "<", "N/A", "115年第三季"].forEach(no);
  assert.strictEqual(no("未檢測").value, "未檢測");
});

T.test("isTimeRange", () => {
  ["10:00 ~ 11:00", "10:00~11:00", "05;00 ~ 06:00", "23:00 ~ 00:00", "03:00 ~ °04:00", "10時~11時", "10-11時", "10:00",
    "10:00 - 11:00", "10：00～11：00"].forEach((s) => assert.ok(D.isTimeRange(s), s));
  ["115.08.31/ 10: 00 至 115.09.01/10 : 00", "最大小時平均值", "10", "10.5", "", "115.08.31", "0 ~ 30", "10-11"].forEach((s) => assert.ok(!D.isTimeRange(s), s));
  assert.ok(D.isTimeRange("10 ~ 11"), "Excel 報告的「HH ~ HH」時段");
});

T.test("parseRocDate / formatDate", () => {
  assert.deepStrictEqual(D.parseRocDate("115.08.31"), { y: 115, m: 8, d: 31 });
  assert.deepStrictEqual(D.parseRocDate("監測日期 :115.08.31~115. 09. 01"), { y: 115, m: 8, d: 31 });
  assert.deepStrictEqual(D.parseRocDate("115年08月31日"), { y: 115, m: 8, d: 31 });
  assert.deepStrictEqual(D.parseRocDate("2026-08-31"), { y: 2026, m: 8, d: 31 });
  assert.deepStrictEqual(D.parseRocDate("115.08.31/ 10: 00 至 115.09.01"), { y: 115, m: 8, d: 31 });
  assert.strictEqual(D.parseRocDate("DQ-41182-025-1"), null);
  assert.strictEqual(D.parseRocDate("115.13.01"), null);
  assert.strictEqual(D.parseRocDate("報告"), null);
  assert.strictEqual(D.formatDate({ y: 115, m: 8, d: 1 }), "115.08.01");
});

T.test("parsePeriod / quarterOf / dateInPeriod", () => {
  assert.deepStrictEqual(D.parsePeriod("115年第三季"), { y: 115, q: 3 });
  assert.deepStrictEqual(D.parsePeriod("115年第3季"), { y: 115, q: 3 });
  assert.deepStrictEqual(D.parsePeriod("115年度第一季"), { y: 115, q: 1 });
  assert.deepStrictEqual(D.parsePeriod("115Q3"), { y: 115, q: 3 });
  assert.deepStrictEqual(D.parsePeriod("115年7月"), { y: 115, m: 7 });
  assert.deepStrictEqual(D.parsePeriod("115.07~115.09"), { y: 115, q: 3 });
  assert.deepStrictEqual(D.parsePeriod("第二季(115年)"), { y: 115, q: 2 });
  assert.strictEqual(D.parsePeriod("標準值"), null);
  assert.strictEqual(D.quarterOf({ y: 115, m: 8 }), 3);
  assert.strictEqual(D.quarterOf({ y: 115, m: 1 }), 1);
  assert.strictEqual(D.quarterOf({ y: 115, m: 12 }), 4);
  assert.strictEqual(D.dateInPeriod("115.08.31", "115年第三季"), true);
  assert.strictEqual(D.dateInPeriod("115.05.31", "115年第三季"), false);
  assert.strictEqual(D.dateInPeriod("114.08.31", "115年第三季"), false);
  assert.strictEqual(D.dateInPeriod("2026.08.31", "115年第三季"), true);
  assert.strictEqual(D.dateInPeriod(null, "115年第三季"), null);
  assert.strictEqual(D.dateInPeriod("115.07.02", "115年7月"), true);
});

T.test("stationSim：規格範例的同型案例（合成名稱）", () => {
  const s = D.stationSim;
  assert.ok(s("白和新村", "白河新村") >= 0.7, "一字 OCR 差異");
  assert.ok(s("青山社區", "青山社區活動中心") >= 0.9, "通用字尾");
  assert.ok(s("東湖", "東湖社區活動中心") >= 0.85, "短名包含");
  assert.ok(s("西林", "南港社區活動中心") < 0.3, "不同測站");
  assert.ok(s("南港社區活動中心", "南港社區活動中心") > s("南港社區活動中心", "北港社區活動中心"), "完全相同者較高");
  assert.ok(s("南港社區活動中心", "東湖社區活動中心") < 0.6, "同字尾、核心完全不同");
  assert.ok(s("南淋社區活動中心", "南港社區活動中心") >= 0.6, "核心一字 OCR 差異");
  assert.ok(s("社區活動中心", "南港社區活動中心") < 0.6, "只有通用字尾");
  assert.ok(s("城頭", "埔頭") < 0.6, "兩字名一字不同 → 不採用");
  assert.strictEqual(s("白河新村", "白河新村"), 1);
  assert.strictEqual(s("白河新村(AQ-1)", "白河新村"), 1);
  assert.strictEqual(s("", "白河新村"), 0);
  assert.strictEqual(s("ABCD", "白河新村"), 0);
  assert.ok(s("AQ-1", "AQ-2") < 0.6, "編號不同");
  assert.ok(s("第一測站", "第二測站") < 0.6, "中文編號不同");
  assert.ok(s("1號井", "1號井") === 1);
});

T.test("findStationCapture", () => {
  const c = D.findStationCapture;
  assert.strictEqual(c("計畫名稱 : 某計畫 現場編號:1150101A-1 監測位置: 白河新村 監測日期 :115.01.01~115.01.02"), "白河新村");
  assert.strictEqual(c("監測位置:南港社區活動中心 藍測日期 :115.01.01"), "南港社區活動中心");
  assert.strictEqual(c("監測位置：白河新村監測日期：115.01.01"), "白河新村");
  assert.strictEqual(c("採樣地點：東湖"), "東湖");
  assert.strictEqual(c("檢測位置:"), null);
  assert.strictEqual(c("檢測項目:SO2"), null);
  assert.strictEqual(c(""), null);
});

T.test("METHOD_ITEMS / findMethodItem", () => {
  assert.strictEqual(D.findMethodItem("NIEA A201.15A").code, "ODOR");
  assert.strictEqual(D.findMethodItem("NIBA A201.15A").code, "ODOR");
  assert.strictEqual(D.findMethodItem("NIEA A201, 154").code, "ODOR");
  assert.strictEqual(D.findMethodItem("NIEAA416.14C").code, "SO2");
  assert.strictEqual(D.findMethodItem("NIEA A421.14C").code, "CO");
  assert.strictEqual(D.findMethodItem("NIEA A417.13C").code, null);
  assert.deepStrictEqual(D.findMethodItem("NIEA A417.13C").codes, ["NOx", "NO2"]);
  assert.strictEqual(D.findMethodItem("NIEA A740.10C").code, null);
  assert.strictEqual(D.findMethodItem("NIEA A205.11C").code, "PM2.5");
  assert.strictEqual(D.findMethodItem("SO2"), null);
  assert.strictEqual(D.METHOD_ITEMS.A102[0], "TSP");
});

T.test("isFiller / isStarLike / normStation", () => {
  ["-", "—", "*", "米", "o*", "一", "二", "--", "/"].forEach((s) => assert.ok(D.isFiller(s), s));
  ["0.1", "SO2", "未", "測點二"].forEach((s) => assert.ok(!D.isFiller(s), s));
  ["*", "米", "o*", "*«"].forEach((s) => assert.ok(D.isStarLike(s), s));
  assert.ok(!D.isStarLike("-"));
  assert.strictEqual(D.normStation(" 白河 新村（AQ-1）"), "白河新村");
});

T.test("效能：大量標題文字辨識 < 1.5 秒", () => {
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    D.findItems("測項" + i + " SO2 (ppm) 最大小時平均值", { weak: true });
    D.findStat("最大小時平均什" + (i % 50));
    D.findUnit("PMio Cugim?) " + i);
    D.parseValue(String(i / 7));
  }
  assert.ok(Date.now() - t0 < 1500, "耗時 " + (Date.now() - t0) + "ms");
});

T.done("dict.test.js");
