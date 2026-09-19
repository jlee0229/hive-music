/**
 * Generates the PWA icons as plain PNGs (no image deps): the stage-dark background with an
 * ivory hexagon-ring + dot, echoing the landing page's logo mark. Placeholder art — swap for
 * real brand assets when the team has them; F9 only needs the manifest to resolve real files.
 * Run: `bun run apps/web/scripts/gen-icons.ts`
 */
import zlib from "node:zlib";

const STAGE = [0x0b, 0x0f, 0x14] as const;
const IVORY = [0xf1, 0xf5, 0xf9] as const;

function hexAt(px: number, py: number, cx: number, cy: number, r: number): boolean {
  // point-in-regular-hexagon test (flat-top), via 6 half-plane checks
  const dx = Math.abs(px - cx) / r;
  const dy = Math.abs(py - cy) / r;
  return dx <= Math.sqrt(3) / 2 && dy <= 1 && Math.sqrt(3) * dx + dy <= Math.sqrt(3);
}

function drawIcon(size: number): Buffer {
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.34;
  const ringWidth = Math.max(2, size * 0.045);
  const dotR = size * 0.12;
  const rowBytes = size * 4 + 1; // filter byte + RGBA
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const outer = hexAt(x, y, cx, cy, outerR);
      const inner = hexAt(x, y, cx, cy, outerR - ringWidth);
      const dot = Math.hypot(x - cx, y - cy) <= dotR;
      const ivory = (outer && !inner) || dot;
      const off = y * rowBytes + 1 + x * 4;
      const [r, g, b] = ivory ? IVORY : STAGE;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = 255;
    }
  }

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData), 0);
    return Buffer.concat([len, typeData, crc]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// minimal CRC32 (PNG spec table-free implementation)
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const outDir = `${import.meta.dir}/../public`;
for (const size of [192, 512]) {
  await Bun.write(`${outDir}/icon-${size}.png`, drawIcon(size));
  console.log(`wrote icon-${size}.png`);
}
await Bun.write(`${outDir}/apple-touch-icon.png`, drawIcon(180));
console.log("wrote apple-touch-icon.png");
