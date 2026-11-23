#!/usr/bin/env python3
"""Generate Kontak square logo, favicons, and PWA icons from sampled brand geometry.

Source: the historic non-square public/icon-512.png (784x1168), a white geometric
K and a green disc on a navy rounded rectangle. Colors and letterform were
measured from that PNG (navy #0C1C36, green #1EBB62).
"""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

# Sampled from the original PNG (most-common exact pixels).
NAVY = (12, 28, 54)  # #0C1C36
GREEN = (30, 187, 98)  # #1EBB62
WHITE = (255, 255, 255)
NAVY_HEX = "#0C1C36"
GREEN_HEX = "#1EBB62"

# Letterform in original PNG pixel space (784x1168).
STEM_L, STEM_R = 183.0, 316.5
Y_TOP, Y_BOT = 268.0, 872.0
UL_TOP = (477.5076, 268.0)
UR_TOP = (627.0379, 268.0)
JOIN_U = (316.5, 486.9610)
CROTCH = (400.4796, 564.3196)
LR_BOT = (634.1918, 872.0)
LL_BOT = (477.4805, 872.0)
JOIN_L = (316.5, 647.1538)
GREEN_C = (505.5, 627.0)
GREEN_R = 103.5
# Combined mark bounding box (K + disc; disc stays inside this).
MARK_X0, MARK_Y0 = 183.0, 268.0
MARK_W, MARK_H = 451.0, 605.0

# "any" icons: vertical padding ~12.5% so the tall K fills the square well.
ANY_PAD = 0.125
# maskable safe zone is a centered circle of diameter 80%. Keep all silhouette
# points (arm tips + disc) inside a slightly tighter 76% circle.
MASKABLE_SAFE = 0.76

CORNER_RATIO = 96 / 512  # ~18.75%, close to the original rect's ~19.5% of width


def mark_extent_points():
    """Key silhouette points in original space, used to fit the maskable safe circle."""
    pts = [
        (STEM_L, Y_TOP),
        (STEM_L, Y_BOT),
        UR_TOP,
        LR_BOT,
        CROTCH,
        (GREEN_C[0] + GREEN_R, GREEN_C[1]),
        (GREEN_C[0] - GREEN_R, GREEN_C[1]),
        (GREEN_C[0], GREEN_C[1] + GREEN_R),
        (GREEN_C[0], GREEN_C[1] - GREEN_R),
    ]
    return pts


def transform_for(size: float, pad: float | None, maskable: bool) -> tuple[float, float, float]:
    """Return (scale, ox, oy) mapping original PNG coords into a size x size square."""
    cx = MARK_X0 + MARK_W / 2
    cy = MARK_Y0 + MARK_H / 2
    if maskable:
        # scale so the farthest mark point sits on the safe circle.
        farthest = 0.0
        for x, y in mark_extent_points():
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d > farthest:
                farthest = d
        s = (size * MASKABLE_SAFE / 2) / farthest
    else:
        usable = size * (1 - 2 * (pad if pad is not None else ANY_PAD))
        s = usable / MARK_H
    ox = size / 2 - cx * s
    oy = size / 2 - cy * s
    return s, ox, oy


def xf(p, s, ox, oy):
    return (p[0] * s + ox, p[1] * s + oy)


def k_polygon(s, ox, oy):
    return [
        xf((STEM_L, Y_TOP), s, ox, oy),
        xf((STEM_R, Y_TOP), s, ox, oy),
        xf(JOIN_U, s, ox, oy),
        xf(UL_TOP, s, ox, oy),
        xf(UR_TOP, s, ox, oy),
        xf(CROTCH, s, ox, oy),
        xf(LR_BOT, s, ox, oy),
        xf(LL_BOT, s, ox, oy),
        xf(JOIN_L, s, ox, oy),
        xf((STEM_R, Y_BOT), s, ox, oy),
        xf((STEM_L, Y_BOT), s, ox, oy),
    ]


def fmt_points(pts):
    return " ".join(f"{x:.3f},{y:.3f}" for x, y in pts)


def svg_markup(size=512, *, rounded=True, maskable=False, pad=None, bg_full=False) -> str:
    s, ox, oy = transform_for(size, pad, maskable)
    poly = fmt_points(k_polygon(s, ox, oy))
    gc = xf(GREEN_C, s, ox, oy)
    gr = GREEN_R * s
    rx = size * CORNER_RATIO if rounded and not bg_full and not maskable else 0
    if bg_full or maskable:
        bg = f'<rect width="{size}" height="{size}" fill="{NAVY_HEX}"/>'
    elif rounded:
        bg = (
            f'<rect width="{size}" height="{size}" rx="{rx:.3f}" ry="{rx:.3f}" '
            f'fill="{NAVY_HEX}"/>'
        )
    else:
        bg = f'<rect width="{size}" height="{size}" fill="{NAVY_HEX}"/>'
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="Kontak">
  {bg}
  <polygon fill="#FFFFFF" points="{poly}"/>
  <circle fill="{GREEN_HEX}" cx="{gc[0]:.3f}" cy="{gc[1]:.3f}" r="{gr:.3f}"/>
</svg>
'''


def render_png(path: Path, size: int, *, rounded=True, maskable=False, pad=None, bg_full=False, supersample=8):
    # Draw at a high resolution so 16/32 px favicons stay sharp after downsample.
    scale = supersample if size <= 64 else (4 if size <= 256 else 2)
    canvas = size * scale
    s, ox, oy = transform_for(canvas, pad, maskable)
    if bg_full or maskable:
        im = Image.new("RGBA", (canvas, canvas), NAVY + (255,))
        draw = ImageDraw.Draw(im)
    else:
        im = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        draw = ImageDraw.Draw(im)
        if rounded:
            rx = canvas * CORNER_RATIO
            draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=rx, fill=NAVY + (255,))
        else:
            draw.rectangle((0, 0, canvas - 1, canvas - 1), fill=NAVY + (255,))
    draw.polygon(k_polygon(s, ox, oy), fill=WHITE + (255,))
    gc = xf(GREEN_C, s, ox, oy)
    gr = GREEN_R * s
    box = [gc[0] - gr, gc[1] - gr, gc[0] + gr, gc[1] + gr]
    draw.ellipse(box, fill=GREEN + (255,))
    out = im.resize((size, size), Image.Resampling.LANCZOS)
    # Flatten to RGB when fully opaque (apple-touch / maskable).
    if bg_full or maskable:
        out = out.convert("RGB")
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path, "PNG", optimize=True)
    return out



def save_ico(path: Path, images: list[Image.Image]) -> None:
    """Write a multi-size ICO using PNG payloads (supported since Windows Vista)."""
    payloads = []
    for im in images:
        buf = io.BytesIO()
        im.convert("RGBA").save(buf, format="PNG")
        payloads.append(buf.getvalue())
    offset = 6 + 16 * len(images)
    with path.open("wb") as f:
        f.write(struct.pack("<HHH", 0, 1, len(images)))
        off = offset
        for im, data in zip(images, payloads):
            w = 0 if im.width >= 256 else im.width
            h = 0 if im.height >= 256 else im.height
            f.write(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), off))
            off += len(data)
        for data in payloads:
            f.write(data)


def main():
    favicon_svg = svg_markup(512, rounded=True)
    (PUBLIC / "favicon.svg").write_text(favicon_svg, encoding="utf-8")
    (PUBLIC / "logo.svg").write_text(favicon_svg, encoding="utf-8")

    render_png(PUBLIC / "favicon-32.png", 32, rounded=True)
    render_png(PUBLIC / "icon-192.png", 192, rounded=True)
    render_png(PUBLIC / "icon-512.png", 512, rounded=True)
    render_png(PUBLIC / "apple-touch-icon.png", 180, rounded=False, bg_full=True)
    render_png(PUBLIC / "maskable-512.png", 512, maskable=True, bg_full=True)

    # Multi-size ICO (PNG-in-ICO) from crisp native renders, not one downscale.
    ico_imgs = [render_png(PUBLIC / f".ico-{side}.png", side, rounded=True) for side in (16, 32, 48)]
    save_ico(PUBLIC / "favicon.ico", ico_imgs)
    for side in (16, 32, 48):
        (PUBLIC / f".ico-{side}.png").unlink(missing_ok=True)

    print("wrote:")
    for name in (
        "logo.svg",
        "favicon.svg",
        "favicon.ico",
        "favicon-32.png",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "maskable-512.png",
    ):
        p = PUBLIC / name
        print(f"  {p}  {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
