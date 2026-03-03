/**
 * FocusBubble – main.ts (Main Process)
 *
 * Responsibilities:
 *  • Create the transparent, frameless, always-on-top floating window
 *  • Handle IPC messages from the renderer (move window, collapse, etc.)
 *  • Poll for notifications every 60s, process them through the Airia Brain
 *    AI agent, and push enriched results to the renderer
 */

import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell, systemPreferences } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import started from 'electron-squirrel-startup';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { fetchNewGmailNotifications, fetchEmailBody } from './notifications/gmailPoller';
import { convertFile, getSupportedTargets } from './fileConverter';

// Load .env so process.env.AIRIA_API_KEY is available
dotenv.config();

// ─── Chromium flags (must be set before app 'ready') ─────────────────────────
// SpeechSynthesis          — keeps speechSynthesis available as a fallback
// AudioServiceOutOfProcess — stable audio pipeline on macOS
// autoplay-policy          — Audio elements play without user gesture (for TTS)
// NOTE: We use MediaRecorder (not webkitSpeechRecognition) for STT — it is
// fully local via SFSpeechRecognizer and requires no Google network access.
app.commandLine.appendSwitch('enable-features', 'SpeechSynthesis,AudioServiceOutOfProcess');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ─── Squirrel Windows installer guard ────────────────────────────────────────
if (started) app.quit();

// ─── Globals ──────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

const BUBBLE_W = 240;
const BUBBLE_H = 240;

const IDLE_PILL_W = 160;
const IDLE_PILL_H = 50;
let preIdleX = 0;
let preIdleY = 0;

// ─── Position & panel-size persistence ───────────────────────────────────────
// Saved to userData so it survives app updates and isn't committed to git.
function getPositionFile(): string {
  return path.join(app.getPath('userData'), 'bubble-position.json');
}
function getPanelSizeFile(): string {
  return path.join(app.getPath('userData'), 'panel-size.json');
}

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = fs.readFileSync(getPositionFile(), 'utf8');
    const pos = JSON.parse(raw) as { x: number; y: number };
    if (typeof pos.x === 'number' && typeof pos.y === 'number') return pos;
  } catch { /* no saved position yet */ }
  return null;
}

function savePosition(x: number, y: number): void {
  try {
    fs.writeFileSync(getPositionFile(), JSON.stringify({ x, y }));
  } catch { /* non-critical */ }
}

function loadSavedPanelSize(): { width: number; height: number } | null {
  try {
    const raw = fs.readFileSync(getPanelSizeFile(), 'utf8');
    const s = JSON.parse(raw) as { width: number; height: number };
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch { /* no saved size yet */ }
  return null;
}

function savePanelSize(width: number, height: number): void {
  try {
    fs.writeFileSync(getPanelSizeFile(), JSON.stringify({ width, height }));
  } catch { /* non-critical */ }
}

// ─── Daily planner (in-memory, resets at midnight) ───────────────────────────

interface DailyTask {
  id: string;
  title: string;
  dueTime?: string;
  dueMinutes?: number;
  completed: boolean;
  remindedAt?: number;
  snoozedUntil?: number;
}

let dailyTasks: DailyTask[] = [];
let dailyGreeted = false;
let autoCalledToday = false;
let dailyDate = new Date().toDateString(); // tracks which calendar day the data belongs to

// ─── One-off ad-hoc call reminders ───────────────────────────────────────────
interface AdHocReminder { id: string; task: string; fireAtMs: number; fired: boolean; toPhone: string; }
let adHocReminders: AdHocReminder[] = [];

// ─── Periodic task check-in calls ────────────────────────────────────────────
// Tracks which hours we've already called on today (e.g. [9, 11, 13, 15])
let periodicCallHoursFired: number[] = [];

function resetDailyPlanIfNewDay(): void {
  const today = new Date().toDateString();
  if (today !== dailyDate) {
    dailyTasks               = [];
    dailyGreeted             = false;
    autoCalledToday          = false;
    periodicCallHoursFired   = [];
    dailyDate                = today;
    console.log('FocusBubble: midnight reset — daily plan cleared');
  }
}

// ─── Daily task disk persistence ─────────────────────────────────────────────
function getTasksFile(): string {
  return path.join(app.getPath('userData'), 'daily-tasks.json');
}
function loadDailyTasksFromDisk(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(getTasksFile(), 'utf8')) as { date: string; tasks: DailyTask[] };
    if (raw.date === new Date().toDateString() && Array.isArray(raw.tasks)) {
      dailyTasks = raw.tasks;
      console.log(`FocusBubble: loaded ${raw.tasks.length} task(s) from disk`);
    }
  } catch { /* no file or stale date */ }
}
function saveTasksToDisk(): void {
  try {
    fs.writeFileSync(getTasksFile(), JSON.stringify({ date: new Date().toDateString(), tasks: dailyTasks }));
  } catch { /* non-critical */ }
}

// ─── Place a Twilio call directly from main process ───────────────────────────
async function placeTwilioCall(twiml: string): Promise<void> {
  if (!twilioConfig) { console.warn('FocusBubble: placeTwilioCall — no twilioConfig'); return; }
  const { sid, token, fromPhone } = twilioConfig;
  // toPhone lives in twilioConfig via saveTwilioSettings; we store it there when renderer saves settings
  const toPhone = (twilioConfig as TwilioConfig & { toPhone?: string }).toPhone;
  if (!toPhone) { console.warn('FocusBubble: placeTwilioCall — no toPhone'); return; }
  try {
    const resp = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      new URLSearchParams({ To: toPhone, From: fromPhone, Twiml: twiml }),
      { auth: { username: sid, password: token }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 }
    );
    console.log(`FocusBubble: call placed — SID ${(resp.data as { sid?: string }).sid}`);
  } catch (err) {
    console.error('FocusBubble: Twilio call failed —', err instanceof Error ? err.message : err);
  }
}

// ─── Twilio Sync polling — marks tasks done when user presses 1 on phone ─────
function startSyncPolling(): void {
  setInterval(async () => {
    if (!twilioConfig?.syncSid || !twilioConfig.sid || !twilioConfig.token) return;
    const { sid, token, syncSid } = twilioConfig;
    const pending = dailyTasks.filter(t => !t.completed);
    if (pending.length === 0) return;
    for (const task of pending) {
      try {
        const resp = await axios.get(
          `https://sync.twilio.com/v1/Services/${syncSid}/Documents/done-${task.id}`,
          { auth: { username: sid, password: token }, timeout: 8_000 }
        );
        const done = (resp.data as { data?: { done?: boolean } }).data?.done;
        if (done) {
          task.completed = true;
          saveTasksToDisk();
          console.log(`FocusBubble: Sync — task marked done via phone: "${task.title}"`);
          // Notify renderer so UI updates
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('planner:task-done-via-phone', { id: task.id });
          }
          // Clean up the Sync document
          await axios.delete(
            `https://sync.twilio.com/v1/Services/${syncSid}/Documents/done-${task.id}`,
            { auth: { username: sid, password: token }, timeout: 8_000 }
          ).catch(() => {});
        }
      } catch { /* document doesn't exist yet — that's fine */ }
    }
  }, 30_000);
}

function startDailyPlannerCheck(): void {
  function check(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    resetDailyPlanIfNewDay();
    const hour = new Date().getHours();
    // Greet once per day on first launch/check between 5am–11am.
    // Mark greeted immediately so the 60s interval never double-fires it.
    if (hour >= 5 && hour < 11 && !dailyGreeted) {
      dailyGreeted = true;
      mainWindow.webContents.send('planner:morning-greeting');
    }
    if (hour >= 6 && hour < 22) {
      mainWindow.webContents.send('planner:check-reminders');
    }
    // ── Auto-call scheduler ──────────────────────────────────────────────────
    if (twilioConfig?.autoCallTime && !autoCalledToday) {
      const [hStr, mStr] = twilioConfig.autoCallTime.split(':');
      const callMins = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
      const nowMins  = new Date().getHours() * 60 + new Date().getMinutes();
      if (Math.abs(nowMins - callMins) <= 1) {
        autoCalledToday = true;
        mainWindow.webContents.send('planner:auto-call-trigger');
      }
    }
    // ── Periodic task check-in calls ─────────────────────────────────────────
    // Call every 2 hours between 9am–6pm if there are pending tasks and Twilio is configured.
    // Only fires once per hour slot so the 60s interval never double-fires.
    if (twilioConfig && dailyTasks.length > 0) {
      const nowH = new Date().getHours();
      const nowM = new Date().getMinutes();
      const checkHours = [9, 11, 13, 15, 17]; // 9am, 11am, 1pm, 3pm, 5pm
      for (const h of checkHours) {
        if (nowH === h && nowM < 2 && !periodicCallHoursFired.includes(h)) {
          const pending = dailyTasks.filter(t => !t.completed);
          if (pending.length > 0) {
            periodicCallHoursFired.push(h);
            const taskLines = pending.map((t, i) =>
              `Task ${i + 1}: ${t.title}${t.dueTime ? `, due at ${t.dueTime}` : ''}.`
            ).join(' ').replace(/&/g, 'and').replace(/[<>]/g, '').replace(/[^\x20-\x7E]/g, '');
            const count = pending.length;
            const twiml = `<Response><Say>Hi! Orbiv check-in. You still have ${count} pending ${count === 1 ? 'task' : 'tasks'}: ${taskLines} Keep it up!</Say></Response>`;
            console.log(`FocusBubble: periodic check-in call at ${h}:00`);
            placeTwilioCall(twiml);
          }
        }
      }
    }
    // ── Ad-hoc reminder scheduler ────────────────────────────────────────────
    const now = Date.now();
    for (const r of adHocReminders) {
      if (!r.fired && now >= r.fireAtMs) {
        r.fired = true;
        console.log(`FocusBubble: firing ad-hoc reminder — "${r.task}"`);
        // Call Twilio directly from main — works even if UI panel is closed
        if (twilioConfig) {
          const { sid, token, fromPhone } = twilioConfig;
          const toPhone = r.toPhone;
          if (toPhone) {
            const safeTask = r.task.replace(/&/g, 'and').replace(/[<>]/g, '').replace(/—|–/g, ', ').replace(/[^\x20-\x7E]/g, '').trim();
            const twiml = `<Response><Say>Hi! This is Orbiv. This is your reminder to ${safeTask}. Have a great day!</Say></Response>`;
            axios.post(
              `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
              new URLSearchParams({ To: toPhone, From: fromPhone, Twiml: twiml }),
              { auth: { username: sid, password: token }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 }
            ).then(resp => {
              console.log(`FocusBubble: ad-hoc reminder call placed — SID ${(resp.data as { sid?: string }).sid}`);
            }).catch(err => {
              console.error('FocusBubble: ad-hoc reminder call failed —', err instanceof Error ? err.message : err);
            });
          } else {
            console.warn('FocusBubble: ad-hoc reminder has no toPhone — skipping call');
          }
        } else {
          console.warn('FocusBubble: ad-hoc reminder fired but no twilioConfig — skipping call');
        }
        // Still notify renderer so it can show an on-screen indicator
        mainWindow.webContents.send('planner:adhoc-reminder', { id: r.id, task: r.task });
      }
    }
    // Clean up fired reminders older than 10 minutes
    adHocReminders = adHocReminders.filter(r => !r.fired || now - r.fireAtMs < 600_000);
  }
  setTimeout(check, 3000);
  setInterval(check, 60_000);
}

// In-memory bubble position — the position the bubble sits at when collapsed.
// This is the single source of truth; it must NOT be overwritten by panel
// resize operations that move the window (left/top edge drags).
let bubbleX = 0;
let bubbleY = 0;

// ─── Airia Brain configuration ────────────────────────────────────────────────
const AIRIA_ENDPOINT =
  'https://api.airia.ai/v2/PipelineExecution/d31d96dc-c7aa-4fcf-8c4a-cf2d27f74cf0';
/** Set to true after Airia returns 402 so we stop calling it for this session. */
let airiaCreditsExhausted = false;

// How often to poll for new notifications (ms). 60 seconds by default.
const POLL_INTERVAL_MS = 60_000;

// ─── Airia response types ─────────────────────────────────────────────────────
interface AiriaNotificationItem {
  sender: string;
  summary: string;
  time?: string;
  urgency: 'high' | 'medium' | 'low';
}

interface AiriaPlatformGroup {
  platform: string;
  items: AiriaNotificationItem[];
}

// ─── Raw notification collector ───────────────────────────────────────────────
/**
 * Gathers raw notifications from all connected sources.
 * Currently: real Gmail unread messages from the last 24h.
 * Add more sources here (Outlook, Slack, WhatsApp, etc.) as they are connected.
 *
 * Returns an empty array if all sources fail — never throws.
 */
async function collectRawNotifications(): Promise<object[]> {
  const results: object[] = [];

  // ── Gmail ──────────────────────────────────────────────────────────────────
  try {
    const gmailItems = await fetchNewGmailNotifications();
    results.push(...gmailItems);
    console.log(`FocusBubble: Gmail returned ${gmailItems.length} notification(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('FocusBubble: Gmail fetch failed —', msg);
  }

  // ── Add future sources here ────────────────────────────────────────────────
  // const outlookItems = await fetchOutlookNotifications();
  // results.push(...outlookItems);

  return results;
}

// ─── Airia Brain API call ─────────────────────────────────────────────────────
/**
 * Send raw notifications to the Airia Brain agent for AI processing.
 * Returns an array of per-platform groups, each with summarised + urgency-scored items.
 * Falls back to an empty array if the API call fails.
 */
async function callAiriaBrain(raw: object[]): Promise<AiriaPlatformGroup[]> {
  const apiKey = process.env.AIRIA_API_KEY;

  if (!apiKey || apiKey.trim() === '') {
    console.error('FocusBubble: AIRIA_API_KEY is not set in .env — skipping AI processing');
    return [];
  }

  console.log(`FocusBubble: Sending ${raw.length} notifications to Airia Brain...`);

  // Airia expects a single "userInput" string — we JSON-stringify our payload
  const requestBody = {
    userInput: JSON.stringify({ notifications: raw }),
    asyncOutput: false,
  };

  const response = await axios.post(AIRIA_ENDPOINT, requestBody, {
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 20_000, // 20s — AI processing can take a moment
  });

  // Log the raw response so we can see exactly what shape Airia returns
  console.log('FocusBubble: Airia raw response →', JSON.stringify(response.data, null, 2));

  // The agent may return JSON directly or as a string inside a wrapper
  let parsed: unknown = response.data;

  // If the whole response is a string, parse it
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed as string);
    } catch {
      // Not JSON — leave as-is and handle below
    }
  }

  // Handle Airia's possible response shapes:
  //   • { notifications: [...] }
  //   • { output: { notifications: [...] } }
  //   • { result: { notifications: [...] } }
  //   • { result: "{ \"notifications\": [...] }" }  (stringified JSON inside result)
  const asObj = parsed as Record<string, unknown>;

  let groups: AiriaPlatformGroup[] =
    (asObj?.notifications as AiriaPlatformGroup[]) ??
    (asObj?.output as Record<string, unknown>)?.notifications as AiriaPlatformGroup[] ??
    (asObj?.result as Record<string, unknown>)?.notifications as AiriaPlatformGroup[] ??
    [];

  // Try parsing result as a string if we still have nothing.
  // Airia may wrap the JSON in a markdown code fence (```json ... ```) — strip it first.
  if (groups.length === 0 && typeof asObj?.result === 'string') {
    try {
      const stripped = (asObj.result as string)
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
      const inner = JSON.parse(stripped) as Record<string, unknown>;
      groups = (inner?.notifications as AiriaPlatformGroup[]) ?? [];
    } catch {
      // Not parseable — fall through to empty
    }
  }

  console.log(`FocusBubble: Airia returned ${groups.length} platform group(s)`);
  return groups;
}

// ─── Airia polling loop ───────────────────────────────────────────────────────
/**
 * Runs immediately (after a short delay for the window to load) then every
 * POLL_INTERVAL_MS milliseconds. Fetches raw notifications, processes them
 * through Airia, and pushes each enriched item to the renderer.
 */
function startAiriaPolling(): void {
  async function poll(): Promise<void> {
    // ── 1. Collect raw notifications from all sources ──────────────────────
    const raw = await collectRawNotifications();

    if (raw.length === 0) {
      console.log('FocusBubble: No new notifications to process this cycle');
      return;
    }

    // ── 2. Try Airia Brain for AI summaries + urgency scoring ──────────────
    let groups: AiriaPlatformGroup[] = [];
    try {
      groups = await callAiriaBrain(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('FocusBubble: Airia call failed —', msg);
    }

    // ── 3a. Airia succeeded — push enriched notifications ─────────────────
    if (groups.length > 0) {
      // Build a lookup from sender → messageId using the raw array
      const rawTyped = raw as Array<{ platform: string; sender: string; messageId?: string }>;
      const msgIdBySender = new Map(rawTyped.map(r => [r.sender.toLowerCase(), r.messageId]));

      for (const group of groups) {
        for (const item of group.items ?? []) {
          pushNotification({
            platform:  group.platform.toLowerCase(),
            sender:    item.sender,
            preview:   item.summary,
            timestamp: item.time ?? new Date().toISOString(),
            urgency:   item.urgency ?? 'low',
            messageId: msgIdBySender.get(item.sender.toLowerCase()),
          });
        }
      }
      return;
    }

    // ── 3b. Airia failed or returned nothing — push raw as fallback ────────
    console.warn('FocusBubble: Falling back to raw (unenriched) notifications');
    for (const item of raw as Array<{ platform: string; sender: string; preview: string; timestamp: string; messageId?: string }>) {
      pushNotification({
        platform:   item.platform.toLowerCase(),
        sender:     item.sender,
        preview:    item.preview,
        timestamp:  item.timestamp,
        urgency:    'low',
        messageId:  item.messageId,
      });
    }
  }

  // First poll after 2s (gives the window time to fully load and register IPC listeners)
  setTimeout(poll, 2_000);

  // Then poll on the regular interval
  setInterval(poll, POLL_INTERVAL_MS);
}

// ─── Window factory ───────────────────────────────────────────────────────────
function createWindow(): void {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // Restore last position, or default to bottom-right corner
  const saved = loadSavedPosition();
  const startX = saved ? Math.max(0, Math.min(saved.x, sw - BUBBLE_W)) : sw - BUBBLE_W - 24;
  const startY = saved ? Math.max(0, Math.min(saved.y, sh - BUBBLE_H)) : sh - BUBBLE_H - 24;

  // Seed in-memory bubble position from the saved value
  bubbleX = startX;
  bubbleY = startY;

  mainWindow = new BrowserWindow({
    x: startX,
    y: startY,
    width: BUBBLE_W,
    height: BUBBLE_H,

    transparent: true,
    // '#00000001': 1/255 alpha — visually invisible but tells macOS the window
    // has a non-zero background, so the OS delivers ALL mouse/drag events to
    // every pixel in the window bounds (not just pixels with visible content).
    // Without this, macOS passes drags over transparent pixels straight through
    // to the desktop even when setIgnoreMouseEvents(false) is set.
    backgroundColor: '#00000001',
    frame: false,
    hasShadow: false,
    // titleBarStyle must be omitted (not 'hidden') — on macOS, 'hidden' still
    // renders the traffic-light buttons even with frame:false. Omitting it
    // defers entirely to frame:false which removes the title bar completely.
    resizable: false,

    alwaysOnTop: true,
    skipTaskbar: true,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the renderer active even when the window loses focus.
      // Required on macOS: without this, drag events from Finder stop
      // firing if the user pauses mid-drag over the bubble.
      backgroundThrottling: false,
    },
  });

  // Grant microphone + speech permissions — required for Web Speech API
  const ALLOWED_PERMS = new Set(['media', 'microphone', 'speech', 'speechRecognition']);
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMS.has(permission));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return ALLOWED_PERMS.has(permission);
  });

  // 'pop-up-menu' sits at the same tier as context menus — high enough to
  // float above Finder windows and full-screen apps, but crucially the OS
  // still delivers drag-and-drop events to it (unlike some higher tiers).
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Window is always fully interactive — never use setIgnoreMouseEvents(true).
  // Pass-through for transparent areas is handled by the SVG hit-rect in the
  // renderer (pointer-events on SVG elements) rather than the OS-level ignore.
  // This is required for drag-and-drop from Finder to work: macOS does not
  // forward drag events through a pass-through window.
  mainWindow.setIgnoreMouseEvents(false);
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.on('ready', async () => {
  // Request macOS microphone permission before creating the window.
  // Without this the OS never shows the "Allow Microphone" dialog and
  // SpeechRecognition fires 'not-allowed' immediately.
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.info('FocusBubble: macOS mic status:', micStatus);
    if (micStatus !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.info('FocusBubble: mic permission request result:', granted);
    }
  }
  loadDailyTasksFromDisk();
  createWindow();
  startAiriaPolling();
  startDailyPlannerCheck();
  startSyncPolling();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC: Window management ───────────────────────────────────────────────────

// Main process tracks panel state — it is the single authority on
// setIgnoreMouseEvents, preventing renderer race conditions.
let panelExpanded = false;


ipcMain.on('bubble:expand', (_event, { width, height }: { width: number; height: number }) => {
  if (!mainWindow) return;

  panelExpanded = true;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [cx, cy] = mainWindow.getPosition();
  const newX = Math.min(cx, sw - width - 12);
  const newY = Math.min(cy, sh - height - 12);

  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.show();
  mainWindow.focus();

  // Resize first (no animate — animated resize races with setIgnoreMouseEvents on macOS)
  mainWindow.setBounds({ x: newX, y: newY, width, height }, false);
  mainWindow.setIgnoreMouseEvents(false);
  console.log('Main: panel expanded — window is now fully interactive');
});

ipcMain.on('bubble:collapse', () => {
  if (!mainWindow) return;
  console.log('Main: IPC bubble:collapse received');
  panelExpanded = false;
  // Always return to the bubble's own position — NOT the panel's current position,
  // which may have shifted due to left/top edge resize drags.
  mainWindow.setBounds({ x: bubbleX, y: bubbleY, width: BUBBLE_W, height: BUBBLE_H }, false);
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  savePosition(bubbleX, bubbleY);
});

ipcMain.on('bubble:move', (_event, { dx, dy }: { dx: number; dy: number }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const newX = x + dx;
  const newY = y + dy;
  mainWindow.setPosition(newX, newY);
  // Keep bubble position in sync — this is the only place it should move
  bubbleX = newX;
  bubbleY = newY;
  savePosition(newX, newY);
});

// bubble:set-ignore-mouse is kept as a no-op so the preload/renderer don't
// throw on the send — but pass-through is permanently disabled (see createWindow).
ipcMain.on('bubble:set-ignore-mouse', () => { /* no-op — window is always interactive */ });

// ─── IPC: File-chat panel resize ──────────────────────────────────────────────
// Grows or shrinks the window for the file-chat overlay.
// On expand: saves the current bubble position, then centres the larger window on it.
// On restore: returns to the exact saved bubble position — no drift.
let preChatBubbleX = 0;
let preChatBubbleY = 0;

ipcMain.on('bubble:chat-resize', (_event, { width, height }: { width: number; height: number }) => {
  if (!mainWindow || panelExpanded) return; // don't interfere with the notification panel

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const isRestoring = (width === BUBBLE_W && height === BUBBLE_H);

  if (isRestoring) {
    // Always return to exactly where the bubble was before the chat opened
    const clampedX = Math.max(0, Math.min(preChatBubbleX, sw - BUBBLE_W));
    const clampedY = Math.max(0, Math.min(preChatBubbleY, sh - BUBBLE_H));
    mainWindow.setBounds({ x: clampedX, y: clampedY, width: BUBBLE_W, height: BUBBLE_H }, false);
    bubbleX = clampedX;
    bubbleY = clampedY;
    savePosition(clampedX, clampedY);
  } else {
    // Expanding: snapshot the current bubble position before moving
    preChatBubbleX = bubbleX;
    preChatBubbleY = bubbleY;

    // Centre the larger window on the bubble's centre
    const newX = Math.round(bubbleX + (BUBBLE_W - width)  / 2);
    const newY = Math.round(bubbleY + (BUBBLE_H - height) / 2);
    const clampedX = Math.max(0, Math.min(newX, sw - width));
    const clampedY = Math.max(0, Math.min(newY, sh - height));
    mainWindow.setBounds({ x: clampedX, y: clampedY, width, height }, false);
  }
});

// ─── IPC: Resize panel ────────────────────────────────────────────────────────
// x/y are optional — only sent when dragging a left or top edge (window must move + resize)
ipcMain.on('bubble:resize-panel', (_event, { x, y, width, height }: { x?: number; y?: number; width: number; height: number }) => {
  if (!mainWindow || !panelExpanded) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [cx, cy] = mainWindow.getPosition();

  const newX = x !== undefined ? Math.max(0, Math.min(x, cx + width - 400)) : cx;
  const newY = y !== undefined ? Math.max(0, Math.min(y, cy + height - 300)) : cy;

  // Clamp so the window never leaves the screen
  const clampedW = Math.max(400, Math.min(width, sw - newX));
  const clampedH = Math.max(300, Math.min(height, sh - newY));
  mainWindow.setBounds({ x: newX, y: newY, width: clampedW, height: clampedH }, false);

  // Persist the panel size so it's restored on next expand
  // bubbleX/Y are intentionally NOT updated here — panel position shifts are temporary
  savePanelSize(clampedW, clampedH);
});

// ─── IPC: Get saved panel size ────────────────────────────────────────────────
ipcMain.handle('panel:get-size', (): { width: number; height: number } => {
  return loadSavedPanelSize() ?? { width: 600, height: 620 };
});

// ─── IPC: Idle mode ───────────────────────────────────────────────────────────

ipcMain.on('bubble:idle-enter', (_event, { position }: { position: string }) => {
  if (!mainWindow) return;
  // Snapshot current bubble position so idle-exit can restore it exactly
  preIdleX = bubbleX;
  preIdleY = bubbleY;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  let ix: number, iy: number;
  if (position === 'top-right')        { ix = sw - IDLE_PILL_W - 16; iy = 10; }
  else if (position === 'bottom-right') { ix = sw - IDLE_PILL_W - 16; iy = sh - IDLE_PILL_H - 16; }
  else if (position === 'remember-last') { ix = bubbleX; iy = bubbleY; }
  else /* top-center */                 { ix = Math.round((sw - IDLE_PILL_W) / 2); iy = 10; }
  mainWindow.setBounds({ x: ix, y: iy, width: IDLE_PILL_W, height: IDLE_PILL_H }, false);
  mainWindow.setOpacity(0.82);
});

ipcMain.on('bubble:idle-exit', () => {
  if (!mainWindow) return;
  mainWindow.setBounds({ x: preIdleX, y: preIdleY, width: BUBBLE_W, height: BUBBLE_H }, false);
  mainWindow.setOpacity(1.0);
  // Restore in-memory tracking so bubble:move and bubble:collapse continue working
  bubbleX = preIdleX;
  bubbleY = preIdleY;
});

// Repositions the pill window during an idle-mode drag without corrupting bubbleX/bubbleY.
// preIdleX/Y are updated so that idle-exit restores from the dragged position.
ipcMain.on('bubble:idle-move', (_event, { dx, dy }: { dx: number; dy: number }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy);
  preIdleX = x + dx;
  preIdleY = y + dy;
});

// ─── IPC: Meeting notetaker ───────────────────────────────────────────────────

/**
 * Generates a timestamped PDF from accumulated transcript chunks and saves it
 * to ~/Downloads. Uses pdf-lib (already installed) — no extra dependencies.
 */
ipcMain.handle(
  'meeting:generate-pdf',
  async (
    _event,
    { title, startTime, chunks }: { title: string; startTime: number; chunks: { ts: number; text: string }[] }
  ): Promise<{ ok: boolean; filePath?: string; error?: string }> => {
    try {
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

      const pdfDoc   = await PDFDocument.create();
      const fontReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

      const pageW = 595; const pageH = 842;
      const margin = 56; const maxW = pageW - margin * 2;
      const lineH = 15;  const fontSize = 10.5;

      // Strip any character outside WinAnsi range so pdf-lib standard fonts never crash.
      function toWinAnsi(text: string): string {
        return text.replace(/[^\x00-\xFF]/g, '?');
      }

      function wrapText(text: string, font: typeof fontReg, size: number): string[] {
        text = toWinAnsi(text);
        const words = text.split(' ');
        const lines: string[] = [];
        let cur = '';
        for (const w of words) {
          const test = cur ? `${cur} ${w}` : w;
          if (font.widthOfTextAtSize(test, size) > maxW && cur) {
            lines.push(cur); cur = w;
          } else { cur = test; }
        }
        if (cur) lines.push(cur);
        return lines.length ? lines : [''];
      }

      type LineObj = { text: string; bold?: boolean; mono?: boolean; indent?: boolean };
      const allLines: LineObj[] = [];

      // Title block
      allLines.push({ text: toWinAnsi(title), bold: true });
      allLines.push({ text: toWinAnsi(new Date(startTime).toLocaleString()), mono: true });
      allLines.push({ text: `Duration: ${Math.round((Date.now() - startTime) / 60000)} min`, mono: true });
      allLines.push({ text: '' });
      allLines.push({ text: '-'.repeat(72) });
      allLines.push({ text: '' });

      // Transcript chunks with [MM:SS] timestamps
      for (const chunk of chunks) {
        const elapsed = Math.round((chunk.ts - startTime) / 1000);
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        allLines.push({ text: `[${mm}:${ss}]`, bold: true });
        for (const wrapped of wrapText(chunk.text, fontReg, fontSize)) {
          allLines.push({ text: wrapped, indent: true });
        }
        allLines.push({ text: '' });
      }

      // Paginate
      let page = pdfDoc.addPage([pageW, pageH]);
      let y = pageH - margin;

      for (const line of allLines) {
        if (y < margin + lineH) {
          page = pdfDoc.addPage([pageW, pageH]);
          y = pageH - margin;
        }
        if (!line.text) { y -= lineH * 0.6; continue; }
        const font  = line.bold ? fontBold : line.mono ? fontMono : fontReg;
        const size  = line.bold ? 11 : fontSize;
        const color = line.bold ? rgb(0.06, 0.49, 0.73) : rgb(0.12, 0.12, 0.12);
        const x     = margin + (line.indent ? 16 : 0);
        page.drawText(line.text, { x, y, size, font, color });
        y -= lineH;
      }

      const bytes = await pdfDoc.save();
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outPath = path.join(os.homedir(), 'Downloads', `meeting-notes-${ts}.pdf`);
      fs.writeFileSync(outPath, bytes);
      console.log(`FocusBubble: meeting PDF saved → ${outPath}`);
      return { ok: true, filePath: outPath };
    } catch (err) {
      console.error('FocusBubble: meeting PDF error —', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
);

/** Returns current main-process timestamp. Used by renderer to anchor chunk timestamps. */
ipcMain.handle('meeting:get-time', (): number => Date.now());

// ─── IPC: Daily Planner ───────────────────────────────────────────────────────
ipcMain.handle('planner:load', (): { tasks: DailyTask[]; greeted: boolean } => ({
  tasks: dailyTasks, greeted: dailyGreeted,
}));

ipcMain.handle('planner:save-tasks', (_e, tasks: DailyTask[]): void => {
  dailyTasks = tasks;
  saveTasksToDisk();
});

ipcMain.handle('planner:set-greeted', (): void => {
  dailyGreeted = true;
});

ipcMain.handle('planner:update-task', (_e, id: string, patch: Partial<DailyTask>): void => {
  const task = dailyTasks.find(t => t.id === id);
  if (task) { Object.assign(task, patch); saveTasksToDisk(); }
});

ipcMain.handle('planner:due-tasks', (): DailyTask[] => {
  const now  = Date.now();
  const mins = new Date().getHours() * 60 + new Date().getMinutes();
  return dailyTasks.filter(t =>
    !t.completed &&
    (!t.snoozedUntil || now > t.snoozedUntil) &&
    (t.dueMinutes !== undefined
      ? mins >= t.dueMinutes && (!t.remindedAt || now - t.remindedAt > 30 * 60_000)
      : !t.remindedAt || now - t.remindedAt > 120 * 60_000)
  );
});

// ─── Ad-hoc reminder scheduling ──────────────────────────────────────────────
ipcMain.handle('planner:schedule-reminder', (_e, { task, fireAtMs, toPhone }: { task: string; fireAtMs: number; toPhone: string }): { id: string } => {
  const id = `adhoc-${Date.now()}`;
  adHocReminders.push({ id, task, fireAtMs, fired: false, toPhone });
  console.log(`FocusBubble: ad-hoc reminder scheduled — "${task}" at ${new Date(fireAtMs).toLocaleTimeString()} → ${toPhone}`);
  return { id };
});

// ─── Twilio config (in-memory for scheduler) ─────────────────────────────────
interface TwilioConfig { sid: string; token: string; fromPhone: string; autoCallTime: string; toPhone: string; webhookUrl: string; syncSid: string; }
let twilioConfig: TwilioConfig | null = null;

ipcMain.handle('settings:save-twilio', (_e, cfg: TwilioConfig): void => {
  twilioConfig = cfg;
  console.log(`FocusBubble: Twilio config saved — toPhone: ${cfg.toPhone}, autoCallTime: ${cfg.autoCallTime}`);
});

// ─── IPC: Twilio outbound call ────────────────────────────────────────────────
ipcMain.handle('vc:twilio-call', async (_e, { sid, token, fromPhone, toPhone, tasks }: {
  sid: string; token: string; fromPhone: string; toPhone: string; tasks: DailyTask[];
}): Promise<{ ok: boolean; callSid?: string; error?: string }> => {
  try {
    const pending = tasks.filter(t => !t.completed);
    const count = pending.length;
    const taskLines = pending.map((t, i) =>
      `Task ${i + 1}: ${t.title}${t.dueTime ? `, due at ${t.dueTime}` : ''}.`
    ).join(' ');

    // Sanitise helper
    const sanitise = (s: string) => s
      .replace(/&/g, 'and').replace(/[<>]/g, '').replace(/[""]/g, '"')
      .replace(/[''`]/g, "'").replace(/—|–/g, ', ').replace(/[^\x20-\x7E]/g, '').trim();

    const webhookUrl = twilioConfig?.webhookUrl ?? '';
    const syncSid    = twilioConfig?.syncSid    ?? '';

    let callParams: Record<string, string>;

    if (webhookUrl && count > 0) {
      // ── Interactive mode: Gather keypresses via webhook ────────────────────
      // Encode tasks as JSON in the URL so the Function knows what to read
      const tasksEncoded = encodeURIComponent(JSON.stringify(
        pending.map(t => ({ id: t.id, title: sanitise(t.title) }))
      ));
      const firstTask = pending[0];
      // & in XML attributes must be &amp; — build URL params separately
      const gatherParams = [
        `tasks=${tasksEncoded}`,
        `taskIndex=0`,
        `taskId=${encodeURIComponent(firstTask.id)}`,
        `syncSid=${encodeURIComponent(syncSid)}`,
      ].join('&amp;');
      const gatherUrl = `https://${webhookUrl}/gather?${gatherParams}`;
      const twiml = `<Response><Say>Hi! This is Orbiv. You have ${count} pending ${count === 1 ? 'task' : 'tasks'}.</Say><Gather numDigits="1" action="${gatherUrl}" timeout="10"><Say>Task 1: ${sanitise(firstTask.title)}. Press 1 if completed, press 2 to skip.</Say></Gather><Say>No input received. Check back in the app. Goodbye.</Say></Response>`;
      console.log('FocusBubble: interactive TwiML (Gather)');
      callParams = { To: toPhone, From: fromPhone, Twiml: twiml };
    } else {
      // ── Simple mode: just read tasks aloud ────────────────────────────────
      const bodyText = count === 0
        ? `Hi! This is Orbiv. You have no pending tasks. Great work today!`
        : `Hi! This is Orbiv. You have ${count} pending ${count === 1 ? 'task' : 'tasks'} today. ${sanitise(taskLines)} Have a productive day!`;
      console.log('FocusBubble: simple TwiML');
      callParams = { To: toPhone, From: fromPhone, Twiml: `<Response><Say>${bodyText}</Say></Response>` };
    }

    const resp = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      new URLSearchParams(callParams),
      { auth: { username: sid, password: token }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 }
    );
    const callSid = (resp.data as { sid?: string }).sid ?? 'unknown';
    console.log(`FocusBubble: Twilio call placed — SID ${callSid}`);
    return { ok: true, callSid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('FocusBubble: Twilio call failed —', msg);
    return { ok: false, error: msg };
  }
});

// ─── IPC: Spotify playback via AppleScript ────────────────────────────────────
ipcMain.handle('vc:spotify-play', async (_event, query: string): Promise<{ ok: boolean; error?: string }> => {
  const { execSync } = await import('node:child_process');
  // Ensure Spotify is running before sending AppleScript
  try {
    execSync('open -a Spotify', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 1500));
  } catch { /* already open or not installed — handled below */ }

  // `play track "spotify:search:<query>"` plays the top search result directly.
  // This is different from `play` (which just resumes) — it actually queues and
  // starts the best match for the search string.
  const escaped = query.replace(/"/g, '\\"');
  try {
    execSync(
      `osascript -e 'tell application "Spotify" to play track "spotify:search:${escaped}"'`,
      { timeout: 8000 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ─── IPC: Spotify player state poll ──────────────────────────────────────────
ipcMain.handle('vc:spotify-state', async (): Promise<{ playing: boolean; position: number }> => {
  const { execSync } = await import('node:child_process');
  try {
    // Check if Spotify is actually running BEFORE using `tell application "Spotify"`,
    // because AppleScript auto-launches any app it addresses — which would reopen
    // Spotify every poll cycle whenever the user closes it.
    const running = execSync('pgrep -x Spotify', { timeout: 1000, encoding: 'utf8' }).trim();
    if (!running) return { playing: false, position: 0 };

    const out = (execSync(
      `osascript -e 'tell application "Spotify" to return (player state as string) & "," & (player position as string)'`,
      { timeout: 2000, encoding: 'utf8' }
    ) as string).trim();
    const [state, pos] = out.split(',');
    return { playing: state.trim() === 'playing', position: parseFloat(pos) || 0 };
  } catch {
    return { playing: false, position: 0 };
  }
});

// ─── IPC: Fetch email body on demand ─────────────────────────────────────────
// Renderer sends the Gmail message ID; main process fetches the body and replies.
ipcMain.handle('gmail:fetch-body', async (_event, messageId: string): Promise<string> => {
  return fetchEmailBody(messageId);
});

// ─── IPC: File conversion ─────────────────────────────────────────────────────

/** Return the list of formats the given file can be converted to. */
ipcMain.handle('file:get-targets', (_event, filePath: string) => {
  return getSupportedTargets(filePath);
});

/** Convert a file to the requested format and return the result. */
ipcMain.handle('file:convert', async (_event, filePath: string, targetExt: string) => {
  return convertFile(filePath, targetExt);
});

/** Open the converted file in Finder / default app. */
ipcMain.on('file:reveal', (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

// ─── IPC: Local file search ────────────────────────────────────────────────────

interface SearchResult {
  name: string;
  filePath: string;
  size: number;
  modified: number;
  ext: string;
}

ipcMain.handle('search:files', async (_event, query: string): Promise<SearchResult[]> => {
  if (!query || !query.trim()) return [];

  // Strip common filler words so "find my tax return" → keywords: ["tax","return"]
  const STOP = new Set(['a','an','the','my','me','i','find','search','look','for','where','is',
    'file','files','document','documents','show','get','open','locate','any','some','please']);
  const keywords = query.trim().toLowerCase()
    .replace(/[_\-\.]+/g, ' ')           // treat separators as spaces
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));

  // Fall back to raw tokens if stripping left nothing
  const terms = keywords.length > 0
    ? keywords
    : query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 1);

  const home = os.homedir();
  const roots = [
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    home,
  ];

  const SKIP = new Set(['node_modules', '.git', '.Trash', 'Library', 'Applications',
    'System', 'usr', 'private', 'Volumes']);
  const scored: Array<SearchResult & { score: number }> = [];
  const seen = new Set<string>();

  function scoreFile(name: string, fullPath: string): number {
    const nameLower = name.toLowerCase().replace(/[_\-\.]+/g, ' ');
    const pathLower = fullPath.toLowerCase().replace(/[_\-\.]+/g, ' ');
    let s = 0;
    for (const kw of terms) {
      if (nameLower.includes(kw)) s += 3;       // keyword in filename = strong
      else if (pathLower.includes(kw)) s += 1;  // keyword in path = weak
    }
    return s;
  }

  function walk(dir: string, depth: number): void {
    if (depth > 5 || scored.length >= 200) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (scored.length >= 200) return;
      if (entry.name.startsWith('.')) continue;
      if (SKIP.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (seen.has(full)) continue;
        const sc = scoreFile(entry.name, full);
        if (sc > 0) {
          seen.add(full);
          try {
            const st = fs.statSync(full);
            scored.push({
              name: entry.name,
              filePath: full,
              size: st.size,
              modified: st.mtimeMs,
              ext: path.extname(entry.name).replace('.', '').toLowerCase(),
              score: sc,
            });
          } catch { /* stat failed — skip */ }
        }
      }
    }
  }

  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, 0);
  }

  // Sort: score desc, then recency desc
  scored.sort((a, b) => b.score - a.score || b.modified - a.modified);

  // Return top 30, stripping the internal score field
  return scored.slice(0, 30).map(({ score: _s, ...r }) => r);
});

/** Open a file with the system default app. */
ipcMain.on('file:open', (_event, filePath: string) => {
  shell.openPath(filePath);
});

// ─── IPC: Screenshot ──────────────────────────────────────────────────────────
/**
 * Capture the primary display and save a PNG to ~/Downloads.
 * Returns { ok, filePath, dataUrl } on success or { ok: false, error } on failure.
 */
ipcMain.handle('vc:screenshot', async (): Promise<{ ok: boolean; filePath?: string; dataUrl?: string; error?: string }> => {
  const { execSync } = await import('node:child_process');
  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(os.homedir(), 'Downloads', `screenshot-${ts}.png`);

  try {
    // Use macOS native screencapture — always works if Screen Recording permission granted.
    // -x = no sound, -t png = format
    execSync(`screencapture -x -t png "${outPath}"`, { timeout: 8000 });

    if (!fs.existsSync(outPath)) return { ok: false, error: 'screencapture produced no file' };
    const png    = fs.readFileSync(outPath);
    if (png.length < 1000) return { ok: false, error: 'Screenshot appears empty — check Screen Recording permission in System Settings → Privacy & Security' };
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    return { ok: true, filePath: outPath, dataUrl };
  } catch (err) {
    // Fallback to desktopCapturer if screencapture fails
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 3840, height: 2160 },
      });
      const primary = sources[0];
      if (!primary) return { ok: false, error: 'No screen source found' };
      const png = primary.thumbnail.toPNG();
      if (png.length < 1000) return { ok: false, error: 'Screenshot empty — grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording' };
      fs.writeFileSync(outPath, png);
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      return { ok: true, filePath: outPath, dataUrl };
    } catch (err2) {
      return { ok: false, error: err2 instanceof Error ? err2.message : String(err2) };
    }
  }
});

// ─── IPC: Open application ────────────────────────────────────────────────────
/**
 * Open a named macOS application.  The renderer sends a normalised app name;
 * we map it to a bundle path and call shell.openPath.
 */
const APP_MAP: Record<string, string> = {
  notion:        '/Applications/Notion.app',
  safari:        '/Applications/Safari.app',
  chrome:        '/Applications/Google Chrome.app',
  firefox:       '/Applications/Firefox.app',
  vscode:        '/Applications/Visual Studio Code.app',
  code:          '/Applications/Visual Studio Code.app',
  slack:         '/Applications/Slack.app',
  spotify:       '/Applications/Spotify.app',
  messages:      '/System/Applications/Messages.app',
  mail:          '/System/Applications/Mail.app',
  calendar:      '/System/Applications/Calendar.app',
  notes:         '/System/Applications/Notes.app',
  finder:        '/System/Library/CoreServices/Finder.app',
  terminal:      '/System/Applications/Utilities/Terminal.app',
  xcode:         '/Applications/Xcode.app',
  figma:         '/Applications/Figma.app',
  whatsapp:      '/Applications/WhatsApp.app',
  zoom:          '/Applications/zoom.us.app',
  discord:       '/Applications/Discord.app',
  linear:        '/Applications/Linear.app',
  arc:           '/Applications/Arc.app',
  obsidian:      '/Applications/Obsidian.app',
  bear:          '/Applications/Bear.app',
};

ipcMain.handle('vc:open-app', async (_event, appName: string): Promise<{ ok: boolean; error?: string }> => {
  const key = appName.toLowerCase().trim();
  const appPath = APP_MAP[key] ?? `/Applications/${appName}.app`;
  const err = await shell.openPath(appPath);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

ipcMain.handle('vc:close-app', (_event, appName: string): { ok: boolean; error?: string } => {
  // Derive the process name — strip .app, take last path component
  const key = appName.toLowerCase().trim();
  // Map known aliases to their actual process names
  const PROC_MAP: Record<string, string> = {
    chrome: 'Google Chrome', vscode: 'Electron', code: 'Electron',
    whatsapp: 'WhatsApp', zoom: 'zoom.us', discord: 'Discord',
    slack: 'Slack', spotify: 'Spotify', notion: 'Notion',
    safari: 'Safari', firefox: 'Firefox', arc: 'Arc',
    figma: 'Figma', linear: 'Linear', obsidian: 'Obsidian',
    bear: 'Bear', terminal: 'Terminal', finder: 'Finder',
  };
  const procName = PROC_MAP[key] ?? appName.trim();
  try {
    // Use AppleScript quit — graceful, respects save dialogs
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    execSync(`osascript -e 'tell application "${procName}" to quit'`, { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ─── IPC: ElevenLabs TTS (primary) + macOS `say` (fallback) ──────────────────

const EL_VOICE_ID_DEFAULT = '21m00Tcm4TlvDq8ikWAM'; // Adam — deep, calm, natural
const EL_MODEL            = 'eleven_multilingual_v2';

/** Call ElevenLabs REST API, return raw MP3 as a Buffer. Throws on failure. */
async function elevenLabsTTS(text: string, voiceId = EL_VOICE_ID_DEFAULT): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) throw new Error('No ELEVENLABS_API_KEY');
  const resp = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: EL_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    },
    {
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      responseType: 'arraybuffer',
      timeout: 15_000,
    },
  );
  return Buffer.from(resp.data as ArrayBuffer);
}

/** Pick the best available macOS `say` voice. */
function getBestSayVoice(): string {
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const list = execSync('say -v "?" 2>&1', { encoding: 'utf8' });
    for (const name of ['Zoe', 'Ava (English (US))', 'Nicky (English (US))', 'Samantha', 'Flo (English (US))', 'Shelley (English (US))', 'Sandy (English (US))', 'Reed (English (US))']) {
      if (list.includes(name)) return name;
    }
  } catch { /* ignore */ }
  return 'Samantha';
}

const SAY_VOICE = getBestSayVoice();
console.info(`FocusBubble: TTS fallback voice → "${SAY_VOICE}"`);

let sayProcess: ReturnType<typeof spawn> | null = null;

function saySpeak(text: string): void {
  if (sayProcess) { sayProcess.kill(); sayProcess = null; }
  const safe = String(text).replace(/["\\]/g, ' ').slice(0, 300);
  sayProcess = spawn('say', ['-v', SAY_VOICE, '-r', '155', safe]);
  sayProcess.on('close', () => { sayProcess = null; });
}

// vc:transcribe removed — transcription now runs entirely in the renderer via
// Whisper WebWorker (@xenova/transformers). No IPC or subprocess needed.

/**
 * vc:speak — tries ElevenLabs first; on any failure falls back to `say`.
 * Returns base64 MP3 data-URL so the renderer can play it via Audio element.
 * If ElevenLabs fails the fallback fires automatically; renderer gets ok:false.
 */
ipcMain.handle('vc:speak', async (_event, text: string, voiceId?: string): Promise<{ ok: boolean; dataUrl?: string }> => {
  console.log(`FocusBubble: vc:speak called — "${text.slice(0, 60)}"`);
  try {
    const mp3 = await elevenLabsTTS(text, voiceId);
    console.log(`FocusBubble: ElevenLabs OK — ${mp3.length} bytes`);
    return { ok: true, dataUrl: `data:audio/mpeg;base64,${mp3.toString('base64')}` };
  } catch (err) {
    console.warn('FocusBubble: ElevenLabs TTS failed — using say fallback:', err instanceof Error ? err.message : err);
    saySpeak(text);
    return { ok: false };
  }
});

ipcMain.on('vc:speak-stop', () => {
  if (sayProcess) { sayProcess.kill(); sayProcess = null; }
});

// ─── IPC: Airia voice intent classification ───────────────────────────────────
/**
 * Send a voice transcript to Airia for intent classification.
 * Returns structured JSON: { intent, keywords?, app?, target?, query? }
 */
ipcMain.handle('vc:classify', async (_event, transcript: string): Promise<Record<string, unknown>> => {
  const apiKey = process.env.AIRIA_API_KEY;
  if (!apiKey?.trim() || airiaCreditsExhausted) {
    return classifyLocally(transcript);
  }

  try {
    const body = {
      userInput: JSON.stringify({
        task: 'classify_voice_command',
        transcript,
        instructions: `You are the intent classifier for FocusBubble, a voice assistant on macOS.
Classify the transcript into exactly one intent. Respond with ONLY valid JSON (no markdown, no explanation).

Rules:
- If the user asks to find, search, locate, or look for a file/document → search_file
- If the user asks a general question or wants information (time, date, joke, help) → use the matching intent
- If the user wants to open/launch an app → open_app
- If the user wants to close/quit an app → close_app
- If the user wants to play music on Spotify → play_song
- If the user wants to be called or phoned about their tasks → call_reminder
- If the user wants to set a reminder to be called at a specific time about a specific task → set_reminder, extract "time" (e.g. "3pm", "15:00") and "task" (what to remind them about)
- If the transcript looks like STT noise (e.g. "(music playing)", "(applause)", sound descriptions in parentheses) → unknown

Possible intents:
  { "intent": "search_file",        "keywords": "<relevant search terms only, no filler words>" }
  { "intent": "take_screenshot",    "target": "full_screen" }
  { "intent": "open_app",           "app": "<app name>" }
  { "intent": "close_app",          "app": "<app name>" }
  { "intent": "play_song",          "query": "<song/artist name>" }
  { "intent": "start_meeting" }
  { "intent": "stop_meeting" }
  { "intent": "read_notifications" }
  { "intent": "tell_time" }
  { "intent": "tell_date" }
  { "intent": "greeting" }
  { "intent": "joke" }
  { "intent": "help" }
  { "intent": "call_reminder" }
  { "intent": "set_reminder",       "time": "<time string>", "task": "<task description>" }
  { "intent": "unknown",            "query": "<original transcript>" }

Transcript: "${transcript}"`,
      }),
      asyncOutput: false,
    };
    const resp = await axios.post(AIRIA_ENDPOINT, body, {
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      timeout: 12_000,
    });

    // Parse response — may be wrapped like notifications
    let raw: unknown = resp.data;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* ok */ } }
    const asObj = raw as Record<string, unknown>;
    const inner = asObj?.result ?? asObj?.output ?? asObj;
    if (typeof inner === 'string') {
      try {
        const stripped = (inner as string).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        return JSON.parse(stripped) as Record<string, unknown>;
      } catch { /* fall through */ }
    }
    if (typeof inner === 'object' && inner !== null && 'intent' in (inner as object)) {
      return inner as Record<string, unknown>;
    }
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 402 || status === 401 || status === 403) {
      // Credits exhausted or auth issue — stop calling Airia for this session
      airiaCreditsExhausted = true;
      console.info('FocusBubble: Airia credits exhausted — switching to local classifier permanently.');
    } else {
      console.warn('FocusBubble: vc:classify Airia call failed —', err instanceof Error ? err.message : err);
    }
  }

  return classifyLocally(transcript);
});

/** Known app names used for entity extraction in local classification. */
const KNOWN_APPS = new Set(Object.keys(APP_MAP).concat([
  'google chrome', 'visual studio code', 'vs code', 'iterm', 'iterm2',
  'photoshop', 'illustrator', 'premiere', 'after effects', 'lightroom',
  'teams', 'skype', 'telegram', 'signal', 'tweetbot', 'twitter',
  'word', 'excel', 'powerpoint', 'outlook', 'onenote', 'onedrive',
  'dropbox', 'box', '1password', 'bitwarden', 'lastpass',
  'pycharm', 'intellij', 'webstorm', 'goland', 'clion',
  'transmit', 'cyberduck', 'proxyman', 'charles', 'postman', 'insomnia',
  'screenflow', 'cleanmymac', 'alfred', 'raycast', 'bartender',
]));

/** Noise words stripped from file search queries. */
const SEARCH_NOISE = /\b(search|find|look|looking|locate|where|is|are|my|the|a|an|for|file|files|document|documents|show|me|can|you|please|i|need|want|get|fetch|pull|up|bring)\b/g;

/** Noise words stripped from app open queries. */
const OPEN_NOISE  = /\b(open|launch|start|run|boot|fire|pull|bring|can|you|please|i|want|to|up|for|me|the|a|an)\b/g;
const CLOSE_NOISE = /\b(close|quit|exit|kill|stop|shut|down|force|can|you|please|i|want|to|for|me|the|a|an)\b/g;

/**
 * Rich local intent classifier — used when Airia is unavailable.
 * Checks intents in specificity order (most specific patterns first).
 */
function classifyLocally(t: string): Record<string, unknown> {
  const s = t.toLowerCase().replace(/['']/g, "'").trim();

  // STT noise — sound descriptions in parentheses, e.g. "(music playing)"
  if (/^\(.*\)$/.test(s)) return { intent: 'unknown', query: t };

  // ── Ad-hoc timed reminder ─────────────────────────────────────────────────
  const reminderMatch = s.match(/\bremind\s*me\b.{0,60}?\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})/i);
  if (reminderMatch) {
    const time = reminderMatch[1].trim();
    const task = s
      .replace(/remind\s*me\b/i, '')
      .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '')
      .replace(/\bto\b|\babout\b/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { intent: 'set_reminder', time, task: task || 'your task' };
  }

  // ── Phone task reminder call ──────────────────────────────────────────────
  if (/\b(call\s*me|phone\s*me|remind\s*me\s*by\s*phone|task\s*(check\s*)?call|phone\s*reminder)\b/.test(s))
    return { intent: 'call_reminder' };

  // ── Meeting notetaker — check before screenshot so "record meeting" doesn't match screenshot ──
  if (/\b(start|begin|record|take|kick\s*off)\b.{0,20}\b(meeting|notes?|notetaker|transcript|recording)\b|\b(meeting|notes?)\b.{0,10}\b(start|begin|go|on)\b/i.test(s))
    return { intent: 'start_meeting' };
  if (/\b(stop|end|finish|done|complete|save)\b.{0,20}\b(meeting|notes?|notetaker|transcript|recording)\b|\b(stop|end)\b.{0,10}\b(notes?|recording)\b/i.test(s))
    return { intent: 'stop_meeting' };

  // ── Spotify playback ───────────────────────────────────────────────────────
  if (/\b(play|listen\s*to|put\s*on|queue)\b/i.test(s)) {
    const query = s
      .replace(/\b(play|listen\s*to|put\s*on|queue|on\s*spotify|spotify|please|for\s*me|now|by)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (query.length > 1) return { intent: 'play_song', query };
  }

  // ── Screenshot ─────────────────────────────────────────────────────────────
  if (/\b(screenshot|screen\s*shot|capture\s*(the\s*)?(screen|display)|snap\s*(the\s*)?(screen|display)|take\s*a\s*(pic|photo|picture|snapshot)|grab\s*(the\s*)?(screen|display))\b/.test(s))
    return { intent: 'take_screenshot', target: 'full_screen' };

  // ── Close app — check BEFORE open so "close whatsapp" doesn't match open ──
  if (/\b(close|quit|exit|kill|force\s*quit|shut\s*down)\b/.test(s)) {
    for (const known of KNOWN_APPS) {
      if (s.includes(known)) return { intent: 'close_app', app: known };
    }
    const stripped = s.replace(CLOSE_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();
    const tokens = stripped.split(/\s+/).filter(Boolean);
    const app = tokens.sort((a, b) => b.length - a.length)[0] ?? '';
    if (app.length > 1) return { intent: 'close_app', app };
  }

  // ── Open app — match known app names first (most specific) ────────────────
  for (const known of KNOWN_APPS) {
    if (s.includes(known)) {
      const key = known.replace(/\s+/g, '').replace('visualstudiocode', 'vscode');
      const appKey = APP_MAP[known] ? known : (APP_MAP[key] ? key : known);
      return { intent: 'open_app', app: appKey };
    }
  }
  if (/\b(open|launch|start|run|boot|fire\s*up|pull\s*up|bring\s*up)\b/.test(s)) {
    const stripped = s.replace(OPEN_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();
    const tokens = stripped.split(/\s+/).filter(Boolean);
    const app = tokens.sort((a, b) => b.length - a.length)[0] ?? '';
    if (app.length > 1) return { intent: 'open_app', app };
  }

  // ── Notifications / messages ───────────────────────────────────────────────
  if (/\b(notification|notifications|unread|missed|new\s*message|any\s*message|check\s*(my\s*)?(email|messages|inbox|slack|whatsapp|teams)|what('?s|\s*is)\s*(new|up)|catch\s*me\s*up)\b/.test(s))
    return { intent: 'read_notifications' };

  // ── File search ────────────────────────────────────────────────────────────
  if (/\b(search|find|look(ing)?\s*for|where\s*is|locate|where\s*did|can\s*you\s*find|help\s*me\s*find|show\s*me)\b/.test(s)) {
    const kw = s.replace(SEARCH_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();
    return { intent: 'search_file', keywords: kw || t };
  }

  // ── Softer file-search phrases ("my tax return", "the contract pdf") ──────
  if (/\b(my |the )?(tax|invoice|receipt|contract|resume|cv|passport|report|budget|proposal|presentation|spreadsheet|pdf|doc|docx|txt|png|jpg)\b/.test(s)) {
    const kw = s.replace(SEARCH_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();
    return { intent: 'search_file', keywords: kw || t };
  }

  // ── Conversational / informational queries ────────────────────────────────
  if (/\b(what('?s|\s+is)\s+(the\s+)?(current\s+)?time|what\s+time\s+is\s+it|tell\s+me\s+the\s+time)\b/.test(s))
    return { intent: 'tell_time' };

  if (/\b(what('?s|\s+is)\s+(the\s+)?(today'?s?\s+)?date|what\s+day\s+is\s+(it|today)|what('?s|\s+is)\s+today)\b/.test(s))
    return { intent: 'tell_date' };

  if (/\b(how\s+are\s+you|how'?s?\s+it\s+going|how\s+are\s+things|you\s+okay|you\s+alright)\b/.test(s))
    return { intent: 'greeting' };

  if (/\b(tell\s+(me\s+)?a\s+joke|got\s+a\s+joke|make\s+me\s+laugh|say\s+something\s+funny|be\s+funny)\b/.test(s))
    return { intent: 'joke' };

  if (/\b(what\s+can\s+you\s+do|what\s+are\s+your\s+commands|help\s+me|your\s+capabilities|how\s+do\s+i\s+use\s+you|commands)\b/.test(s))
    return { intent: 'help' };

  return { intent: 'unknown', query: t };
}

// ─── Push notification to renderer ───────────────────────────────────────────
function pushNotification(notification: object): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('notification:new', notification);
}
