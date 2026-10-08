# -*- coding: utf-8 -*-
"""
Yang-analyze web — tests/fill/fixtures/office_make_fixtures.py
產生 docx.js / xlsxtpl.js 瀏覽器測試用的「合成」範本（全部是假資料，可進 repo）：
  office_tpl.docx      Word 範本：表名段落、gridSpan、vMerge、gridBefore、段落標記 rPr、空 run、
                       多段落儲存格、巢狀表格、隱藏文字、sdt 包住的儲存格、無 rPr 的儲存格
  office_tpl.xlsx.bin  Excel 範本（openpyxl）：標題列、合併表頭、框線/字型/數字格式、空白待填區塊、
                       公式、第二個區塊、第二張工作表、欄樣式
  office_tpl.xls.bin   同上轉成 .xls（需 LibreOffice；沒有就略過）
（.xlsx/.xls 被 .gitignore 排除，故加 .bin 副檔名；測試以內容判斷格式。）
用法：python3 tests/fill/fixtures/office_make_fixtures.py
"""
import copy
import os
import shutil
import subprocess
import tempfile

import docx
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.shared import Pt
import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- Word
def set_mark_rpr(par, east="標楷體", ascii_="Times New Roman", sz=28):
    """段落標記 rPr（空白儲存格的字型就存在這裡）"""
    pPr = par._p.get_or_add_pPr()
    rPr = OxmlElement("w:rPr")
    f = OxmlElement("w:rFonts")
    f.set(qn("w:ascii"), ascii_); f.set(qn("w:eastAsia"), east)
    f.set(qn("w:hAnsi"), ascii_); f.set(qn("w:cs"), ascii_)
    rPr.append(f)
    for tag in ("w:sz", "w:szCs"):
        e = OxmlElement(tag); e.set(qn("w:val"), str(sz)); rPr.append(e)
    pPr.append(rPr)


def run_fmt(run, east="標楷體", ascii_="Times New Roman", size=14):
    run.font.name = ascii_
    run.font.size = Pt(size)
    rPr = run._r.get_or_add_rPr()
    rPr.rFonts.set(qn("w:eastAsia"), east)


def put(cell, text, **kw):
    p = cell.paragraphs[0]
    r = p.add_run(text)
    run_fmt(r, **kw)
    return r


def tc_pr(cell):
    return cell._tc.get_or_add_tcPr()


def make_docx(path):
    d = docx.Document()
    d.add_paragraph("前言段落：本文件為合成測試資料。")
    d.add_paragraph("")
    d.add_paragraph("表1 測試站甲空氣品質歷次調查結果彙整")

    # 表 0：4 列 × 5 欄。第 0 欄 0-1 列 vMerge；第 1-2 欄表頭 gridSpan；第 2 列為待填列
    t = d.add_table(rows=5, cols=5)
    t.style = "Table Grid"
    a = t.cell(0, 0).merge(t.cell(1, 0))
    put(a, "項目")
    a.add_paragraph("季別")
    h = t.cell(0, 1).merge(t.cell(0, 2))
    put(h, "SO2 (ppm)")
    put(t.cell(0, 3), "NO2")
    put(t.cell(0, 4), "PM10")
    put(t.cell(1, 1), "小時值")
    put(t.cell(1, 2), "日平均")
    put(t.cell(1, 3), "小時值(ppm)")
    put(t.cell(1, 4), "24小時值(μg/m3)")
    put(t.cell(2, 0), "115年第三季")
    # (2,1)：只有段落標記 rPr（使用者範本的情形）
    set_mark_rpr(t.cell(2, 1).paragraphs[0])
    # (2,2)：已有一個空 run（含 rPr 與空 w:t）
    p22 = t.cell(2, 2).paragraphs[0]
    set_mark_rpr(p22)
    r = p22.add_run("")
    run_fmt(r, size=12)
    r._r.append(OxmlElement("w:t"))
    # (2,3)：多個段落（第一段空、第二段空）
    c23 = t.cell(2, 3)
    set_mark_rpr(c23.paragraphs[0], sz=24)
    c23.add_paragraph("")
    # (2,4)：沒有任何 rPr → 沿用同列鄰格 run 的字型
    put(t.cell(3, 0), "標準值")
    put(t.cell(3, 1), "0.25")
    put(t.cell(3, 2), "0.1")
    put(t.cell(3, 3), "0.1")
    put(t.cell(3, 4), "100")
    # 第 4 列：第 1-2 欄 vMerge restart（待填，跨兩列：4、5）→ 先多加一列
    t.add_row()
    put(t.cell(4, 0), "116年第一季")
    put(t.cell(5, 0), "116年第二季")
    v = t.cell(4, 1).merge(t.cell(5, 1))
    set_mark_rpr(v.paragraphs[0])
    # (4,2)：隱藏文字（視為空白）
    hp = t.cell(4, 2).paragraphs[0]
    set_mark_rpr(hp)
    hr = hp.add_run("hidden")
    hr.font.hidden = True
    # (4,3)：巢狀表格
    nt = t.cell(4, 3).add_table(rows=1, cols=2)
    nt.cell(0, 0).text = "內A"
    nt.cell(0, 1).text = "內B"
    put(t.cell(4, 4), "<1&2>")
    for c in range(2, 5):
        put(t.cell(5, c), "x" + str(c))

    d.add_paragraph("")
    d.add_paragraph("表2 測試站乙噪音振動")
    # 表 1：gridBefore 偏移（第 2 列從第 1 欄開始）
    t2 = d.add_table(rows=3, cols=4)
    t2.style = "Table Grid"
    for c, txt in enumerate(["季別", "Leq", "L日", "L夜"]):
        put(t2.cell(0, c), txt)
    put(t2.cell(1, 0), "115年第三季")
    for c in (1, 2, 3):
        set_mark_rpr(t2.cell(1, c).paragraphs[0], east="新細明體", ascii_="Arial", sz=20)
    # 第 2 列：刪掉第一格並加 gridBefore=1
    tr = t2.rows[2]._tr
    first_tc = tr.tc_lst[0]
    tr.remove(first_tc)
    trPr = tr.get_or_add_trPr()
    gb = OxmlElement("w:gridBefore"); gb.set(qn("w:val"), "1")
    trPr.insert(0, gb)
    tcs = tr.tc_lst
    put_cell = docx.table._Cell(tcs[0], t2)
    set_mark_rpr(put_cell.paragraphs[0])     # 待填（邏輯欄 1）
    docx.table._Cell(tcs[1], t2).paragraphs[0].add_run("55.1")
    # 第 3 格包進 sdt（內容控制項）
    sdt = OxmlElement("w:sdt")
    sdtPr = OxmlElement("w:sdtPr"); sdt.append(sdtPr)
    sdtContent = OxmlElement("w:sdtContent"); sdt.append(sdtContent)
    tc3 = tcs[2]
    tr.replace(tc3, sdt)
    sdtContent.append(tc3)
    docx.table._Cell(tc3, t2).paragraphs[0].add_run("SDT值")

    # 表 2：緊接在表 1 之後（中間只有一個空段落）→ 表名取不到（3 段內沒有非空段落）
    d.add_paragraph("")
    t3 = d.add_table(rows=2, cols=2)
    t3.cell(0, 0).text = "A"
    t3.cell(0, 1).text = "B"
    d.add_paragraph("結尾段落")
    d.save(path)


# ---------------------------------------------------------------- Excel
def make_xlsx(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "空氣品質"
    thin = Side(style="thin")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)
    kai = Font(name="標楷體", size=12)
    bold = Font(name="標楷體", size=12, bold=True)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws["A1"] = "表1 測試站甲空氣品質彙整"
    ws["A1"].font = bold
    ws.merge_cells("A1:F1")
    # 表頭（第 3-4 列）
    ws["A3"] = "檢測項目"; ws.merge_cells("A3:A4")
    ws["B3"] = "SO2"; ws.merge_cells("B3:C3")
    ws["D3"] = "NO2"
    ws["E3"] = "PM10"
    ws["F3"] = "備註"
    ws["B4"] = "小時值(ppm)"; ws["C4"] = "日平均(ppm)"; ws["D4"] = "小時值(ppm)"; ws["E4"] = "24小時值(μg/m3)"
    ws["F4"] = "-"
    ws["A5"] = "115年第三季"
    ws["A6"] = "115年第二季"
    ws["B6"] = 0.003; ws["C6"] = 0.002; ws["D6"] = 0.011; ws["E6"] = 35; ws["F6"] = "ok"
    ws["A7"] = "標準值"
    ws["B7"] = 0.075; ws["C7"] = 0.03; ws["D7"] = 0.1; ws["E7"] = 100
    ws["F7"] = "=E7*2"
    for row in ws.iter_rows(min_row=3, max_row=7, min_col=1, max_col=6):
        for c in row:
            c.border = box
            c.font = kai
            c.alignment = center
    ws["B6"].number_format = "0.000"
    ws["C6"].number_format = "0.000"
    ws["D6"].number_format = "0.0"
    ws["B5"].number_format = "0.000"     # 待填格原本就是 0.000
    ws["E5"].fill = PatternFill("solid", fgColor="FFDDEEFF")
    # 第二個區塊（隔兩列空白）
    ws["A10"] = "表2 測試站乙"
    ws["A11"] = "季別"; ws["B11"] = "THC"; ws["C11"] = "CH4"
    ws["A12"] = "115年第三季"
    for row in ws.iter_rows(min_row=11, max_row=12, min_col=1, max_col=3):
        for c in row:
            c.border = box
    ws.column_dimensions["B"].width = 14
    # 第二張工作表：沒有框線（待填格不存在於 XML）、欄樣式
    ws2 = wb.create_sheet("噪音")
    ws2["A1"] = "季別"; ws2["B1"] = "Leq"; ws2["C1"] = "L日"
    ws2["A2"] = "115年第三季"
    ws2["B3"] = "x"
    wb.save(path)


def main():
    make_docx(os.path.join(HERE, "office_tpl.docx"))
    xlsx = os.path.join(HERE, "office_tpl.xlsx.bin")
    tmpd = tempfile.mkdtemp()
    try:
        tx = os.path.join(tmpd, "office_tpl.xlsx")
        make_xlsx(tx)
        shutil.copy(tx, xlsx)
        soffice = shutil.which("soffice")
        if soffice:
            subprocess.run([soffice, "--headless", "--convert-to", "xls", "--outdir", tmpd, tx],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
            shutil.copy(os.path.join(tmpd, "office_tpl.xls"), os.path.join(HERE, "office_tpl.xls.bin"))
        else:
            print("soffice 不存在，略過 .xls")
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)
    print("ok")


if __name__ == "__main__":
    main()
