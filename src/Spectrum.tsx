// Live spectrum: real-time bar analyzer tuned for electronic music
// (PRODUCT.md Pillar 2) — log-frequency binning so kick/bass gets
// visual weight, dB scaling with a range that makes drops hit,
// peak-hold caps for percussive afterglow, 60fps canvas.

import { useEffect, useRef } from "react";

const BAR_COUNT = 48;
const DB_FLOOR = -72; // dynamic range floor; lower = busier quiet parts
const DB_CEIL = -8;
const FREQ_MIN = 30; // Hz — below this is rumble, not rhythm
const FREQ_MAX = 16000;
const PEAK_FALL = 0.55; // px/frame the peak cap falls
const SPECTRUM_COLOR = "#a78bfa"; // purple: the spectrum's accent (PRODUCT.md)
const PEAK_COLOR = "#f472b6"; // pink flair on the caps

export function Spectrum({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const ctx2d = canvas.getContext("2d")!;
    const data = new Float32Array(analyser.frequencyBinCount);
    const sampleRate = analyser.context.sampleRate;
    const binHz = sampleRate / analyser.fftSize;

    // Precompute log-spaced FFT bin ranges per bar.
    const edges: number[] = [];
    for (let i = 0; i <= BAR_COUNT; i++) {
      const f = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, i / BAR_COUNT);
      edges.push(Math.min(Math.round(f / binHz), data.length - 1));
    }

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getFloatFrequencyData(data);
      const { width, height } = canvas;
      ctx2d.clearRect(0, 0, width, height);
      const barW = width / BAR_COUNT;
      const peaks = peaksRef.current;

      for (let i = 0; i < BAR_COUNT; i++) {
        // Max within the bar's bin range: percussive hits stay sharp
        // where averaging would smear them.
        let db = -Infinity;
        for (let b = edges[i]; b <= Math.max(edges[i], edges[i + 1] - 1); b++) {
          if (data[b] > db) db = data[b];
        }
        const norm = Math.max(0, Math.min(1, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
        const h = norm * height;

        ctx2d.fillStyle = SPECTRUM_COLOR;
        ctx2d.globalAlpha = 0.35 + norm * 0.65;
        ctx2d.fillRect(i * barW + 1, height - h, barW - 2, h);
        ctx2d.globalAlpha = 1;

        // Peak-hold cap with gravity.
        peaks[i] = Math.max(h, peaks[i] - PEAK_FALL);
        if (peaks[i] > 1) {
          ctx2d.fillStyle = PEAK_COLOR;
          ctx2d.fillRect(i * barW + 1, height - peaks[i] - 2, barW - 2, 2);
        }
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} width={900} height={120} className="spectrum" />;
}
