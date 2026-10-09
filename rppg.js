/*
 * rppg.js — browser port of the rPPG pipeline in rPPG-1.0.0 (Python).
 *
 *   Python module                         ->  here
 *   ------------------------------------------------------------------
 *   RoiProcessorPatches.detect_ROI        ->  RppgEngine.addFrame()  (patch means)
 *   Processors (GREEN / POS)              ->  greenSignal() / posSignal()
 *   HrExtractorFrequency (Welch PSD)      ->  _spectrum()  (Hann-windowed PSD)
 *   Rppg.run (median across ROIs)         ->  RppgEngine.analyze()
 *
 * Differences from the Python code, all on purpose:
 *   - Browser frames arrive at an irregular rate, so samples are time-stamped
 *     and linearly resampled to a uniform `fs` before any spectral work.
 *   - Patch size scales with face width instead of a fixed 20 px.
 *   - POS is implemented (the README recommends it; the Python code never did).
 *     The Python "CHROM" is a ratio of 45-frame window means, which acts as a
 *     comb filter with nulls near 40/80/120 BPM, so it is not ported.
 *   - A patch only votes if its spectrum has a clear peak (`minConcentration`).
 */
(function (root) {
  'use strict';

  // ---- Patch landmarks (RoiProcessorPatches.get_patch_landmark_indices) ----
  const FOREHEAD_CENTER = [10, 151, 9, 8, 107, 336, 285, 55, 8];
  const CHEEK_LEFT_BOTTOM = [215, 138, 135, 210, 212, 57, 216, 207, 192];
  const CHEEK_RIGHT_BOTTOM = [435, 427, 416, 364, 394, 422, 287, 410, 434, 436];
  const FOREHEAD_RIGHT = [338, 337, 336, 296, 285, 295, 282, 334, 293, 301, 251, 298, 333, 299, 297, 332, 284];
  const FOREHEAD_LEFT = [21, 71, 68, 54, 103, 104, 63, 70, 53, 52, 65, 107, 66, 108, 69, 67, 109, 105];
  const CHEEK_LEFT_TOP = [116, 111, 117, 118, 119, 100, 47, 126, 101, 123, 137, 177, 50, 36, 209, 129, 205, 147, 177, 215, 187, 207, 206, 203];
  const CHEEK_RIGHT_TOP = [349, 348, 347, 346, 345, 447, 323, 280, 352, 330, 371, 358, 423, 426, 425, 427, 411, 376];

  const PATCH_LANDMARKS = Array.from(new Set([].concat(
    FOREHEAD_CENTER, CHEEK_LEFT_BOTTOM, CHEEK_RIGHT_BOTTOM,
    FOREHEAD_RIGHT, FOREHEAD_LEFT, CHEEK_LEFT_TOP, CHEEK_RIGHT_TOP
  )));

  const DEFAULTS = {
    fs: 30,                 // uniform resampling rate (Hz)
    windowSeconds: 10,      // analysis window
    updateEveryMs: 1000,    // how often the UI should call analyze()
    minHz: 0.65,            // 39 BPM   (same as HrExtractor)
    maxHz: 4.0,             // 240 BPM  (same as HrExtractor)
    processor: 'POS',       // 'POS' | 'GREEN'
    posWindowSeconds: 1.6,  // POS sliding window (Wang et al. 2017)
    patchScale: 0.07,       // patch edge = this * face width (px)
    minPatchPx: 8,
    maxGapMs: 1000,         // a longer hole in the data restarts the buffer
    minFps: 10,             // below this the signal is not trustworthy
    agreeBpm: 5,            // patches within this of the median "agree"
    minConcentration: 0.2,  // fraction of band power around a patch's peak
    freqStepHz: 0.01
  };

  // ------------------------------------------------------------------ DSP --

  function median(arr) {
    if (!arr.length) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function removeMean(x) {
    let m = 0;
    for (let i = 0; i < x.length; i++) m += x[i];
    m /= x.length;
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] - m;
    return y;
  }

  // 1st-order RC filters, run forward then backward (zero phase).
  function lowpass1(x, fc, fs) {
    const dt = 1 / fs, rc = 1 / (2 * Math.PI * fc), a = dt / (rc + dt);
    const y = new Float64Array(x.length);
    y[0] = x[0];
    for (let i = 1; i < x.length; i++) y[i] = y[i - 1] + a * (x[i] - y[i - 1]);
    return y;
  }
  function highpass1(x, fc, fs) {
    const dt = 1 / fs, rc = 1 / (2 * Math.PI * fc), a = rc / (rc + dt);
    const y = new Float64Array(x.length);
    y[0] = 0;
    for (let i = 1; i < x.length; i++) y[i] = a * (y[i - 1] + x[i] - x[i - 1]);
    return y;
  }
  function zeroPhase(fn, x, fc, fs) {
    const fwd = fn(x, fc, fs);
    fwd.reverse();
    const bwd = fn(fwd, fc, fs);
    bwd.reverse();
    return bwd;
  }
  function bandpass(x, fs, lo, hi) {
    let y = removeMean(x);
    y = zeroPhase(lowpass1, y, hi, fs);
    y = zeroPhase(highpass1, y, lo, fs);
    return removeMean(y);
  }

  // GreenProcessor: the green channel is the BVP.
  function greenSignal(R, G, B) { return Float64Array.from(G); }

  // POS (Plane-Orthogonal-to-Skin), overlap-added over sliding windows.
  function posSignal(R, G, B, l) {
    const N = R.length;
    const H = new Float64Array(N);
    const s1 = new Float64Array(l), s2 = new Float64Array(l);
    for (let n = l - 1; n < N; n++) {
      const s = n - l + 1;
      let mr = 0, mg = 0, mb = 0;
      for (let i = s; i <= n; i++) { mr += R[i]; mg += G[i]; mb += B[i]; }
      mr /= l; mg /= l; mb /= l;
      if (!(mr > 0 && mg > 0 && mb > 0)) continue;
      let m1 = 0, m2 = 0;
      for (let k = 0; k < l; k++) {
        const rn = R[s + k] / mr, gn = G[s + k] / mg, bn = B[s + k] / mb;
        s1[k] = gn - bn;               // [0, 1, -1]
        s2[k] = -2 * rn + gn + bn;     // [-2, 1, 1]
        m1 += s1[k]; m2 += s2[k];
      }
      m1 /= l; m2 /= l;
      let v1 = 0, v2 = 0;
      for (let k = 0; k < l; k++) {
        v1 += (s1[k] - m1) * (s1[k] - m1);
        v2 += (s2[k] - m2) * (s2[k] - m2);
      }
      const sd1 = Math.sqrt(v1 / l), sd2 = Math.sqrt(v2 / l);
      const alpha = sd2 > 1e-12 ? sd1 / sd2 : 0;
      let mh = 0;
      for (let k = 0; k < l; k++) { s1[k] = s1[k] + alpha * s2[k]; mh += s1[k]; }
      mh /= l;
      for (let k = 0; k < l; k++) H[s + k] += s1[k] - mh;
    }
    return H;
  }

  // ---------------------------------------------------------------- Engine --

  class RppgEngine {
    constructor(opts) {
      this.cfg = Object.assign({}, DEFAULTS, opts || {});
      this._buildTables();
      this.reset();
    }

    reset() {
      this.samples = [];       // {t, rgb:Float32Array(P*3), mean:[r,g,b]}
      this.motionHist = [];
      this.lastNose = null;
      this.brightness = NaN;
    }

    _buildTables() {
      const c = this.cfg;
      this.N = Math.round(c.fs * c.windowSeconds);
      this.posLen = Math.max(8, Math.round(c.fs * c.posWindowSeconds));
      this.hann = new Float64Array(this.N);
      for (let n = 0; n < this.N; n++) this.hann[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (this.N - 1));
      this.freqs = [];
      for (let f = c.minHz; f <= c.maxHz + 1e-9; f += c.freqStepHz) this.freqs.push(f);
      const J = this.freqs.length;
      this.cosT = new Float32Array(J * this.N);
      this.sinT = new Float32Array(J * this.N);
      for (let j = 0; j < J; j++) {
        for (let n = 0; n < this.N; n++) {
          const ang = 2 * Math.PI * this.freqs[j] * n / c.fs;
          this.cosT[j * this.N + n] = Math.cos(ang);
          this.sinT[j * this.N + n] = Math.sin(ang);
        }
      }
      this.concHalfBins = Math.round(0.1 / c.freqStepHz); // +-0.1 Hz around the peak
    }

    /**
     * Take one video frame's worth of patch means.
     * @param landmarks  MediaPipe FaceMesh landmarks (normalised 0..1)
     * @param img        {data:Uint8ClampedArray RGBA, ...} for the SAME frame
     * @returns true if the buffer was restarted (face lost for too long)
     */
    addFrame(landmarks, img, w, h, tMs) {
      const c = this.cfg;
      let restarted = false;
      const last = this.samples[this.samples.length - 1];
      if (last && tMs - last.t > c.maxGapMs) { this.reset(); restarted = true; }
      else if (last && tMs <= last.t) return false;

      let minX = 1, maxX = 0;
      for (let i = 0; i < landmarks.length; i++) {
        const x = landmarks[i].x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      const faceW = (maxX - minX) * w;
      if (!(faceW > 0)) return restarted;

      const patch = Math.max(c.minPatchPx, Math.round(faceW * c.patchScale));
      const half = patch >> 1;
      const d = img.data;
      const P = PATCH_LANDMARKS.length;
      const rgb = new Float32Array(P * 3);
      let sr = 0, sg = 0, sb = 0, ok = 0;

      for (let p = 0; p < P; p++) {
        const lm = landmarks[PATCH_LANDMARKS[p]];
        const cx = Math.trunc(lm.x * w), cy = Math.trunc(lm.y * h);
        const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
        // same bounds rule as the Python ROI processor
        if (x0 >= 0 && y0 >= 0 && x1 < w && y1 < h) {
          let r = 0, g = 0, b = 0;
          for (let y = y0; y < y1; y++) {
            let o = (y * w + x0) * 4;
            for (let x = x0; x < x1; x++, o += 4) { r += d[o]; g += d[o + 1]; b += d[o + 2]; }
          }
          const cnt = (x1 - x0) * (y1 - y0);
          r /= cnt; g /= cnt; b /= cnt;
          rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b;
          sr += r; sg += g; sb += b; ok++;
        } else {
          rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = NaN;
        }
      }
      if (ok < P * 0.5) return restarted; // face mostly out of frame

      // motion: nose-tip displacement per frame, relative to face width
      const nose = landmarks[1];
      if (this.lastNose) {
        const dx = (nose.x - this.lastNose.x) * w, dy = (nose.y - this.lastNose.y) * h;
        this.motionHist.push(Math.hypot(dx, dy) / faceW);
        if (this.motionHist.length > 15) this.motionHist.shift();
      }
      this.lastNose = { x: nose.x, y: nose.y };

      this.brightness = sg / ok;
      this.samples.push({ t: tMs, rgb: rgb, mean: [sr / ok, sg / ok, sb / ok] });

      const keepFrom = tMs - (c.windowSeconds + 2) * 1000;
      while (this.samples.length > 2 && this.samples[0].t < keepFrom) this.samples.shift();
      return restarted;
    }

    get motion() { return this.motionHist.length ? median(this.motionHist) : 0; }

    // Linear-interpolation plan: for each uniform grid point, the sample below + weight.
    _plan(n) {
      const S = this.samples, M = S.length, fs = this.cfg.fs;
      const tEnd = S[M - 1].t;
      const lo = new Int32Array(n), a = new Float64Array(n);
      let j = 0;
      for (let k = 0; k < n; k++) {
        const tg = tEnd - (n - 1 - k) * 1000 / fs;
        if (k === 0 && tg < S[0].t) return null;
        while (j + 1 < M - 1 && S[j + 1].t <= tg) j++;
        const span = S[j + 1].t - S[j].t;
        const w = span > 0 ? (tg - S[j].t) / span : 0;
        a[k] = w < 0 ? 0 : (w > 1 ? 1 : w);
        lo[k] = j;
      }
      return { lo: lo, a: a };
    }

    _signal(R, G, B) {
      return this.cfg.processor === 'GREEN' ? greenSignal(R, G, B) : posSignal(R, G, B, this.posLen);
    }

    // Hann-windowed periodogram over [minHz, maxHz] (what scipy.welch does with nperseg = window).
    _spectrum(x) {
      const N = this.N, J = this.freqs.length;
      const xw = new Float64Array(N);
      for (let n = 0; n < N; n++) xw[n] = x[n] * this.hann[n];
      const pw = new Float64Array(J);
      let total = 0, best = 0, bi = 0;
      for (let j = 0; j < J; j++) {
        let re = 0, im = 0;
        const o = j * N;
        for (let n = 0; n < N; n++) { re += xw[n] * this.cosT[o + n]; im += xw[n] * this.sinT[o + n]; }
        const p = re * re + im * im;
        pw[j] = p; total += p;
        if (p > best) { best = p; bi = j; }
      }
      let near = 0;
      for (let j = Math.max(0, bi - this.concHalfBins); j <= Math.min(J - 1, bi + this.concHalfBins); j++) near += pw[j];
      return { bpm: this.freqs[bi] * 60, conc: total > 0 ? near / total : 0 };
    }

    /**
     * Estimate heart rate from the last `windowSeconds` of data.
     * state: 'collecting' | 'lowfps' | 'weak' | 'ok'
     */
    analyze() {
      const c = this.cfg, S = this.samples, M = S.length;
      const base = { brightness: this.brightness, motion: this.motion };
      if (M < 2) return Object.assign({ state: 'collecting', progress: 0 }, base);
      const spanMs = S[M - 1].t - S[0].t;
      const progress = Math.min(1, spanMs / (c.windowSeconds * 1000));
      const plan = progress >= 1 ? this._plan(this.N) : null;
      if (!plan) return Object.assign({ state: 'collecting', progress: Math.min(progress, 0.99) }, base);

      const tStart = S[M - 1].t - c.windowSeconds * 1000;
      let inWin = 0;
      for (let i = 0; i < M; i++) if (S[i].t >= tStart) inWin++;
      const fps = inWin / c.windowSeconds;
      if (fps < c.minFps) return Object.assign({ state: 'lowfps', progress: 1, fps: fps }, base);

      const N = this.N, P = PATCH_LANDMARKS.length;
      const R = new Float64Array(N), G = new Float64Array(N), B = new Float64Array(N);
      const hrs = [];
      let used = 0;

      for (let p = 0; p < P; p++) {
        let bad = false;
        for (let k = 0; k < N; k++) {
          const s0 = S[plan.lo[k]].rgb, s1 = S[plan.lo[k] + 1].rgb, a = plan.a[k];
          const o = p * 3;
          const r = s0[o] * (1 - a) + s1[o] * a;
          if (r !== r) { bad = true; break; }      // NaN: patch left the frame
          R[k] = r;
          G[k] = s0[o + 1] * (1 - a) + s1[o + 1] * a;
          B[k] = s0[o + 2] * (1 - a) + s1[o + 2] * a;
        }
        if (bad) continue;
        used++;
        const sig = bandpass(this._signal(R, G, B), c.fs, c.minHz, c.maxHz);
        const sp = this._spectrum(sig);
        if (sp.conc >= c.minConcentration) hrs.push(sp.bpm);
      }

      const out = Object.assign({ progress: 1, fps: fps, patches: used, voters: hrs.length }, base);
      if (used < 5 || hrs.length < Math.max(5, used * 0.1)) {
        return Object.assign(out, { state: 'weak', quality: 0, bpm: NaN });
      }
      const bpm = median(hrs);
      let agree = 0;
      for (const h of hrs) if (Math.abs(h - bpm) <= c.agreeBpm) agree++;
      return Object.assign(out, { state: 'ok', bpm: bpm, quality: agree / used });
    }

    /** Live pulse trace (POS of the face-average colour), band-passed. For the chart. */
    getWaveform(seconds) {
      const c = this.cfg, S = this.samples, M = S.length;
      if (M < 2) return null;
      const span = (S[M - 1].t - S[0].t) / 1000;
      const n = Math.round(c.fs * Math.min(seconds, span));
      if (n < c.fs * 3) return null;
      const plan = this._plan(n);
      if (!plan) return null;
      const R = new Float64Array(n), G = new Float64Array(n), B = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const m0 = S[plan.lo[k]].mean, m1 = S[plan.lo[k] + 1].mean, a = plan.a[k];
        R[k] = m0[0] * (1 - a) + m1[0] * a;
        G[k] = m0[1] * (1 - a) + m1[1] * a;
        B[k] = m0[2] * (1 - a) + m1[2] * a;
      }
      const l = Math.min(this.posLen, n - 1);
      const sig = c.processor === 'GREEN' ? greenSignal(R, G, B) : posSignal(R, G, B, l);
      return bandpass(sig, c.fs, c.minHz, c.maxHz);
    }
  }

  RppgEngine.PATCH_LANDMARKS = PATCH_LANDMARKS;
  RppgEngine.dsp = { posSignal, greenSignal, bandpass, median };

  root.RppgEngine = RppgEngine;
  if (typeof module === 'object' && module.exports) module.exports = RppgEngine;
})(typeof window !== 'undefined' ? window : globalThis);
