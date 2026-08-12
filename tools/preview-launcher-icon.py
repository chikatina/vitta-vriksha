"""Render the launcher icon at real launcher sizes, so it can be judged before shipping.

An icon that reads at 192 pixels can be unrecognisable at 48, and both mask shapes crop
differently. This rasterises the vector at every density under both crops.

    python tools/preview-launcher-icon.py                      # the current icon
    python tools/preview-launcher-icon.py "A=a.xml" "B=b.xml"   # compare candidates

Writes preview.png beside this script and prints its path.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, "..", "app", "src", "main", "res", "drawable"))

spec = importlib.util.spec_from_file_location(
    "gen", os.path.join(HERE, "generate-legacy-launcher-icons.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

CANDIDATES = [tuple(arg.split("=", 1)) for arg in sys.argv[1:]] or [
    ("Launcher icon", f"{RES}/ic_launcher_foreground.xml"),
    ("Themed monochrome", f"{RES}/ic_launcher_monochrome.xml"),
]

stops = gen.background_gradient(f"{RES}/ic_launcher_background.xml")
SIZES = [48, 72, 96, 144, 192]
uid = [0]


def tile(size, art, mask="squircle", bg="brand"):
    uid[0] += 1
    i = uid[0]
    shape = ('<circle cx="54" cy="54" r="47"/>' if mask == "circle"
             else '<rect x="7" y="7" width="94" height="94" rx="24"/>')
    grad = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    fill = f"url(#g{i})" if bg == "brand" else bg
    return f'''<figure style="margin:0;text-align:center">
      <svg width="{size}" height="{size}" viewBox="0 0 108 108">
        <defs><linearGradient id="g{i}" x1="0" y1="0" x2="108" y2="108"
              gradientUnits="userSpaceOnUse">{grad}</linearGradient>
        <clipPath id="c{i}">{shape}</clipPath></defs>
        <g clip-path="url(#c{i})"><rect width="108" height="108" fill="{fill}"/>{art}</g>
      </svg>
      <figcaption style="font:11px system-ui;color:#888;margin-top:5px">{size}</figcaption></figure>'''


rows = []
for label, path in CANDIDATES:
    art = gen.vector_to_svg_paths(path)
    tiles = "".join(tile(s, art) for s in SIZES)
    rows.append(f'''<section style="margin-bottom:26px">
      <h2 style="font:600 13px system-ui;color:#333;margin:0 0 10px">{label}</h2>
      <div style="display:flex;gap:22px;align-items:flex-end">{tiles}</div></section>''')

html = ('<!doctype html><meta charset="utf-8">'
        '<body style="margin:0;padding:26px;background:#f7f8f7">' + "".join(rows) + "</body>")

tmp = tempfile.mkdtemp()
page = os.path.join(tmp, "sheet.html")
open(page, "w", encoding="utf-8").write(html)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview.png")

subprocess.run([gen.find_browser(), "--headless", "--disable-gpu", "--hide-scrollbars",
                "--no-sandbox", f"--window-size=720,{140 + 300 * len(CANDIDATES)}",
                f"--screenshot={out}", f"--user-data-dir={tmp}/p",
                f'file:///{page.replace(os.sep, "/")}'], capture_output=True)
print(f"wrote {out}")
