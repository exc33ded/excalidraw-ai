// Live smoke test: generate a simple flowchart PNG, send it to the real
// vision model, and run the result through validateSkeleton. Reads bridge/.env.
import { deflateSync } from "node:zlib";
import { callVisionModel } from "./vision.mjs";
import { validateSkeleton } from "./diagram-contract.mjs";

try { process.loadEnvFile?.(new URL("./.env", import.meta.url)); } catch (e) {}

// --- minimal PNG encoder (no dependencies) ---
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = pixels[i]; raw[o + 1] = pixels[i + 1]; raw[o + 2] = pixels[i + 2];
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function makeDiagramPng() {
  const w = 400, h = 260;
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = 255; px[i * 3 + 1] = 255; px[i * 3 + 2] = 255; }
  function fill(x0, y0, x1, y1, r, g, b) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
  }
  fill(40, 90, 150, 160, 30, 30, 30);    // left box
  fill(250, 90, 360, 160, 30, 30, 30);   // right box
  fill(145, 25, 255, 85, 30, 30, 30);    // top box
  fill(150, 120, 255, 130, 10, 10, 10);  // arrow left->right
  fill(250, 110, 255, 140, 10, 10, 10);  // arrowhead
  fill(195, 85, 205, 120, 10, 10, 10);   // arrow top->left
  return makePng(w, h, px);
}

const dataUrl = "data:image/png;base64," + makeDiagramPng().toString("base64");
const config = { baseUrl: process.env.AI_API_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_API_MODEL };

try {
  const raw = await callVisionModel({ image: dataUrl, prompt: "Convert this rough diagram into clean Excalidraw elements.", config });
  console.log("RAW:", JSON.stringify(raw).slice(0, 500));
  const result = validateSkeleton(raw && raw.elements);
  console.log("VALID:", result.ok);
  if (result.ok) console.log("ELEMENTS:", JSON.stringify(result.elements, null, 2));
  else console.log("ERROR:", result.error);
} catch (e) {
  console.log("CALL-FAILED:", (e && e.message ? e.message : String(e)).slice(0, 800));
}
