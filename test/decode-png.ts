import { inflateSync } from "node:zlib";

/** Decodes the 8-bit RGB PNGs `encodePng` writes, checking every chunk's CRC. */
export function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const buffer = Buffer.from(png);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("No PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const crc = buffer.readUInt32BE(offset + 8 + length);
    if (crc !== crc32(buffer.subarray(offset + 4, offset + 8 + length)))
      throw new Error(`Bad CRC in ${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2) throw new Error("Not 8-bit RGB");
    } else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const up = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      if (filter === 0) rgb[y * stride + x] = value;
      else if (filter === 2) rgb[y * stride + x] = (value + up) & 0xff;
      else throw new Error(`Unexpected filter ${filter}`);
    }
  }
  return { width, height, rgb };
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function pixel(image: { width: number; rgb: Uint8Array }, x: number, y: number): number[] {
  const at = (y * image.width + x) * 3;
  return [image.rgb[at], image.rgb[at + 1], image.rgb[at + 2]];
}
