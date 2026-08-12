"""Build the scheme reference database the app ships.

A statement does not print everything the app needs. A registrar prints a scheme's name
and its own internal code but not the ISIN, the AMFI code, or whether the scheme is
equity or debt. A depository prints the ISIN and nothing else. Both gaps are closed by a
reference database, and it also carries each scheme's value on 31 January 2018, which the
grandfathering rule for long-term equity gains needs.

The published database is
[casparser-isin](https://github.com/codereverser/casparser-isin), about 47 MB, almost all
of it a table of every security ever listed in India. The app needs a fraction of that:

  scheme        every mutual fund scheme, keyed by ISIN and by registrar code
  nav20180131   the 31 January 2018 values
  isin          only the securities that carry an exchange symbol, so a demat equity
                holding can be shown with a ticker rather than an ISIN

That comes to a few megabytes, which the APK compresses to well under one. The app has no
network permission, so this has to ship rather than be fetched.

    python tools/build-isin-db.py --source path/to/isin.db

With no --source, the database is taken from an installed `casparser_isin` package.
Re-run when a newer one is published, and note the version it writes into the meta table.
"""

import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.normpath(os.path.join(
    HERE, "..", "app", "src", "main", "assets", "www", "vendor", "isin", "isin.db"))


def find_source(explicit):
    if explicit:
        if not os.path.isfile(explicit):
            sys.exit(f"  no database at {explicit}")
        return explicit

    try:
        import casparser_isin
    except ImportError:
        sys.exit("  casparser_isin is not installed; pass --source instead")

    path = os.path.join(os.path.dirname(casparser_isin.__file__), "isin.db")
    if not os.path.isfile(path):
        sys.exit(f"  casparser_isin is installed but has no database at {path}")
    return path


def build(source_path, target_path):
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    if os.path.exists(target_path):
        os.remove(target_path)

    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    target = sqlite3.connect(target_path)

    target.executescript("""
        CREATE TABLE scheme(
            id INTEGER NOT NULL PRIMARY KEY,
            name, isin, amfi_code, type, rta, rta_code
        );
        CREATE TABLE nav20180131(isin NOT NULL PRIMARY KEY, nav);
        CREATE TABLE isin(
            isin NOT NULL PRIMARY KEY,
            name, issuer, type, status, symbol, exchange
        );
        CREATE TABLE meta(key NOT NULL PRIMARY KEY, value);
    """)

    counts = {}

    rows = source.execute(
        "SELECT id, name, isin, amfi_code, type, rta, rta_code FROM scheme").fetchall()
    target.executemany("INSERT INTO scheme VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    counts["scheme"] = len(rows)

    rows = source.execute("SELECT isin, nav FROM nav20180131").fetchall()
    target.executemany("INSERT INTO nav20180131 VALUES (?, ?)", rows)
    counts["nav20180131"] = len(rows)

    # Only the securities that carry a symbol. The rest of that table is 260,000 rows of
    # debentures, preference shares and government paper that the app has no use for and
    # that would multiply the size by ten.
    rows = source.execute(
        "SELECT isin, name, issuer, type, status, symbol, exchange FROM isin"
        " WHERE symbol IS NOT NULL AND symbol != ''").fetchall()
    target.executemany("INSERT INTO isin VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    counts["isin"] = len(rows)

    version = "unknown"
    try:
        for key, value in source.execute("SELECT key, value FROM meta"):
            target.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, value))
            if key == "version":
                version = value
    except sqlite3.OperationalError:
        pass
    target.execute("INSERT OR REPLACE INTO meta VALUES ('source', 'casparser-isin')")

    # The lookups go by ISIN and by registrar code, so both are indexed. The primary keys
    # cover the other two tables.
    target.executescript("""
        CREATE INDEX idx_scheme_isin ON scheme(isin);
        CREATE INDEX idx_scheme_rta_code ON scheme(rta_code);
    """)
    target.commit()
    target.execute("VACUUM")
    target.close()
    source.close()
    return counts, version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="path to casparser-isin's isin.db")
    parser.add_argument("--target", default=TARGET, help="where to write the slim database")
    args = parser.parse_args()

    source_path = find_source(args.source)
    print(f"reading {source_path} ({os.path.getsize(source_path) / 1024 / 1024:.0f} MB)")

    counts, version = build(source_path, args.target)

    print(f"  version {version}")
    for table, count in counts.items():
        print(f"  {table:14} {count:>7,} rows")
    print(f"  wrote {args.target} ({os.path.getsize(args.target) / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
