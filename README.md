# PDF.js viewer for Paseo

A [Paseo](https://paseo.sh) plugin that opens `.pdf` files in the file tab with
[PDF.js](https://mozilla.github.io/pdf.js/): selectable text, search, links, zoom, and live reload
that keeps your place when a build rewrites the PDF. See [OVERVIEW.md](OVERVIEW.md) for what it
does from a user's point of view.

Requires Paseo 0.13.0 or later (file panels). Runs in the desktop app and the web app; the iOS
and Android apps show a message instead.

## Install

From a checkout:

```sh
npm install            # also embeds PDF.js into server/generated/
paseo plugin install "$PWD"
```

From Git (Paseo runs the `build` steps in paseo-plugin.json on the daemon host, which needs `npm`
and `node` on its PATH):

```sh
paseo plugin add git:<owner>/paseo-pdfjs-viewer
```

Open a `.pdf` from Files. If another plugin also handles PDFs, Paseo asks which one to use; change
it later with **Open with…** in the tab menu or in **Settings › Files**.

## How it works

- **The PDF.js runtime comes from the plugin's server code.** Paseo evaluates plugin client
  bundles in the native apps too, and Hermes cannot parse PDF.js (it uses `import()`). The client
  bundle stays small (about 45 KB) and free of PDF.js; on web it asks the server for the library,
  viewer, worker, and stylesheet, and loads them from `blob:` URLs.
- **Everything is embedded at install time.** Paseo runs plugin server bundles outside the plugin
  directory, so they cannot read `node_modules` at runtime. `scripts/embed-pdfjs.mjs` writes the
  PDF.js files, CMaps, standard fonts, and image decoders into `server/generated/`.
- **Fonts and CMaps on demand.** PDF.js asks a custom `BinaryDataFactory` for each file it needs;
  the factory fetches it from the plugin's server code.
- **Scoped styles.** PDF.js's viewer stylesheet has global rules, so it is wrapped in
  `@scope (.paseo-pdfjs-root)`; browsers without `@scope` get it unscoped.
- **Reloads that keep your place.** File changes are debounced (compilers often write a PDF in
  several steps), the new version loads in a hidden layer, and the view is restored in PDF
  coordinates before the layers swap. A version that fails to parse is retried, and the old one
  stays on screen.

## Limits

- Not available in the iOS and Android apps; see the next section.
- Every change re-reads the whole file, because the plugin file API has no partial reads.
- Non-embedded Chinese, Japanese, and Korean fonts need a matching system font.
- No form filling, annotation editing, printing, or saving.

## What Paseo would need for more

- A web view with scripts, or a native PDF view, for plugins in the iOS and Android apps
  ([#5834](https://github.com/getpaseo/paseo/discussions/5834)).
- Partial reads in the plugin file API, so a rebuild does not resend the whole file.
- Saving or sharing a file to the device from a plugin.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run format         # Prettier
paseo plugin install "$PWD"
paseo plugin reload pdfjs-viewer   # after changes
```

`client/web/` is the only code that touches the DOM; it is type-checked with
`tsconfig.web.json`. The rest of the client is type-checked without the DOM library and must stay
safe to evaluate in the native apps. `test/bundle.test.ts` compiles the client entry with Paseo's
compiler options and fails if PDF.js or `import()` syntax ends up in it.

## Credits

- [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla renders everything. See
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Paseo's [`pdf-panel`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/pdf-panel)
  example is the starting point for the file panel, and the
  [`markdown-panel`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/markdown-panel)
  example for mounting a DOM component on web only.
- [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) and
  [vscode-pdf](https://github.com/tomoki1207/vscode-pdfviewer) showed the approach for keeping the
  reader's position across rebuilds with PDF.js. No code is copied from them.
- [getpaseo/paseo#2452](https://github.com/getpaseo/paseo/pull/2452), the earlier proposal to
  preview PDFs in Paseo core, bounded preview reads; the 64 MB prompt here follows it. The
  discussion in [#5930](https://github.com/getpaseo/paseo/discussions/5930) led to file panels.
- [tlamadon/paseo-pdf-viewer](https://github.com/tlamadon/paseo-pdf-viewer) and
  [nkwib/paseo-doc-viewer](https://github.com/nkwib/paseo-doc-viewer) informed the reading-position
  and live-reload behavior; they render with PDFium on the daemon instead, which also works on
  phones.

## License

MIT. See [LICENSE](LICENSE).
