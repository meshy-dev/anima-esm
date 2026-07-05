// Type declaration for the vendored pure-JS animated WebP muxer.
// Muxes an array of single-frame WebP blobs (from canvas.toBlob('image/webp'))
// into one animated WebP (RIFF/VP8X/ANIM/ANMF container).

export declare function muxAnimatedWebP(
  frames: Uint8Array[],
  width: number,
  height: number,
  delayMs: number,
  loopCount?: number,
): Uint8Array<ArrayBuffer>;
