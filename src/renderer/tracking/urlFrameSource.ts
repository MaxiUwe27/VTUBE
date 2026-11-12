// Turns raw BGRA frames from the main process (offscreen "Browserquelle" page, see src/main/urlSource.ts)
// into a live MediaStream video track, so FaceTracker's normal video pipeline (frame callbacks,
// ImageBitmap → worker, preview <video>) works unchanged.
//
// Preferred: WebCodecs VideoFrame (BGRX, no pixel swizzling in JS) written into a
// MediaStreamTrackGenerator. Fallback: draw the VideoFrame onto a canvas and use canvas.captureStream().

interface TrackGenerator extends MediaStreamTrack { readonly writable: WritableStream<VideoFrame> }
type TrackGeneratorCtor = new (init: { kind: 'video' }) => TrackGenerator;

export class UrlFrameSource {
  readonly stream: MediaStream;
  private gen: TrackGenerator | null = null;
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private pending = 0;
  private closed = false;

  constructor(fps: number) {
    const Gen = (globalThis as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;
    if (Gen && typeof VideoFrame === 'function') {
      this.gen = new Gen({ kind: 'video' });
      this.writer = this.gen.writable.getWriter();
      this.stream = new MediaStream([this.gen]);
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 640;
      this.canvas.height = 480;
      this.ctx2d = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.stream = this.canvas.captureStream(Math.max(1, fps));
    }
  }

  /** Implementation in use (diagnostics). */
  get kind(): 'generator' | 'canvas' { return this.gen ? 'generator' : 'canvas'; }

  /** `data` = BGRA (alpha ignored), top-down, width*height*4 bytes. Drops the frame if the track is behind. */
  push(data: Uint8Array, width: number, height: number): void {
    if (this.closed || width <= 0 || height <= 0 || data.byteLength < width * height * 4) return;
    if (this.writer) {
      if (this.pending >= 2) return;
      let frame: VideoFrame;
      try {
        frame = new VideoFrame(data, {
          format: 'BGRX', codedWidth: width, codedHeight: height, timestamp: Math.round(performance.now() * 1000),
        });
      } catch (e) {
        console.warn('[UrlFrameSource] VideoFrame failed', e);
        return;
      }
      this.pending++;
      // The generator takes ownership of the frame and closes it.
      this.writer.write(frame).catch(() => { try { frame.close(); } catch { /* ignore */ } })
        .finally(() => { this.pending--; });
      return;
    }
    const c = this.canvas!, g = this.ctx2d;
    if (!g) return;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    if (typeof VideoFrame === 'function') {
      const frame = new VideoFrame(data, { format: 'BGRX', codedWidth: width, codedHeight: height, timestamp: 0 });
      try { g.drawImage(frame, 0, 0); } finally { frame.close(); }
    } else {
      // No WebCodecs: swap B/R by hand.
      const img = g.createImageData(width, height), out = img.data;
      for (let i = 0; i < out.length; i += 4) {
        out[i] = data[i + 2]; out[i + 1] = data[i + 1]; out[i + 2] = data[i]; out[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.stream.getTracks()) t.stop();
    if (this.writer) {
      this.writer.close().catch(() => undefined);
      this.writer = null;
    }
    this.gen = null;
    this.canvas = null;
    this.ctx2d = null;
  }
}
