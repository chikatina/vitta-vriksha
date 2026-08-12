# Acknowledgements

Vitta Vriksha is built on the work of these projects.

## Runtime

**[SQLite](https://www.sqlite.org/)** (public domain)
On-device storage. The app bundles the official WebAssembly build, which runs the same
engine and reads the same file format as the native library.

**[pdf.js](https://mozilla.github.io/pdf.js/)** (Apache 2.0)
Reads consolidated account statements, including the encrypted ones, and reports where
each piece of text sits on the page. A statement is a table, and reconstructing a table
needs coordinates.

**[casparser](https://github.com/codereverser/casparser)** (MIT)
by Sandeep Somasekharan. Reads CAMS, KFintech, NSDL and CDSL consolidated account
statements: investor details, folios, schemes, transactions, demat holdings and capital
gains. The parser this app bundles,
[casparser-js](https://github.com/chikatina/casparser-js), is a JavaScript port of it,
and the debt is a large one: the layout heuristics, the transaction classification, the
tax rules and the test suite are all its work, carried across.

**[casparser-isin](https://github.com/codereverser/casparser-isin)** (MIT)
by the same author. The reference database of Indian mutual fund schemes, their ISINs and
AMFI codes, and their values on 31 January 2018, which is what capital gains
grandfathering is measured against. The database the app ships is a slimmed copy of it,
built by `tools/build-isin-db.py`.

**[Association of Mutual Funds in India](https://www.amfiindia.com/)**, and the National
and Bombay stock exchanges, whose published data is what `casparser-isin` assembles.

## Interface

**[Material Symbols](https://fonts.google.com/icons)** (Apache 2.0)
Every icon in the app. The bundled font at
`app/src/main/assets/www/fonts/material-symbols-outlined.woff2` is a subset of the
Outlined set, cut down to the icons this app draws by
`tools/subset-material-symbols.py`.

**[Material Design 3](https://m3.material.io/)**
The shape, colour and motion conventions the interface follows. The implementation here
is original CSS rather than a Material component library.

## Platform

**[Android Open Source Project](https://source.android.com/)** (Apache 2.0)
The platform, WebView, WebCrypto, and the biometric and alarm APIs.

**[Kotlin](https://kotlinlang.org/)** (Apache 2.0)
The app shell.

---

Vitta Vriksha itself is released under the MIT licence.

