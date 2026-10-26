import { createHash } from "node:crypto";

/**
 * Builds a small PDF for tests: one page per size, each with its page number and a black square in
 * the top-left corner, so a render can be checked by its pixels. With `password`, the file is
 * encrypted with the standard security handler, revision 2 (40-bit RC4), which needs that password
 * to open.
 */
export function makePdf(
  sizes: { width: number; height: number }[],
  { password }: { password?: string } = {},
): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const pageIds = sizes.map((_, index) => 4 + index * 2);
  const security = password === undefined ? null : standardSecurity(password);

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
    const id = pageIds[index] + 1;
    const data = security ? security.encrypt(id, content) : content;
    add(`<< /Length ${data.length} >>\nstream\n${data}\nendstream`);
  });
  if (security) add(security.dictionary);

  // Built as latin1, so each character is one byte and string offsets are byte offsets.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const encryption = security
    ? ` /Encrypt ${objects.length} 0 R /ID [<${security.id}> <${security.id}>]`
    : "";
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

// PDF 1.7 (ISO 32000-1) section 7.6.3, algorithms 1 to 4, for revision 2.
const PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);
const PERMISSIONS = -4;

function standardSecurity(password: string) {
  const id = "0123456789abcdef0123456789abcdef";
  const user = padded(password);
  const owner = rc4(md5(padded(`${password}-owner`)).subarray(0, 5), user);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(PERMISSIONS);
  const key = md5(user, owner, permissions, Buffer.from(id, "hex")).subarray(0, 5);
  const check = rc4(key, PADDING);
  return {
    id,
    dictionary:
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${PERMISSIONS} ` +
      `/O <${owner.toString("hex")}> /U <${check.toString("hex")}> >>`,
    /** Encrypts a stream of object `id`, generation 0, as a latin1 string. */
    encrypt(objectId: number, data: string): string {
      const objectKey = md5(key, Buffer.from([objectId & 0xff, (objectId >> 8) & 0xff, 0, 0, 0]));
      return rc4(objectKey.subarray(0, 10), Buffer.from(data, "latin1")).toString("latin1");
    },
  };
}

function padded(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, "latin1"), PADDING]).subarray(0, 32);
}

function md5(...parts: Buffer[]): Buffer {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}
