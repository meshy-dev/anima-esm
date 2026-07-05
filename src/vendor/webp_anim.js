// Pure-JS animated WebP muxer. Assembles a RIFF/VP8X/ANIM/ANMF container from an
// array of single-frame WebP blobs produced by canvas.toBlob('image/webp', q)
// (browser-native VP8 encode -- Chrome/Edge). Each input is a complete WebP file
// (RIFF/WEBP + a VP8 or VP8L bitstream, optionally an ALPH chunk); the muxer
// extracts the bitstream(s) and wraps them as ANMF frame data. No wasm, no fetch
// -- fully self-contained. Spec: developers.google.com/speed/webp/docs/riff_container

// 24-bit little-endian (raw value).
const u24 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];

// Build a RIFF chunk: FourCC(4) + uint32 size(4) + data + 1 pad byte if odd.
// The pad byte is 0 (Uint8Array zero-fills), as RIFF requires.
const chunk = (fcc, data) => {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out[0] = fcc.charCodeAt(0); out[1] = fcc.charCodeAt(1);
  out[2] = fcc.charCodeAt(2); out[3] = fcc.charCodeAt(3);
  out[4] = data.length & 255; out[5] = (data.length >>> 8) & 255;
  out[6] = (data.length >>> 16) & 255; out[7] = (data.length >>> 24) & 255;
  out.set(data, 8);
  return out;
};

// Concatenate Uint8Arrays.
const concat = (arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// Parse a single-frame WebP file -> { alph, bs, bsFcc }.
// Iterates RIFF chunks after the 12-byte RIFF/WEBP header, capturing the alpha
// bitstream (ALPH) and the image bitstream (VP8 lossy or VP8L lossless).
const parseFrame = (webp) => {
  let off = 12, alph = null, bs = null, bsFcc = "";
  while (off + 8 <= webp.length) {
    const fcc = String.fromCharCode(webp[off], webp[off + 1], webp[off + 2], webp[off + 3]);
    const size = webp[off + 4] | (webp[off + 5] << 8) | (webp[off + 6] << 16) | (webp[off + 7] << 24);
    const dataStart = off + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > webp.length) break;
    if (fcc === "ALPH") alph = webp.subarray(dataStart, dataEnd);
    else if (fcc === "VP8 " || fcc === "VP8L") { bs = webp.subarray(dataStart, dataEnd); bsFcc = fcc; }
    off = dataEnd + (size & 1); // skip the pad byte when the chunk size is odd
  }
  if (!bs) throw new Error("webp_anim: frame has no VP8/VP8L bitstream");
  return { alph, bs, bsFcc };
};

// Mux an animated WebP from single-frame WebP blobs.
//   frames    : Uint8Array[] -- each a complete WebP file from toBlob('image/webp')
//   width     : canvas width in pixels (every frame is full-canvas)
//   height    : canvas height in pixels
//   delayMs   : per-frame duration in milliseconds (raw, not 1-based)
//   loopCount : animation loop count (0 = infinite)
// Returns a Uint8Array containing the animated WebP file.
export const muxAnimatedWebP = (frames, width, height, delayMs, loopCount = 0) => {
  const parsed = frames.map(parseFrame);
  const anyAlpha = parsed.some((p) => p.alph != null);
  // VP8X (10 bytes): flags byte + 24-bit reserved 0 + Canvas Width Minus One +
  // Canvas Height Minus One. flags (MSB0): Rsv(2)|I|L|E|X|A|R -> A=bit1=0x02,
  // L (alpha)=bit4=0x10.
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0x00);
  vp8x.set(u24(width - 1), 4);
  vp8x.set(u24(height - 1), 7);
  const vp8xChunk = chunk("VP8X", vp8x);
  // ANIM (6 bytes): Background Color [B,G,R,A] uint32 + Loop Count uint16.
  // Background 0x00000000 (transparent) -- every frame covers the full canvas.
  const anim = new Uint8Array(6);
  anim[4] = loopCount & 255;
  anim[5] = (loopCount >>> 8) & 255;
  const animChunk = chunk("ANIM", anim);
  // ANMF per frame: 16-byte header + Frame Data (ALPH? + VP8/VP8L sub-chunks).
  const anmfChunks = parsed.map((p) => {
    const hdr = new Uint8Array(16);
    hdr.set(u24(0), 0);            // Frame X (raw, 0)
    hdr.set(u24(0), 3);            // Frame Y (raw, 0)
    hdr.set(u24(width - 1), 6);    // Frame Width Minus One (1-based)
    hdr.set(u24(height - 1), 9);   // Frame Height Minus One (1-based)
    hdr.set(u24(delayMs), 12);     // Frame Duration (raw ms)
    hdr[15] = 0;                   // flags: B=0 (alpha blend), D=0 (no dispose)
    const bsChunk = chunk(p.bsFcc, p.bs);
    const frameData = p.alph != null ? concat([chunk("ALPH", p.alph), bsChunk]) : bsChunk;
    return chunk("ANMF", concat([hdr, frameData]));
  });
  // RIFF file: "RIFF" + uint32 file size + "WEBP" + body.
  // File size = total - 8 = 4 (WEBP) + body.length.
  const body = concat([vp8xChunk, animChunk, ...anmfChunks]);
  const riff = new Uint8Array(12 + body.length);
  riff[0] = 82; riff[1] = 73; riff[2] = 70; riff[3] = 70;   // "RIFF"
  const fileSize = 4 + body.length;
  riff[4] = fileSize & 255; riff[5] = (fileSize >>> 8) & 255;
  riff[6] = (fileSize >>> 16) & 255; riff[7] = (fileSize >>> 24) & 255;
  riff[8] = 87; riff[9] = 69; riff[10] = 66; riff[11] = 80; // "WEBP"
  riff.set(body, 12);
  return riff;
};
