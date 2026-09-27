#!/usr/bin/env python3
"""
Draws the card that shows up when the landing page is pasted into a chat.

Why a script and not a hand-made file: the numbers on it are measurements, and
measurements move. When the next run changes them, this regenerates the card in
a second instead of someone editing a PNG by hand and quietly leaving a stale
figure in front of everyone who sees the link.

    .venv/bin/python tools/make_og_image.py

Writes web/og.png at 1200x630, the size every platform crops from. Cyrillic
needs a font that has it, so the face is named explicitly rather than left to a
default that silently falls back to boxes.
"""

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / "web/og.png"
WIDTH, HEIGHT = 1200, 630
MARGIN = 84

# Matches the landing page's dark palette, so the card and the page it links to
# are recognisably the same thing.
INK = (231, 234, 232)
SOFT = (154, 163, 157)
FAINT = (121, 130, 124)
GROUND = (13, 16, 15)
PANEL = (22, 26, 25)
RULE = (41, 50, 48)
ACCENT = (95, 183, 152)

FONT_DIR = "/System/Library/Fonts/Supplemental/"


def font(name, size):
    try:
        return ImageFont.truetype(FONT_DIR + name, size)
    except OSError:
        sys.exit("шрифт не найден: " + FONT_DIR + name)


def main():
    image = Image.new("RGB", (WIDTH, HEIGHT), GROUND)
    draw = ImageDraw.Draw(image)

    bold = font("Arial Bold.ttf", 60)
    regular = font("Arial Unicode.ttf", 29)
    label = font("Arial Bold.ttf", 19)
    number = font("Arial Bold.ttf", 52)
    caption = font("Arial Unicode.ttf", 21)

    y = MARGIN
    draw.text((MARGIN, y), "МУЗЫКАЛЬНЫЙ СОРТИР", font=label, fill=ACCENT)
    y += 52

    for line in ("Раскладывает фонотеку,", "пока вы собираетесь на сет"):
        draw.text((MARGIN, y), line, font=bold, fill=INK)
        y += 72

    y += 18
    draw.text((MARGIN, y), "Жанры, темп, тональность и плейлисты для Rekordbox.",
              font=regular, fill=SOFT)
    y += 40
    draw.text((MARGIN, y), "Всё считается в браузере.", font=regular, fill=SOFT)

    # The three measurements, in the same order and wording as the page.
    panel_top = HEIGHT - MARGIN - 132
    draw.rounded_rectangle([MARGIN, panel_top, WIDTH - MARGIN, panel_top + 132],
                           radius=8, fill=PANEL, outline=RULE, width=1)
    column = (WIDTH - 2 * MARGIN) / 3
    for index, (value, what) in enumerate(
            [("90.1%", "темп"), ("59.4%", "тональность"), ("20.5%", "жанр")]):
        x = MARGIN + column * index + 32
        draw.text((x, panel_top + 26), value, font=number, fill=INK)
        draw.text((x, panel_top + 88), what, font=caption, fill=FAINT)
        if index:
            line_x = MARGIN + column * index
            draw.line([line_x, panel_top + 18, line_x, panel_top + 114], fill=RULE, width=1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, "PNG", optimize=True)
    print("записано %s — %dx%d, %d КБ" % (OUT.name, WIDTH, HEIGHT, OUT.stat().st_size // 1024))


if __name__ == "__main__":
    main()
