// Loose type declarations for the vendored mediabunny WebM muxer (ESM build of
// Vanilagy/media). The .js is bundled verbatim by esbuild; these types let the
// library type-check without pulling the muxer's own (large) type graph.

export declare const QUALITY_HIGH: number;

export class WebMOutputFormat {}

export class BufferTarget {
  buffer: ArrayBuffer | null;
}

export class CanvasSource {
  constructor(
    canvas: HTMLCanvasElement,
    opts?: { codec?: string; bitrate?: number; keyFrameInterval?: number },
  );
  add(t: number, dt: number): Promise<void>;
  close(): void;
}

export class Output {
  constructor(opts: { format: WebMOutputFormat; target: BufferTarget });
  addVideoTrack(source: CanvasSource, opts?: { frameRate?: number }): void;
  start(): Promise<void>;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
  readonly target: BufferTarget;
}
