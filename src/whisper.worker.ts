/**
 * whisper.worker.ts — Whisper STT via @xenova/transformers, ES module WebWorker.
 *
 * ort-web.min.js is patched via the ortWebPatchPlugin Vite transform plugin
 * (vite.renderer.config.ts) to prepend `self.ort = onnxruntime-common` before
 * the UMD wrapper runs, fixing the registerBackend undefined error.
 *
 * Messages IN:  { type: 'transcribe', audio: Float32Array, sampleRate: number }
 * Messages OUT: { type: 'ready' | 'loading' | 'transcript' | 'error', ... }
 */

import { pipeline, env } from '@xenova/transformers';

env.useBrowserCache = true;
env.useFSCache = false;
env.allowRemoteModels = true;
env.allowLocalModels = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null;

const MODEL = 'Xenova/whisper-tiny.en';

async function init(): Promise<void> {
  // Configure ONNX WASM backend — env.backends.onnx is populated after ort-web loads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onnxEnv = (env as any).backends?.onnx;
  console.log('[whisper-worker] onnxEnv:', onnxEnv ? 'present' : 'missing', 'wasm:', onnxEnv?.wasm ? 'present' : 'missing');
  if (onnxEnv?.wasm) {
    onnxEnv.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/';
    onnxEnv.wasm.numThreads = 1;
  }

  self.postMessage({ type: 'loading', message: 'Loading voice model (first run downloads ~150MB)…' });

  asr = await pipeline('automatic-speech-recognition', MODEL, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    progress_callback: (p: any) => {
      console.log('[whisper-worker] progress:', JSON.stringify(p));
      if (p.status === 'downloading') {
        const pct = p.progress != null ? `${Math.round(p.progress)}%` : '';
        self.postMessage({ type: 'loading', message: `Downloading voice model… ${pct}` });
      }
    },
  });

  self.postMessage({ type: 'ready' });
}

init().catch(err => {
  console.error('[whisper-worker] init failed:', err);
  self.postMessage({ type: 'error', message: `Failed to load Whisper model: ${String(err)}` });
});

self.addEventListener('message', async (event: MessageEvent<{ type: string; audio?: Float32Array; sampleRate?: number }>) => {
  const { type, audio, sampleRate } = event.data;
  if (type !== 'transcribe') return;

  if (!audio || audio.length === 0) {
    self.postMessage({ type: 'transcript', text: '' });
    return;
  }
  if (!asr) {
    self.postMessage({ type: 'error', message: 'Model not ready yet — please wait' });
    return;
  }

  try {
    const targetRate = 16000;
    const samples = sampleRate && sampleRate !== targetRate
      ? resample(audio, sampleRate, targetRate)
      : audio;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await asr(samples, { sampling_rate: targetRate, return_timestamps: false });
    self.postMessage({ type: 'transcript', text: result.text?.trim() ?? '' });
  } catch (err) {
    self.postMessage({ type: 'error', message: `Transcription failed: ${String(err)}` });
  }
});

function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const newLength = Math.round(samples.length / ratio);
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, samples.length - 1);
    out[i] = samples[lo] * (1 - (pos - lo)) + samples[hi] * (pos - lo);
  }
  return out;
}
