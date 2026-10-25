Read PDFs inside Paseo's file tab. Click a `.pdf` in Files and it opens in a [PDF.js](https://mozilla.github.io/pdf.js/) viewer instead of "Binary preview unavailable".

The viewer is meant for documents an agent or a build keeps rewriting, such as Typst or LaTeX output. When the file changes, the tab reloads it and keeps your page, zoom, and scroll position, and it shows the old version until the new one has drawn. The tab also remembers where you were when you close and reopen it.

What you can do in the viewer:

- Select and copy text, and follow links. Links inside the document jump within it; web links open in your browser.
- Search the document, with a match count and highlighting.
- Move by page, zoom in and out, fit the width or the whole page, or pinch and Ctrl+scroll to zoom.
- Choose what dragging does: select text, pan the page with the hand tool, or mark an area. An area can be copied to the clipboard as text or as an image rendered at twice the screen's resolution. The tab remembers which tool you used.
- Invert page colors for reading in a dark theme.
- Open password-protected PDFs. The password is kept in memory only, never saved, and reused when the file is rebuilt.

Setup: Paseo 0.13.0 or later on both the app and the daemon. Installing from a Git repository or the registry runs `npm ci` and `node` on the daemon host, so both need to be on its PATH.

Limits:

- Works in the desktop app and in a browser. The iOS and Android apps show a message instead, because Paseo plugins cannot run PDF.js there yet.
- The whole file is read into the app each time it changes, over the relay when the host is remote. Files over 64 MB ask before opening.
- Chinese, Japanese, and Korean text that uses non-embedded fonts needs a matching font installed on the computer you view it on.
- The viewer does not fill in forms, edit annotations, print, or save.

The plugin's server code sends the PDF.js library and its fonts, character maps, and image decoders to the app; nothing is fetched from the internet.
