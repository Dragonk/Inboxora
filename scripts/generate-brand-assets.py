#!/usr/bin/env python3
"""Render Inboxora's single-purpose app and UI brand assets from vector-like paths."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend" / "public"
SIZES = (72, 96, 128, 144, 152, 192, 384, 512)
ANDROID_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
CANVAS = 1024


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size, top, bottom):
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(4))
        for x in range(size):
            pixels[x, y] = color
    return image


def line(draw, points, fill, width, joint="curve"):
    draw.line(points, fill=fill, width=round(width), joint=joint)


def draw_mark(canvas, palette, compact=False):
    """Mail envelope + calendar tabs/grid + contact badge, designed for 24px use."""
    d = ImageDraw.Draw(canvas)
    navy, main, accent, gold, surface, shadow = palette
    s = CANVAS / 512
    # Envelope: primary, familiar shape with a substantial stroke at small sizes.
    box = (68*s, 176*s, 444*s, 420*s)
    d.rounded_rectangle(box, radius=52*s, fill=surface, outline=navy, width=round(20*s))
    line(d, [(78*s, 196*s), (256*s, 330*s), (434*s, 196*s)], navy, 22*s)
    line(d, [(78*s, 407*s), (205*s, 300*s)], accent, 17*s)
    line(d, [(434*s, 407*s), (307*s, 300*s)], accent, 17*s)

    # Calendar grows naturally out of the envelope's upper right corner.
    cal = (276*s, 82*s, 458*s, 273*s)
    d.rounded_rectangle(cal, radius=42*s, fill=main, outline=navy, width=round(20*s))
    d.rounded_rectangle((276*s, 130*s, 458*s, 170*s), radius=10*s, fill=accent)
    for x in (315, 394):
        d.rounded_rectangle((x*s, 58*s, (x+26)*s, 111*s), radius=13*s, fill=gold)
    for x, y in ((316, 193), (364, 193), (412, 193), (316, 231), (364, 231), (412, 231)):
        d.rounded_rectangle((x*s, y*s, (x+22)*s, (y+20)*s), radius=7*s, fill=surface)

    # Contact: a compact, recognisable avatar badge, not another generic dot.
    cx, cy, r = 404*s, 365*s, 70*s
    d.ellipse((cx-r, cy-r, cx+r, cy+r), fill=gold, outline=navy, width=round(16*s))
    d.ellipse((379*s, 323*s, 429*s, 373*s), fill=navy)
    d.rounded_rectangle((360*s, 378*s, 448*s, 430*s), radius=28*s, fill=navy)


def app_icon(size=CANVAS):
    bg = gradient(size, (80, 70, 232, 255), (22, 157, 211, 255))
    mask = rounded_mask(size, round(size * .23))
    bg.putalpha(mask)
    # Gentle vignette and inset highlight retain definition against either page theme.
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle((22*size/512, 22*size/512, size-22*size/512, size-22*size/512), radius=size*.205,
                         outline=(255, 255, 255, 90), width=max(2, round(size*.012)))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((80*size/512, 190*size/512, 460*size/512, 434*size/512), radius=52*size/512, fill=(10, 19, 70, 64))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size*.018))
    bg.alpha_composite(shadow)
    draw_mark(bg, ((19, 26, 78, 255), (246, 250, 255, 255), (29, 218, 213, 255), (255, 199, 79, 255), (255, 255, 255, 255), (0, 0, 0, 0)))
    bg.alpha_composite(overlay)
    return bg


def ui_mark(dark_theme):
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    if dark_theme:
        palette = ((238, 244, 255, 255), (101, 88, 255, 255), (35, 221, 216, 255), (255, 198, 74, 255), (255, 255, 255, 255), (0, 0, 0, 0))
    else:
        palette = ((16, 31, 73, 255), (91, 76, 238, 255), (0, 153, 167, 255), (218, 133, 22, 255), (247, 250, 255, 255), (0, 0, 0, 0))
    draw_mark(image, palette)
    return image


def save_png(image, path, size):
    image.resize((size, size), Image.Resampling.LANCZOS).save(path, "PNG", optimize=True)


def main():
    icon = app_icon()
    for size in SIZES:
        save_png(icon, PUBLIC / f"inboxora-icon-{size}.png", size)
        save_png(icon, PUBLIC / f"icon-{size}.png", size)
    save_png(ui_mark(False), PUBLIC / "inboxora-ui-logo.png", CANVAS)
    save_png(ui_mark(False), PUBLIC / "inboxora-ui-logo-light.png", CANVAS)
    save_png(ui_mark(True), PUBLIC / "inboxora-ui-logo-dark.png", CANVAS)
    android_res = ROOT / "frontend" / "packages" / "android" / "app" / "src" / "main" / "res"
    foreground = ui_mark(False)
    for directory, size in ANDROID_SIZES.items():
        target = android_res / directory
        save_png(icon, target / "ic_launcher.png", size)
        save_png(icon, target / "ic_launcher_round.png", size)
        save_png(foreground, target / "ic_launcher_foreground.png", round(size * 2.25))
    print("Rendered Inboxora app icon and theme-specific UI marks.")


if __name__ == "__main__":
    main()
