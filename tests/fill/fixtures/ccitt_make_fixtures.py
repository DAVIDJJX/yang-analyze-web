#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
產生 ccitt.test.js 用的「合成」測試檔（不含任何真實資料）。
需要：Pillow（繪圖）與系統 libtiff（libtiff.so.6，經 ctypes 呼叫，以便精確控制
Compression / FillOrder / Photometric / RowsPerStrip / Tile / T4Options）。

用法（於 repo 根目錄）：  python3 -I tests/fill/fixtures/ccitt_make_fixtures.py
輸出：tests/fill/fixtures/ccitt_*.pbm（期望結果，P4，1 = 黑）與 ccitt_*.tif
"""
import ctypes, os, random, sys
from ctypes import c_void_p, c_char_p, c_uint32, c_int, c_double
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
lib = ctypes.CDLL("libtiff.so.6")
lib.TIFFOpen.restype = c_void_p
lib.TIFFOpen.argtypes = [c_char_p, c_char_p]


def setf(tif, tag, *vals):
    if lib.TIFFSetField(c_void_p(tif), c_uint32(tag), *vals) != 1:
        raise RuntimeError("TIFFSetField failed: %d" % tag)


def draw_page(w, h, seed):
    """合成「掃描頁」：表格線、仿文字、隨機矩形、斜線、棋盤格、邊界像素。"""
    rnd = random.Random(seed)
    im = Image.new("1", (w, h), 1)
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, w - 5, h - 5], outline=0, width=3)
    for y in range(40, h - 40, 37):
        d.line([20, y, w - 20, y], fill=0, width=1 if y % 2 else 2)
    for x in range(20, w - 20, 91):
        d.line([x, 40, x, h - 80], fill=0, width=1)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    for i in range(60):
        x, y = rnd.randrange(20, w - 120), rnd.randrange(40, h - 30)
        s = "".join(rnd.choice("ABCDEFGHJK0123456789.<>-") for _ in range(rnd.randrange(3, 12)))
        d.text((x, y), s, fill=0, font=font)
    for i in range(25):
        x0, y0 = rnd.randrange(0, w - 10), rnd.randrange(0, h - 10)
        x1, y1 = min(w - 1, x0 + rnd.randrange(1, 140)), min(h - 1, y0 + rnd.randrange(1, 60))
        d.rectangle([x0, y0, x1, y1], fill=0 if i % 3 else None, outline=0)
    d.ellipse([w // 2, h // 3, w // 2 + 120, h // 3 + 70], outline=0, width=4)
    d.line([0, h - 1, w - 1, 0], fill=0, width=1)
    d.line([30, 30, w - 30, h - 60], fill=0, width=3)
    px = im.load()
    for y in range(h - 70, h - 40):            # 棋盤格（大量短行程與垂直模式）
        for x in range(40, 200):
            if (x + y) % 2 == 0:
                px[x, y] = 0
    for y in range(0, h, 7):                    # 左右邊界像素
        px[0, y] = 0
        px[w - 1, (y + 3) % h] = 0
    for i in range(400):                        # 雜點
        px[rnd.randrange(w), rnd.randrange(h)] = 0
    for x in range(w):                          # 一整列全黑
        px[x, 120] = 0
    return im


def runs_image(w, seed):
    """寬幅隨機行程影像：涵蓋黑白兩色 0–63 全部終止碼、64–2560 全部結合碼及 > 2560 的行程。"""
    rnd = random.Random(seed)
    lens = []
    for color in (0, 1):
        L = list(range(0, 64)) + [64 * k + rnd.randrange(0, 64) for k in range(1, 41)] + [2560 + rnd.randrange(1, 100)]
        rnd.shuffle(L)
        lens.append(L)
    rows = []
    # 特殊列
    rows.append([w])                          # 全白
    rows.append([0, w])                       # 全黑
    rows.append([0, 1, w - 2, 1])             # 頭尾各一個黑點
    rows.append([1] * w)                      # 1 像素交錯
    rows.append([w - 1, 1])                   # 只有最後一個像素黑
    rows.append([2600, w - 2600])
    rows.append([0, 2690, w - 2690])
    wi = bi = 0
    while wi < len(lens[0]) or bi < len(lens[1]):
        row, total, color = [], 0, 0
        while True:
            src, idx = (lens[0], wi) if color == 0 else (lens[1], bi)
            if idx < len(src):
                r = src[idx]
            else:
                r = rnd.randrange(1, 300)
            if total + r > w:
                row.append(w - total)
                break
            if color == 0:
                wi += 1
            else:
                bi += 1
            row.append(r)
            total += r
            color ^= 1
            if total == w:
                break
        rows.append(row)
    for _ in range(8):
        row, total = [], 0
        while total < w:
            r = min(w - total, rnd.choice([rnd.randrange(0, 5), rnd.randrange(0, 64), rnd.randrange(60, 2000)]))
            row.append(r)
            total += r
        rows.append(row)
    h = len(rows)
    im = Image.new("1", (w, h), 1)
    px = im.load()
    for y, row in enumerate(rows):
        x, color = 0, 0
        for r in row:
            if color:
                for k in range(x, x + r):
                    px[k, y] = 0
            x += r
            color ^= 1
    return im


def ink_rows(im):
    """每列位元打包，1 = 黑（WhiteIsZero）。"""
    w, h = im.size
    raw = im.tobytes()            # Pillow "1"：1 = 白，MSB 為最左像素
    rb = (w + 7) // 8
    pad = (8 - w % 8) % 8
    rows = []
    for y in range(h):
        r = bytearray((~b) & 0xFF for b in raw[y * rb:(y + 1) * rb])
        if pad:
            r[-1] &= (0xFF << pad) & 0xFF
        rows.append(bytes(r))
    return rows


def write_pbm(path, im):
    w, h = im.size
    with open(path, "wb") as f:
        f.write(b"P4\n%d %d\n" % (w, h))
        f.write(b"".join(ink_rows(im)))


def write_tiff(path, pages):
    tif = lib.TIFFOpen(path.encode(), b"w")
    if not tif:
        raise RuntimeError("TIFFOpen failed")
    for pi, p in enumerate(pages):
        im = p["im"]
        w, h = im.size
        rows = ink_rows(im)
        if p.get("phot", 0) == 1:     # BlackIsZero：位元 0 = 黑
            rows = [bytes((~b) & 0xFF for b in r) for r in rows]
        setf(tif, 256, c_uint32(w))
        setf(tif, 257, c_uint32(h))
        setf(tif, 258, c_int(1))
        setf(tif, 277, c_int(1))
        setf(tif, 259, c_int(p["comp"]))
        setf(tif, 262, c_int(p.get("phot", 0)))
        setf(tif, 266, c_int(p.get("fill", 1)))
        setf(tif, 284, c_int(1))
        setf(tif, 282, c_double(p.get("dpi", 200)))
        setf(tif, 283, c_double(p.get("dpi", 200)))
        setf(tif, 296, c_int(2))
        if p["comp"] == 3:
            setf(tif, 292, c_uint32(p.get("t4", 0)))
        if len(pages) > 1:
            setf(tif, 297, c_int(pi), c_int(len(pages)))
        if p.get("tile"):
            tw, th = p["tile"]
            setf(tif, 322, c_uint32(tw))
            setf(tif, 323, c_uint32(th))
            trb = (tw + 7) // 8
            for ty in range(0, h, th):
                for tx in range(0, w, tw):
                    buf = bytearray(trb * th)
                    for yy in range(th):
                        if ty + yy >= h:
                            break
                        for xx in range(tw):
                            x = tx + xx
                            if x >= w:
                                break
                            bit = (rows[ty + yy][x >> 3] >> (7 - (x & 7))) & 1
                            if bit:
                                buf[yy * trb + (xx >> 3)] |= 0x80 >> (xx & 7)
                    if lib.TIFFWriteTile(c_void_p(tif), ctypes.c_char_p(bytes(buf)), c_uint32(tx), c_uint32(ty), c_uint32(0), ctypes.c_uint16(0)) < 0:
                        raise RuntimeError("TIFFWriteTile failed")
        else:
            setf(tif, 278, c_uint32(p.get("rps", h)))
            for y in range(h):
                if lib.TIFFWriteScanline(c_void_p(tif), ctypes.c_char_p(rows[y]), c_uint32(y), ctypes.c_uint16(0)) != 1:
                    raise RuntimeError("TIFFWriteScanline failed")
        if lib.TIFFWriteDirectory(c_void_p(tif)) != 1:
            raise RuntimeError("TIFFWriteDirectory failed")
    lib.TIFFClose(c_void_p(tif))


def main():
    page = draw_page(643, 400, 20261008)
    runs = runs_image(2700, 7)
    write_pbm(os.path.join(OUT, "ccitt_page.pbm"), page)
    write_pbm(os.path.join(OUT, "ccitt_runs.pbm"), runs)
    J = lambda n: os.path.join(OUT, n)
    write_tiff(J("ccitt_page_g4.tif"), [dict(im=page, comp=4)])
    write_tiff(J("ccitt_page_g4_strips_pi1_lsb.tif"), [dict(im=page, comp=4, phot=1, fill=2, rps=37)])
    write_tiff(J("ccitt_page_g3_1d.tif"), [dict(im=page, comp=3, t4=0)])
    write_tiff(J("ccitt_page_g3_2d_fill_lsb.tif"), [dict(im=page, comp=3, t4=5, fill=2, rps=64)])
    write_tiff(J("ccitt_page_rle.tif"), [dict(im=page, comp=2)])
    write_tiff(J("ccitt_page_packbits.tif"), [dict(im=page, comp=32773, rps=50)])
    write_tiff(J("ccitt_page_lzw_tiled.tif"), [dict(im=page, comp=5, tile=(128, 112), phot=1)])
    write_tiff(J("ccitt_runs_g4.tif"), [dict(im=runs, comp=4)])
    write_tiff(J("ccitt_runs_g3_1d.tif"), [dict(im=runs, comp=3, t4=0)])
    write_tiff(J("ccitt_runs_g3_2d.tif"), [dict(im=runs, comp=3, t4=1, dpi=100)])
    write_tiff(J("ccitt_multi.tif"), [dict(im=page, comp=4, dpi=300), dict(im=runs, comp=3, t4=1, dpi=200)])
    for n in sorted(os.listdir(OUT)):
        if n.startswith("ccitt_") and (n.endswith(".tif") or n.endswith(".pbm")):
            print(n, os.path.getsize(os.path.join(OUT, n)))
    # 以 Pillow（libtiff）交叉驗證：每個 tif 解出的影像須與期望 PBM 一致
    exp = {"page": Image.open(J("ccitt_page.pbm")).convert("1"), "runs": Image.open(J("ccitt_runs.pbm")).convert("1")}
    for n in sorted(os.listdir(OUT)):
        if not (n.startswith("ccitt_") and n.endswith(".tif")):
            continue
        im = Image.open(J(n))
        k = 0
        while True:
            key = "runs" if ("runs" in n or (n == "ccitt_multi.tif" and k == 1)) else "page"
            got = im.convert("L").point(lambda v: 0 if v < 128 else 255).convert("1")
            # PBM 中 1 = 黑，Pillow 讀 PBM 後 0 = 黑，兩者皆以「黑」比較
            e = exp[key].convert("L")
            g = got.convert("L")
            if e.tobytes() != g.tobytes():
                print("MISMATCH", n, k)
                sys.exit(1)
            k += 1
            try:
                im.seek(k)
            except EOFError:
                break
        print("verified", n, k, "page(s)")


if __name__ == "__main__":
    main()
