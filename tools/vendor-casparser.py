"""Copy casparser-js into assets/www/vendor.

The statement parser is developed as its own project, because it is useful on its own and
because it has a test suite of its own that has nothing to do with this app. It is plain
ES modules with no dependencies and no build step, so vendoring it is a copy rather than a
bundle: the files that ship are the files that were tested.

    python tools/vendor-casparser.py --source ../casparser-js

Re-run after changing the parser. The version it writes into vendor/casparser/VERSION is
what the About screen reports.
"""

import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.normpath(os.path.join(
    HERE, "..", "app", "src", "main", "assets", "www", "vendor", "casparser"))

DEFAULT_SOURCE = os.path.normpath(os.path.join(HERE, "..", "..", "casparser-js"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="a casparser-js checkout")
    args = parser.parse_args()

    source = os.path.join(args.source, "src")
    manifest = os.path.join(args.source, "package.json")
    if not os.path.isdir(source):
        sys.exit(f"  no src directory at {source}")

    version = "unknown"
    if os.path.isfile(manifest):
        with open(manifest, encoding="utf-8") as handle:
            version = json.load(handle).get("version", "unknown")

    if os.path.isdir(VENDOR):
        shutil.rmtree(VENDOR)
    shutil.copytree(source, VENDOR)

    # The pdf.js adapter is the only file that expects the library to be installed from a
    # package registry; the app hands it the vendored copy instead, so nothing here needs
    # to change, but the note is worth leaving where a reader will find it.
    with open(os.path.join(VENDOR, "VERSION"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"{version}\n")

    files = sum(len(names) for _, _, names in os.walk(VENDOR))
    size = sum(
        os.path.getsize(os.path.join(root, name))
        for root, _, names in os.walk(VENDOR) for name in names
    )
    print(f"casparser-js {version}")
    print(f"  {files} files, {size / 1024:.0f} KB into {VENDOR}")


if __name__ == "__main__":
    main()
