import os
import sys
from PIL import Image, ImageOps, ImageDraw, ImageFilter
import numpy as np

USER_IMG_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "source_icon.jpg")

img = Image.open(USER_IMG_PATH).convert("RGBA")
arr = np.array(img)

# Find the squircle bounding box by checking where brightness > 10
# (Outer is pure black (0,0,0))
mask_non_black = (arr[:, :, 0] > 15) | (arr[:, :, 1] > 15) | (arr[:, :, 2] > 15)
rows = np.any(mask_non_black, axis=1)
cols = np.any(mask_non_black, axis=0)
rmin, rmax = np.where(rows)[0][[0, -1]]
cmin, cmax = np.where(cols)[0][[0, -1]]

print(f"Squircle bounds: x=[{cmin}, {cmax}], y=[{rmin}, {rmax}], size=({cmax-cmin+1}, {rmax-rmin+1})")

# Crop exactly to the squircle
squircle_img = img.crop((cmin, rmin, cmax + 1, rmax + 1))
print(f"Cropped squircle size: {squircle_img.size}")

# Sample the green background inside the squircle (near the top-left inner area)
# Let's sample at (100, 100) inside the squircle
bg_pixel = squircle_img.getpixel((squircle_img.width // 2, 80))
print(f"Inner background color: {bg_pixel}")
bg_hex = "#{:02x}{:02x}{:02x}".format(bg_pixel[0], bg_pixel[1], bg_pixel[2])
print(f"Background Hex: {bg_hex}")

# Save cropped squircle for inspection
squircle_img.save("tools/squircle_extracted.png")
print("Saved tools/squircle_extracted.png")
