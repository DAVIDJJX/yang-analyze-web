# -*- coding: utf-8 -*-
"""產生 tests/fill/fixtures/ocr_text.pdf（純合成資料，供 pdfread.js 瀏覽器測試）。

用法（repo 根目錄）：python3 tests/fill/fixtures/ocr_make_pdf.py
需要 reportlab。第 1 頁：直立 A4，含 Helvetica 數字、非內嵌中文 CID 字型（MSung-Light /
UniCNS-UCS2-H，需 pdf.js cmaps 才能取出文字）、格線表格與 90° 旋轉文字；
第 2 頁：/Rotate 90；第 3 頁：橫式 A4。座標與字串寫在 ocr_text.json 供測試比對。
"""
import json, os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase import cidfonts
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

# reportlab 預設把 MSung-Light 配成 UniGB-UCS2-H（與 CNS1 字集不符），改成台灣常見的 UniCNS-UCS2-H
cidfonts.defaultUnicodeEncodings["MSung-Light"] = ("cht", "UniCNS-UCS2-H")
HERE = os.path.dirname(os.path.abspath(__file__))
pdfmetrics.registerFont(UnicodeCIDFont("MSung-Light"))
out = os.path.join(HERE, "ocr_text.pdf")
c = canvas.Canvas(out, pagesize=A4, invariant=1)
c.setTitle("ocr_text synthetic fixture")
spec = {"pages": []}

def text(c, font, size, x, y, s, items):
    c.setFont(font, size)
    c.drawString(x, y, s)
    items.append({"str": s, "font": font, "size": size, "x": x, "y": y,
                  "w": pdfmetrics.stringWidth(s, font, size)})

# ---- 第 1 頁 ----
items = []
text(c, "Helvetica", 12, 100, 700, "0.034", items)
text(c, "Helvetica-Bold", 20, 100, 650, "SO2 (ppm)", items)
text(c, "MSung-Light", 14, 300, 700, "示範新城", items)
# 表格：2 列 × 2 欄
c.setLineWidth(1.2)
x0, x1, xm, y0, y1, ym = 90, 450, 270, 500, 580, 540
c.rect(x0, y0, x1 - x0, y1 - y0)
c.line(xm, y0, xm, y1); c.line(x0, ym, x1, ym)
text(c, "MSung-Light", 12, 100, 555, "最大小時平均值", items)
text(c, "Helvetica", 12, 280, 555, "0.001", items)
text(c, "MSung-Light", 12, 100, 515, "日平均值", items)
text(c, "Helvetica", 12, 280, 515, "<10", items)
# 90° 旋轉文字（由下往上）
c.saveState(); c.translate(500, 300); c.rotate(90)
c.setFont("Helvetica", 16); c.drawString(0, 0, "VERT 77")
c.restoreState()
items.append({"str": "VERT 77", "font": "Helvetica", "size": 16, "x": 500, "y": 300, "rot": 90,
              "w": pdfmetrics.stringWidth("VERT 77", "Helvetica", 16)})
spec["pages"].append({"w": A4[0], "h": A4[1], "rotate": 0, "items": items})
c.showPage()

# ---- 第 2 頁：/Rotate 90（reportlab 會把 MediaBox 換成 842×595 橫式，顯示時轉回直式）----
items = []
c.setPageRotation(90)
text(c, "Helvetica", 24, 100, 400, "0.029", items)
spec["pages"].append({"w": A4[1], "h": A4[0], "rotate": 90, "items": items})
c.showPage()

# ---- 第 3 頁：橫式 ----
c.setPageRotation(0)
c.setPageSize(landscape(A4))
items = []
text(c, "Helvetica", 18, 400, 300, "LAND 12.5", items)
spec["pages"].append({"w": landscape(A4)[0], "h": landscape(A4)[1], "rotate": 0, "items": items})
c.showPage()
c.save()

with open(os.path.join(HERE, "ocr_text.json"), "w", encoding="utf-8") as f:
    json.dump(spec, f, ensure_ascii=False, indent=1)
print("wrote", out, os.path.getsize(out), "bytes")

# ---- 設有開啟密碼的 PDF（測試錯誤訊息）----
from reportlab.lib.pdfencrypt import StandardEncryption
pw = os.path.join(HERE, "ocr_pw.pdf")
c2 = canvas.Canvas(pw, pagesize=A4, invariant=1, encrypt=StandardEncryption("secret", canPrint=1, strength=40))
c2.setFont("Helvetica", 12); c2.drawString(100, 700, "locked 1.23"); c2.showPage(); c2.save()
print("wrote", pw, os.path.getsize(pw), "bytes")
