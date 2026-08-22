# tools

Scripts for the generated assets. None of them run during a build: they are run by hand
when the thing they produce needs to change, and their output is committed.

## subset-material-symbols.py

Rebuilds `app/src/main/assets/www/fonts/material-symbols-outlined.woff2` and
`app/src/main/assets/www/js/icon-codepoints.js`.

The app ships without the INTERNET permission, so the icon font is bundled instead of
loaded from the Google Fonts CDN. The full variable font is about 3.9 MB, far too much for
the 140 or so icons the UI draws, so this pins the variable axes and subsets by codepoint,
which lands at roughly 10 KB.

Icons are addressed by codepoint rather than by the usual ligature. Material Symbols does
its name-to-glyph substitution through contextual `rlig` lookups, and those cannot survive
a subset without dragging every icon in the font along with them. The generated map is
what lets calling code keep saying `icon('home')`.

Run it whenever you reference an icon that is not already bundled. An unbundled name logs a
console warning at runtime and falls back to a help glyph, so it will not pass unnoticed.

```
pip install fonttools brotli

curl -sL "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" -o msy.css
# copy the woff2 URL out of msy.css, then:
curl -sL "<woff2 url>" -o material-symbols-full.woff2

python tools/subset-material-symbols.py
```

Add names to the `NAMES` block. They come from <https://fonts.google.com/icons> with the
style set to Material Symbols Outlined. The script prints any name it could not find.

`material-symbols-full.woff2` is gitignored: it is a build input, not an asset.

## extract-glyph-path.py

Prints a glyph from the bundled font as Android vector `pathData`.

The launcher icon carries a rupee sign, and this is where it came from. Lifting the outline
from the font gives a mark that matches the icons inside the app, which drawing one by eye
would not.

```
python tools/extract-glyph-path.py currency_rupee --at 54,42 --height 26
```

## generate-brand-mark.py

Rebuilds `app/src/main/assets/www/js/brand-mark.js` from
`res/drawable/ic_launcher_foreground.xml`.

The lock screen, the setup flow and the About page all show the app's mark. Generating it
from the launcher vector means the mark inside the app is the same drawing as the icon on
the home screen, rather than a lookalike that drifts.

```
python tools/generate-brand-mark.py
```

## generate-legacy-launcher-icons.py

Rebuilds `res/mipmap-*/ic_launcher.png` and `ic_launcher_round.png`.

Adaptive icons in `res/mipmap-anydpi-v26` cover API 26 and up. The project's minSdk is 24,
and on API 24 and 25 an `anydpi-v26` icon does not resolve at all, so real bitmaps have to
be there too.

The PNGs are rasterised from `res/drawable/ic_launcher_background.xml` and
`ic_launcher_foreground.xml` by a headless browser. Android vector `pathData` is SVG path
syntax, so the paths transfer unchanged, and the bitmaps cannot drift away from the vector
the way a second hand-written copy of the geometry would.

Run it after any change to those two drawables.

```
pip install pillow
python tools/generate-legacy-launcher-icons.py
```

Needs a Chrome or Edge binary, which any machine set up for Android development has.

## bump-version.ps1

Bumps `versionCode` and `versionName` across `app/build.gradle` and `about.js`, with optional release compilation.

```powershell
# Auto-bump patch version (e.g. 1.0.3 -> 1.0.4, code 3 -> 4)
.\tools\bump-version.ps1

# Minor version bump and build signed release (.aab & .apk)
.\tools\bump-version.ps1 -Type minor -Build

# Explicit version code & name with build
.\tools\bump-version.ps1 -VersionCode 5 -VersionName "1.1.0" -Build
```

## build-release.ps1

Validates Node test suite, runs Gradle `bundleRelease` and `assembleRelease`, and copies versioned `.aab` & `.apk` to the `release/` directory.

```powershell
.\tools\build-release.ps1
```

## run-e2e.ps1

Builds the **Debug APK** (`assembleDebug`), installs it on the connected device/emulator (`com.chikatistudio.vittavriksha.debug`), launches the debug application, executes Maestro E2E test flows, and syncs captured screenshots.

```powershell
# Run the master E2E suite on Debug build
.\tools\run-e2e.ps1

# Run a specific Maestro test flow on Debug build
.\tools\run-e2e.ps1 -Flow .maestro/03_add_transaction.yaml

# Skip rebuilding APK if already installed
.\tools\run-e2e.ps1 -SkipBuild
```
