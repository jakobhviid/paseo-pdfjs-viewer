# Third-party notices

This repository contains no third-party code. When the plugin is prepared (`npm install` or the
`build` steps in `paseo-plugin.json`), `scripts/embed-pdfjs.mjs` copies the following files from
the [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) npm package into
`server/generated/pdfjs-assets.js`. Their license texts ship in that package at the paths listed.

| Component                                  | Files embedded                                                                                              | License                     | License text in `node_modules/pdfjs-dist/`             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| PDF.js (Mozilla Foundation)                | `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `web/pdf_viewer.mjs`, `web/pdf_viewer.css`, `web/images/*` | Apache-2.0                  | `LICENSE`                                              |
| Adobe CMaps                                | `cmaps/*.bcmap`                                                                                             | BSD-3-Clause                | `cmaps/LICENSE`                                        |
| Foxit standard fonts (PDFium)              | `standard_fonts/Foxit*.pfb`                                                                                 | BSD-3-Clause                | `standard_fonts/LICENSE_FOXIT`                         |
| Liberation Sans fonts                      | `standard_fonts/LiberationSans-*.ttf`                                                                       | GPL-2.0 with font exception | `standard_fonts/LICENSE_LIBERATION`                    |
| JBIG2 decoder (PDFium, compiled by PDF.js) | `wasm/jbig2.wasm`                                                                                           | BSD-3-Clause; Apache-2.0    | `wasm/LICENSE_JBIG2`, `wasm/LICENSE_PDFJS_JBIG2`       |
| OpenJPEG decoder (compiled by PDF.js)      | `wasm/openjpeg.wasm`                                                                                        | BSD-2-Clause                | `wasm/LICENSE_OPENJPEG`, `wasm/LICENSE_PDFJS_OPENJPEG` |
