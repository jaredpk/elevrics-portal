#!/usr/bin/env python3
"""Regenerate the portal favicon rasters from the SVG mark's geometry.

No third-party deps on purpose: this runs anywhere python3 does, and the icon
is simple enough (rounded rects + vertical gradient) that a rasteriser is
cheaper than a Pillow/librsvg dependency in a repo that has none.

    python3 scripts/render-favicon.py

Edit public/favicon.svg and the VARIANTS entry below together -- the SVG is the
source of truth for shape, this file mirrors it for the PNG/ICO fallbacks.
"""
import struct, zlib

BARS_GEOM = [(9.0, 33.90, 12.0, 17.10), (26.0, 23.45, 12.0, 27.55), (43.0, 13.00, 12.0, 38.00)]
GRAD = [((0x9B, 0x5C, 0xF6), (0x7B, 0x2C, 0xBF)),
        ((0x6D, 0x8E, 0xF8), (0x3C, 0x6F, 0xF0)),
        ((0x2E, 0xC4, 0xBD), (0x00, 0xA1, 0x9A))]
WHITE = [((0xFF, 0xFF, 0xFF), (0xE6, 0xF2, 0xF1))] * 3
BAR_R, BG_R, SS = 3.0, 14.0, 4

VARIANTS = {
    "navy":      ((0x07, 0x18, 0x33), GRAD),   # current site icon
    "tealplate": ((0x00, 0xA1, 0x9A), WHITE),  # A: brand teal + white bars
    "darkteal":  ((0x04, 0x30, 0x2F), GRAD),   # B: dark teal + gradient bars
    "offwhite":  ((0xF7, 0xF8, 0xFB), GRAD),   # C: light plate + gradient bars
}


def hit(px, py, x, y, w, h, r):
    if px < x or px > x + w or py < y or py > y + h:
        return False
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render(size, plate, bars, bg_radius=BG_R):
    scale = 64.0 / size
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    ux = (px + (sx + 0.5) / SS) * scale
                    uy = (py + (sy + 0.5) / SS) * scale
                    if not hit(ux, uy, 0, 0, 64, 64, bg_radius):
                        continue
                    col = plate
                    for i, (bx, by, bw, bh) in enumerate(BARS_GEOM):
                        if hit(ux, uy, bx, by, bw, bh, BAR_R):
                            ctop, cbot = bars[i]
                            t = (uy - by) / bh
                            col = tuple(round(ctop[k] + (cbot[k] - ctop[k]) * t) for k in range(3))
                            break
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = SS * SS
            a = acc[3] / n
            if a <= 0.5:
                row += b"\x00\x00\x00\x00"
            else:
                cov = acc[3] / 255.0
                row += bytes((round(acc[0] / cov), round(acc[1] / cov), round(acc[2] / cov), round(a)))
        rows.append(bytes(row))
    return rows


def png_bytes(rows, w, h=None):
    h = h or len(rows)
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico_bytes(pngs):
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for size, data in pngs:
        entries += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs



if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
    plate, bars = VARIANTS["tealplate"]

    ico = [(s, png_bytes(render(s, plate, bars), s)) for s in (16, 32, 48)]
    with open(os.path.join(out, "favicon.ico"), "wb") as f:
        f.write(ico_bytes(ico))

    # Square, unrounded: iOS applies its own mask to the home-screen icon.
    with open(os.path.join(out, "apple-touch-icon.png"), "wb") as f:
        f.write(png_bytes(render(180, plate, bars, bg_radius=0.0), 180))

    for name in ("favicon.ico", "apple-touch-icon.png"):
        print(name, os.path.getsize(os.path.join(out, name)), "bytes")
