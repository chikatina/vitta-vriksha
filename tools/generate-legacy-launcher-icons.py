"""Render the PNG launcher icons that API 24 and 25 need.

Adaptive icons in res/mipmap-anydpi-v26 cover API 26 and up. Below that Android needs a
real bitmap, so this renders one per density.

The bitmaps are rasterised from res/drawable/ic_launcher_background.xml and
ic_launcher_foreground.xml rather than redrawn here. Android vector pathData is SVG path
syntax, so the paths transfer across unchanged and the PNGs cannot drift away from the
vector the way a second hand-written copy of the geometry would.

Needs a Chrome or Edge binary, which any machine with Android Studio already has, and
Pillow for the downsample.

    pip install pillow
    python tools/generate-legacy-launcher-icons.py
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
from xml.etree import ElementTree

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, "..", "app", "src", "main", "res"))

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# Rasterise large and downsample, which antialiases far better than asking the browser for
# a 48 pixel render directly.
SUPERSAMPLE = 4

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]


def find_browser():
    for candidate in BROWSERS:
        if os.path.exists(candidate):
            return candidate
    for name in ("google-chrome", "chromium", "chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    sys.exit("No Chrome or Edge binary found. Install one, or add its path to BROWSERS.")


ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


def vector_to_svg_paths(path):
    """Translate an Android vector drawable's <path> and <group> tree into SVG.

    Both formats use the same path grammar, so the geometry transfers unchanged. Groups
    become <g transform=...>, which is what lets the launcher icon fan its leaves out by
    rotation instead of carrying five sets of pre-rotated coordinates.
    """
    root = ElementTree.parse(path).getroot()

    def attr(node, name, default=None):
        return node.get(f"{ANDROID_NS}{name}", default)

    def convert(node):
        out = []
        for child in node:
            tag = child.tag.split("}")[-1]

            if tag == "path":
                data = " ".join((attr(child, "pathData") or "").split())
                out.append(
                    f'<path d="{data}" '
                    f'fill="{attr(child, "fillColor", "none")}" '
                    f'fill-rule="{attr(child, "fillType", "nonzero")}" '
                    f'stroke="{attr(child, "strokeColor", "none")}" '
                    f'stroke-width="{attr(child, "strokeWidth", "1")}" '
                    f'stroke-linecap="{attr(child, "strokeLineCap", "butt")}" '
                    f'stroke-linejoin="round" />'
                )

            elif tag == "group":
                pivot_x = float(attr(child, "pivotX", "0"))
                pivot_y = float(attr(child, "pivotY", "0"))
                transforms = []

                translate_x = float(attr(child, "translateX", "0"))
                translate_y = float(attr(child, "translateY", "0"))
                if translate_x or translate_y:
                    transforms.append(f"translate({translate_x} {translate_y})")

                rotation = float(attr(child, "rotation", "0"))
                if rotation:
                    transforms.append(f"rotate({rotation} {pivot_x} {pivot_y})")

                scale_x = float(attr(child, "scaleX", "1"))
                scale_y = float(attr(child, "scaleY", "1"))
                if scale_x != 1 or scale_y != 1:
                    # Vector drawables scale about the pivot, SVG about the origin.
                    transforms.append(
                        f"translate({pivot_x} {pivot_y}) scale({scale_x} {scale_y}) "
                        f"translate({-pivot_x} {-pivot_y})"
                    )

                inner = convert(child)
                out.append(f'<g transform="{" ".join(transforms)}">\n{inner}\n</g>'
                           if transforms else f"<g>\n{inner}\n</g>")

        return "\n".join(out)

    return convert(root)


def background_gradient(path):
    """Read the two gradient stops out of the background vector."""
    xml = open(path, encoding="utf-8").read()
    stops = re.findall(r'<item android:offset="([\d.]+)" android:color="(#[0-9A-Fa-f]+)"', xml)
    if stops:
        return stops
    flat = re.search(r'android:fillColor="(#[0-9A-Fa-f]+)"', xml)
    colour = flat.group(1) if flat else "#0E6B5A"
    return [("0.0", colour), ("1.0", colour)]


def build_svg(size, round_icon, foreground, stops):
    # A legacy icon is not cropped by the launcher, so it carries its own mask. The corner
    # radius follows the platform's own 22 percent.
    mask = ('<circle cx="54" cy="54" r="54"/>' if round_icon
            else '<rect width="108" height="108" rx="23.8"/>')
    gradient = "".join(
        f'<stop offset="{offset}" stop-color="{colour}"/>' for offset, colour in stops
    )

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{{margin:0;padding:0;background:transparent}}
  svg{{display:block}}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 108 108">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="108" y2="108" gradientUnits="userSpaceOnUse">
      {gradient}
    </linearGradient>
    <clipPath id="mask">{mask}</clipPath>
  </defs>
  <g clip-path="url(#mask)">
    <rect width="108" height="108" fill="url(#bg)"/>
    {foreground}
  </g>
</svg>
</body></html>"""


def render(browser, html, size, out_path):
    work = size * SUPERSAMPLE

    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "icon.html")
        shot = os.path.join(tmp, "shot.png")
        with open(page, "w", encoding="utf-8") as handle:
            handle.write(html.replace(f'width="{size}"', f'width="{work}"')
                             .replace(f'height="{size}"', f'height="{work}"'))

        result = subprocess.run([
            browser, "--headless", "--disable-gpu", "--hide-scrollbars",
            "--no-sandbox", "--force-color-profile=srgb",
            "--default-background-color=00000000",
            f"--window-size={work},{work}",
            f"--screenshot={shot}",
            f"--user-data-dir={os.path.join(tmp, 'profile')}",
            f"file:///{page.replace(os.sep, '/')}",
        ], capture_output=True, text=True)

        if not os.path.exists(shot):
            sys.exit(f"The browser produced no screenshot.\n{result.stderr[:800]}")

        image = Image.open(shot).convert("RGBA").resize((size, size), Image.LANCZOS)
        image.save(out_path)


def main():
    browser = find_browser()
    foreground = vector_to_svg_paths(os.path.join(RES, "drawable", "ic_launcher_foreground.xml"))
    stops = background_gradient(os.path.join(RES, "drawable", "ic_launcher_background.xml"))

    for density, size in DENSITIES.items():
        folder = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(folder, exist_ok=True)

        for name, round_icon in (("ic_launcher", False), ("ic_launcher_round", True)):
            html = build_svg(size, round_icon, foreground, stops)
            render(browser, html, size, os.path.join(folder, f"{name}.png"))

        print(f"  mipmap-{density}: {size}x{size}")

    print(f"rendered with {os.path.basename(browser)}")


if __name__ == "__main__":
    main()
