"""Rebuild the bundled Material Symbols Outlined subset and its name-to-codepoint map.

Source: https://fonts.google.com/icons (Material Symbols Outlined, Apache 2.0).

The app ships without the INTERNET permission, so the font is bundled rather than fetched
from the Google Fonts CDN. The full variable font is about 3.9 MB, far too much for the
140 or so icons the UI draws, so this pins the variable axes and subsets by codepoint.

Icons are addressed by codepoint rather than by the usual ligature. Material Symbols
performs name-to-glyph substitution through contextual rlig lookups, and those cannot
survive a subset without dragging every icon in the font along with them. Subsetting by
codepoint keeps the file at roughly 13 KB, and the generated map below lets the UI keep
writing icon('home') instead of a hex escape.

    pip install fonttools brotli

    # Ask for the axes explicitly. Without them Google serves a pre-built static instance,
    # which works but subsets to roughly twice the size.
    curl -sL -A "Mozilla/5.0" "https://fonts.googleapis.com/css2?family=Material+Symbols+\
Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" -o msy.css
    curl -sL -A "Mozilla/5.0" "$(grep -o 'https://[^)]*woff2' msy.css | head -1)" \
        -o tools/material-symbols-full.woff2
    rm msy.css

    python tools/subset-material-symbols.py

Add new icon names to NAMES below. The script reports anything it cannot find.
"""

import os

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))

# Google Fonts hands back woff2 or ttf depending on what the client looks like, and
# fontTools reads either. Accept whichever was downloaded.
SRC = next(
    (path for path in (os.path.join(HERE, f"material-symbols-full.{ext}")
                       for ext in ("woff2", "ttf", "otf"))
     if os.path.exists(path)),
    os.path.join(HERE, "material-symbols-full.woff2"),
)
WWW = os.path.normpath(os.path.join(HERE, "..", "app", "src", "main", "assets", "www"))
FONT_OUT = os.path.join(WWW, "fonts", "material-symbols-outlined.woff2")
MAP_OUT = os.path.join(WWW, "js", "icon-codepoints.js")

NAMES = """
dashboard receipt_long donut_small savings more_horiz

lock lock_open fingerprint close arrow_back arrow_forward search filter_list more_vert
check check_circle add edit delete chevron_right chevron_left expand_more expand_less
calendar_month upload_file download refresh visibility visibility_off warning error info
dark_mode light_mode contrast notifications sms security backup group person
person_add description picture_as_pdf palette tune verified_user cloud_off key rule label
sort today event schedule autorenew north_east south_west remove help science
logout backspace history settings_backup_restore devices drag_indicator open_in_new
content_copy share push_pin star

bolt trending_up trending_down payments credit_card account_balance account_balance_wallet
currency_rupee flag rocket_launch local_fire_department timeline pie_chart bar_chart
show_chart percent request_quote price_check wallet currency_exchange account_tree
monitoring query_stats balance stacked_bar_chart storefront

shopping_cart restaurant home directions_car medical_services shopping_bag movie school
spa flight redeem shield work computer sell fitness_center pets child_care build
local_gas_station local_cafe sports_esports menu_book celebration local_taxi
fastfood water_drop wifi subscriptions real_estate_agent diamond umbrella checkroom cake
headphones directions_bus train hotel local_hospital local_pharmacy volunteer_activism
theaters sports_soccer directions_bike luggage
""".split()


def main():
    font = TTFont(SRC)

    # Reverse the cmap so icon names resolve to the codepoint the UI will emit.
    by_name = {}
    for codepoint, glyph in font.getBestCmap().items():
        by_name.setdefault(glyph, codepoint)

    wanted = sorted(set(NAMES))
    resolved = {name: by_name[name] for name in wanted if name in by_name}
    missing = [name for name in wanted if name not in by_name]

    # Flatten every axis, so gvar and fvar drop out and the file shrinks. Google Fonts
    # sometimes serves an already static instance, which has no axes to pin.
    if "fvar" in font:
        axes = {a.axisTag: a for a in font["fvar"].axes}
        pins = {tag: value for tag, value in
                (("opsz", 24), ("GRAD", 0), ("wght", 400), ("FILL", 0)) if tag in axes}
        font = instancer.instantiateVariableFont(font, pins)

    options = Options()
    options.flavor = "woff2"
    options.layout_features = []          # nothing addresses this font by ligature
    options.drop_tables += ["DSIG"]
    # A pre-built static download carries hinting the WebView never uses.
    options.hinting = False
    options.name_IDs = ["*"]
    options.notdef_outline = True

    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=list(resolved.values()))
    subsetter.subset(font)
    font.save(FONT_OUT)

    entries = "\n".join(
        f"  {name}: '\\u{codepoint:04x}'," for name, codepoint in sorted(resolved.items())
    )
    with open(MAP_OUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(
            "/*\n"
            " * Generated by tools/subset-material-symbols.py. Do not edit by hand.\n"
            " *\n"
            " * Maps Material Symbols Outlined names to the codepoints present in the bundled\n"
            " * font subset. Add a name to the script's NAMES list and re-run it to extend this.\n"
            " */\n\n"
            "export const ICON_CODEPOINTS = {\n"
            f"{entries}\n"
            "};\n"
        )

    size = os.path.getsize(FONT_OUT)
    print(f"{len(resolved)} icons, {size / 1024:.1f} KB -> {os.path.relpath(FONT_OUT, HERE)}")
    print(f"map written to {os.path.relpath(MAP_OUT, HERE)}")
    if missing:
        print("not found in font:", ", ".join(missing))


if __name__ == "__main__":
    main()
