// Live spectrum: real-time bar analyzer tuned for electronic music
// (PRODUCT.md Pillar 2) — log-frequency binning so kick/bass gets
// visual weight, dB scaling with a range that makes drops hit,
// peak-hold caps for percussive afterglow, 60fps canvas. Paused
// audio decays to silence; once the bars and caps settle the loop
// stops scheduling frames (vizidle) instead of drawing a static
// image at 60fps.

import { useEffect, useRef } from "react";
import { shouldKeepDrawing } from "./vizidle";

const BAR_COUNT = 48;
const DB_FLOOR = -72; // dynamic range floor; lower = busier quiet parts
const DB_CEIL = -8;
const FREQ_MIN = 30; // Hz — below this is rumble, not rhythm
const FREQ_MAX = 16000;
const PEAK_FALL = 0.55; // px/frame (in CSS px) the peak cap falls

export function Spectrum({
  analyser,
  paused = false,
  mirror = false,
}: {
  analyser: AnalyserNode | null;
  /** Playback state: paused + settled visuals stop the frame loop. */
  paused?: boolean;
  /** Stage mode: mirrored floor-reflection below the bars. */
  mirror?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  // Read inside the frame loop without re-running the canvas effect.
  const pausedRef = useRef(paused);
  // Resume hook: the paused-flip effect restarts a stopped loop.
  const drawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const ctx2d = canvas.getContext("2d")!;
    const data = new Float32Array(analyser.frequencyBinCount);
    const sampleRate = analyser.context.sampleRate;
    const binHz = sampleRate / analyser.fftSize;

    // Accent colors come from the theme tokens (audit P2: hardcoded
    // dark-palette hex was invisible on light) — SSOT is App.css.
    // Re-read when data-theme flips.
    let barColor = "";
    let peakColor = "";
    const readColors = () => {
      const style = getComputedStyle(canvas);
      barColor = style.getPropertyValue("--spectrum").trim();
      peakColor = style.getPropertyValue("--lyrics").trim();
    };
    readColors();
    const themeObserver = new MutationObserver(readColors);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    // Backing store tracks CSS size × devicePixelRatio so bars stay
    // crisp on Retina and undistorted at any layout width. dpr is
    // re-read per resize: the window can move between displays
    // (audit P2: a mount-time dpr went blurry after a monitor hop).
    let dpr = window.devicePixelRatio || 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // Precompute log-spaced FFT bin ranges per bar.
    const edges: number[] = [];
    for (let i = 0; i <= BAR_COUNT; i++) {
      const f = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, i / BAR_COUNT);
      edges.push(Math.min(Math.round(f / binHz), data.length - 1));
    }

    let raf = 0;
    const draw = () => {
      analyser.getFloatFrequencyData(data);
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      ctx2d.clearRect(0, 0, width, height);
      const barW = width / BAR_COUNT;
      const peaks = peaksRef.current;
      // Mirror mode: bars grow from a floor line, reflection below it.
      const floor = mirror ? height * 0.72 : height;
      // Residual motion: tallest bar or cap still visibly up.
      let motion = 0;

      for (let i = 0; i < BAR_COUNT; i++) {
        // Max within the bar's bin range: percussive hits stay sharp
        // where averaging would smear them.
        let db = -Infinity;
        for (let b = edges[i]; b <= Math.max(edges[i], edges[i + 1] - 1); b++) {
          if (data[b] > db) db = data[b];
        }
        const norm = Math.max(0, Math.min(1, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
        const h = norm * floor;

        ctx2d.fillStyle = barColor;
        ctx2d.globalAlpha = 0.35 + norm * 0.65;
        ctx2d.fillRect(i * barW + 1, floor - h, barW - 2, h);

        if (mirror) {
          // Floor reflection: dim, vertically squashed.
          ctx2d.globalAlpha = (0.35 + norm * 0.65) * 0.25;
          ctx2d.fillRect(i * barW + 1, floor, barW - 2, h * 0.35);
        }
        ctx2d.globalAlpha = 1;

        // Peak-hold cap with gravity.
        peaks[i] = Math.max(h, peaks[i] - PEAK_FALL);
        if (peaks[i] > 1) {
          ctx2d.fillStyle = peakColor;
          ctx2d.fillRect(i * barW + 1, floor - peaks[i] - 2, barW - 2, 2);
        }
        motion = Math.max(motion, h, peaks[i]);
      }

      // Schedule the next frame only while there's something to move;
      // the paused-flip effect below restarts the loop on resume.
      if (shouldKeepDrawing(pausedRef.current, motion)) {
        raf = requestAnimationFrame(draw);
      } else {
        raf = 0;
      }
    };
    drawRef.current = () => {
      if (raf === 0) draw(); // guard: never stack a second loop
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      drawRef.current = null;
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [analyser, mirror]);

  // Track paused without restarting the whole loop; when playback
  // resumes and the loop had stopped, kick a fresh frame.
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) drawRef.current?.();
  }, [paused]);

  return <canvas ref={canvasRef} className="spectrum" />;
}
