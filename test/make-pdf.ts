/**
 * Builds a small PDF for tests: one page per size, each with its page number and a black square in
 * the top-left corner, so a render can be checked by its pixels.
 */
export function makePdf(sizes: { width: number; height: number }[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const pageIds = sizes.map((_, index) => 4 + index * 2);

  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${sizes.length} >>`,
  );
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  sizes.forEach(({ width, height }, index) => {
    const content =
      `0 0 0 rg 0 ${height - 100} 100 100 re f ` +
      `BT /F1 24 Tf 150 ${height - 80} Td (Page ${index + 1}) Tj ET`;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
    );
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
