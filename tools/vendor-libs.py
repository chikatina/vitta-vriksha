"""Download the two third-party libraries the app bundles, into assets/www/vendor.

The app has no INTERNET permission and no bundler, so anything it uses has to sit in the
APK. These two are here deliberately, against the project's usual no-third-party-JS rule:

  SQLite WASM   the SQL engine. Writing one is not a reasonable undertaking, and using it
                keeps the schema and every query identical to what the Python layer ran.
  pdf.js        reads consolidated account statements. Mozilla's parser handles encrypted
                PDFs and reports text with positions, which is what a table parser needs.

Both are pure WASM and JavaScript, so the same files serve Android and iOS and the app
carries no native code of its own.

    python tools/vendor-libs.py

Re-run to upgrade. Check the licence notices it writes into vendor/ and keep
ACKNOWLEDGEMENTS.md in step.
"""

import io
import os
import shutil
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.normpath(
    os.path.join(HERE, "..", "app", "src", "main", "assets", "www", "vendor"))

SQLITE_VERSION = "3500400"
SQLITE_URL = f"https://sqlite.org/2025/sqlite-wasm-{SQLITE_VERSION}.zip"

PDFJS_VERSION = "5.4.149"
PDFJS_URL = (f"https://github.com/mozilla/pdf.js/releases/download/"
             f"v{PDFJS_VERSION}/pdfjs-{PDFJS_VERSION}-dist.zip")


def fetch(url):
    print(f"  fetching {url.rsplit('/', 1)[-1]}")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return zipfile.ZipFile(io.BytesIO(response.read()))


def extract(archive, wanted, destination):
    """Copies the named files out of the archive, ignoring its directory layout."""
    os.makedirs(destination, exist_ok=True)
    found = {}

    for entry in archive.namelist():
        name = entry.rsplit("/", 1)[-1]
        if name in wanted and name not in found:
            with archive.open(entry) as source:
                data = source.read()
            with open(os.path.join(destination, name), "wb") as target:
                target.write(data)
            found[name] = len(data)

    missing = [n for n in wanted if n not in found]
    if missing:
        sys.exit(f"  not found in the archive: {', '.join(missing)}")
    return found


def main():
    if os.path.isdir(VENDOR):
        shutil.rmtree(VENDOR)

    print("SQLite WASM")
    sqlite = extract(
        fetch(SQLITE_URL),
        # The plain build, not the bundler-friendly or worker variants. It needs no
        # COOP/COEP headers, which WebViewAssetLoader cannot set.
        ["sqlite3.mjs", "sqlite3.wasm"],
        os.path.join(VENDOR, "sqlite"),
    )

    print("pdf.js")
    pdfjs = extract(
        fetch(PDFJS_URL),
        ["pdf.mjs", "pdf.worker.mjs"],
        os.path.join(VENDOR, "pdfjs"),
    )

    with open(os.path.join(VENDOR, "README.md"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"""# vendor

Downloaded by `tools/vendor-libs.py`. Do not edit these files.

| Library | Version | Licence |
| --- | --- | --- |
| [SQLite WASM](https://sqlite.org/wasm) | {SQLITE_VERSION} | Public domain |
| [pdf.js](https://mozilla.github.io/pdf.js/) | {PDFJS_VERSION} | Apache 2.0 |

They are bundled rather than fetched because the app declares no INTERNET permission.
Being WebAssembly and JavaScript, the same files serve Android and iOS.
""")

    total = sum(sqlite.values()) + sum(pdfjs.values())
    print()
    for name, size in {**sqlite, **pdfjs}.items():
        print(f"  {name:22} {size / 1024:>8.0f} KB")
    print(f"  {'total':22} {total / 1024:>8.0f} KB uncompressed")


if __name__ == "__main__":
    main()
