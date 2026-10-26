import { promisify } from "node:util";
import { deflate as deflateCallback } from "node:zlib";

const deflate = promisify(deflateCallback);

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start = 0xffffffff): number {
  let c = start;
  for (let index = 0; index < bytes.length; index += 1) {
    c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  const crc = crc32(data, crc32(out.subarray(4, 8))) ^ 0xffffffff;
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

/**
 * Encodes an opaque RGBA bitmap as an 8-bit RGB PNG. Alpha is dropped: PDFium fills the page white
 * before drawing. `invert` flips the colors for dark themes, as the web viewer's CSS filter does.
 * Each row uses the Up filter, which suits pages that are mostly flat color and text. Compression
 * runs on Node's thread pool, off the plugin's thread.
 */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  { invert = false }: { invert?: boolean } = {},
): Promise<Buffer> {
  if (rgba.length < width * height * 4) throw new Error("The bitmap is smaller than its size.");
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    let source = y * width * 4;
    for (let x = 0; x < stride; x += 3, source += 4) {
      current[x] = invert ? 255 - rgba[source] : rgba[source];
      current[x + 1] = invert ? 255 - rgba[source + 1] : rgba[source + 1];
      current[x + 2] = invert ? 255 - rgba[source + 2] : rgba[source + 2];
    }
    const row = y * (stride + 1);
    raw[row] = 2; // Up
    for (let x = 0; x < stride; x += 1) raw[row + 1 + x] = (current[x] - previous[x]) & 0xff;
    [previous, current] = [current, previous];
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
