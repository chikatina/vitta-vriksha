import os
import sys
from PIL import Image, ImageOps, ImageDraw, ImageFilter
import numpy as np

USER_IMG_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "source_icon.jpg")
RES_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "res"))

# 1. Load original image
orig = Image.open(USER_IMG_PATH).convert("RGBA")
arr = np.array(orig)

# Find non-black boundary of the squircle
mask_non_black = (arr[:, :, 0] > 15) | (arr[:, :, 1] > 15) | (arr[:, :, 2] > 15)
rows = np.any(mask_non_black, axis=1)
cols = np.any(mask_non_black, axis=0)
rmin, rmax = np.where(rows)[0][[0, -1]]
cmin, cmax = np.where(cols)[0][[0, -1]]

# Square crop
side = max(cmax - cmin + 1, rmax - rmin + 1)
cx = (cmin + cmax) // 2
cy = (rmin + rmax) // 2
x0 = max(0, cx - side // 2)
y0 = max(0, cy - side // 2)
x1 = min(orig.width, x0 + side)
y1 = min(orig.height, y0 + side)

squircle = orig.crop((x0, y0, x1, y1))
print(f"Squircle cropped: {squircle.size}")

# Detect background color
bg_rgb = (3, 55, 43) # #03372B
bg_hex = "#03372B"

# 2. Extract foreground with transparent background
# Background in the image is deep green around (3, 55, 43)
# Let's create an alpha mask where background pixels are transparent
arr_sq = np.array(squircle).astype(float)
# Distance to background color
diff = np.sqrt(
    (arr_sq[:, :, 0] - bg_rgb[0]) ** 2 +
    (arr_sq[:, :, 1] - bg_rgb[1]) ** 2 +
    (arr_sq[:, :, 2] - bg_rgb[2]) ** 2
)

# Smooth alpha transition: diff < 15 -> 0, diff > 35 -> 255
alpha = np.clip((diff - 12.0) / (32.0 - 12.0) * 255.0, 0, 255).astype(np.uint8)

# Create isolated tree foreground
fg_isolated = squircle.copy()
fg_isolated.putalpha(Image.fromarray(alpha))

# 3. Create full square icon (with background filled to edge for adaptive / legacy)
# Replace outer black corners with the deep green background
full_bg = Image.new("RGBA", squircle.size, (*bg_rgb, 255))
full_icon = full_bg.copy()
full_icon.paste(squircle, (0, 0), squircle)

# Densities for standard launcher icons
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

for density, (legacy_size, adaptive_size) in DENSITIES.items():
    density_dir = os.path.join(RES_DIR, f"mipmap-{density}")
    os.makedirs(density_dir, exist_ok=True)
    
    # a. Legacy standard icon (ic_launcher.png) - resized with Lanczos
    icon_legacy = full_icon.resize((legacy_size, legacy_size), Image.Resampling.LANCZOS)
    icon_legacy.save(os.path.join(density_dir, "ic_launcher.png"), "PNG")
    
    # b. Legacy round icon (ic_launcher_round.png) - circular mask
    round_mask = Image.new("L", (legacy_size, legacy_size), 0)
    draw_round = ImageDraw.Draw(round_mask)
    draw_round.ellipse((0, 0, legacy_size - 1, legacy_size - 1), fill=255)
    
    icon_round = Image.new("RGBA", (legacy_size, legacy_size), (0, 0, 0, 0))
    icon_round.paste(icon_legacy, (0, 0), round_mask)
    icon_round.save(os.path.join(density_dir, "ic_launcher_round.png"), "PNG")
    
    # c. Adaptive Foreground (ic_launcher_foreground.png)
    # The adaptive canvas is adaptive_size x adaptive_size (e.g. 432x432 for xxxhdpi)
    # The visible safe area is the inner 72dp (i.e. 72 / 108 = 66.67% of adaptive_size)
    safe_target_size = int(round(adaptive_size * (72.0 / 108.0)))
    fg_scaled = fg_isolated.resize((safe_target_size, safe_target_size), Image.Resampling.LANCZOS)
    
    adaptive_fg = Image.new("RGBA", (adaptive_size, adaptive_size), (0, 0, 0, 0))
    offset = (adaptive_size - safe_target_size) // 2
    adaptive_fg.paste(fg_scaled, (offset, offset), fg_scaled)
    adaptive_fg.save(os.path.join(density_dir, "ic_launcher_foreground.png"), "PNG")
    
    print(f"Generated mipmap-{density}: legacy={legacy_size}x{legacy_size}, adaptive_fg={adaptive_size}x{adaptive_size}")

# 4. Update adaptive icon XMLs in mipmap-anydpi-v26
anydpi_dir = os.path.join(RES_DIR, "mipmap-anydpi-v26")
os.makedirs(anydpi_dir, exist_ok=True)

ic_launcher_xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""

with open(os.path.join(anydpi_dir, "ic_launcher.xml"), "w", encoding="utf-8") as f:
    f.write(ic_launcher_xml)

with open(os.path.join(anydpi_dir, "ic_launcher_round.xml"), "w", encoding="utf-8") as f:
    f.write(ic_launcher_xml)

# 5. Update background drawable
bg_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="{bg_hex}"
        android:pathData="M0,0h108v108h-108z" />
</vector>
"""
with open(os.path.join(RES_DIR, "drawable", "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
    f.write(bg_xml)

print("All Android launcher icons and adaptive drawables successfully generated from user image!")
