/**
 * Video benchmark panel (PS "Benchmark-2"): bypass the simulated pan/tilt camera and
 * run the coarse-pointing pipeline on a recorded video.
 *
 *   · Browser: the video is decoded by the browser (seek → draw → grey) and analysed
 *     frame by frame with the same detector + learned verifier + Kalman as the engine.
 *   · FastAPI server: the file is uploaded to /api/video/analyze (OpenCV decoding).
 *   · Built-in stream: a synthetic full-screen (2000×2000) noisy video with a moving
 *     beacon and a cloud outage, generated in the browser, with exact ground truth.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp, saveReport, download } from '../state/store';
import { DEFAULT_VIDEO_PARAMS, VideoAnalyzer, VideoParams, VideoRow, parseTruthCsv, rgbaToGray } from '../core/video/analyzer';
import { buildReport, fmtVal, VideoReportSummary } from '../core/analysis/report';
import { Rng } from '../core/math';
import { syntheticFrame } from '../core/video/synthetic';
import { Icon, Seg, Slider, Toggle } from './ui';

type Source = 'browser' | 'server';
interface Progress {
  i: number;
  n: number;
  row: VideoRow | null;
  fps: number;
}

function drawPreview(cv: HTMLCanvasElement, gray: Uint8Array | Uint8ClampedArray, W: number, H: number, row: VideoRow | null, spot: number) {
  const maxW = 560;
  const maxH = 420;
  const k = Math.min(maxW / W, maxH / H);
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  // Area-average downscale (what the frame looks like), with mild gain so a dim beacon shows.
  const step = 1 / k;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * step);
    const y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) * step)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * step);
      const x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) * step)));
      let sum = 0;
      let cnt = 0;
      for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) {
        sum += gray[yy * W + xx];
        cnt++;
      }
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.min(255, (1.6 * sum) / cnt);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(232,240,247,0.35)';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 8, h / 2);
  ctx.lineTo(w / 2 + 8, h / 2);
  ctx.moveTo(w / 2, h / 2 - 8);
  ctx.lineTo(w / 2, h / 2 + 8);
  ctx.stroke();
  if (!row) return;
  if (row.truthX !== null && row.truthY !== null) {
    ctx.strokeStyle = 'rgba(255,208,138,0.9)';
    ctx.beginPath();
    ctx.arc(row.truthX * k, row.truthY * k, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (row.x !== null && row.y !== null) {
    const s = Math.max(10, spot * k * 2);
    ctx.strokeStyle = row.state === 'TRACKING' ? '#9cf5c8' : '#ffb547';
    ctx.strokeRect(row.x * k - s / 2, row.y * k - s / 2, s, s);
    ctx.beginPath();
    ctx.moveTo(row.x * k - s, row.y * k);
    ctx.lineTo(row.x * k + s, row.y * k);
    ctx.moveTo(row.x * k, row.y * k - s);
    ctx.lineTo(row.x * k, row.y * k + s);
    ctx.stroke();
  }
  if (row.kfX !== null && row.kfY !== null) {
    ctx.fillStyle = '#ffd08a';
    ctx.beginPath();
    ctx.moveTo(row.kfX * k, row.kfY * k - 5);
    ctx.lineTo(row.kfX * k + 5, row.kfY * k);
    ctx.lineTo(row.kfX * k, row.kfY * k + 5);
    ctx.lineTo(row.kfX * k - 5, row.kfY * k);
    ctx.closePath();
    ctx.fill();
  }
}

export function VideoBench() {
  const open = useApp((s) => s.videoOpen);
  const serverUrl = useApp((s) => s.serverUrl);
  const set = useApp((s) => s.set);
  const notify = useApp((s) => s.notify);
  const [source, setSource] = useState<Source>('browser');
  const [file, setFile] = useState<File | null>(null);
  const [truthText, setTruthText] = useState<string | null>(null);
  const [truthName, setTruthName] = useState<string>('');
  const [params, setParams] = useState<VideoParams>({ ...DEFAULT_VIDEO_PARAMS });
  const [fps, setFps] = useState(30);
  const [exact, setExact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<Progress | null>(null);
  const [result, setResult] = useState<{ summary: VideoReportSummary; analyzer: VideoAnalyzer | null; server?: { csv: string; report: string } } | null>(null);
  const cancel = useRef(false);
  const preview = useRef<HTMLCanvasElement>(null);
  const vidIn = useRef<HTMLInputElement>(null);
  const truthIn = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (cancel.current = true), []);
  if (!open) return null;

  const close = () => {
    cancel.current = true;
    set({ videoOpen: false });
  };

  async function runBrowser(synthetic: boolean) {
    cancel.current = false;
    setBusy(true);
    setResult(null);
    const truth = truthText ? parseTruthCsv(truthText) : null;
    const a = new VideoAnalyzer({ ...params }, fps);
    let W = 2000;
    let H = 2000;
    let n = 180;
    let video: HTMLVideoElement | null = null;
    let url = '';
    let canvas: HTMLCanvasElement | null = null;
    let c2d: CanvasRenderingContext2D | null = null;
    try {
      if (!synthetic) {
        if (!file) return;
        url = URL.createObjectURL(file);
        video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.src = url;
        await new Promise<void>((res, rej) => {
          video!.onloadedmetadata = () => res();
          video!.onerror = () => rej(new Error('This browser cannot decode the video (try an H.264 MP4, or analyse it on the FastAPI server).'));
        });
        W = video.videoWidth;
        H = video.videoHeight;
        n = Math.max(1, Math.floor(video.duration * fps + 1e-6));
        canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        c2d = canvas.getContext('2d', { willReadFrequently: true });
      }
      const gray = new Uint8Array(W * H);
      const rng = new Rng(7);
      const t0 = performance.now();
      let lastDraw = 0;
      const step = async (i: number, tr: [number, number] | null, idx?: number) => {
        const row = a.process(gray, W, H, tr, idx);
        const now = performance.now();
        if (now - lastDraw > 120 || i === n - 1) {
          lastDraw = now;
          if (preview.current) drawPreview(preview.current, gray, W, H, row, a.spotSizePx);
          setProg({ i: i + 1, n, row, fps: (1000 * (i + 1)) / (now - t0) });
          await new Promise((r) => setTimeout(r, 0));
        }
      };
      type RVFC = (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      const rvfc = video ? ((video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(video) ?? null) : null;
      if (synthetic) {
        for (let i = 0; i < n && !cancel.current; i++) await step(i, syntheticFrame(i, fps, W, H, rng, gray));
      } else if (video && c2d && rvfc && !exact) {
        // Sequential decoding: every presented frame is captured into a queue (playback
        // pauses while the queue is long) and analysed in order with its true index.
        // Seeking per frame would re-decode from the last keyframe every time.
        const v = video;
        const cx = c2d;
        const queue: { idx: number; g: Uint8Array }[] = [];
        let ended = false;
        let lastFrameAt = performance.now();
        const play = () => void v.play().catch(() => undefined);
        const onFrame = (_now: number, meta: { mediaTime: number }) => {
          lastFrameAt = performance.now();
          cx.drawImage(v, 0, 0, W, H);
          const g = new Uint8Array(W * H);
          rgbaToGray(cx.getImageData(0, 0, W, H).data, g);
          queue.push({ idx: Math.round(meta.mediaTime * fps), g });
          if (queue.length > (W * H > 1e6 ? 6 : 24)) v.pause();
          if (!ended && !cancel.current) rvfc(onFrame);
        };
        v.onended = () => {
          ended = true;
        };
        v.playbackRate = W * H > 1e6 ? 0.25 : 0.5;
        rvfc(onFrame);
        play();
        let i = 0;
        while (!cancel.current) {
          const item = queue.shift();
          if (!item) {
            if (ended || performance.now() - lastFrameAt > 8000) break;
            if (v.paused && !ended) play();
            await new Promise((r) => setTimeout(r, 4));
            continue;
          }
          gray.set(item.g);
          await step(i++, truth?.get(item.idx) ?? null, item.idx);
          if (v.paused && !ended && queue.length < 3) play();
        }
        v.pause();
      } else if (video && c2d) {
        for (let i = 0; i < n && !cancel.current; i++) {
          video.currentTime = Math.min(video.duration - 1e-3, (i + 0.5) / fps);
          await new Promise<void>((res) => {
            video!.onseeked = () => res();
          });
          c2d.drawImage(video, 0, 0, W, H);
          rgbaToGray(c2d.getImageData(0, 0, W, H).data, gray);
          await step(i, truth?.get(i) ?? null, i);
        }
      }
      const summary = a.summary(synthetic ? 'built-in synthetic stream (2000×2000)' : (file?.name ?? 'video'), synthetic || !!truth);
      setResult({ summary, analyzer: a });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      if (url) URL.revokeObjectURL(url);
      setBusy(false);
    }
  }

  async function runServer() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setProg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (truthText) fd.append('truth', new Blob([truthText], { type: 'text/csv' }), truthName || 'truth.csv');
      fd.append('hfovDeg', String(params.hfovDeg));
      fd.append('spotSizePx', String(params.spotSizePx));
      fd.append('thresholdSigma', String(params.thresholdSigma));
      fd.append('verifier', String(params.verifier));
      const base = serverUrl.replace(/\/$/, '');
      const r = await fetch(`${base}/api/video/analyze`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`Server: ${r.status} ${await r.text()}`);
      const j = await r.json();
      const s = j.summary;
      setResult({
        summary: {
          fileName: file.name,
          width: s.width,
          height: s.height,
          fps: s.videoFps,
          frames: s.frames,
          detectionRate: (s.detectionRatePct ?? 0) / 100,
          acquisitionS: s.acquisitionS,
          lossPct: s.lossPct,
          reacqMaxS: s.reacqMaxS,
          centroidRmsePx: s.centroidRmsePx,
          centroidMaxPx: s.centroidMaxPx,
          procMeanMs: s.procMeanMs ?? 0,
          processingFps: s.processingFps ?? 0,
          lockRetentionPct: s.lockRetentionPct ?? null,
          truthProvided: s.truthProvided,
        },
        analyzer: null,
        server: { csv: `${base}${j.csv}`, report: `${base}${j.report}` },
      });
    } catch (e) {
      notify(`Video analysis failed: ${(e as Error).message}. Is the FastAPI server running?`);
    } finally {
      setBusy(false);
    }
  }

  const s = result?.summary;
  const report = (fmt: 'html' | 'md' | 'json') => {
    if (!s) return;
    const rep = buildReport({ kind: 'video', source: result?.server ? 'FastAPI engine (camera bypass)' : 'Browser (camera bypass)', config: null, video: s });
    saveReport(rep, fmt, 'astraq-video-report');
  };

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal glass" role="dialog" aria-label="Video benchmark">
        <div className="drawer-head">
          <h3>
            Video benchmark <span className="dim" style={{ letterSpacing: '0.06em', fontSize: 12 }}>· camera bypass (PS Benchmark-2)</span>
          </h3>
          <button className="btn icon ghost" onClick={close} aria-label="Close" disabled={busy}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-left">
            <p className="note" style={{ marginTop: 0 }}>
              The simulated pan/tilt camera is bypassed: every frame of a recorded video goes straight into the detector, the learned verifier and the Kalman tracker. You get a per-frame centroid log and an automatic performance report.
            </p>
            <div className="eyebrow" style={{ margin: '10px 0 6px' }}>
              Analyse in
            </div>
            <Seg
              value={source}
              options={[
                { v: 'browser', label: 'This browser' },
                { v: 'server', label: 'FastAPI server' },
              ]}
              onChange={setSource}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={() => vidIn.current?.click()} disabled={busy}>
                <Icon name="film" size={14} /> {file ? 'Change video' : 'Choose video (.mp4)'}
              </button>
              <button className="btn sm" onClick={() => truthIn.current?.click()} disabled={busy}>
                <Icon name="upload" size={14} /> {truthText ? 'Change truth CSV' : 'Ground truth CSV (optional)'}
              </button>
            </div>
            <p className="note">
              {file ? (
                <>
                  Video: <b>{file.name}</b> ({(file.size / 1e6).toFixed(1)} MB)
                </>
              ) : (
                'No video chosen.'
              )}
              {truthText && (
                <>
                  <br />
                  Truth: <b>{truthName}</b> (columns frame,x,y)
                </>
              )}
            </p>
            <input
              ref={vidIn}
              type="file"
              accept="video/*,.mp4,.m4v,.webm,.mov,.avi"
              style={{ display: 'none' }}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
            <input
              ref={truthIn}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setTruthText(await f.text());
                  setTruthName(f.name);
                }
                e.target.value = '';
              }}
            />
            {source === 'browser' && <Slider label="Frame rate of the video" value={fps} min={10} max={60} step={1} digits={0} unit=" fps" onChange={setFps} />}
            <Slider label="Horizontal FOV of the video" value={params.hfovDeg} min={0.5} max={30} step={0.5} digits={1} unit="°" onChange={(v) => setParams({ ...params, hfovDeg: v })} />
            <Slider label="Beacon size (0 = auto-estimate)" value={params.spotSizePx} min={0} max={30} step={1} digits={0} unit=" px" onChange={(v) => setParams({ ...params, spotSizePx: v })} />
            <Slider label="Threshold (k·σ)" value={params.thresholdSigma} min={3} max={10} step={0.5} digits={1} onChange={(v) => setParams({ ...params, thresholdSigma: v })} />
            <Toggle label="Learned beacon verifier (AI)" on={params.verifier} onChange={(v) => setParams({ ...params, verifier: v })} />
            {source === 'browser' && (
              <Toggle
                label="Frame-exact decoding (slower)"
                on={exact}
                onChange={setExact}
                hint="Seek to every frame instead of playing the video: no frame is skipped, but long videos take much longer"
              />
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={busy || !file} onClick={() => (source === 'browser' ? runBrowser(false) : runServer())}>
                Analyse video
              </button>
              {source === 'browser' && (
                <button className="btn" disabled={busy} onClick={() => runBrowser(true)} title="No file needed: a generated 2000×2000 noisy video with exact ground truth">
                  Try built-in 2000×2000 stream
                </button>
              )}
              {busy && source === 'browser' && (
                <button className="btn ghost" onClick={() => (cancel.current = true)}>
                  Stop
                </button>
              )}
            </div>
            {source === 'server' && (
              <p className="note">
                Uploads to <b>{serverUrl}</b>/api/video/analyze (OpenCV decoding, any codec). Start the server first (see README).
              </p>
            )}
          </div>
          <div className="modal-right">
            <div className="vb-preview">
              <canvas ref={preview} />
              {!prog && !result && <span className="dim">Preview appears here while the video is analysed</span>}
            </div>
            {prog && (
              <div className="vb-prog">
                <div className="prog">
                  <i style={{ width: `${(100 * prog.i) / prog.n}%` }} />
                </div>
                <span className="mono dim">
                  frame {prog.i}/{prog.n} · {prog.row?.state ?? ''} · {prog.fps.toFixed(1)} fps incl. decoding
                </span>
              </div>
            )}
            {s && (
              <>
                <div className="vb-cards">
                  <Card label="Frames" value={`${s.frames} · ${s.width}×${s.height}`} />
                  <Card label="Detection rate" value={fmtVal(100 * s.detectionRate, 1, '%')} />
                  <Card label="Acquisition" value={fmtVal(s.acquisitionS, 2, 's')} ok={s.acquisitionS !== null && s.acquisitionS <= 2} />
                  <Card label="Lock retention" value={fmtVal(s.lockRetentionPct, 1, '%')} />
                  <Card label="Re-acquisition (worst)" value={fmtVal(s.reacqMaxS, 2, 's')} ok={s.reacqMaxS === null ? undefined : s.reacqMaxS <= 1} />
                  <Card label="Centroid RMSE" value={s.truthProvided ? fmtVal(s.centroidRmsePx, 3, 'px') : 'no truth'} />
                  <Card label="Processing speed" value={fmtVal(s.processingFps, 1, 'FPS')} ok={s.processingFps >= 20} />
                  <Card label="Time per frame" value={fmtVal(s.procMeanMs, 1, 'ms')} />
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  {result?.analyzer && (
                    <button className="btn sm" onClick={() => download('astraq-video-centroid-log.csv', result.analyzer!.csv(), 'text/csv')}>
                      <Icon name="download" size={14} /> Centroid log (CSV)
                    </button>
                  )}
                  {result?.server && (
                    <a className="btn sm" href={result.server.csv} target="_blank" rel="noreferrer">
                      <Icon name="download" size={14} /> Centroid log (CSV)
                    </a>
                  )}
                  <button className="btn sm primary" onClick={() => report('html')}>
                    <Icon name="report" size={14} /> Performance report
                  </button>
                  <button className="btn sm" onClick={() => report('md')}>
                    Markdown
                  </button>
                  <button className="btn sm" onClick={() => report('json')}>
                    JSON
                  </button>
                </div>
                {result?.analyzer && (
                  <p className="note">
                    Beacon size used: <b>{result.analyzer.spotSizePx.toFixed(1)} px</b>
                    {params.spotSizePx <= 0 ? ' (estimated from the first detections)' : ''}. Processing speed excludes browser decoding.
                    {result.analyzer.skipped > 0 && (
                      <>
                        {' '}
                        The browser's decoder did not deliver {result.analyzer.skipped} frame(s); the tracker predicted across those gaps. For a frame-exact log use the FastAPI server.
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className={`vb-card ${ok === undefined ? '' : ok ? 'ok' : 'bad'}`}>
      <div className="eyebrow">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}
