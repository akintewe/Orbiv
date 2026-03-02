/**
 * FocusBubble — renderer.ts  (v4 — amorphous liquid blob)
 *
 * HOW THE BLOB WORKS
 * ──────────────────
 * We place N_POINTS equally-spaced anchor points on a circle of radius
 * BASE_RADIUS. Every animation frame, each point is displaced outward/inward
 * by a small amount driven by simplex noise sampled at a slowly-advancing
 * position in noise-space.
 *
 * Because simplex noise is smooth and continuous, neighbouring points and
 * neighbouring frames produce similar values → the shape morphs organically
 * with no discontinuities or hard jumps.
 *
 * Those displaced points are then connected by a Catmull-Rom spline (adapted
 * from George Doscode's tutorial on dev.to). Catmull-Rom produces smooth
 * closed curves through any set of points with zero configuration — no need
 * to calculate Bézier control handles by hand.
 *
 * The result is an always-different, never-repeating amorphous blob.
 *
 * FILTER PIPELINE (in index.html)
 * ─────────────────────────────────
 *  goo filter  (on #blob-goo-group)
 *    feGaussianBlur stdDeviation=6  → smears alpha channel outward
 *    feColorMatrix  0 0 0 20 -10    → snaps the smear back with high contrast
 *    feComposite atop               → crisp source rendered over gooey alpha
 *  outer-glow  (on #blob-glow-wrap)
 *    feGaussianBlur + feMerge       → soft ambient halo
 *
 * GSAP is used for:
 *  • The overall container drift (slow X/Y sine wave across the window)
 *  • Alert pop (quick scale burst + elastic settle)
 *  • Expand/collapse transitions
 *
 * Simplex noise drives the per-frame path morph inside rAF.
 */

import './index.css';
import { createNoise2D } from 'simplex-noise';
import { gsap } from 'gsap';
import type { FBNotification } from './preload';

declare global {
  interface Window {
    focusBubble: {
      expand(w: number, h: number): void;
      collapse(): void;
      move(dx: number, dy: number): void;
      setIgnoreMouseEvents(ignore: boolean): void;
      onNotification(cb: (n: FBNotification) => void): () => void;
      fetchEmailBody(messageId: string): Promise<string>;
      resizePanel(width: number, height: number, x?: number, y?: number): void;
      getPanelSize(): Promise<{ width: number; height: number }>;
      resizeToChatSize(width: number, height: number): void;
      getConversionTargets(filePath: string): Promise<string[]>;
      convertFile(filePath: string, targetExt: string): Promise<{ ok: boolean; outputPath?: string; message: string }>;
      revealFile(filePath: string): void;
      getFilePath(file: File): string;
      searchFiles(query: string): Promise<{ name: string; filePath: string; size: number; modified: number; ext: string }[]>;
      openFile(filePath: string): void;
      classifyIntent(transcript: string): Promise<Record<string, unknown>>;
      takeScreenshot(): Promise<{ ok: boolean; filePath?: string; dataUrl?: string; error?: string }>;
      openApp(appName: string): Promise<{ ok: boolean; error?: string }>;
      closeApp(appName: string): Promise<{ ok: boolean; error?: string }>;
      spotifyPlay(query: string): Promise<{ ok: boolean; error?: string }>;
      getSpotifyState(): Promise<{ playing: boolean; position: number }>;
      transcribeAudio(audioBase64: string, mimeType?: string): Promise<string>;
      speak(text: string, voiceId?: string): Promise<{ ok: boolean; dataUrl?: string }>;
      speakStop(): void;
      enterIdleMode(position: string): void;
      exitIdleMode(): void;
      idleMove(dx: number, dy: number): void;
      generateMeetingPdf(payload: { title: string; startTime: number; chunks: { ts: number; text: string }[] }): Promise<{ ok: boolean; filePath?: string; error?: string }>;
      getMeetingTime(): Promise<number>;
      loadDailyPlan(): Promise<{ tasks: DailyTask[]; greeted: boolean }>;
      saveTasksToday(tasks: DailyTask[]): Promise<void>;
      setGreetedToday(): Promise<void>;
      updateTask(id: string, patch: Partial<DailyTask>): Promise<void>;
      getDueTasks(): Promise<DailyTask[]>;
      onPlannerEvent(cb: (e: { type: string }) => void): () => void;
      twilioCall(cfg: { sid: string; token: string; fromPhone: string; toPhone: string; tasks: DailyTask[] }): Promise<{ ok: boolean; callSid?: string; error?: string }>;
      saveTwilioSettings(cfg: { sid: string; token: string; fromPhone: string; autoCallTime: string }): Promise<void>;
      onAutoCallTrigger(callback: () => void): () => void;
    };
  }
}

interface DailyTask {
  id: string;
  title: string;
  dueTime?: string;
  dueMinutes?: number;
  completed: boolean;
  remindedAt?: number;
  snoozedUntil?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOB CONFIGURATION  — Siri-style multi-layer iridescent orb
// ═══════════════════════════════════════════════════════════════════════════════

/** Number of control points per layer */
const N_POINTS = 8;

/** Centre of blob in SVG coords (viewBox "-180 -180 360 360") */
const CX = 0;
const CY = 0;

/**
 * Each colour layer has its own base radius and displacement so they
 * drift at different scales → colour zones shift and swirl past each other.
 *
 * BASE   — largest, always fully encloses the others (the sphere silhouette)
 * CYAN   — slightly smaller, offset phase, fast morph → bright highlight swirl
 * BLUE   — mid radius, medium phase offset
 * PURPLE — smallest of the 3 colour blobs, slowest → deep shadow zone
 */
const LAYERS = {
  base: { radius: 82, idleDist: 13, noiseMult: 1.00, phaseShift: 0 },
  cyan: { radius: 70, idleDist: 21, noiseMult: 1.30, phaseShift: 200 },
  blue: { radius: 75, idleDist: 18, noiseMult: 1.15, phaseShift: 500 },
  purple: { radius: 65, idleDist: 24, noiseMult: 0.90, phaseShift: 800 },
} as const;
type LayerKey = keyof typeof LAYERS;

const IDLE_DISPLACEMENT = 1.0;  // multiplier — actual px comes from layer config
const ALERT_DISPLACEMENT = 2.5;
const EXPAND_DISPLACEMENT = 4.5;

const IDLE_NOISE_STEP = 0.007;
const ALERT_NOISE_STEP = 0.020;

// ─── Noise instances ─────────────────────────────────────────────────────────
const noiseA = createNoise2D();
const noiseB = createNoise2D();

// ─── Blob state ──────────────────────────────────────────────────────────────
interface BlobPoint {
  angle: number;
  noiseOffsetX: number;
  noiseOffsetY: number;
}

function makePoints(phaseShift: number): BlobPoint[] {
  return Array.from({ length: N_POINTS }, (_, i) => ({
    angle: (i / N_POINTS) * Math.PI * 2,
    noiseOffsetX: Math.random() * 1000 + phaseShift,
    noiseOffsetY: Math.random() * 1000 + phaseShift + 333,
  }));
}

const layerPoints: Record<LayerKey, BlobPoint[]> = {
  base: makePoints(LAYERS.base.phaseShift),
  cyan: makePoints(LAYERS.cyan.phaseShift),
  blue: makePoints(LAYERS.blue.phaseShift),
  purple: makePoints(LAYERS.purple.phaseShift),
};

let noiseStep = IDLE_NOISE_STEP;
let displacementMult = IDLE_DISPLACEMENT;
let morphRAF = 0;
let isMorphing = true;

// ═══════════════════════════════════════════════════════════════════════════════
// CATMULL-ROM SPLINE  (from George Doscode's dev.to tutorial)
// ═══════════════════════════════════════════════════════════════════════════════

/** Linear interpolation between two values. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map a value from one range to another (noise -1..1 → pixels). */
function mapRange(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return ((v - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

/**
 * Convert a closed set of (x, y) points into an SVG path string using
 * Catmull-Rom spline interpolation.
 *
 * The Catmull-Rom formula uses each point's neighbours as implicit control
 * handles → no manual bezier tuning, always smooth.
 *
 * Adapted from: https://dev.to/georgedoescode/tutorial-build-a-smooth-animated-blob-using-svg-js-3pne
 */
function pointsToPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  // Build SVG cubic bezier segments (C commands)
  const d: string[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]; // previous
    const p1 = pts[i];               // current
    const p2 = pts[(i + 1) % n];     // next
    const p3 = pts[(i + 2) % n];     // next-next

    // Catmull-Rom → Bézier conversion
    const tension = 1 / 6;

    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;

    if (i === 0) d.push(`M ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`);
    d.push(`C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`);
  }
  d.push('Z');
  return d.join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM REFS
// ═══════════════════════════════════════════════════════════════════════════════
const blobContainer = document.getElementById('blob-container')!;
const blobSvg = document.getElementById('blob-svg')!;
const blobGlowWrap = document.getElementById('blob-glow-wrap')!;
const pathBase = document.getElementById('blob-base') as unknown as SVGPathElement;
const pathCyan = document.getElementById('blob-cyan') as unknown as SVGPathElement;
const pathBlue = document.getElementById('blob-blue') as unknown as SVGPathElement;
const pathPurple = document.getElementById('blob-purple') as unknown as SVGPathElement;
const blobSpec = document.getElementById('blob-spec') as unknown as SVGPathElement;
const blobHotspot = document.getElementById('blob-hotspot') as unknown as SVGEllipseElement;
const badge = document.getElementById('badge') as HTMLElement;
const badgeCount = document.getElementById('badge-count') as HTMLSpanElement;
const panel = document.getElementById('panel') as HTMLElement;
const platformTables = document.getElementById('platform-tables')!;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const btnClose = document.getElementById('btn-close')!;
const btnMarkAll = document.getElementById('btn-mark-all')!;
const resizeHandles = Array.from(document.querySelectorAll<HTMLElement>('.resize-handle'));

// ── Idle mode + Settings DOM refs ─────────────────────────────────────────────
const idlePill         = document.getElementById('idle-pill')            as HTMLElement;
const idleDot          = document.getElementById('idle-dot')             as HTMLElement;
const idleViz          = document.getElementById('idle-viz')             as HTMLCanvasElement;
const btnSettings      = document.getElementById('btn-settings')         as HTMLButtonElement;
const settingsCard     = document.getElementById('settings-card')        as HTMLElement;
const settingsBack     = document.getElementById('settings-back')        as HTMLButtonElement;
const settingsSave     = document.getElementById('settings-save')        as HTMLButtonElement;
const settingTimeoutEl = document.getElementById('setting-idle-timeout') as HTMLSelectElement;
const settingPositionEl= document.getElementById('setting-idle-position')as HTMLSelectElement;
const settingShapeEl   = document.getElementById('setting-idle-shape')   as HTMLSelectElement;
const settingUserPhoneEl   = document.getElementById('setting-user-phone')   as HTMLInputElement;
const settingTwilioSidEl   = document.getElementById('setting-twilio-sid')   as HTMLInputElement;
const settingTwilioTokenEl = document.getElementById('setting-twilio-token') as HTMLInputElement;
const settingTwilioPhoneEl = document.getElementById('setting-twilio-phone') as HTMLInputElement;
const settingAutoCallEl    = document.getElementById('setting-auto-call')    as HTMLInputElement;

// ── Meeting notetaker DOM refs ────────────────────────────────────────────────
const meetingView          = document.getElementById('meeting-view')               as HTMLElement;
const meetingElapsedEl     = document.getElementById('meeting-elapsed')            as HTMLElement;
const meetingChunkLabel    = document.getElementById('meeting-chunk-label')        as HTMLElement;
const meetingTranscriptPrv = document.getElementById('meeting-transcript-preview') as HTMLElement;
const meetingStopBtn       = document.getElementById('meeting-stop-btn')           as HTMLButtonElement;

// ── Daily Planner DOM refs ────────────────────────────────────────────────────
const plannerView       = document.getElementById('planner-view')       as HTMLElement;
const plannerGreeting   = document.getElementById('planner-greeting')   as HTMLElement;
const plannerYnRow      = document.getElementById('planner-yn-row')     as HTMLElement;
const plannerYesBtn     = document.getElementById('planner-yes-btn')    as HTMLButtonElement;
const plannerNoBtn      = document.getElementById('planner-no-btn')     as HTMLButtonElement;
const plannerTaskList   = document.getElementById('planner-task-list')  as HTMLElement;
const plannerInputRow   = document.getElementById('planner-input-row')  as HTMLElement;
const plannerInput      = document.getElementById('planner-input')      as HTMLInputElement;
const plannerInputSend  = document.getElementById('planner-input-send') as HTMLButtonElement;
const plannerBtnRow     = document.getElementById('planner-btn-row')    as HTMLElement;
const plannerDoneBtn    = document.getElementById('planner-done-btn')   as HTMLButtonElement;
const reminderOverlay   = document.getElementById('reminder-overlay')   as HTMLElement;
const reminderText      = document.getElementById('reminder-text')      as HTMLElement;
const reminderYesBtn    = document.getElementById('reminder-yes')       as HTMLButtonElement;
const reminderNoBtn     = document.getElementById('reminder-no')        as HTMLButtonElement;
const reminderSnoozeBtn = document.getElementById('reminder-snooze')    as HTMLButtonElement;

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

interface FBSettings {
  idleTimeoutSeconds: number;
  idlePosition: 'top-center' | 'top-right' | 'bottom-right' | 'remember-last';
  idleShape: 'pill' | 'circle' | 'hidden';
  userPhone: string;
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
  autoCallTime: string;
}

const SETTINGS_KEY = 'focusbubble-settings-v1';
const DEFAULT_SETTINGS: FBSettings = {
  idleTimeoutSeconds: 60,
  idlePosition: 'top-center',
  idleShape: 'pill',
  userPhone: '', twilioSid: '', twilioToken: '', twilioPhone: '', autoCallTime: '',
};

function loadSettings(): FBSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<FBSettings> | null;
    if (!parsed) return { ...DEFAULT_SETTINGS };
    return {
      idleTimeoutSeconds: parsed.idleTimeoutSeconds ?? DEFAULT_SETTINGS.idleTimeoutSeconds,
      idlePosition:       parsed.idlePosition       ?? DEFAULT_SETTINGS.idlePosition,
      idleShape:          parsed.idleShape           ?? DEFAULT_SETTINGS.idleShape,
      userPhone:    (parsed as Partial<FBSettings>).userPhone    ?? '',
      twilioSid:    (parsed as Partial<FBSettings>).twilioSid    ?? '',
      twilioToken:  (parsed as Partial<FBSettings>).twilioToken  ?? '',
      twilioPhone:  (parsed as Partial<FBSettings>).twilioPhone  ?? '',
      autoCallTime: (parsed as Partial<FBSettings>).autoCallTime ?? '',
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s: FBSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

let settings: FBSettings = loadSettings();

// ═══════════════════════════════════════════════════════════════════════════════
// MORPH LOOP  — runs on rAF, redraws all 4 colour layer paths every frame
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build displaced blob points for one layer.
 * Each layer has its own noise offset seed (phaseShift) and displacement scale
 * so they morph at different rates and sizes → colour zones swirl past each other.
 */
function buildLayerPts(
  pts: BlobPoint[],
  cfg: { radius: number; idleDist: number; noiseMult: number },
): { x: number; y: number }[] {
  const step = noiseStep * cfg.noiseMult;
  const dist = cfg.idleDist * displacementMult;

  return pts.map(pt => {
    pt.noiseOffsetX += step;
    pt.noiseOffsetY += step;

    const nx = noiseA(pt.noiseOffsetX, pt.angle);
    const ny = noiseB(pt.noiseOffsetY, pt.angle + 31.41);
    const n = (nx + ny) * 0.5;

    const r = cfg.radius + mapRange(n, -1, 1, -dist, dist);
    return {
      x: CX + Math.cos(pt.angle) * r,
      y: CY + Math.sin(pt.angle) * r,
    };
  });
}

function morphFrame(): void {
  // Drive each layer independently
  const basePts = buildLayerPts(layerPoints.base, LAYERS.base);
  const cyanPts = buildLayerPts(layerPoints.cyan, LAYERS.cyan);
  const bluePts = buildLayerPts(layerPoints.blue, LAYERS.blue);
  const purplePts = buildLayerPts(layerPoints.purple, LAYERS.purple);

  pathBase.setAttribute('d', pointsToPath(basePts));
  pathCyan.setAttribute('d', pointsToPath(cyanPts));
  pathBlue.setAttribute('d', pointsToPath(bluePts));
  pathPurple.setAttribute('d', pointsToPath(purplePts));

  // Specular: base shape scaled 80% inward → stays inside the sphere
  const specPts = basePts.map(p => ({
    x: lerp(CX, p.x, 0.80),
    y: lerp(CY, p.y, 0.80),
  }));
  blobSpec.setAttribute('d', pointsToPath(specPts));

  if (isMorphing) morphRAF = requestAnimationFrame(morphFrame);
}

function startMorph(): void {
  isMorphing = true;
  if (!morphRAF) morphRAF = requestAnimationFrame(morphFrame);
}

function stopMorph(): void {
  isMorphing = false;
  if (morphRAF) { cancelAnimationFrame(morphRAF); morphRAF = 0; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IDLE DRIFT  — GSAP slowly floats the container around the window
// ═══════════════════════════════════════════════════════════════════════════════
let driftTL: gsap.core.Timeline | null = null;

function startDrift(): void {
  driftTL?.kill();
  // Gentle Lissajous drift — slightly different X and Y periods
  // so the blob traces a lazy figure-of-eight over time
  driftTL = gsap.timeline({ repeat: -1, yoyo: true })
    .to(blobContainer, { x: 10, duration: 5.0, ease: 'sine.inOut' }, 0)
    .to(blobContainer, { y: -7, duration: 4.2, ease: 'sine.inOut' }, 0);

  gsap.to(blobContainer, {
    x: -8, duration: 5.8, ease: 'sine.inOut',
    repeat: -1, yoyo: true, delay: 2.5,
  });
}

function stopDrift(): void {
  driftTL?.kill();
  // Kill tweens but DO NOT reset x/y — that would visibly snap the blob back
  // to centre mid-drag. We leave it wherever GSAP left it; startDrift() will
  // take over smoothly from that position when drift resumes.
  gsap.killTweensOf(blobContainer, 'x,y');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT STATE
// ═══════════════════════════════════════════════════════════════════════════════
let pulseTL: gsap.core.Timeline | null = null;
let isAlert = false;

function enterAlertState(): void {
  if (isAlert) return;
  isAlert = true;

  // Speed up morph and widen displacement → agitated swirling
  noiseStep = ALERT_NOISE_STEP;
  displacementMult = ALERT_DISPLACEMENT;

  // Switch to alert glow (brighter cyan pulse)
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow-alert)');

  // Splash pop: quick scale-out, elastic settle back
  gsap.timeline()
    .to(blobSvg, { scale: 1.32, duration: 0.14, ease: 'power3.out' })
    .to(blobSvg, { scale: 1.00, duration: 0.72, ease: 'elastic.out(1.05, 0.42)' });

  // Hotspot flash
  gsap.timeline()
    .to(blobHotspot, { attr: { opacity: 0.85 }, duration: 0.08 })
    .to(blobHotspot, { attr: { opacity: 0.28 }, duration: 0.55, ease: 'power2.out' });

  // After pop settles, ease back to a calmer-but-still-alert pace
  setTimeout(() => {
    noiseStep = lerp(IDLE_NOISE_STEP, ALERT_NOISE_STEP, 0.35);
    displacementMult = lerp(IDLE_DISPLACEMENT, ALERT_DISPLACEMENT, 0.40);

    pulseTL = gsap.timeline({ repeat: -1, yoyo: true })
      .to(blobSvg, { scale: 1.07, duration: 1.6, ease: 'sine.inOut' });
  }, 800);
}

function clearAlertState(): void {
  if (!isAlert) return;
  isAlert = false;

  pulseTL?.kill();
  pulseTL = null;
  gsap.set(blobSvg, { scale: 1 });

  noiseStep = IDLE_NOISE_STEP;
  displacementMult = IDLE_DISPLACEMENT;

  blobGlowWrap.setAttribute('filter', 'url(#outer-glow)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAG-AND-DROP  — "hungry mouth" blob state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a static set of 8 (x, y) points that form a wide-open-mouth shape
 * in the blob's SVG coordinate space (centre 0,0, radius ~82).
 *
 * Points are laid out clockwise from 12 o'clock.  The bottom half is pushed
 * outward (wider jaw) and the top has a slight dent (upper lip indent) so the
 * shape reads as a round open mouth / "hungry" face.
 *
 *   0 → top-centre   (slight dent → upper-lip)
 *   1 → upper-right
 *   2 → right
 *   3 → lower-right  (pushed out → wide jaw)
 *   4 → bottom       (pushed far down → open chin)
 *   5 → lower-left   (pushed out)
 *   6 → left
 *   7 → upper-left
 */
function makeMouthPoints(scale = 1): { x: number; y: number }[] {
  const s = scale;
  return [
    { x:   0   * s, y: -62  * s }, // 0 top — slight inward dent (upper lip)
    { x:  68   * s, y: -42  * s }, // 1 upper-right
    { x:  92   * s, y:   8  * s }, // 2 right — pushed wide
    { x:  78   * s, y:  68  * s }, // 3 lower-right — wide jaw corner
    { x:   0   * s, y:  96  * s }, // 4 bottom — open chin, pushed far down
    { x: -78   * s, y:  68  * s }, // 5 lower-left
    { x: -92   * s, y:   8  * s }, // 6 left
    { x: -68   * s, y: -42  * s }, // 7 upper-left
  ];
}

let isDragOver = false;
let dragEnterCount = 0; // counter to handle dragleave firing on child elements
let mouthTL: gsap.core.Timeline | null = null;

/**
 * Transition the blob into the "hungry mouth" state.
 * 1. Freeze the noise morph loop (so GSAP owns the paths)
 * 2. Tween all 4 layer paths toward the mouth shape
 * 3. Swap in warm orange gradients
 * 4. Switch to drag glow and scale up slightly
 */
function enterDragState(): void {
  if (isDragOver || isExpanded) return;
  isDragOver = true;

  // Stop the noise rAF — GSAP will own the path attributes from here.
  // We stop AFTER reading the current `d` values implicitly: GSAP always reads
  // the element's current attribute value as the tween start when no `from` is given.
  stopMorph();
  stopDrift();

  // Build the target mouth path string for each layer at its own scale
  // Base is largest, others proportionally smaller (matching the idle radius ratios)
  const mouthBase   = pointsToPath(makeMouthPoints(1.00));  // radius ~92 at bottom
  const mouthCyan   = pointsToPath(makeMouthPoints(0.84));
  const mouthBlue   = pointsToPath(makeMouthPoints(0.90));
  const mouthPurple = pointsToPath(makeMouthPoints(0.78));

  mouthTL?.kill();
  mouthTL = gsap.timeline();

  // Tween each layer's `d` attribute from current blob → mouth shape.
  // GSAP interpolates SVG path `d` strings when they have the same command
  // structure (same number of C commands) — our pointsToPath always produces
  // M + 8×C + Z regardless of the points, so interpolation is smooth.
  mouthTL
    .to(pathBase,   { attr: { d: mouthBase   }, duration: 0.55, ease: 'back.out(1.4)' }, 0)
    .to(pathCyan,   { attr: { d: mouthCyan   }, duration: 0.60, ease: 'back.out(1.2)' }, 0)
    .to(pathBlue,   { attr: { d: mouthBlue   }, duration: 0.50, ease: 'back.out(1.3)' }, 0)
    .to(pathPurple, { attr: { d: mouthPurple }, duration: 0.65, ease: 'back.out(1.1)' }, 0)
    // Specular: same mouth shape, scaled 80% inward (mirrors idle behaviour)
    .to(blobSpec, { attr: { d: pointsToPath(makeMouthPoints(0.80)) }, duration: 0.55, ease: 'back.out(1.4)' }, 0)
    // Gentle scale pulse — the blob breathes open like it's ready to eat
    .to(blobSvg, { scale: 1.12, duration: 0.55, ease: 'back.out(1.5)' }, 0)
    .to(blobSvg, { scale: 1.06, duration: 0.9, ease: 'sine.inOut', repeat: -1, yoyo: true }, 0.55);

  // Swap gradients to warm orange/amber palette
  pathBase.setAttribute('fill',   'url(#grad-base-drag)');
  pathCyan.setAttribute('fill',   'url(#grad-cyan-drag)');
  pathBlue.setAttribute('fill',   'url(#grad-blue-drag)');
  pathPurple.setAttribute('fill', 'url(#grad-purple-drag)');

  // Warm glow
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow-drag)');
  document.body.classList.add('drag-over');

}

/**
 * Return the blob to its normal idle morphing state.
 * Smoothly tweens the paths back to a neutral round shape, then hands
 * control back to the noise rAF loop.
 */
function exitDragState(): void {
  if (!isDragOver) return;
  isDragOver = false;
  document.body.classList.remove('drag-over');

  mouthTL?.kill();

  // Tween back to a neutral round blob (base radius points, no displacement)
  // We regenerate a fresh "neutral" shape rather than trying to pick up from
  // the noise loop mid-stream — looks cleaner on exit
  const neutralBase   = pointsToPath(makePoints(LAYERS.base.phaseShift).map((pt) => ({
    x: CX + Math.cos(pt.angle) * LAYERS.base.radius,
    y: CY + Math.sin(pt.angle) * LAYERS.base.radius,
  })));
  const neutralCyan   = pointsToPath(makePoints(LAYERS.cyan.phaseShift).map((pt) => ({
    x: CX + Math.cos(pt.angle) * LAYERS.cyan.radius,
    y: CY + Math.sin(pt.angle) * LAYERS.cyan.radius,
  })));
  const neutralBlue   = pointsToPath(makePoints(LAYERS.blue.phaseShift).map((pt) => ({
    x: CX + Math.cos(pt.angle) * LAYERS.blue.radius,
    y: CY + Math.sin(pt.angle) * LAYERS.blue.radius,
  })));
  const neutralPurple = pointsToPath(makePoints(LAYERS.purple.phaseShift).map((pt) => ({
    x: CX + Math.cos(pt.angle) * LAYERS.purple.radius,
    y: CY + Math.sin(pt.angle) * LAYERS.purple.radius,
  })));

  gsap.timeline({
    onComplete: () => {
      // Restore gradients and glow BEFORE re-starting the morph loop so there's
      // no single frame showing the wrong gradient on a freshly morphed path
      pathBase.setAttribute('fill',   'url(#grad-base)');
      pathCyan.setAttribute('fill',   'url(#grad-cyan)');
      pathBlue.setAttribute('fill',   'url(#grad-blue)');
      pathPurple.setAttribute('fill', 'url(#grad-purple)');
      blobGlowWrap.setAttribute('filter', isAlert ? 'url(#outer-glow-alert)' : 'url(#outer-glow)');

      // Hand paths back to the noise loop
      startMorph();
      startDrift();
    },
  })
    .to(pathBase,   { attr: { d: neutralBase   }, duration: 0.45, ease: 'power2.out' }, 0)
    .to(pathCyan,   { attr: { d: neutralCyan   }, duration: 0.45, ease: 'power2.out' }, 0)
    .to(pathBlue,   { attr: { d: neutralBlue   }, duration: 0.45, ease: 'power2.out' }, 0)
    .to(pathPurple, { attr: { d: neutralPurple }, duration: 0.45, ease: 'power2.out' }, 0)
    .to(blobSvg,    { scale: 1,                  duration: 0.45, ease: 'power2.out' }, 0);
}

/**
 * "Gulp" success animation — plays on drop.
 * Quick scale-up swallow followed by elastic bounce settle.
 */
function gulpAnimation(): void {
  gsap.timeline()
    .to(blobSvg, { scale: 0.82, duration: 0.10, ease: 'power3.in' })   // quick suck-in
    .to(blobSvg, { scale: 1.30, duration: 0.18, ease: 'power3.out' })  // gulp bulge
    .to(blobSvg, { scale: 1.00, duration: 0.65, ease: 'elastic.out(1.1, 0.4)' }); // settle
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESSING ANIMATION  — crazy churning morph while a conversion runs
// ═══════════════════════════════════════════════════════════════════════════════

let processingTL: gsap.core.Timeline | null = null;

/**
 * Wild "churning" blob shapes — spiky, distorted, asymmetric.
 * Each is a set of 8 points in the same SVG space as the normal blob.
 */
function makeChurnPoints(variant: number): { x: number; y: number }[] {
  // 3 different wild shapes that cycle during processing
  if (variant === 0) {
    // Spiky starburst
    return [
      { x:   0, y: -105 },
      { x:  55, y:  -30 },
      { x: 100, y:   20 },
      { x:  45, y:   85 },
      { x:   0, y:  110 },
      { x: -55, y:   72 },
      { x: -95, y:    5 },
      { x: -42, y:  -55 },
    ];
  } else if (variant === 1) {
    // Melting/drip shape — tall and narrow top, wide bottom
    return [
      { x:   0, y:  -95 },
      { x:  35, y:  -60 },
      { x:  85, y:   10 },
      { x:  90, y:   65 },
      { x:  20, y:  108 },
      { x: -25, y:  100 },
      { x: -80, y:   55 },
      { x: -30, y:  -70 },
    ];
  } else {
    // Pinched/vortex — twisted diagonal
    return [
      { x:  20, y:  -90 },
      { x:  88, y:  -28 },
      { x:  70, y:   45 },
      { x:  10, y:  102 },
      { x: -40, y:   88 },
      { x: -90, y:   20 },
      { x: -65, y:  -45 },
      { x: -15, y:  -95 },
    ];
  }
}

/** Start the processing animation loop. Stops noise morph and takes over paths. */
function startProcessingAnimation(): void {
  stopMorph();
  stopDrift();

  // Bright processing colours — electric yellow/green
  pathBase.setAttribute('fill',   'url(#grad-base-drag)');
  pathCyan.setAttribute('fill',   'url(#grad-cyan-drag)');
  pathBlue.setAttribute('fill',   'url(#grad-blue-drag)');
  pathPurple.setAttribute('fill', 'url(#grad-purple-drag)');
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow-alert)');

  // Ramp up noise speed and displacement for background churn
  noiseStep = 0.04;
  displacementMult = 5.0;

  // Cycle through 3 wild shapes, each morphing to the next
  let variant = 0;
  function nextShape(): void {
    const pts = makeChurnPoints(variant % 3);
    const scale = 1.0 + (variant % 3) * 0.08; // slight scale variation
    processingTL = gsap.timeline({ onComplete: nextShape });
    processingTL
      .to(pathBase,   { attr: { d: pointsToPath(pts.map(p => ({ x: p.x * 1.0, y: p.y * 1.0 }))) }, duration: 0.55, ease: 'power2.inOut' }, 0)
      .to(pathCyan,   { attr: { d: pointsToPath(pts.map(p => ({ x: p.x * 0.82, y: p.y * 0.82 }))) }, duration: 0.48, ease: 'power3.inOut' }, 0.06)
      .to(pathBlue,   { attr: { d: pointsToPath(pts.map(p => ({ x: p.x * 0.88, y: p.y * 0.88 }))) }, duration: 0.52, ease: 'power2.inOut' }, 0.03)
      .to(pathPurple, { attr: { d: pointsToPath(pts.map(p => ({ x: p.x * 0.76, y: p.y * 0.76 }))) }, duration: 0.60, ease: 'power1.inOut' }, 0.09)
      .to(blobSpec,   { attr: { d: pointsToPath(pts.map(p => ({ x: p.x * 0.70, y: p.y * 0.70 }))) }, duration: 0.55, ease: 'power2.inOut' }, 0)
      .to(blobSvg,    { scale, rotation: variant % 2 === 0 ? 8 : -8, duration: 0.55, ease: 'power2.inOut' }, 0);
    variant++;
  }
  nextShape();

  // Spin the container slowly
  gsap.to(blobContainer, { rotation: 360, duration: 3.5, ease: 'none', repeat: -1 });
}

/** Stop the processing animation and return blob to idle. */
function stopProcessingAnimation(): void {
  processingTL?.kill();
  processingTL = null;
  gsap.killTweensOf(blobContainer, 'rotation');
  gsap.set(blobContainer, { rotation: 0 });
  gsap.set(blobSvg, { rotation: 0 });

  // Restore gradients and morph
  pathBase.setAttribute('fill',   'url(#grad-base)');
  pathCyan.setAttribute('fill',   'url(#grad-cyan)');
  pathBlue.setAttribute('fill',   'url(#grad-blue)');
  pathPurple.setAttribute('fill', 'url(#grad-purple)');
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow)');

  noiseStep = IDLE_NOISE_STEP;
  displacementMult = IDLE_DISPLACEMENT;
  startMorph();
  startDrift();
}

/** Success burst — explode outward, flash white, then elastic settle. */
function successAnimation(): void {
  stopProcessingAnimation();
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow-alert)');
  gsap.timeline({
    onComplete: () => blobGlowWrap.setAttribute('filter', 'url(#outer-glow)'),
  })
    .to(blobSvg, { scale: 1.8, duration: 0.14, ease: 'power3.out' })
    .to(blobHotspot, { attr: { opacity: 1.0 }, duration: 0.08 }, 0)
    .to(blobSvg, { scale: 0.7, duration: 0.12, ease: 'power3.in' })
    .to(blobSvg, { scale: 1.0, duration: 0.9,  ease: 'elastic.out(1.2, 0.38)' })
    .to(blobHotspot, { attr: { opacity: 0.28 }, duration: 0.5, ease: 'power2.out' }, 0.2);
}

/** Error shake — red tinge, fast horizontal shake, settle. */
function errorAnimation(): void {
  stopProcessingAnimation();
  pathBase.setAttribute('fill', 'url(#grad-base-drag)');
  gsap.timeline({
    onComplete: () => {
      pathBase.setAttribute('fill', 'url(#grad-base)');
    },
  })
    .to(blobSvg, { x: -12, duration: 0.07, ease: 'power2.out' })
    .to(blobSvg, { x:  12, duration: 0.07, ease: 'power2.inOut' })
    .to(blobSvg, { x:  -8, duration: 0.06, ease: 'power2.inOut' })
    .to(blobSvg, { x:   6, duration: 0.06, ease: 'power2.inOut' })
    .to(blobSvg, { x:   0, duration: 0.10, ease: 'power2.out' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE CHAT  — speech-bubble conversation that pops out of the blob on drop
// ═══════════════════════════════════════════════════════════════════════════════

const fileChat     = document.getElementById('file-chat')!;
const fcBubble     = document.getElementById('file-chat-bubble')!;
const fcMessages   = document.getElementById('file-chat-messages')!;
const fcInput      = document.getElementById('file-chat-input') as HTMLTextAreaElement;
const fcForm       = document.getElementById('file-chat-form') as HTMLFormElement;
const fcClose      = document.getElementById('file-chat-close')!;
const fcBack       = document.getElementById('file-chat-back')!;
const fcFilename   = document.getElementById('file-chat-filename')!;

// Chat panel lives in the same Electron window as the blob.
// When opened we ask the main process to grow the window; on close we shrink back.
const CHAT_W = 360;
const CHAT_H = 480;

/** Currently active file (set when the chat is opened). */
let activeChatFile: File | null = null;
/** Native filesystem path for activeChatFile — resolved via webUtils in the drop handler. */
let activeChatFilePath = '';

/** Add a message bubble to the chat. Returns the element so callers can mutate it. */
function fcAddMessage(text: string, role: 'bot' | 'user'): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `fc-msg ${role}`;
  div.textContent = text;
  fcMessages.appendChild(div);
  // Scroll to bottom
  fcMessages.scrollTop = fcMessages.scrollHeight;
  return div;
}

/** Show the animated "..." typing indicator. Returns a remove() function. */
function fcShowTyping(): () => void {
  const div = document.createElement('div');
  div.className = 'fc-msg bot typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  fcMessages.appendChild(div);
  fcMessages.scrollTop = fcMessages.scrollHeight;
  return () => div.remove();
}

/** Append quick-reply chips for each available conversion target. */
function fcAddChips(targets: string[], onPick: (target: string) => void): void {
  if (targets.length === 0) return;
  const row = document.createElement('div');
  row.className = 'fc-chips';
  targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'fc-chip';
    btn.textContent = `→ ${t.toUpperCase()}`;
    btn.addEventListener('click', () => {
      row.remove();
      onPick(t);
    });
    row.appendChild(btn);
  });
  fcMessages.appendChild(row);
  fcMessages.scrollTop = fcMessages.scrollHeight;
}

/**
 * DOCX-specific chat: immediately offer "Convert to PDF" as the primary action.
 * Starts the processing animation the moment the user clicks the chip.
 */
function openFileChatDocx(file: File, nativePath: string): void {
  activeChatFile = file;
  activeChatFilePath = nativePath;

  fcMessages.innerHTML = '';
  fcInput.value = '';
  fcInput.style.height = 'auto';
  fcFilename.textContent = file.name;

  window.focusBubble.resizeToChatSize(CHAT_W, CHAT_H);

  setTimeout(() => {
    fileChat.removeAttribute('hidden');
    gsap.fromTo(fcBubble,
      { scale: 0.82, opacity: 0 },
      { scale: 1, opacity: 1, duration: 0.38, ease: 'back.out(1.8)' },
    );

    setTimeout(() => {
      fcAddMessage(`Got "${file.name}" — a DOCX file. What would you like to do?`, 'bot');

      // Big primary chip for Convert to PDF + secondary options
      fcAddChips(['pdf', 'txt', 'html', 'rtf'], (target) => {
        fcAddMessage(`Converting to ${target.toUpperCase()}…`, 'user');
        runConversion(nativePath, target);
      });

      setTimeout(() => fcInput.focus(), 200);
    }, 320);
  }, 120);
}

/**
 * Open the file chat overlay for the given dropped file.
 * Grows the Electron window to CHAT_W×CHAT_H, animates the panel in,
 * then posts the bot's opening question + conversion chips.
 */
function openFileChat(file: File, nativePath: string): void {
  activeChatFile = file;
  activeChatFilePath = nativePath;

  // Clear any previous conversation
  fcMessages.innerHTML = '';
  fcInput.value = '';
  fcInput.style.height = 'auto';

  // Show filename in header
  fcFilename.textContent = file.name;

  // Grow window to chat size first, then reveal the panel
  window.focusBubble.resizeToChatSize(CHAT_W, CHAT_H);

  setTimeout(() => {
    fileChat.removeAttribute('hidden');

    gsap.fromTo(fcBubble,
      { scale: 0.82, opacity: 0 },
      { scale: 1, opacity: 1, duration: 0.38, ease: 'back.out(1.8)' },
    );

    setTimeout(() => fcInput.focus(), 380);

    // Bot opening question — then load conversion options
    setTimeout(() => {
      const removeTyping = fcShowTyping();
      setTimeout(async () => {
        removeTyping();
        fcAddMessage(`Got "${file.name}" — what would you like to do with it?`, 'bot');

        if (nativePath) {
          const targets = await window.focusBubble.getConversionTargets(nativePath);
          if (targets.length > 0) {
            const hint = fcAddMessage('Convert it to:', 'bot');
            hint.style.marginBottom = '2px';
            fcAddChips(targets, (target) => {
              fcAddMessage(`Convert to ${target.toUpperCase()}`, 'user');
              runConversion(nativePath, target);
            });
          } else {
            fcAddMessage('I can\'t convert this file type — but you can type what you\'d like me to do.', 'bot');
          }
        } else {
          fcAddMessage('Type what you\'d like me to do with this file.', 'bot');
        }
      }, 650);
    }, 280);
  }, 120);
}

/** Run a file conversion and report back in the chat. */
async function runConversion(filePath: string, targetExt: string): Promise<void> {
  const removeTyping = fcShowTyping();
  startProcessingAnimation();
  try {
    const result = await window.focusBubble.convertFile(filePath, targetExt);
    removeTyping();
    if (result.ok && result.outputPath) {
      successAnimation();
      const msg = fcAddMessage(`Done! "${result.outputPath.split('/').pop()}" saved to Downloads — click to reveal.`, 'bot');
      msg.style.cursor = 'pointer';
      msg.style.textDecoration = 'underline';
      msg.style.textDecorationColor = 'rgba(103,232,249,0.4)';
      msg.addEventListener('click', () => window.focusBubble.revealFile(result.outputPath!));
    } else {
      errorAnimation();
      fcAddMessage(`Couldn't convert: ${result.message}`, 'bot');
    }
  } catch {
    removeTyping();
    errorAnimation();
    fcAddMessage('Something went wrong during conversion.', 'bot');
  }
}

/**
 * Close the chat and return the window to bubble size.
 * Called by both the ✕ dismiss and the ← back button.
 */
function closeFileChat(): void {
  // Stop any in-progress conversion animation
  if (processingTL) stopProcessingAnimation();

  gsap.to(fcBubble, {
    scale: 0.78, opacity: 0,
    duration: 0.20, ease: 'power2.in',
    onComplete: () => {
      fileChat.setAttribute('hidden', '');
      fcMessages.innerHTML = '';
      activeChatFile = null;
      activeChatFilePath = '';
      // Reset any drift offset so the blob sits centred in the restored window
      gsap.set(blobContainer, { x: 0, y: 0 });
      // Shrink window back to bubble dimensions
      window.focusBubble.resizeToChatSize(BUBBLE_RESTORE_W, BUBBLE_RESTORE_H);
    },
  });
}

// Bubble dimensions to restore — kept in sync with BUBBLE_W/H from main.ts
const BUBBLE_RESTORE_W = 240;
const BUBBLE_RESTORE_H = 240;

/** Handle a user message submission. */
function handleFileChatSubmit(): void {
  const text = fcInput.value.trim();
  if (!text) return;

  fcInput.value = '';
  fcInput.style.height = 'auto';

  fcAddMessage(text, 'user');

  const lower = text.toLowerCase();
  const filePath = activeChatFilePath;

  // Detect "convert to <ext>" intent
  const convertMatch = lower.match(/\b(?:convert|change|turn|export|save)\b.*?\b(pdf|txt|html|rtf|docx|png|jpg|jpeg|webp|tiff|bmp|gif|heic)\b/);
  if (convertMatch) {
    if (filePath) { runConversion(filePath, convertMatch[1]); }
    else { fcAddMessage('File path not available — try dropping the file again.', 'bot'); }
    return;
  }

  // Detect bare extension mention: "pdf", "to pdf", "as pdf", "docx", etc.
  const extMatch = lower.match(/\b(?:to |as |in |convert to |change to )?(pdf|txt|html|rtf|docx|png|jpg|jpeg|webp|tiff|bmp|gif|heic)\b/);
  if (extMatch) {
    if (filePath) { runConversion(filePath, extMatch[1]); }
    else { fcAddMessage('File path not available — try dropping the file again.', 'bot'); }
    return;
  }

  // Fallback
  const removeTyping = fcShowTyping();
  setTimeout(() => {
    removeTyping();
    fcAddMessage('I\'m not sure what to do with that yet — try saying "convert to DOCX" or pick a format above.', 'bot');
  }, 600);
}

// ── Auto-resize textarea as user types ───────────────────────────────────────
fcInput.addEventListener('input', () => {
  fcInput.style.height = 'auto';
  fcInput.style.height = `${Math.min(fcInput.scrollHeight, 80)}px`;
});

// ── Send on Enter (Shift+Enter = newline) ────────────────────────────────────
fcInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleFileChatSubmit();
  }
});

fcForm.addEventListener('submit', (e) => {
  e.preventDefault();
  handleFileChatSubmit();
});

fcClose.addEventListener('click', closeFileChat);
// Back arrow — same as close: dismiss chat and return to idle blob
fcBack.addEventListener('click', closeFileChat);

// ── Drag event listeners ──────────────────────────────────────────────────────
//
// macOS + Chromium drag-drop quirks we work around here:
//
//  1. dragenter/dragleave fire on EVERY child element the cursor crosses.
//     We use a ref-count (dragEnterCount) to avoid flickering; only act when
//     it crosses 0↔1.
//
//  2. On macOS, e.dataTransfer.types is EMPTY on dragleave (OS strips it).
//     Do NOT gate dragleave on types check — just decrement the counter
//     unconditionally.
//
//  3. dragover MUST call preventDefault() on every frame or the drop event
//     is cancelled by the OS before it reaches the window.
//
//  4. stopPropagation() on all handlers prevents any outer listener from
//     accidentally re-triggering state.
//
//  5. The #drop-zone div (full-window, z-index -1 normally) is promoted to
//     pointer-events:all during a drag so macOS has a non-transparent surface
//     to deliver events to, even when the cursor is over empty SVG space.

const dropZone = document.getElementById('drop-zone') as HTMLElement;

function enableDropZone(): void {
  dropZone.style.pointerEvents = 'all';
}
function disableDropZone(): void {
  dropZone.style.pointerEvents = 'none';
}

document.addEventListener('dragenter', (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  if (isExpanded) return;
  // Only react to actual file drags, not text/links/HTML
  if (!e.dataTransfer?.types.includes('Files')) return;

  dragEnterCount++;
  if (dragEnterCount === 1) {
    enableDropZone();
    enterDragState();
  }
});

document.addEventListener('dragover', (e: DragEvent) => {
  // Must preventDefault on EVERY dragover tick or macOS cancels the drop
  e.preventDefault();
  e.stopPropagation();
  if (isExpanded) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (e: DragEvent) => {
  e.stopPropagation();
  if (isExpanded) return;
  // NOTE: do NOT check e.dataTransfer.types here — macOS strips types on dragleave.
  // Only treat it as a real leave when the cursor exits the window itself
  // (relatedTarget is null = cursor left the Chromium window entirely).
  if (e.relatedTarget !== null) {
    // Cursor moved to a child element — not a real leave, skip.
    return;
  }

  dragEnterCount = 0;
  disableDropZone();
  exitDragState();
});

document.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault(); // stop browser from navigating to the file
  e.stopPropagation();
  dragEnterCount = 0;
  disableDropZone();

  if (isExpanded) return;

  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) {
    exitDragState();
    return;
  }

  const file = files[0];
  // webUtils.getPathForFile is the correct Electron 32+ API for native paths
  const nativePath = window.focusBubble.getFilePath(file);
  const isDocx = file.name.toLowerCase().endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  console.log('FocusBubble: file dropped', {
    name: file.name,
    nativePath: nativePath || '(unavailable)',
    type: file.type || '(unknown type)',
    isDocx,
    size: `${(file.size / 1024).toFixed(1)} KB`,
  });

  // Gulp animation plays regardless of file type
  gulpAnimation();
  setTimeout(() => {
    exitDragState();
    setTimeout(() => {
      if (isDocx && nativePath) {
        // DOCX: open chat and immediately trigger PDF conversion with animation
        openFileChatDocx(file, nativePath);
      } else {
        // Any other file: open the general chat
        openFileChat(file, nativePath);
      }
    }, 480);
  }, 280);
});

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE COMMAND SYSTEM
// Double-click blob → listen → Airia classifies intent → execute action.
// Falls back to text input when no microphone is available.
// ═══════════════════════════════════════════════════════════════════════════════

type FsResult = { name: string; filePath: string; size: number; modified: number; ext: string };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const fsOverlay       = document.getElementById('file-search')       as HTMLElement;
const fsBubbleEl      = document.getElementById('fs-bubble')         as HTMLElement;
const fsBack          = document.getElementById('fs-back')           as HTMLButtonElement;
const fsCloseBtn      = document.getElementById('fs-close')          as HTMLButtonElement;
const fsTitleText     = document.getElementById('fs-title-text')     as HTMLElement;
const fsTitleIcon     = document.getElementById('fs-title-icon')     as SVGSVGElement;
const vcListenView    = document.getElementById('vc-listen-view')    as HTMLElement;
const vcOrb           = document.getElementById('vc-orb')            as HTMLElement;
const vcBars          = document.getElementById('vc-bars')           as HTMLElement;
const vcLabel         = document.getElementById('vc-label')          as HTMLElement;
const vcTypeInstead   = document.getElementById('vc-type-instead')   as HTMLButtonElement;
const fsInputWrap     = document.getElementById('fs-input-wrap')     as HTMLElement;
const fsInput         = document.getElementById('fs-input')          as HTMLInputElement;
const fsMic           = document.getElementById('fs-mic')            as HTMLButtonElement;
const fsSubmit        = document.getElementById('fs-submit')         as HTMLButtonElement;
const fsStatus        = document.getElementById('fs-status')         as HTMLElement;
const fsResults       = document.getElementById('fs-results')        as HTMLElement;
const vcScreenWrap    = document.getElementById('vc-screenshot-wrap') as HTMLElement;
const vcScreenImg     = document.getElementById('vc-screenshot-img') as HTMLImageElement;
const vcScreenLabel   = document.getElementById('vc-screenshot-label') as HTMLElement;

const FS_W = 520;
const FS_H = 480;
let fsOpen = false;
let vcListening = false;

// ── speech synthesis ──────────────────────────────────────────────────────────

/** Default ElevenLabs voice — Adam (deep, calm, natural). Override per-call via voiceId. */
const EL_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

let _currentAudio: HTMLAudioElement | null = null;

/**
 * Speak text via ElevenLabs TTS (primary) with macOS `say` as auto-fallback.
 * Main process handles the API call and returns a base64 MP3 data URL.
 * If ElevenLabs fails, main fires `say` automatically — nothing extra needed here.
 *
 * Extra params (_volume, _rate, _pitch) kept for call-site compatibility.
 */
/**
 * Speak text and return a Promise that resolves when playback finishes.
 * Callers can `await vcSpeak(...)` then immediately open the mic safely.
 */
async function vcSpeak(
  text: string,
  _volume?: number,
  _rate?: number,
  _pitch?: number,
  voiceId = EL_DEFAULT_VOICE_ID,
): Promise<void> {
  // Stop anything currently playing
  if (_currentAudio) {
    _currentAudio.pause();
    _currentAudio.src = '';
    _currentAudio = null;
  }

  let result: { ok: boolean; dataUrl?: string } | null = null;
  try {
    result = await window.focusBubble.speak(text, voiceId);
  } catch (err) {
    console.error('FocusBubble: vcSpeak IPC error:', err);
    return;
  }

  if (result?.ok && result.dataUrl) {
    console.log('FocusBubble: ElevenLabs TTS — playing, bytes:', result.dataUrl.length);
    await new Promise<void>((resolve) => {
      const audio = new Audio(result!.dataUrl);
      audio.volume = 0.9;
      _currentAudio = audio;
      audio.onended  = () => { _currentAudio = null; resolve(); };
      audio.onerror  = () => { _currentAudio = null; resolve(); };
      audio.play().catch(() => { _currentAudio = null; resolve(); });
    });
  } else {
    // say fallback is running in main process — estimate its duration
    console.log('FocusBubble: say fallback speaking');
    const estimatedMs = Math.max(1500, text.length * 65);
    await new Promise<void>(r => setTimeout(r, estimatedMs));
  }
}

// ── open / close ──────────────────────────────────────────────────────────────

function openFileSearch(): void {
  if (fsOpen) return;
  fsOpen = true;
  cancelIdleTimer();

  // Reset to listening state
  vcScreenWrap.hidden = true;
  fsResults.hidden = true;
  fsResults.innerHTML = '';
  fsStatus.hidden = true;
  fsInputWrap.hidden = true;
  vcListenView.removeAttribute('hidden');
  fsBubbleEl.classList.add('vc-mode');
  fsTitleText.textContent = 'Hey, what can I help with?';
  vcLabel.textContent = 'Listening…';
  vcLabel.classList.remove('vc-transcript');
  vcBars.className = 'idle';

  fsOverlay.removeAttribute('hidden');
  gsap.fromTo(fsBubbleEl,
    { scale: 0.84, opacity: 0, y: 10 },
    { scale: 1,    opacity: 1, y: 0, duration: 0.28, ease: 'back.out(1.7)' },
  );

  window.focusBubble.resizeToChatSize(FS_W, FS_H);

  // After pop-in: speak greeting, then open mic once audio is done
  setTimeout(async () => {
    await vcSpeak("Hey! What can I do for you?");
    vcStartListening();
  }, 320);
}

function closeFileSearch(): void {
  if (meetingActive) return;   // don't close panel while recording
  vcStopListening();
  // Stop ElevenLabs audio element (if playing)
  if (_currentAudio) { _currentAudio.pause(); _currentAudio.src = ''; _currentAudio = null; }
  // Stop say fallback (if running)
  window.focusBubble.speakStop();
  gsap.to(fsBubbleEl, {
    scale: 0.82, opacity: 0, y: 8,
    duration: 0.17, ease: 'power2.in',
    onComplete: () => {
      fsOverlay.setAttribute('hidden', '');
      fsResults.innerHTML = '';
      fsResults.hidden = true;
      fsStatus.hidden = true;
      fsInput.value = '';
      vcScreenWrap.hidden = true;
      fsBubbleEl.classList.remove('vc-mode');
      fsOpen = false;
      gsap.set(blobContainer, { x: 0, y: 0 });
      window.focusBubble.resizeToChatSize(BUBBLE_RESTORE_W, BUBBLE_RESTORE_H);
      resetIdleTimer();
    },
  });
}

// ── Voice Recognition (MediaRecorder → Whisper WebWorker) ────────────────────
// Fully local — no Google, no Apple servers, no internet needed after first run.
// Pipeline:
//   1. getUserMedia → AudioContext (capture raw PCM samples directly)
//   2. AnalyserNode for silence detection → ScriptProcessorNode collects samples
//   3. Float32Array sent to whisper.worker.ts → Xenova/whisper-tiny.en
//   4. Transcript returned → vcProcessTranscript()
// ElevenLabs handles TTS (speaking). Whisper handles STT (listening).

let _micStream: MediaStream | null = null;
let _audioCtx: AudioContext | null = null;
let _silenceTimer: ReturnType<typeof setTimeout> | null = null;
const SILENCE_MS = 1200;
const MAX_REC_MS = 10000;
const SAMPLE_RATE = 16000;

// ── Whisper worker — created once, lives for the app lifetime ─────────────────
let _worker: Worker | null = null;
let _workerReady = false;
let _workerError = '';

function getWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  _worker.onmessage = (e: MessageEvent<{ type: string; message?: string; text?: string }>) => {
    const { type, message, text } = e.data;
    if (type === 'ready') {
      _workerReady = true;
      console.log('FocusBubble STT: Whisper model ready');
    } else if (type === 'loading') {
      console.log('FocusBubble STT:', message);
      // Update label if the panel is open and we're showing the "downloading" state
      if (fsOpen && message) {
        vcLabel.textContent = message;
        vcLabel.classList.remove('vc-transcript');
      }
    } else if (type === 'transcript') {
      _handleTranscript(text ?? '');
    } else if (type === 'error') {
      console.error('FocusBubble STT: worker error —', message);
      _workerError = message ?? 'Unknown error';
      vcLabel.textContent = 'Voice error — try again or type below.';
      setTimeout(vcStartListening, 1000);
    }
  };
  _worker.onerror = (e) => {
    console.error('FocusBubble STT: worker crashed:', e.message);
    _worker = null;
    _workerReady = false;
  };
  return _worker;
}

// Kick off worker (and model download) as soon as the renderer loads
// so it's ready by the time the user double-clicks the bubble.
getWorker();

let _pendingTranscriptResolve: ((text: string) => void) | null = null;

function _handleTranscript(text: string): void {
  if (_pendingTranscriptResolve) {
    const resolve = _pendingTranscriptResolve;
    _pendingTranscriptResolve = null;
    resolve(text);
  }
}

function _transcribeWithWhisper(samples: Float32Array, sampleRate: number): Promise<string> {
  return new Promise((resolve) => {
    _pendingTranscriptResolve = resolve;
    getWorker().postMessage({ type: 'transcribe', audio: samples, sampleRate }, [samples.buffer]);
    // Safety timeout — resolve empty if worker hangs
    setTimeout(() => {
      if (_pendingTranscriptResolve === resolve) {
        _pendingTranscriptResolve = null;
        resolve('');
      }
    }, 20_000);
  });
}

function vcStartListening(): void {
  // Wait for TTS to finish before opening the mic
  if (_currentAudio && !_currentAudio.paused) {
    const audioEl = _currentAudio;
    const prev = audioEl.onended as (() => void) | null;
    audioEl.onended = () => {
      if (prev) prev();
      if (!vcListenView.hasAttribute('hidden') && fsOpen) vcStartListening();
    };
    return;
  }
  if (vcListening) return;

  const worker = getWorker();

  vcListening = true;
  vcOrb.classList.add('active');
  vcBars.className = 'listening';
  vcLabel.classList.remove('vc-transcript');

  if (!_workerReady) {
    vcLabel.textContent = _workerError
      ? 'Voice model failed — type below.'
      : 'Loading voice model… (one-time download)';
    if (_workerError) {
      vcListening = false;
      vcOrb.classList.remove('active');
      vcBars.className = 'idle';
      return;
    }
    // Worker still loading — wait for it, then retry
    const waitReady = (): void => {
      if (_workerReady) { vcListening = false; vcStartListening(); return; }
      if (_workerError) {
        vcListening = false;
        vcOrb.classList.remove('active');
        vcBars.className = 'idle';
        return;
      }
      setTimeout(waitReady, 300);
    };
    setTimeout(waitReady, 300);
    return;
  }

  vcLabel.textContent = 'Listening…';

  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: SAMPLE_RATE, echoCancellation: true, noiseSuppression: true },
    video: false,
  }).then(stream => {
    _micStream = stream;

    const actx = new AudioContext({ sampleRate: SAMPLE_RATE });
    _audioCtx = actx;

    const src = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);

    // ScriptProcessor collects raw PCM samples (deprecated but still reliable in Electron)
    const bufSize = 4096;
    const processor = actx.createScriptProcessor(bufSize, 1, 1);
    src.connect(processor);
    processor.connect(actx.destination);

    const allSamples: Float32Array[] = [];
    const freq = new Uint8Array(analyser.frequencyBinCount);
    let hasSpeech = false;
    let collecting = true;

    processor.onaudioprocess = (e) => {
      if (!collecting) return;
      const data = e.inputBuffer.getChannelData(0);
      allSamples.push(new Float32Array(data));

      analyser.getByteFrequencyData(freq);
      const avg = freq.reduce((s, v) => s + v, 0) / freq.length;

      if (avg > 10) {
        hasSpeech = true;
        if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
      } else if (hasSpeech && !_silenceTimer) {
        _silenceTimer = setTimeout(stopRecording, SILENCE_MS);
      }
    };

    const maxTimer = setTimeout(stopRecording, MAX_REC_MS);

    async function stopRecording(): Promise<void> {
      if (!collecting) return;
      collecting = false;
      clearTimeout(maxTimer);
      if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }

      processor.disconnect();
      src.disconnect();
      stream.getTracks().forEach(t => t.stop());
      actx.close().catch(() => { /* ok */ });
      _micStream = null;
      _audioCtx = null;
      vcListening = false;
      vcOrb.classList.remove('active');
      vcBars.className = 'idle';

      if (!fsOpen || vcListenView.hasAttribute('hidden')) return;

      if (!hasSpeech || allSamples.length === 0) {
        console.log('FocusBubble STT: no speech — restarting');
        vcLabel.textContent = 'Listening…';
        setTimeout(vcStartListening, 300);
        return;
      }

      // Merge all chunks into one Float32Array
      const total = allSamples.reduce((n, a) => n + a.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of allSamples) { merged.set(chunk, offset); offset += chunk.length; }

      console.log(`FocusBubble STT: captured ${merged.length} samples (${(merged.length / SAMPLE_RATE).toFixed(1)}s) — sending to Whisper`);

      vcBars.className = 'processing';
      vcLabel.textContent = 'Thinking…';

      const transcript = await _transcribeWithWhisper(merged, SAMPLE_RATE);
      console.log(`FocusBubble STT: transcript="${transcript}"`);

      if (!transcript?.trim()) {
        vcLabel.textContent = 'Didn\'t catch that — try again.';
        setTimeout(vcStartListening, 600);
        return;
      }
      if (/^\s*\(.*\)\s*$/.test(transcript.trim())) {
        setTimeout(vcStartListening, 300);
        return;
      }
      if (meetingActive) { setTimeout(vcStartListening, 400); return; }

      vcLabel.textContent = `"${transcript}"`;
      vcLabel.classList.add('vc-transcript');
      vcProcessTranscript(transcript);
    }

    // Attach stopRecording so vcStopListening() can trigger it
    (_micStream as MediaStream & { _fbStop?: () => void })._fbStop = stopRecording;

    console.log('FocusBubble STT: recording started (Whisper pipeline)');
  }).catch(err => {
    console.error('FocusBubble STT: getUserMedia failed:', err);
    vcListening = false;
    vcOrb.classList.remove('active');
    vcBars.className = 'idle';
    vcLabel.textContent = (err as Error).name === 'NotAllowedError'
      ? 'Mic blocked — allow in System Settings → Privacy & Security → Microphone'
      : 'Mic unavailable — type your command below.';
    vcLabel.classList.remove('vc-transcript');
  });

  // Suppress unused-variable warning for worker reference
  void worker;
}

function vcStopListening(): void {
  if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
  const stream = _micStream as (MediaStream & { _fbStop?: () => void }) | null;
  if (stream?._fbStop) { stream._fbStop(); }
  else if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); }
  _micStream = null;
  if (_audioCtx) { _audioCtx.close().catch(() => { /* ok */ }); _audioCtx = null; }
  vcListening = false;
  vcOrb.classList.remove('active');
  vcBars.className = 'idle';
}

function vcSwitchToTextInput(placeholder?: string): void {
  vcStopListening();
  vcListenView.setAttribute('hidden', '');
  fsInputWrap.removeAttribute('hidden');
  fsBubbleEl.classList.remove('vc-mode');
  if (placeholder) fsInput.placeholder = placeholder;
  fsInput.focus();
}

// ── intent processing ─────────────────────────────────────────────────────────

async function vcProcessTranscript(transcript: string): Promise<void> {
  const s = transcript.toLowerCase().trim();

  // ── Reminder voice reply (highest priority) ───────────────────────────────
  if (activeReminderTaskId) {
    if (/\b(yes|yeah|done|completed?|finished?|yep|sure|yup)\b/.test(s)) {
      await handleReminderResponse('yes'); return;
    }
    if (/\b(no|not yet|nope|later|haven't|not done)\b/.test(s)) {
      await handleReminderResponse('no'); return;
    }
    if (/\b(snooze|remind|again|later|wait)\b/.test(s)) {
      await handleReminderResponse('snooze'); return;
    }
  }

  // ── Planner yes/no intercept ──────────────────────────────────────────────
  if (plannerAwaitingYN) {
    if (/\b(yes|yeah|yep|sure|yup|have|do|i do)\b/.test(s)) {
      plannerAwaitingYN = false;
      plannerYnRow.setAttribute('hidden', '');
      plannerInputRow.removeAttribute('hidden');
      plannerBtnRow.removeAttribute('hidden');
      plannerCollecting = true;
      await vcSpeak("Great! Tell me your plans one at a time. Say 'done' when you're finished.");
      vcStartListening();
      return;
    }
    if (/\b(no|nope|not really|nothing|none)\b/.test(s)) {
      plannerAwaitingYN = false;
      await vcSpeak("No problem! Have a productive day.");
      closePlannerView();
      closeFileSearch();
      return;
    }
  }

  // ── Planner task collection ───────────────────────────────────────────────
  if (plannerCollecting) {
    if (/\b(done|that'?s? all|finish|finished|stop|end|no more)\b/.test(s)) {
      await finishPlanning();
      return;
    }
    await addPlannerTask(transcript);
    setTimeout(vcStartListening, 400);
    return;
  }

  vcBars.className = 'processing';
  vcLabel.textContent = 'Got it…';
  vcLabel.classList.remove('vc-transcript');

  // Agitate blob while classifying (local — instant)
  noiseStep = 0.022;
  displacementMult = 2.8;

  let intent: Record<string, unknown>;
  try {
    intent = await window.focusBubble.classifyIntent(transcript);
  } catch {
    intent = { intent: 'unknown', query: transcript };
  }

  noiseStep = IDLE_NOISE_STEP;
  displacementMult = IDLE_DISPLACEMENT;
  vcBars.className = 'idle';
  const action = String(intent.intent ?? 'unknown');

  if (action === 'search_file') {
    const kw = String(intent.keywords ?? transcript);
    fsTitleText.textContent = `Searching for "${kw}"`;
    await vcDoSearch(kw);

  } else if (action === 'take_screenshot') {
    fsTitleText.textContent = 'Taking screenshot…';
    await vcDoScreenshot();

  } else if (action === 'open_app') {
    const app = String(intent.app ?? '');
    fsTitleText.textContent = `Opening ${app}…`;
    await vcDoOpenApp(app);

  } else if (action === 'close_app') {
    const app = String(intent.app ?? '');
    fsTitleText.textContent = `Closing ${app}…`;
    await vcDoCloseApp(app);

  } else if (action === 'play_song') {
    const query = String(intent.query ?? transcript);
    fsTitleText.textContent = `Playing on Spotify…`;
    await vcDoSpotifyPlay(query);

  } else if (action === 'start_meeting') {
    await startMeeting();

  } else if (action === 'stop_meeting') {
    if (meetingActive) {
      await stopMeeting();
    } else {
      vcSpeak("No meeting is recording right now.");
      setTimeout(closeFileSearch, 1800);
    }

  } else if (action === 'read_notifications') {
    const nCount = notifications.length;
    const nMsg = nCount === 0
      ? "You're all caught up — no new notifications."
      : nCount === 1
        ? "You have one new notification."
        : `You've got ${nCount} new notifications.`;
    vcSpeak(nMsg, 0.55, 0.88, 1.06);
    vcLabel.textContent = nMsg;
    setTimeout(closeFileSearch, 2200);

  } else if (action === 'tell_time') {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    const msg = `It's ${h12}:${m} ${ampm}.`;
    fsTitleText.textContent = 'Current Time';
    vcLabel.textContent = msg;
    vcSpeak(msg, 0.55, 0.88, 1.06);
    setTimeout(closeFileSearch, 2200);

  } else if (action === 'tell_date') {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const msg = `Today is ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}.`;
    fsTitleText.textContent = "Today's Date";
    vcLabel.textContent = msg;
    vcSpeak(msg, 0.55, 0.88, 1.06);
    setTimeout(closeFileSearch, 2500);

  } else if (action === 'greeting') {
    const replies = [
      "I'm doing great, thanks for asking! How can I help you today?",
      "All good here! Ready to help. What do you need?",
      "Feeling good and ready to assist! What's up?",
    ];
    const msg = replies[Math.floor(Math.random() * replies.length)];
    fsTitleText.textContent = 'Hey!';
    vcLabel.textContent = msg;
    vcSpeak(msg).then(() => { if (fsOpen && !vcListenView.hasAttribute('hidden')) vcStartListening(); });

  } else if (action === 'joke') {
    const jokes = [
      "Why do programmers prefer dark mode? Because light attracts bugs!",
      "Why did the computer go to therapy? It had too many windows open.",
      "I told my computer I needed a break. Now it won't stop sending me Kit-Kat ads.",
      "Why do Java developers wear glasses? Because they don't C sharp!",
    ];
    const msg = jokes[Math.floor(Math.random() * jokes.length)];
    fsTitleText.textContent = 'Here you go 😄';
    vcLabel.textContent = msg;
    vcSpeak(msg).then(() => { if (fsOpen && !vcListenView.hasAttribute('hidden')) vcStartListening(); });

  } else if (action === 'help') {
    const msg = "I can search files, open or close apps, take screenshots, play Spotify, record meetings, manage your daily tasks, call you for task check-ins, and more. Just speak naturally!";
    fsTitleText.textContent = 'What I can do';
    vcLabel.textContent = msg;
    vcSpeak(msg).then(() => { if (fsOpen && !vcListenView.hasAttribute('hidden')) vcStartListening(); });

  } else if (action === 'call_reminder') {
    fsTitleText.textContent = 'Phone Reminder';
    await vcDoTwilioCall();

  } else {
    // unknown — speak then retry once audio is done
    vcLabel.textContent = "Didn't understand — try again or type below.";
    vcSpeak("Hmm, I'm not sure what you meant. Could you say that again?").then(() => {
      if (fsOpen && !vcListenView.hasAttribute('hidden')) vcStartListening();
    });
  }
}

// ── Twilio phone reminder call ────────────────────────────────────────────────
async function vcDoTwilioCall(): Promise<void> {
  const { userPhone, twilioSid, twilioToken, twilioPhone } = settings;
  if (!userPhone || !twilioSid || !twilioToken || !twilioPhone) {
    vcLabel.textContent = 'Setup required — open Settings';
    await vcSpeak('Please set up your phone number and Twilio credentials in Settings first.');
    return;
  }
  const pending = plannerTasks.filter(t => !t.completed);
  if (pending.length === 0) {
    await vcSpeak('You have no pending tasks — great job!');
    return;
  }
  vcLabel.textContent = `Calling ${userPhone}…`;
  await vcSpeak(`Calling you now to review your ${pending.length} pending ${pending.length === 1 ? 'task' : 'tasks'}.`);
  try {
    const result = await window.focusBubble.twilioCall({
      sid: twilioSid, token: twilioToken, fromPhone: twilioPhone, toPhone: userPhone, tasks: pending,
    });
    if (result.ok) {
      vcLabel.textContent = 'Call placed! Check your phone.';
      await vcSpeak('Call placed — check your phone!');
    } else {
      vcLabel.textContent = 'Call failed';
      await vcSpeak(`The call failed. ${result.error ?? 'Please check your Twilio credentials in Settings.'}`);
    }
  } catch {
    await vcSpeak('Something went wrong placing the call.');
  }
}

// ── action handlers ───────────────────────────────────────────────────────────

async function vcDoSearch(query: string): Promise<void> {
  vcListenView.setAttribute('hidden', '');
  fsStatus.innerHTML = '<span class="fs-dots"><span></span><span></span><span></span></span> Searching…';
  fsStatus.hidden = false;
  fsResults.hidden = true;
  fsResults.innerHTML = '';

  noiseStep = 0.025;
  displacementMult = 3.0;

  try {
    const results = await window.focusBubble.searchFiles(query);
    noiseStep = IDLE_NOISE_STEP;
    displacementMult = IDLE_DISPLACEMENT;
    vcRenderResults(results);

    const n = results.length;
    const msg = n === 0
      ? 'No files found — try different keywords.'
      : `Found ${n} match${n === 1 ? '' : 'es'}. ${n > 0 ? results.slice(0, 3).map(r => r.name).join(', ') : ''}`;
    const spokenResult = n === 0
      ? "I couldn't find anything. Try different keywords."
      : n === 1
        ? `Found one file — ${results[0].name}.`
        : `Found ${n} file${n === 1 ? '' : 's'} — showing the top results.`;
    vcSpeak(spokenResult, 0.55, 0.88, 1.06);
    fsStatus.textContent = msg.slice(0, 80);
  } catch {
    noiseStep = IDLE_NOISE_STEP;
    displacementMult = IDLE_DISPLACEMENT;
    fsResults.innerHTML = `<div class="fs-empty"><strong>Search failed</strong>Something went wrong — please try again.</div>`;
    fsStatus.textContent = 'Error';
    fsResults.hidden = false;
  }
}

async function vcDoScreenshot(): Promise<void> {
  vcListenView.setAttribute('hidden', '');
  fsStatus.innerHTML = '<span class="fs-dots"><span></span><span></span><span></span></span> Capturing…';
  fsStatus.hidden = false;

  const res = await window.focusBubble.takeScreenshot();
  fsStatus.hidden = true;

  if (res.ok && res.dataUrl && res.filePath) {
    vcScreenImg.src = res.dataUrl;
    const fname = res.filePath.split('/').pop() ?? 'screenshot.png';
    vcScreenLabel.textContent = `Saved to Downloads: ${fname}`;
    vcScreenWrap.removeAttribute('hidden');
    successAnimation();
    vcSpeak('Done! Screenshot saved to your Downloads folder.', 0.55, 0.90, 1.08);
  } else {
    fsStatus.textContent = `Screenshot failed: ${res.error ?? 'unknown error'}`;
    fsStatus.hidden = false;
    errorAnimation();
    vcSpeak("Sorry, I couldn't capture the screen. Please try again.", 0.5, 0.88, 1.05);
  }
}

async function vcDoOpenApp(appName: string): Promise<void> {
  vcListenView.setAttribute('hidden', '');
  fsStatus.hidden = false;
  fsStatus.textContent = `Opening ${appName}…`;

  // Fire open + TTS in parallel — app opens while voice is being fetched
  const [res] = await Promise.all([
    window.focusBubble.openApp(appName),
    vcSpeak(`Sure, opening ${appName} now!`),
  ]);
  if (res.ok) {
    successAnimation();
    setTimeout(closeFileSearch, 800);
  } else {
    fsStatus.textContent = `Couldn't open "${appName}". Is it installed?`;
    errorAnimation();
    vcSpeak(`I couldn't find ${appName}. Is it installed?`);
  }
}

async function vcDoCloseApp(appName: string): Promise<void> {
  vcListenView.setAttribute('hidden', '');
  fsStatus.hidden = false;
  fsStatus.textContent = `Closing ${appName}…`;

  const [res] = await Promise.all([
    window.focusBubble.closeApp(appName),
    vcSpeak(`Closing ${appName} now.`),
  ]);
  if (res.ok) {
    successAnimation();
    setTimeout(closeFileSearch, 800);
  } else {
    fsStatus.textContent = `Couldn't close "${appName}".`;
    errorAnimation();
    vcSpeak(`I couldn't close ${appName}. It may not be running.`);
  }
}

async function vcDoSpotifyPlay(query: string): Promise<void> {
  vcListenView.setAttribute('hidden', '');
  fsStatus.hidden = false;
  fsStatus.textContent = `Playing "${query}" on Spotify…`;

  const [res] = await Promise.all([
    window.focusBubble.spotifyPlay(query),
    vcSpeak(`Playing ${query} on Spotify.`),
  ]);
  if (res.ok) {
    successAnimation();
    setTimeout(closeFileSearch, 900);
  } else {
    fsStatus.textContent = `Couldn't play on Spotify. Is it installed?`;
    errorAnimation();
    vcSpeak("I couldn't play that on Spotify. Make sure it's installed.");
  }
}

// ── file results rendering ────────────────────────────────────────────────────

function fsFmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
function fsFmtAge(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 3600000 * 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(d / 86400000);
  return days < 7 ? `${days}d ago` : new Date(ms).toLocaleDateString();
}
function fsShortPath(full: string): string {
  const parts = full.split('/');
  return parts.length <= 3 ? full : `…/${parts.slice(-3, -1).join('/')}`;
}

function vcRenderResults(results: FsResult[]): void {
  fsResults.innerHTML = '';
  if (results.length === 0) {
    fsResults.innerHTML = `<div class="fs-empty"><strong>No matches</strong>Try different keywords or a shorter query.</div>`;
    fsResults.hidden = false;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'fs-row';
    row.title = r.filePath;
    const ext = r.ext ? `<span class="fs-ext">${r.ext}</span>` : '';
    row.innerHTML = `
      <div class="fs-row-info">
        <span class="fs-row-name">${r.name}${ext}</span>
        <span class="fs-row-sub">
          <span class="fs-row-path">${fsShortPath(r.filePath)}</span>
          <span class="fs-row-age">${fsFmtAge(r.modified)} · ${fsFmtSize(r.size)}</span>
        </span>
      </div>
      <button class="fs-open-btn" type="button">Open</button>
    `;
    (row.querySelector('.fs-open-btn') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      window.focusBubble.openFile(r.filePath);
    });
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.fs-open-btn')) return;
      window.focusBubble.revealFile(r.filePath);
    });
    gsap.fromTo(row, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.18,
      delay: results.indexOf(r) * 0.025, ease: 'power2.out' });
    frag.appendChild(row);
  }
  fsResults.appendChild(frag);
  fsResults.hidden = false;
}

// ── text input fallback event wiring ──────────────────────────────────────────

fsBack.addEventListener('click', closeFileSearch);
fsCloseBtn.addEventListener('click', closeFileSearch);

fsInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') { e.preventDefault(); vcProcessTranscript(fsInput.value.trim()); }
  if (e.key === 'Escape') closeFileSearch();
});

fsSubmit.addEventListener('click', () => {
  const t = fsInput.value.trim();
  if (t) vcProcessTranscript(t);
});

fsMic.addEventListener('click', () => {
  vcSwitchToVoice();
});

vcTypeInstead.addEventListener('click', () => {
  vcSwitchToTextInput('Type a command or search…');
});

function vcSwitchToVoice(): void {
  fsInputWrap.setAttribute('hidden', '');
  vcListenView.removeAttribute('hidden');
  fsBubbleEl.classList.add('vc-mode');
  vcStartListening();
}

// ── double-click trigger ──────────────────────────────────────────────────────

let expandTimer: ReturnType<typeof setTimeout> | null = null;
const EXPAND_DELAY = 220; // ms — shorter than OS dblclick threshold (~500ms)

// ═══════════════════════════════════════════════════════════════════════════════
// EXPAND / COLLAPSE
// ═══════════════════════════════════════════════════════════════════════════════
// Default panel size — overridden by saved size loaded asynchronously on init
let PANEL_W = 600;
let PANEL_H = 620;
let isExpanded = false;

// ── Idle mode state ──────────────────────────────────────────────────────────
let isIdle = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// ── Idle visualizer state ─────────────────────────────────────────────────────
const VIZ_BARS   = 8;
const VIZ_REST_H = 3;    // bar height when paused (px)
const VIZ_MAX_H  = 16;   // max bar height when playing (px)
const VIZ_SMOOTH = 0.18; // lerp factor per frame

let vizRafId:   number | null = null;
let vizPollId:  ReturnType<typeof setInterval> | null = null;
let vizPlaying  = false;
let vizTargets  = new Float32Array(VIZ_BARS).fill(VIZ_REST_H);
let vizHeights  = new Float32Array(VIZ_BARS).fill(VIZ_REST_H);

function drawViz(): void {
  const ctx = idleViz.getContext('2d');
  if (!ctx) return;

  // Check whether all bars have settled at rest height
  const allAtRest = vizHeights.every(h => Math.abs(h - VIZ_REST_H) < 0.15);

  // Nothing to show — canvas already clear, stop the rAF loop until playing resumes
  if (!vizPlaying && allAtRest) {
    ctx.clearRect(0, 0, idleViz.width, idleViz.height);
    vizRafId = null;
    return;
  }

  const W = idleViz.width;
  const H = idleViz.height;
  ctx.clearRect(0, 0, W, H);

  const barW = 5;
  const gap  = (W - VIZ_BARS * barW) / (VIZ_BARS + 1);

  for (let i = 0; i < VIZ_BARS; i++) {
    vizHeights[i] += (vizTargets[i] - vizHeights[i]) * VIZ_SMOOTH;
    const h = Math.max(2, vizHeights[i]);
    const x = gap + i * (barW + gap);
    const y = (H - h) / 2;

    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(103,232,249,0.90)');
    grad.addColorStop(1, 'rgba(56,189,248,0.50)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, h, 2);
    ctx.fill();
  }

  vizRafId = requestAnimationFrame(drawViz);
}

function randomiseVizTargets(): void {
  for (let i = 0; i < VIZ_BARS; i++) {
    vizTargets[i] = VIZ_REST_H + Math.random() * (VIZ_MAX_H - VIZ_REST_H);
  }
}

/** Restart the rAF loop if it has self-terminated (happens when bars reach rest). */
function ensureVizDrawing(): void {
  if (vizRafId === null) drawViz();
}

function startViz(): void {
  vizPlaying = false;
  vizHeights.fill(VIZ_REST_H);
  vizTargets.fill(VIZ_REST_H);
  // Canvas starts blank — rAF loop not started until Spotify is detected playing.

  vizPollId = setInterval(async () => {
    const { playing } = await window.focusBubble.getSpotifyState();
    vizPlaying = playing;
    if (playing) {
      randomiseVizTargets();
      ensureVizDrawing();   // wake up draw loop if it self-terminated
    } else {
      vizTargets.fill(VIZ_REST_H);
      // drawViz will self-terminate once bars reach rest
    }
  }, 500);
}

function stopViz(): void {
  if (vizPollId) { clearInterval(vizPollId);       vizPollId = null; }
  if (vizRafId)  { cancelAnimationFrame(vizRafId); vizRafId  = null; }
  const ctx = idleViz.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, idleViz.width, idleViz.height);
}

// ── Meeting notetaker state ───────────────────────────────────────────────────
let meetingActive    = false;
let meetingStartTime = 0;
let meetingChunks: { ts: number; text: string }[] = [];
let meetingElapsedTimer: ReturnType<typeof setInterval> | null = null;
let meetingChunkAbort = false;

function resetIdleTimer(): void {
  if (settings.idleTimeoutSeconds === 0 || isExpanded || fsOpen) return;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  idleTimer = setTimeout(enterIdleMode, settings.idleTimeoutSeconds * 1000);
}

function cancelIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function enterIdleMode(): void {
  if (isIdle || isExpanded || fsOpen) return;
  isIdle = true;
  cancelIdleTimer();
  stopDrift();
  badge.hidden = true;
  idleDot.hidden = pendingCount === 0;

  const shape = settings.idleShape;
  if (shape === 'hidden') {
    stopMorph();
    window.focusBubble.enterIdleMode(settings.idlePosition);
    return;
  }

  idlePill.classList.toggle('shape-circle', shape === 'circle');
  idlePill.removeAttribute('hidden');
  gsap.set(idlePill, { opacity: 0, scale: 0.72 });
  startViz();

  gsap.timeline({
    onComplete: () => {
      stopMorph();
      window.focusBubble.enterIdleMode(settings.idlePosition);
    },
  })
    .to(blobGlowWrap, { opacity: 0, scale: 0.6, duration: 0.35, ease: 'power2.in' }, 0)
    .to(idlePill,     { opacity: 1, scale: 1,   duration: 0.32, ease: 'back.out(1.8)' }, 0.08);
}

function exitIdleMode(): void {
  if (!isIdle) return;
  isIdle = false;
  stopViz();
  window.focusBubble.exitIdleMode();

  const shape = settings.idleShape;
  if (shape === 'hidden') {
    gsap.set(blobGlowWrap, { opacity: 1, scale: 1 });
    startMorph();
    startDrift();
    resetIdleTimer();
    return;
  }

  gsap.set(blobGlowWrap, { opacity: 0, scale: 0.6 });
  startMorph(); // restart before the fade-in so it's already alive when visible

  gsap.timeline({
    onComplete: () => {
      idlePill.setAttribute('hidden', '');
      idlePill.classList.remove('shape-circle');
      startDrift();
      if (pendingCount > 0) {
        badge.hidden = false;
        badgeCount.textContent = pendingCount > 99 ? '99+' : String(pendingCount);
      }
      resetIdleTimer();
    },
  })
    .to(idlePill,     { opacity: 0, scale: 0.7, duration: 0.22, ease: 'power2.in' }, 0)
    .to(blobGlowWrap, { opacity: 1, scale: 1,   duration: 0.38, ease: 'back.out(1.5)' }, 0.12);
}

// ── Settings UI ──────────────────────────────────────────────────────────────

function syncSettingsToUI(): void {
  settingTimeoutEl.value  = String(settings.idleTimeoutSeconds);
  settingPositionEl.value = settings.idlePosition;
  settingShapeEl.value    = settings.idleShape;
  settingUserPhoneEl.value   = settings.userPhone;
  settingTwilioSidEl.value   = settings.twilioSid;
  settingTwilioTokenEl.value = settings.twilioToken;
  settingTwilioPhoneEl.value = settings.twilioPhone;
  settingAutoCallEl.value    = settings.autoCallTime;
}

function openSettings(): void {
  syncSettingsToUI();
  settingsCard.removeAttribute('hidden');
  gsap.fromTo(settingsCard,
    { opacity: 0, x: 20 },
    { opacity: 1, x: 0, duration: 0.24, ease: 'power2.out' },
  );
}

function closeSettings(): void {
  gsap.to(settingsCard, {
    opacity: 0, x: 20, duration: 0.18, ease: 'power2.in',
    onComplete: () => settingsCard.setAttribute('hidden', ''),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEETING NOTETAKER
// ═══════════════════════════════════════════════════════════════════════════════

/** Enter blob "recording mode": red glow, faster morph, idle disabled. */
function enterRecordingMode(): void {
  cancelIdleTimer();
  noiseStep = ALERT_NOISE_STEP * 1.4;
  displacementMult = ALERT_DISPLACEMENT * 1.1;
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow-alert)');
  // Slow red-breathing pulse — gives the blob a "heartbeat" feel while recording
  gsap.to(blobSvg, { scale: 1.08, duration: 1.8, ease: 'sine.inOut', repeat: -1, yoyo: true });
}

/** Restore blob to normal idle state after recording ends. */
function exitRecordingMode(): void {
  gsap.killTweensOf(blobSvg);
  gsap.set(blobSvg, { scale: 1 });
  noiseStep = IDLE_NOISE_STEP;
  displacementMult = IDLE_DISPLACEMENT;
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow)');
  resetIdleTimer();
}

/** Format elapsed seconds as M:SS */
function fmtMeetingElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/** Tick the elapsed time display every second. */
function startElapsedTicker(): void {
  if (meetingElapsedTimer) clearInterval(meetingElapsedTimer);
  meetingElapsedTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - meetingStartTime) / 1000);
    meetingElapsedEl.textContent = fmtMeetingElapsed(secs);
  }, 1000);
}

/**
 * Record one ~30s audio chunk and transcribe it via ElevenLabs STT.
 * Returns the transcript text, or empty string on silence / error.
 */
function recordChunk(): Promise<string> {
  return new Promise(resolve => {
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      video: false,
    }).then(stream => {
      const blobParts: Blob[] = [];
      const mime = ['audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) ?? '';
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 16000,
      });

      rec.ondataavailable = e => { if (e.data.size > 0) blobParts.push(e.data); };

      // Stop after 30s or when the abort flag is set
      const hardStop = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 30_000);
      const abortPoll = setInterval(() => {
        if (meetingChunkAbort && rec.state === 'recording') rec.stop();
      }, 200);

      rec.onstop = async () => {
        clearTimeout(hardStop);
        clearInterval(abortPoll);
        stream.getTracks().forEach(t => t.stop());
        if (blobParts.length === 0) { resolve(''); return; }
        try {
          const audioBlob = new Blob(blobParts, { type: mime || 'audio/webm' });
          const b64: string = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => { res((fr.result as string).split(',')[1] ?? ''); };
            fr.onerror = rej;
            fr.readAsDataURL(audioBlob);
          });
          const text = await window.focusBubble.transcribeAudio(b64, mime || 'audio/webm');
          resolve(text.trim());
        } catch { resolve(''); }
      };

      rec.start();
    }).catch(() => resolve(''));
  });
}

/**
 * Continuous loop: records chunk → transcribes → stores → repeats.
 * Runs until meetingChunkAbort is set to true by stopMeeting().
 */
async function runMeetingLoop(): Promise<void> {
  while (!meetingChunkAbort) {
    meetingChunkLabel.textContent = 'Recording…';
    const text = await recordChunk();
    if (meetingChunkAbort) break;
    if (text) {
      meetingChunks.push({ ts: Date.now(), text });
      // Show last 3 chunks in live preview
      meetingTranscriptPrv.textContent = meetingChunks.slice(-3).map(c => c.text).join('\n\n');
      meetingTranscriptPrv.scrollTop = meetingTranscriptPrv.scrollHeight;
      meetingChunkLabel.textContent = `Chunk ${meetingChunks.length} saved ✓`;
    } else {
      meetingChunkLabel.textContent = 'No speech — continuing…';
    }
  }
}

async function startMeeting(): Promise<void> {
  if (meetingActive) return;
  meetingActive = true;
  meetingChunkAbort = false;
  meetingChunks = [];
  meetingStartTime = await window.focusBubble.getMeetingTime();

  // Switch voice panel to meeting view
  vcListenView.setAttribute('hidden', '');
  fsInputWrap.setAttribute('hidden', '');
  meetingView.removeAttribute('hidden');
  meetingElapsedEl.textContent = '0:00';
  meetingChunkLabel.textContent = 'Starting…';
  meetingTranscriptPrv.textContent = '';
  meetingStopBtn.disabled = false;
  fsTitleText.textContent = 'Meeting Notes';

  cancelIdleTimer();
  enterRecordingMode();
  startElapsedTicker();

  vcSpeak("Listening to your meeting now. Say stop notes when you're done.");
  runMeetingLoop(); // intentionally fire-and-forget — runs in background
}

async function stopMeeting(): Promise<void> {
  if (!meetingActive) return;
  meetingActive = false;
  meetingChunkAbort = true;

  if (meetingElapsedTimer) { clearInterval(meetingElapsedTimer); meetingElapsedTimer = null; }
  exitRecordingMode();

  meetingChunkLabel.textContent = 'Generating PDF…';
  meetingStopBtn.disabled = true;

  vcSpeak("Meeting ended — saving your notes now.");

  const title = `Meeting Notes - ${new Date(meetingStartTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const result = await window.focusBubble.generateMeetingPdf({
    title,
    startTime: meetingStartTime,
    chunks: meetingChunks,
  });

  meetingStopBtn.disabled = false;

  if (result.ok && result.filePath) {
    meetingChunkLabel.textContent = 'Notes saved!';
    successAnimation();
    vcSpeak("Notes saved! Check your Downloads folder.").then(() => {
      window.focusBubble.revealFile(result.filePath!);
      setTimeout(closeFileSearch, 1200);
    });
  } else {
    meetingChunkLabel.textContent = 'Save failed — check console.';
    errorAnimation();
    vcSpeak("Something went wrong saving the notes. Sorry about that.");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY PLANNER
// ═══════════════════════════════════════════════════════════════════════════════

// ── Planner state ─────────────────────────────────────────────────────────────
let plannerTasks: DailyTask[] = [];
let activeReminderTaskId: string | null = null;
let plannerCollecting = false;  // true while user is dictating tasks
let plannerAwaitingYN = false;  // true while waiting for yes/no to "do you have plans?"
let plannerFlowActive = false;  // true while morning greeting flow is running — blocks reminder interruptions

// ── Helpers ───────────────────────────────────────────────────────────────────
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function makePlanId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseDueTime(title: string): { dueTime: string; dueMinutes: number } | undefined {
  // Matches: "11am", "3:30pm", "at 14:00", "by 9", "9:00 am"
  const m = title.match(/\b(?:at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return undefined;
  let hours = parseInt(m[1], 10);
  const mins = parseInt(m[2] ?? '0', 10);
  const ampm = (m[3] ?? '').toLowerCase();
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  if (!ampm && hours < 6) hours += 12; // assume pm for ambiguous small numbers
  return { dueTime: m[0].trim(), dueMinutes: hours * 60 + mins };
}

// ── Render task list ──────────────────────────────────────────────────────────
function renderPlannerTasks(): void {
  plannerTaskList.innerHTML = '';
  plannerTasks.forEach(task => {
    const row = document.createElement('div');
    row.className = 'planner-task-item' + (task.completed ? ' done' : '');

    const check = document.createElement('div');
    check.className = 'planner-task-check' + (task.completed ? ' done' : '');
    check.textContent = task.completed ? '✓' : '';
    check.addEventListener('click', () => {
      task.completed = !task.completed;
      window.focusBubble.updateTask(task.id, { completed: task.completed });
      renderPlannerTasks();
    });

    const titleEl = document.createElement('span');
    titleEl.className = 'planner-task-title';
    titleEl.textContent = task.title;

    const remove = document.createElement('span');
    remove.className = 'planner-task-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      plannerTasks = plannerTasks.filter(t => t.id !== task.id);
      window.focusBubble.saveTasksToday(plannerTasks);
      renderPlannerTasks();
    });

    row.appendChild(check);
    if (task.dueTime) {
      const badge = document.createElement('span');
      badge.className = 'planner-task-time';
      badge.textContent = task.dueTime;
      row.appendChild(badge);
    }
    row.appendChild(titleEl);
    row.appendChild(remove);
    plannerTaskList.appendChild(row);
  });
}

// ── Open/close planner view ───────────────────────────────────────────────────
function openPlannerView(): void {
  vcListenView.setAttribute('hidden', '');
  fsInputWrap.setAttribute('hidden', '');
  meetingView.setAttribute('hidden', '');
  plannerView.removeAttribute('hidden');
  fsTitleText.textContent = 'My Day';
}

function closePlannerView(): void {
  plannerView.setAttribute('hidden', '');
  plannerCollecting = false;
  plannerAwaitingYN = false;
  plannerFlowActive = false;
  vcListenView.removeAttribute('hidden');
}

// ── Add task ──────────────────────────────────────────────────────────────────
const FILLER_ONLY = /^(uh+|um+|hmm+|oh+|ah+|er+|okay|ok|yeah|yes|no|nope|sure|right|so|well|like|you\s*know)\.?$/i;

async function addPlannerTask(text: string): Promise<void> {
  let trimmed = text.trim();
  if (!trimmed) return;

  // Strip filler-only "tasks" from STT noise
  if (FILLER_ONLY.test(trimmed)) return;

  // Enforce max length (120 chars) to avoid accidental whole-sentence dumps
  if (trimmed.length > 120) trimmed = trimmed.slice(0, 120).trim();

  // Minimum meaningful length (at least 3 chars)
  if (trimmed.length < 3) return;

  // Deduplicate: skip if we already have a task with same normalised title
  const normalised = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (plannerTasks.some(t => t.title.toLowerCase().replace(/\s+/g, ' ') === normalised)) {
    vcSpeak("You've already added that task.");
    return;
  }

  const parsed = parseDueTime(trimmed);
  const task: DailyTask = {
    id: makePlanId(),
    title: trimmed,
    dueTime: parsed?.dueTime,
    dueMinutes: parsed?.dueMinutes,
    completed: false,
  };
  plannerTasks.push(task);
  await window.focusBubble.saveTasksToday(plannerTasks);
  renderPlannerTasks();
  vcSpeak(`Got it — ${trimmed}`);
}

// ── Finish planning session ───────────────────────────────────────────────────
async function finishPlanning(): Promise<void> {
  plannerCollecting = false;
  plannerInputRow.setAttribute('hidden', '');
  plannerBtnRow.setAttribute('hidden', '');
  vcStopListening();
  const count = plannerTasks.length;
  if (count === 0) {
    await vcSpeak("No tasks added. Have a great day!");
  } else {
    await vcSpeak(`Got it! You have ${count} ${count === 1 ? 'task' : 'tasks'} planned. I'll check in with you throughout the day.`);
  }
  closePlannerView();
  closeFileSearch();
}

// ── Morning greeting flow ─────────────────────────────────────────────────────
async function startMorningFlow(): Promise<void> {
  if (plannerFlowActive) return; // prevent double-trigger
  plannerFlowActive = true;

  // Start fresh — tasks live in main-process memory, cleared at midnight
  plannerTasks = [];

  if (!fsOpen) openFileSearch();
  openPlannerView();
  renderPlannerTasks();

  plannerGreeting.textContent = `${getGreeting()}! Ready to plan your day?`;
  plannerYnRow.removeAttribute('hidden');
  plannerInputRow.setAttribute('hidden', '');
  plannerBtnRow.setAttribute('hidden', '');

  await window.focusBubble.setGreetedToday();
  await vcSpeak(`${getGreeting()}! I'm FocusBubble. Do you have any plans for today?`);
  plannerAwaitingYN = true;
  plannerFlowActive = false;
}

// ── Reminder system ───────────────────────────────────────────────────────────
async function showReminder(task: DailyTask): Promise<void> {
  activeReminderTaskId = task.id;
  // Update remindedAt so it doesn't immediately re-trigger
  await window.focusBubble.updateTask(task.id, { remindedAt: Date.now() });

  reminderText.textContent = task.dueTime
    ? `Have you done: "${task.title}" (due ${task.dueTime})?`
    : `Just checking in — have you: "${task.title}"?`;
  reminderOverlay.removeAttribute('hidden');

  const greeting = getGreeting();
  vcSpeak(`${greeting}! Just checking in — have you ${task.title}?`);
}

function hideReminder(): void {
  reminderOverlay.setAttribute('hidden', '');
  activeReminderTaskId = null;
}

async function handleReminderResponse(response: 'yes' | 'no' | 'snooze'): Promise<void> {
  if (!activeReminderTaskId) return;
  const id = activeReminderTaskId;
  hideReminder();
  if (response === 'yes') {
    await window.focusBubble.updateTask(id, { completed: true });
    plannerTasks = plannerTasks.map(t => t.id === id ? { ...t, completed: true } : t);
    vcSpeak("Great job! Keep it up.");
  } else if (response === 'no') {
    vcSpeak("No worries, I'll check again later.");
  } else {
    await window.focusBubble.updateTask(id, { snoozedUntil: Date.now() + 30 * 60_000 });
    vcSpeak("Snoozed for 30 minutes.");
  }
}

async function checkAndShowReminder(): Promise<void> {
  if (activeReminderTaskId) return; // already showing one
  if (plannerFlowActive || plannerCollecting || plannerAwaitingYN) return; // busy with planning flow
  try {
    const tasks = await window.focusBubble.getDueTasks() as DailyTask[];
    if (tasks.length > 0) showReminder(tasks[0]);
  } catch {
    // silently ignore — reminder will retry next 60s cycle
  }
}

function expandPanel(): void {
  if (isExpanded) return;
  isExpanded = true;
  cancelIdleTimer();

  stopDrift();

  // ── Phase 1 (0–120ms): blob splatters outward ─────────────────────────
  noiseStep = 0.032;
  displacementMult = EXPAND_DISPLACEMENT;

  // ── Phase 2 (120–340ms): blob fades while still morphing ──────────────
  gsap.timeline()
    .to(blobSvg, {
      scale: 1.45,
      duration: 0.12,
      ease: 'power2.out',
    })
    .to(blobSvg, {
      scale: 2.2,
      opacity: 0,
      duration: 0.22,
      ease: 'power3.in',
      onComplete: () => {
        // ── Phase 3: show panel ──────────────────────────────────────────
        stopMorph();
        noiseStep = IDLE_NOISE_STEP;
        displacementMult = IDLE_DISPLACEMENT;

        blobContainer.style.display = 'none';
        blobContainer.style.zIndex = '-1';
        panel.hidden = false;
        resizeHandles.forEach(h => h.classList.remove('hidden'));
        window.focusBubble.expand(PANEL_W, PANEL_H);

        // Panel irises in from the blob's centre
        gsap.fromTo(panel,
          { opacity: 0, scale: 0.78, transformOrigin: 'center center' },
          { opacity: 1, scale: 1.00, duration: 0.42, ease: 'back.out(1.5)' },
        );
        renderTables();
      },
    });
}

function collapsePanel(): void {
  console.log('collapsePanel called, isExpanded=', isExpanded);
  if (!isExpanded) return;
  isExpanded = false;

  gsap.to(panel, {
    opacity: 0, scale: 0.75, transformOrigin: 'center center',
    duration: 0.22, ease: 'power2.in',
    onComplete: () => {
      console.log('collapsePanel onComplete — restoring blob');
      panel.hidden = true;
      resizeHandles.forEach(h => h.classList.add('hidden'));
      blobContainer.style.display = '';
      blobContainer.style.zIndex = '';
      gsap.set(blobSvg, { scale: 0.45, opacity: 0 });
      gsap.to(blobSvg, { scale: 1, opacity: 1, duration: 0.48, ease: 'back.out(1.7)' });
      window.focusBubble.collapse();
      startMorph();
      startDrift();
      resetIdleTimer();
      if (isAlert) pulseTL?.resume();
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION STATE
// ═══════════════════════════════════════════════════════════════════════════════
let pendingCount = 0;
let notifications: FBNotification[] = [];

function receive(notif: FBNotification): void {
  const id = `${notif.platform}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  notifications.unshift({ ...notif, id });
  pendingCount++;
  updateBadge(pendingCount);
  // Wake from idle on new notification (exitIdleMode calls resetIdleTimer on complete)
  if (isIdle) { exitIdleMode(); }
  else { resetIdleTimer(); }
  if (!isExpanded) {
    enterAlertState();
    playAlertSound();
    // Extra-aggressive morph for high-urgency items
    if (notif.urgency === 'high') {
      noiseStep = ALERT_NOISE_STEP * 1.5;
      displacementMult = ALERT_DISPLACEMENT * 1.2;
    }
  } else {
    renderTables();
  }
}

function dismiss(id: string): void {
  notifications = notifications.filter(n => n.id !== id);
  pendingCount = Math.max(0, pendingCount - 1);
  updateBadge(pendingCount);
  if (pendingCount === 0) clearAlertState();
}

function snooze(id: string): void {
  const idx = notifications.findIndex(n => n.id === id);
  if (idx === -1) return;
  const [n] = notifications.splice(idx, 1);
  pendingCount = Math.max(0, pendingCount - 1);
  updateBadge(pendingCount);
  if (pendingCount === 0) clearAlertState();
  setTimeout(() => receive(n), 15 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE RENDERER
// ═══════════════════════════════════════════════════════════════════════════════
const PLATFORM_META: Record<string, { label: string; icon: string }> = {
  gmail: { label: 'Gmail', icon: '📧' },
  outlook: { label: 'Outlook', icon: '📮' },
  whatsapp: { label: 'WhatsApp', icon: '💬' },
  slack: { label: 'Slack', icon: '⚡' },
  teams: { label: 'Microsoft Teams', icon: '🟣' },
  instagram: { label: 'Instagram', icon: '📸' },
};
const getMeta = (p: string) => PLATFORM_META[p] ?? { label: p, icon: '🔔' };

function renderTables(): void {
  platformTables.innerHTML = '';

  if (notifications.length === 0) {
    platformTables.setAttribute('hidden', '');
    emptyState.removeAttribute('hidden');
    return;
  }

  platformTables.removeAttribute('hidden');
  emptyState.setAttribute('hidden', '');

  // Group by platform, preserving arrival order within each group
  const grouped = new Map<string, FBNotification[]>();
  for (const n of notifications) {
    const list = grouped.get(n.platform) ?? [];
    list.push(n);
    grouped.set(n.platform, list);
  }

  let delay = 0;
  for (const [platform, items] of grouped) {
    const section = buildSection(platform, items);
    section.style.animationDelay = `${delay}ms`;
    platformTables.appendChild(section);
    delay += 55;
  }
}

function buildSection(platform: string, items: FBNotification[]): HTMLElement {
  const meta = getMeta(platform);
  const section = document.createElement('section');
  section.className = 'platform-section';
  section.dataset.platform = platform;
  section.setAttribute('aria-label', `${meta.label} notifications`);
  section.innerHTML = `
    <div class="platform-section-header">
      <span class="platform-icon" aria-hidden="true">${meta.icon}</span>
      <span class="platform-name">${meta.label}</span>
      <span class="platform-count">${items.length}</span>
    </div>
    <table class="notif-table" role="table">
      <tbody></tbody>
    </table>
  `;
  const tbody = section.querySelector('tbody')!;
  for (const notif of items) tbody.appendChild(buildRow(notif));
  return section;
}

function buildRow(notif: FBNotification): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.setAttribute('aria-label', `Message from ${notif.sender}`);
  // Only show chevron/expand if we have a messageId to fetch body from
  const canExpand = !!notif.messageId;
  tr.innerHTML = `
    <td class="td-avatar" aria-hidden="true">${notif.avatar ?? '🔔'}</td>
    <td class="td-sender"  title="${notif.sender}">${notif.sender}</td>
    <td class="td-preview" title="${notif.preview}">${notif.preview}</td>
    <td class="td-time">${fmtTime(new Date(notif.timestamp))}</td>
    <td class="td-actions">
      <span class="urgency-badge urgency-${notif.urgency ?? 'low'}">${notif.urgency ?? 'low'}</span>
      <button class="action-btn read"   aria-label="Mark as read">Read</button>
      <button class="action-btn snooze" aria-label="Snooze">Snooze</button>
    </td>
    ${canExpand ? '<td class="td-chevron" aria-hidden="true">▶</td>' : ''}
  `;
  const [btnRead, btnSnooze] = tr.querySelectorAll<HTMLButtonElement>('.action-btn');

  // ── Read / Snooze buttons ─────────────────────────────────────────────────
  btnRead.addEventListener('click', e => {
    e.stopPropagation();
    dismiss(notif.id!);
    // Remove detail row too if expanded
    const detail = tr.nextElementSibling;
    if (detail?.classList.contains('notif-detail-row')) detail.remove();
    gsap.to(tr, {
      opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0,
      duration: 0.24, ease: 'power2.in',
      onComplete: () => { tr.remove(); checkEmpty(); },
    });
  });
  btnSnooze.addEventListener('click', e => {
    e.stopPropagation();
    snooze(notif.id!);
    const detail = tr.nextElementSibling;
    if (detail?.classList.contains('notif-detail-row')) detail.remove();
    gsap.to(tr, { opacity: 0, duration: 0.20, onComplete: () => { tr.remove(); checkEmpty(); } });
  });

  // ── Click row to expand email body ────────────────────────────────────────
  if (canExpand) {
    let expanded = false;
    let detailRow: HTMLTableRowElement | null = null;

    tr.addEventListener('click', async (e) => {
      // Don't expand if the user clicked a button
      if ((e.target as HTMLElement).closest('button')) return;
      e.stopPropagation();

      if (expanded && detailRow) {
        // Collapse
        expanded = false;
        tr.classList.remove('is-expanded');
        const rowToRemove = detailRow;
        detailRow = null;
        gsap.to(rowToRemove, {
          opacity: 0,
          duration: 0.15, ease: 'power2.in',
          onComplete: () => {
            rowToRemove.remove();
          },
        });
        return;
      }

      // Expand — insert a detail row immediately below
      expanded = true;
      tr.classList.add('is-expanded');

      detailRow = document.createElement('tr');
      detailRow.className = 'notif-detail-row';
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'notif-detail-loading';
      td.textContent = 'Loading…';
      detailRow.appendChild(td);
      tr.insertAdjacentElement('afterend', detailRow);
      gsap.from(detailRow, { opacity: 0, duration: 0.18 });

      // Fetch the body via IPC
      const body = await window.focusBubble.fetchEmailBody(notif.messageId!);

      // If the user collapsed while fetching, discard
      if (!expanded || !detailRow) return;

      td.className = 'notif-detail-body';
      td.textContent = body;
    });
  }

  return tr;
}

function checkEmpty(): void {
  if (notifications.length === 0) {
    platformTables.setAttribute('hidden', '');
    emptyState.removeAttribute('hidden');
    updateBadge(0);
    clearAlertState();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BADGE & ICON
// ═══════════════════════════════════════════════════════════════════════════════
function updateBadge(count: number): void {
  if (count === 0) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    badge.setAttribute('aria-label', `${count} unread`);
    badgeCount.textContent = count > 99 ? '99+' : String(count);
    gsap.fromTo(badge,
      { scale: 1.5 },
      { scale: 1, duration: 0.42, ease: 'elastic.out(1, 0.4)' },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL RESIZE  — 8-way edge/corner handles (all inside #panel, won't trigger
//                 the click-outside-panel collapse handler)
// ═══════════════════════════════════════════════════════════════════════════════
const MIN_W = 400;
const MIN_H = 300;

// Track whether a resize drag is active so the click-outside handler ignores it
let isResizing = false;

resizeHandles.forEach((handle) => {
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // prevent panel drag / collapse triggers

    const dir = handle.dataset.dir ?? 'se';
    const startX  = e.screenX;
    const startY  = e.screenY;
    const startW  = window.innerWidth;
    const startH  = window.innerHeight;
    // Screen-space window origin — needed for repositioning when dragging n/w edges
    // window.screenX/Y gives the window's position in screen coords
    const startWinX = window.screenX;
    const startWinY = window.screenY;

    isResizing = true;

    function onResizeMove(ev: MouseEvent): void {
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;

      let newW = startW;
      let newH = startH;
      let newX: number | undefined;
      let newY: number | undefined;

      // Horizontal axis
      if (dir.includes('e')) newW = Math.max(MIN_W, startW + dx);
      if (dir.includes('w')) {
        newW = Math.max(MIN_W, startW - dx);
        // Only move the window if we actually changed the width
        if (newW !== MIN_W || startW - dx >= MIN_W) {
          newX = startWinX + (startW - newW);
        }
      }

      // Vertical axis
      if (dir.includes('s')) newH = Math.max(MIN_H, startH + dy);
      if (dir.includes('n')) {
        newH = Math.max(MIN_H, startH - dy);
        if (newH !== MIN_H || startH - dy >= MIN_H) {
          newY = startWinY + (startH - newH);
        }
      }

      window.focusBubble.resizePanel(newW, newH, newX, newY);
    }

    function onResizeUp(): void {
      isResizing = false;
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeUp);
    }

    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRAG  (frameless window) — handled via blobHitOverlay mousedown below
// ═══════════════════════════════════════════════════════════════════════════════
let dragOrigin: { x: number; y: number } | null = null;
let hasDragged = false;
const DRAG_THRESHOLD = 4; // pixels — moves less than this = it's a click
function onMove(e: MouseEvent): void {
  if (!dragOrigin) return;
  const dx = e.screenX - dragOrigin.x;
  const dy = e.screenY - dragOrigin.y;
  if (!hasDragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  hasDragged = true;
  window.focusBubble.move(dx, dy);
  dragOrigin = { x: e.screenX, y: e.screenY };
}
function onUp(): void {
  dragOrigin = null;
  blobContainer.style.cursor = 'pointer';
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTION TRIGGERS
// ═══════════════════════════════════════════════════════════════════════════════

// Pass-through is permanently disabled in the main process so that file drags
// from Finder always land on the window. setIgnore is a no-op stub kept so
// any remaining call sites compile without changes.
function setIgnore(_ignore: boolean): void { /* no-op — window is always interactive */ }

// ── Blob click / drag ─────────────────────────────────────────────────────────
blobContainer.addEventListener('mousedown', (e: MouseEvent) => {
  if (isIdle) { exitIdleMode(); return; }
  resetIdleTimer();
  if (isExpanded || e.button !== 0) return;
  dragOrigin = { x: e.screenX, y: e.screenY };
  hasDragged = false;
  blobContainer.style.cursor = 'grabbing';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

blobContainer.addEventListener('click', () => {
  if (isExpanded || hasDragged) return;
  // Delay slightly so a double-click can cancel before expandPanel fires
  if (expandTimer) clearTimeout(expandTimer);
  expandTimer = setTimeout(() => { expandTimer = null; if (!isExpanded && !fsOpen) expandPanel(); }, EXPAND_DELAY);
});

blobContainer.addEventListener('dblclick', () => {
  // Cancel the queued single-click expand
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
  if (!isExpanded && !hasDragged && !fsOpen) openFileSearch();
});

blobContainer.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isExpanded ? collapsePanel() : expandPanel(); }
});

// ── Panel buttons ─────────────────────────────────────────────────────────────
btnClose.addEventListener('click', (e) => {
  e.stopPropagation();
  console.log('Renderer: Close button clicked');
  collapsePanel();
});

btnMarkAll.onclick = (e) => {
  e.stopPropagation();
  console.log('Renderer: Mark all read invoked');
  notifications = []; pendingCount = 0;
  updateBadge(0); clearAlertState(); renderTables();
};

// Prevent clicks on the hidden blob from triggering the outside-panel collapse handler
document.getElementById('app')?.addEventListener('mousedown', (e) => {
  if (isExpanded && blobContainer.contains(e.target as Node)) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && isExpanded) collapsePanel();
});

document.addEventListener('click', (e: MouseEvent) => {
  if (!isExpanded) return;
  if (isResizing) return; // ignore click fired at the end of a resize drag
  const path = e.composedPath();
  // Ignore clicks that hit the blob (it should be hidden but GSAP may restore display)
  if (path.includes(blobContainer as EventTarget)) return;
  if (!path.includes(panel as EventTarget)) {
    console.log('Renderer: Click outside panel');
    collapsePanel();
  }
});

// IPC
window.focusBubble.onNotification((n: FBNotification) => receive(n));

// ── Idle pill interaction ─────────────────────────────────────────────────────

idlePill.addEventListener('click', () => exitIdleMode());

idlePill.addEventListener('dblclick', () => {
  exitIdleMode();
  setTimeout(() => { if (!isIdle && !isExpanded) openFileSearch(); }, 480);
});

idlePill.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exitIdleMode(); }
});

// Drag pill to reposition without corrupting bubbleX/bubbleY
idlePill.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button !== 0) return;
  let hasDraggedPill = false;
  function onPillMove(ev: MouseEvent): void {
    if (!hasDraggedPill && Math.hypot(ev.movementX, ev.movementY) < 2) return;
    hasDraggedPill = true;
    window.focusBubble.idleMove(ev.movementX, ev.movementY);
  }
  function onPillUp(): void {
    document.removeEventListener('mousemove', onPillMove);
    document.removeEventListener('mouseup', onPillUp);
  }
  document.addEventListener('mousemove', onPillMove);
  document.addEventListener('mouseup', onPillUp);
  e.stopPropagation();
});

// ── Settings buttons ──────────────────────────────────────────────────────────

btnSettings.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
settingsBack.addEventListener('click', closeSettings);
settingsSave.addEventListener('click', () => {
  settings = {
    idleTimeoutSeconds: Number(settingTimeoutEl.value),
    idlePosition: settingPositionEl.value as FBSettings['idlePosition'],
    idleShape:    settingShapeEl.value    as FBSettings['idleShape'],
    userPhone:    settingUserPhoneEl.value.trim(),
    twilioSid:    settingTwilioSidEl.value.trim(),
    twilioToken:  settingTwilioTokenEl.value.trim(),
    twilioPhone:  settingTwilioPhoneEl.value.trim(),
    autoCallTime: settingAutoCallEl.value.trim(),
  };
  saveSettings(settings);
  window.focusBubble.saveTwilioSettings({
    sid: settings.twilioSid, token: settings.twilioToken,
    fromPhone: settings.twilioPhone, autoCallTime: settings.autoCallTime,
  });
  if (!isIdle) resetIdleTimer();
  closeSettings();
});

meetingStopBtn.addEventListener('click', () => {
  if (meetingActive) stopMeeting();
});

// ── Daily planner button listeners ────────────────────────────────────────────
plannerYesBtn.addEventListener('click', async () => {
  plannerAwaitingYN = false;
  plannerYnRow.setAttribute('hidden', '');
  plannerInputRow.removeAttribute('hidden');
  plannerBtnRow.removeAttribute('hidden');
  plannerCollecting = true;
  await vcSpeak("Great! Tell me your plans one at a time. Say 'done' when you're finished.");
  vcStartListening();
});

plannerNoBtn.addEventListener('click', async () => {
  plannerAwaitingYN = false;
  await vcSpeak("No problem! Have a productive day.");
  closePlannerView();
  closeFileSearch();
});

plannerInputSend.addEventListener('click', async () => {
  const text = plannerInput.value.trim();
  if (text) { plannerInput.value = ''; await addPlannerTask(text); }
});

plannerInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const text = plannerInput.value.trim();
    if (text) { plannerInput.value = ''; await addPlannerTask(text); }
  }
});

plannerDoneBtn.addEventListener('click', () => finishPlanning());

reminderYesBtn.addEventListener('click',    () => handleReminderResponse('yes'));
reminderNoBtn.addEventListener('click',     () => handleReminderResponse('no'));
reminderSnoozeBtn.addEventListener('click', () => handleReminderResponse('snooze'));

// ── Register planner event listener from main process ────────────────────────
window.focusBubble.onPlannerEvent(({ type }) => {
  if (type === 'morning-greeting') startMorningFlow();
  if (type === 'check-reminders')  checkAndShowReminder();
});

// ── Auto-call trigger from main-process scheduler ─────────────────────────────
window.focusBubble.onAutoCallTrigger(() => {
  if (!plannerCollecting && !plannerAwaitingYN && !plannerFlowActive) {
    if (!fsOpen) openFileSearch();
    vcDoTwilioCall();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WATER DROP SOUNDS  (Web Audio API)
// ═══════════════════════════════════════════════════════════════════════════════
let audioCtx: AudioContext | null = null;
const getCtx = () => (audioCtx ??= new AudioContext());

function playDrop(volume = 0.5, hz = 900, delayS = 0): void {
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + delayS;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(hz, t);
  osc.frequency.exponentialRampToValueAtTime(hz * 0.58, t + 0.20);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.007);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 380;

  osc.connect(hp); hp.connect(gain); gain.connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.28);
}

function playLaunchSound(): void {
  playDrop(0.36, 1120, 0.04);
  playDrop(0.52, 810, 0.20);
  playDrop(0.30, 620, 0.36);
}

function playAlertSound(): void {
  playDrop(0.44, 1000, 0.00);
  playDrop(0.18, 500, 0.09);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════
function fmtTime(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return 'Yesterday';
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
/** Request mic access at startup so macOS shows the permission prompt early. */
async function primeMicPermission(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop — we only needed the grant, not an active stream
    stream.getTracks().forEach(t => t.stop());
    console.log('FocusBubble: microphone permission granted');
  } catch (e) {
    console.warn('FocusBubble: microphone permission denied —', (e as Error).message);
  }
}

function init(): void {
  // Entrance: materialise from nothing with a gentle bounce
  gsap.from(blobContainer, {
    scale: 0, opacity: 0,
    duration: 0.85, ease: 'back.out(2.2)', delay: 0.18,
    onComplete: () => {
      startMorph();
      startDrift();
      resetIdleTimer();
    },
  });

  // Water drop sound timed to the "landing"
  setTimeout(playLaunchSound, 300);

  // Prime mic permission silently in the background
  primeMicPermission();
}

// Load persisted panel size before anything runs, then kick off init
window.focusBubble.getPanelSize().then(({ width, height }) => {
  PANEL_W = width;
  PANEL_H = height;
}).catch(() => { /* use defaults */ }).finally(() => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
});
