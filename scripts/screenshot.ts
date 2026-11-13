/**
 * Saves what the bar's front screen shows as a PNG of its LED matrix, for the README's images.
 *
 *   node scripts/screenshot.ts docs/claude.png [host]
 */
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const COLUMNS = 72;
const ROWS = 16;
/** Image pixels per LED, and the lit square inside it. */
const CELL = 12;
const LED = 10;
const LED_RADIUS = 2;
const MARGIN = 30;
const PANEL_RADIUS = 22;
const PANEL = [17, 17, 17];
const UNLIT = [36, 36, 36];
/** Samples per axis for antialiased edges. */
const SAMPLES = 4;

const [out, host = "10.0.4.20"] = process.argv.slice(2);
if (!out) {
  console.error("usage: node scripts/screenshot.ts <out.png> [host]");
  process.exit(2);
}

const response = await fetch(`http://${host}/api/screen?display=0`, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`GET /api/screen: HTTP ${response.status}`);
// Base64 of the screen's pixels, 3 bytes each in BGR order.
const screen = Buffer.from(await response.text(), "base64");
if (screen.length !== COLUMNS * ROWS * 3) throw new Error(`expected ${COLUMNS * ROWS * 3} bytes, got ${screen.length}`);

/** Whether a point lies inside a rounded rectangle. */
function inside(x: number, y: number, left: number, top: number, width: number, height: number, radius: number): boolean {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/** The share of an image pixel a rounded rectangle covers. */
function coverage(px: number, py: number, left: number, top: number, width: number, height: number, radius: number): number {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      if (inside(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES, left, top, width, height, radius)) hits++;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

const width = COLUMNS * CELL + 2 * MARGIN;
const height = ROWS * CELL + 2 * MARGIN;
const rgba = Buffer.alloc(width * height * 4);
const inset = (CELL - LED) / 2;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const panel = coverage(x, y, 0, 0, width, height, PANEL_RADIUS);
    if (panel === 0) continue;
    const column = Math.floor((x - MARGIN) / CELL);
    const row = Math.floor((y - MARGIN) / CELL);
    let color = PANEL;
    if (column >= 0 && column < COLUMNS && row >= 0 && row < ROWS) {
      const offset = (row * COLUMNS + column) * 3;
      const [b, g, r] = screen.subarray(offset, offset + 3);
      const led = r + g + b > 0 ? [r, g, b] : UNLIT;
      const share = coverage(x, y, MARGIN + column * CELL + inset, MARGIN + row * CELL + inset, LED, LED, LED_RADIUS);
      color = PANEL.map((channel, i) => Math.round(channel + (led[i] - channel) * share));
    }
    rgba.set([...color, Math.round(panel * 255)], (y * width + x) * 4);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8; // bits per channel
header[9] = 6; // RGBA
const scanlines = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
