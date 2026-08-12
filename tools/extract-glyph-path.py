"""Print a Material Symbols glyph as Android vector pathData.

The launcher icon embeds a rupee sign. Rather than drawing one by eye, this lifts the
outline straight out of the font the app already bundles, so the mark matches the icons
used inside the app.

    python tools/extract-glyph-path.py currency_rupee --at 54,42 --height 26

Paste the result into an <path android:pathData="..."/> element. Coordinates are in the
108 unit viewport that adaptive icons use.
"""

import argparse
import os
import re
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.normpath(os.path.join(HERE, "..", "app", "src", "main", "assets", "www"))
FONT = os.path.join(WWW, "fonts", "material-symbols-outlined.woff2")
CODEPOINTS = os.path.join(WWW, "js", "icon-codepoints.js")


def resolve(name):
    """Map an icon name to the glyph name in the subsetted font.

    Subsetting by codepoint drops the readable glyph names, leaving uniXXXX, so the name
    is resolved through the generated codepoint map and then the font's own cmap.
    """
    source = open(CODEPOINTS, encoding="utf-8").read()
    found = re.search(rf"^\s*{re.escape(name)}:\s*'\\u([0-9a-fA-F]{{4}})'", source, re.M)
    if not found:
        sys.exit(f"'{name}' is not in the bundled subset. Add it to "
                 f"subset-material-symbols.py and re-run that first.")
    return int(found.group(1), 16)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name", help="Material Symbols icon name, for example currency_rupee")
    parser.add_argument("--at", default="54,54", help="centre as x,y in the 108 unit viewport")
    parser.add_argument("--height", type=float, default=26.0, help="height in viewport units")
    args = parser.parse_args()

    cx, cy = (float(v) for v in args.at.split(","))
    codepoint = resolve(args.name)

    font = TTFont(FONT)
    glyph_name = font.getBestCmap().get(codepoint)
    if glyph_name is None:
        sys.exit(f"The font has no glyph at U+{codepoint:04X}.")

    glyphs = font.getGlyphSet()

    # Centre on the glyph's own ink rather than its advance box, so it sits where asked.
    bounds = BoundsPen(glyphs)
    glyphs[glyph_name].draw(bounds)
    x_min, y_min, x_max, y_max = bounds.bounds

    scale = args.height / (y_max - y_min)
    # Font space has Y going up and vector drawables have it going down, hence -scale.
    transform = (Transform()
                 .translate(cx, cy)
                 .scale(scale, -scale)
                 .translate(-(x_min + x_max) / 2, -(y_min + y_max) / 2))

    pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    glyphs[glyph_name].draw(TransformPen(pen, transform))

    width = (x_max - x_min) * scale
    print(f"<!-- {args.name}, {args.height:g} units tall, centred on ({cx:g}, {cy:g}), "
          f"{width:.1f} wide -->")
    # Vector drawables accept the same path grammar as SVG. Commas before negative numbers
    # only, since a bare "10-5" would be ambiguous where "10 5" is not.
    print(pen.getCommands().replace(" -", ",-"))


if __name__ == "__main__":
    main()
