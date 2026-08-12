import math
import os

BG_COLOR = "#03372B"
TRUNK_COLOR = "#FAF3E8"
COIN_GOLD = "#FBBF24"
COIN_RIM = "#EAB308"
LEAF_LIGHT = "#84CC16"  # Vibrant spring lime green
LEAF_DARK = "#4E9A45"   # Forest emerald green
FRUIT_GOLD = "#D97706"  # Golden amber fruit dots

def make_leaf(cx, cy, length, width, angle_deg, color, for_svg=False):
    rad = math.radians(angle_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)
    hl = length / 2.0
    hw = width / 2.0
    
    def pt(x, y):
        rx = x * cos_a - y * sin_a + cx
        ry = x * sin_a + y * cos_a + cy
        return f"{rx:.2f},{ry:.2f}"
    
    p_top = pt(0, -hl)
    p_bot = pt(0, hl)
    c1_r = pt(hw * 1.15, -hl * 0.35)
    c2_r = pt(hw * 1.15, hl * 0.35)
    c1_l = pt(-hw * 1.15, hl * 0.35)
    c2_l = pt(-hw * 1.15, -hl * 0.35)
    
    d = f"M {p_bot} C {c2_r} {c1_r} {p_top} C {c2_l} {c1_l} {p_bot} Z"
    if for_svg:
        return f'    <path d="{d}" fill="{color}" />'
    return f'    <path android:fillColor="{color}" android:pathData="{d}" />'

def make_circle(cx, cy, r, color, for_svg=False):
    k = r * 0.55228475
    d = (f"M {cx:.2f},{(cy - r):.2f} "
         f"C {(cx + k):.2f},{(cy - r):.2f} {(cx + r):.2f},{(cy - k):.2f} {(cx + r):.2f},{cy:.2f} "
         f"C {(cx + r):.2f},{(cy + k):.2f} {(cx + k):.2f},{(cy + r):.2f} {cx:.2f},{(cy + r):.2f} "
         f"C {(cx - k):.2f},{(cy + r):.2f} {(cx - r):.2f},{(cy + k):.2f} {(cx - r):.2f},{cy:.2f} "
         f"C {(cx - r):.2f},{(cy - k):.2f} {(cx - k):.2f},{(cy - r):.2f} {cx:.2f},{(cy - r):.2f} Z")
    if for_svg:
        return f'    <path d="{d}" fill="{color}" />'
    return f'    <path android:fillColor="{color}" android:pathData="{d}" />'

# Leaves
leaves = []
leaves.append((54, 19.0, 9.8, 5.2, 0, LEAF_LIGHT))

top_outer = [
    (18, 36.0, 9.6, 5.2, LEAF_DARK),
    (36, 35.0, 9.8, 5.4, LEAF_LIGHT),
    (54, 34.0, 9.6, 5.2, LEAF_DARK),
    (72, 33.0, 9.4, 5.2, LEAF_LIGHT),
    (90, 31.5, 9.2, 5.0, LEAF_DARK),
    (108, 30.0, 9.0, 5.0, LEAF_LIGHT),
    (126, 28.0, 8.6, 4.8, LEAF_DARK),
    (144, 25.5, 8.4, 4.6, LEAF_LIGHT),
]

for angle, dist, l, w, col in top_outer:
    rad = math.radians(angle)
    cx = 54 + dist * math.sin(rad)
    cy = 34 - dist * math.cos(rad) + (dist * 0.16)
    leaves.append((cx, cy, l, w, angle, col))
    cx_l = 54 - dist * math.sin(rad)
    leaves.append((cx_l, cy, l, w, -angle, col))

mid_leaves = [
    (14, 23.0, 9.2, 4.8, LEAF_LIGHT),
    (32, 23.5, 9.2, 4.8, LEAF_DARK),
    (50, 23.0, 9.2, 4.8, LEAF_LIGHT),
    (68, 22.5, 9.0, 4.8, LEAF_DARK),
    (88, 21.0, 8.8, 4.6, LEAF_LIGHT),
    (108, 19.5, 8.4, 4.4, LEAF_DARK),
    (128, 17.5, 8.0, 4.4, LEAF_LIGHT),
]

for angle, dist, l, w, col in mid_leaves:
    rad = math.radians(angle)
    cx = 54 + dist * math.sin(rad)
    cy = 34 - dist * math.cos(rad) + (dist * 0.14)
    leaves.append((cx, cy, l, w, angle, col))
    cx_l = 54 - dist * math.sin(rad)
    leaves.append((cx_l, cy, l, w, -angle, col))

lower_leaves = [
    (38, 54.5, 9.0, 4.8, -38, LEAF_LIGHT),
    (70, 54.5, 9.0, 4.8, 38, LEAF_LIGHT),
    (30, 52.0, 8.6, 4.6, -65, LEAF_DARK),
    (78, 52.0, 8.6, 4.6, 65, LEAF_DARK),
    (46, 47.0, 7.8, 4.2, -22, LEAF_DARK),
    (62, 47.0, 7.8, 4.2, 22, LEAF_DARK),
]

fruits = [
    (54, 43.8, 1.5),
    (37, 20.0, 1.6), (71, 20.0, 1.6),
    (26, 24.5, 1.6), (82, 24.5, 1.6),
    (19, 38.0, 1.6), (89, 38.0, 1.6),
    (27, 46.5, 1.5), (81, 46.5, 1.5),
    (41, 30.5, 1.5), (67, 30.5, 1.5),
    (35, 40.0, 1.5), (73, 40.0, 1.5),
    (49, 44.5, 1.4), (59, 44.5, 1.4),
    (23, 53.5, 1.5), (85, 53.5, 1.5),
    (34, 58.5, 1.5), (74, 58.5, 1.5),
]

trunk_d = """M 51,57
            C 51,51 46,47 41,45.5
            L 33,48
            C 31,48.5 29.5,48 30.5,47
            L 38.5,43
            C 42,41 46,40.5 48.5,43
            L 40.5,38
            C 38.5,36.5 39.5,35 41.5,36
            L 50.5,44.5
            C 52.5,46.5 53.5,49 54,51
            C 54.5,49 55.5,46.5 57.5,44.5
            L 66.5,36
            C 68.5,35 69.5,36.5 67.5,38
            L 59.5,43
            C 62,40.5 66,41 69.5,43
            L 77.5,47
            C 78.5,48 77,48.5 75,48
            L 67,45.5
            C 62,47 57,51 57,57
            L 57,66
            C 57,70 61,73.5 66.5,76
            L 73.5,71.5
            C 75.5,70 76.5,71.5 74.5,73
            L 68.5,76.5
            C 71.5,76.5 74.5,75.5 77,74.5
            L 83.5,75.5
            C 85.5,76 84.5,78 82.5,78.5
            L 75.5,79.5
            L 77.5,83.5
            C 78,85 76,85.5 74.5,84.5
            L 71.5,79.5
            L 66.5,80.5
            L 68.5,84.5
            C 69,86 67,86.5 65.5,85.5
            L 62.5,80.5
            L 56.5,85
            C 55.5,85.8 54.5,85 54,84
            C 53.5,85 52.5,85.8 51.5,85
            L 45.5,80.5
            L 42.5,85.5
            C 41,86.5 39,86 39.5,84.5
            L 41.5,80.5
            L 36.5,79.5
            L 33.5,84.5
            C 32,85.5 30,85 30.5,83.5
            L 32.5,79.5
            L 25.5,78.5
            C 23.5,78 22.5,76 24.5,75.5
            L 31,74.5
            C 33.5,75.5 36.5,76.5 39.5,76.5
            L 33.5,73
            C 31.5,71.5 32.5,70 34.5,71.5
            L 41.5,76
            C 47,73.5 51,70 51,66
            Z"""

# 1. Android ic_launcher_foreground.xml
res_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "res"))
fg_path = os.path.join(res_dir, "drawable", "ic_launcher_foreground.xml")

fg_lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Vitta Vriksha: Authentic Tree of Wealth brand mark -->',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '    android:width="108dp"',
    '    android:height="108dp"',
    '    android:viewportWidth="108"',
    '    android:viewportHeight="108">',
    '',
    f'    <path android:fillColor="{TRUNK_COLOR}" android:pathData="{trunk_d}" />',
    '',
    make_circle(54, 34, 10.0, COIN_RIM),
    make_circle(54, 34, 9.4, COIN_GOLD),
    '',
]
for item in leaves:
    cx, cy, l, w, ang, col = item
    fg_lines.append(make_leaf(cx, cy, l, w, ang, col))
for cx, cy, l, w, ang, col in lower_leaves:
    fg_lines.append(make_leaf(cx, cy, l, w, ang, col))

fg_lines.append('')
for cx, cy, r in fruits:
    fg_lines.append(make_circle(cx, cy, r, FRUIT_GOLD))
fg_lines.append('')
fg_lines.append('</vector>')

with open(fg_path, "w", encoding="utf-8") as f:
    f.write("\n".join(fg_lines))
print(f"wrote {fg_path}")

# 2. Android ic_launcher_background.xml (Full bleed solid #03372B)
bg_path = os.path.join(res_dir, "drawable", "ic_launcher_background.xml")
bg_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="{BG_COLOR}"
        android:pathData="M0,0h108v108h-108z" />
</vector>
"""
with open(bg_path, "w", encoding="utf-8") as f:
    f.write(bg_xml)
print(f"wrote {bg_path}")

# 3. Android ic_launcher_monochrome.xml
mono_path = os.path.join(res_dir, "drawable", "ic_launcher_monochrome.xml")
mono_xml = "\n".join(fg_lines)
for c in [TRUNK_COLOR, COIN_GOLD, COIN_RIM, LEAF_LIGHT, LEAF_DARK, FRUIT_GOLD]:
    mono_xml = mono_xml.replace(f'"{c}"', '"#000000"')
with open(mono_path, "w", encoding="utf-8") as f:
    f.write(mono_xml)
print(f"wrote {mono_path}")

# 4. In-App Brand Mark brand-mark.js
brand_mark_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "assets", "www", "js", "brand-mark.js"))
svg_lines = [
    '/* In-app brand mark SVG (high contrast for both Light and Dark themes). */',
    'export function brandMark(className = "") {',
    '  return `<svg class="brand-mark ${className}" viewBox="0 0 108 108" role="img"',
    '       aria-label="Vitta Vriksha" xmlns="http://www.w3.org/2000/svg">',
    f'    <path d="{trunk_d}" fill="var(--brand-trunk, currentColor)" />',
    make_circle(54, 34, 10.0, COIN_RIM, for_svg=True),
    make_circle(54, 34, 9.4, COIN_GOLD, for_svg=True),
]
for item in leaves:
    cx, cy, l, w, ang, col = item
    svg_lines.append(make_leaf(cx, cy, l, w, ang, col, for_svg=True))
for cx, cy, l, w, ang, col in lower_leaves:
    svg_lines.append(make_leaf(cx, cy, l, w, ang, col, for_svg=True))
for cx, cy, r in fruits:
    svg_lines.append(make_circle(cx, cy, r, FRUIT_GOLD, for_svg=True))
svg_lines.append('  </svg>`;')
svg_lines.append('}')

with open(brand_mark_path, "w", encoding="utf-8") as f:
    f.write("\n".join(svg_lines) + "\n")
print(f"wrote {brand_mark_path}")
