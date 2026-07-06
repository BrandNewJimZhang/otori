// Playback engine behind an interface (ADR-0001 §5): the MVP engine is
// the WebView <audio> element + Web Audio AnalyserNode. If WKWebView's
// format ceiling (FLAC) or gapless playback forces a native engine
// (symphonia + cpal), only this file changes — UI code never touches
// the engine directly.

import { convertFileSrc } from "@tauri-apps/api/core";

export interface PlaybackEngine {
  /** Start playing a local file; resolves when playback begins. */
  play(path: string): Promise<void>;
  togglePause(): void;
  readonly paused: boolean;
  /** Current playback position in milliseconds. */
  readonly positionMs: number;
  /** Analyser for visualizers; null until first play(). */
  readonly analyser: AnalyserNode | null;
  onEnded(cb: () => void): void;
  onError(cb: (message: string) => void): void;
}

class AudioElementEngine implements PlaybackEngine {
  private audio = new Audio();
  private ctx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private endedCb: (() => void) | null = null;
  private errorCb: ((message: string) => void) | null = null;

  constructor() {
    this.audio.addEventListener("ended", () => this.endedCb?.());
    this.audio.addEventListener("error", () => {
      const err = this.audio.error;
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4) is the WKWebView format ceiling.
      const message =
        err?.code === 4
          ? "Format not supported by the WebView engine"
          : `Playback error (code ${err?.code ?? "?"})`;
      this.errorCb?.(message);
    });
  }

  async play(path: string): Promise<void> {
    // AudioContext must be created after a user gesture; first play() is one.
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaElementSource(this.audio);
      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 4096; // ~10.8Hz/bin at 44.1kHz — enough lows for log binning
      this.analyserNode.smoothingTimeConstant = 0.75;
      source.connect(this.analyserNode);
      this.analyserNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.audio.src = convertFileSrc(path);
    await this.audio.play();
  }

  togglePause(): void {
    if (this.audio.paused) void this.audio.play();
    else this.audio.pause();
  }

  get paused(): boolean {
    return this.audio.paused;
  }

  get positionMs(): number {
    return this.audio.currentTime * 1000;
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onError(cb: (message: string) => void): void {
    this.errorCb = cb;
  }
}

export function createEngine(): PlaybackEngine {
  return new AudioElementEngine();
}
