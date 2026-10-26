Read PDFs inside Paseo's file tab. Click a `.pdf` in Files and it opens in a [PDF.js](https://mozilla.github.io/pdf.js/) viewer instead of "Binary preview unavailable".

The viewer is meant for documents an agent or a build keeps rewriting, such as Typst or LaTeX output. When the file changes, the tab reloads it and keeps your page, zoom, and scroll position, and it shows the old version until the new one has drawn. The tab also remembers where you were when you close and reopen it.

To open a PDF at a page from chat, link it with a line fragment, such as `[the results](report.pdf#L5)` for page 5. Paseo passes the line to the viewer, which reads it as the page; a link to an open tab jumps to the page.

What you can do in the viewer:

- Select and copy text, and follow links. Links inside the document jump within it; web links open in your browser.
- Search the document, with a match count and highlighting.
- Move by page, choose a zoom level from the zoom menu (automatic, actual size, fit page, fit width, or 50% to 400%), or pinch and Ctrl+scroll to zoom.
- Turn pages with the Left and Right arrow keys when the whole page width is visible, as in Okular. Zoomed in further, they scroll sideways. The current page, shown in the page box, is the page you last jumped to until you scroll, and otherwise the page nearest the middle of the view, also as in Okular.
- Turn off continuous mode to see one page at a time, as in Okular. Scrolling or pressing Down, Page Down, or Space past the bottom of a page shows the top of the next one; scrolling up past the top shows the bottom of the previous one. The tab remembers the setting.
- Choose what dragging does: select text, pan the page with the hand tool, or mark an area. An area can be copied to the clipboard as text or as an image rendered at twice the screen's resolution. The tab remembers which tool you used.
- Invert page colors for reading in a dark theme.
- Open password-protected PDFs. The password is kept in memory only, never saved, and reused when the file is rebuilt.

On iPhone and iPad, Paseo plugins cannot run PDF.js, so the daemon renders pages with PDFium and the tab shows them as images. Scroll through the pages, pinch to zoom up to 4x (pages re-render sharper as you zoom), step by page from the toolbar, and invert page colors. A rebuild re-renders the pages near you and keeps your place on the page, and each page shows its previous version until the new one has loaded. The tab remembers your page. Text selection, search, and links are desktop and web only.

Setup: Paseo 0.13.0 or later on both the app and the daemon. Installing from a Git repository or the registry runs `npm ci` and `node` on the daemon host, so both need to be on its PATH.

Limits:

- Works in the desktop app, in a browser, and on iOS. The Android app shows a message instead.
- On desktop and web, the whole file is read into the app each time it changes, over the relay when the host is remote. Files over 64 MB ask before opening. On iOS only the rendered pages near the view are sent, as PNG images.
- Chinese, Japanese, and Korean text that uses non-embedded fonts needs a matching font installed on the computer you view it on.
- The viewer does not fill in forms, edit annotations, print, or save.

The plugin's server code sends the PDF.js library and its fonts, character maps, and image decoders to the app, and on iOS renders pages with a PDFium build bundled in the plugin; nothing is fetched from the internet. To render for iOS, the server code reads `.pdf` files the app opens, by their path on the daemon host.
