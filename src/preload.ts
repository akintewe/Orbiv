/**
 * FocusBubble – preload.ts
 *
 * Runs in a privileged context between the main process and the renderer.
 * We use contextBridge to expose ONLY the specific IPC channels the renderer
 * needs — this is the secure, recommended Electron pattern.
 *
 * The renderer accesses these via `window.focusBubble.*`
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('focusBubble', {
  // ── Renderer → Main ────────────────────────────────────────────────────────

  /**
   * Tell the main process to resize the window to panel dimensions.
   * Called when the user expands the bubble.
   */
  expand(width: number, height: number): void {
    ipcRenderer.send('bubble:expand', { width, height });
  },

  /**
   * Tell the main process to shrink the window back to bubble size.
   * Called when the user closes the panel.
   */
  collapse(): void {
    ipcRenderer.send('bubble:collapse');
  },

  /**
   * Send mouse-drag deltas to main so it can reposition the frameless window.
   * @param dx - horizontal delta in pixels
   * @param dy - vertical delta in pixels
   */
  move(dx: number, dy: number): void {
    ipcRenderer.send('bubble:move', { dx, dy });
  },

  /** Toggle macOS transparent-window click-through. */
  setIgnoreMouseEvents(ignore: boolean): void {
    ipcRenderer.send('bubble:set-ignore-mouse', ignore);
  },

  /**
   * Fetch the full body text of a Gmail message by its message ID.
   * Returns the decoded plain-text body (or a fallback error string).
   */
  fetchEmailBody(messageId: string): Promise<string> {
    return ipcRenderer.invoke('gmail:fetch-body', messageId);
  },

  /** Resize the panel window to the given dimensions (and optionally reposition). */
  resizePanel(width: number, height: number, x?: number, y?: number): void {
    ipcRenderer.send('bubble:resize-panel', { x, y, width, height });
  },

  /** Get the last saved panel size (or default). */
  getPanelSize(): Promise<{ width: number; height: number }> {
    return ipcRenderer.invoke('panel:get-size');
  },

  /**
   * Resize the window to the given dimensions, centring on the current position.
   * Used to grow the window when the file-chat panel opens, and shrink it back
   * when the panel closes.
   */
  resizeToChatSize(width: number, height: number): void {
    ipcRenderer.send('bubble:chat-resize', { width, height });
  },

  /** Return the list of formats a file can be converted to. */
  getConversionTargets(filePath: string): Promise<string[]> {
    return ipcRenderer.invoke('file:get-targets', filePath);
  },

  /** Convert a file to the given extension. Returns { ok, outputPath?, message }. */
  convertFile(filePath: string, targetExt: string): Promise<{ ok: boolean; outputPath?: string; message: string }> {
    return ipcRenderer.invoke('file:convert', filePath, targetExt);
  },

  /** Open a file path in Finder. */
  revealFile(filePath: string): void {
    ipcRenderer.send('file:reveal', filePath);
  },

  /** Get the native filesystem path for a dropped File object. */
  getFilePath(file: File): string {
    return webUtils.getPathForFile(file);
  },

  /** Search home/Downloads/Documents/Desktop for files whose name contains all keywords. */
  searchFiles(query: string): Promise<{ name: string; filePath: string; size: number; modified: number; ext: string }[]> {
    return ipcRenderer.invoke('search:files', query);
  },

  /** Open a file with the OS default application. */
  openFile(filePath: string): void {
    ipcRenderer.send('file:open', filePath);
  },

  /** Send a voice transcript to Airia (or local heuristic) for intent classification. */
  classifyIntent(transcript: string): Promise<Record<string, unknown>> {
    return ipcRenderer.invoke('vc:classify', transcript);
  },

  /** Capture the primary screen and save to ~/Downloads. */
  takeScreenshot(): Promise<{ ok: boolean; filePath?: string; dataUrl?: string; error?: string }> {
    return ipcRenderer.invoke('vc:screenshot');
  },

  /** Open a named application (macOS). */
  openApp(appName: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('vc:open-app', appName);
  },

  /** Close/quit a named application via AppleScript. */
  closeApp(appName: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('vc:close-app', appName);
  },

  /** Search Spotify for a track and play it via AppleScript URI scheme. */
  spotifyPlay(query: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('vc:spotify-play', query);
  },

  /** Poll Spotify player state via AppleScript. */
  getSpotifyState(): Promise<{ playing: boolean; position: number }> {
    return ipcRenderer.invoke('vc:spotify-state');
  },

  /** Speak text via ElevenLabs (primary) or macOS say (fallback).
   *  Resolves with { ok: true, dataUrl } on ElevenLabs success,
   *  or { ok: false } if fallback `say` was used instead. */
  speak(text: string, voiceId?: string): Promise<{ ok: boolean; dataUrl?: string }> {
    return ipcRenderer.invoke('vc:speak', text, voiceId);
  },

  /** Stop any currently playing native speech. */
  speakStop(): void {
    ipcRenderer.send('vc:speak-stop');
  },

  /** Enter idle (Dynamic Island) mode — resizes + repositions window to pill. */
  enterIdleMode(position: string): void {
    ipcRenderer.send('bubble:idle-enter', { position });
  },

  /** Exit idle mode — restores full bubble window size and position. */
  exitIdleMode(): void {
    ipcRenderer.send('bubble:idle-exit');
  },

  /** Reposition the idle pill window without corrupting the saved bubble position. */
  idleMove(dx: number, dy: number): void {
    ipcRenderer.send('bubble:idle-move', { dx, dy });
  },

  /** Generate a meeting notes PDF from accumulated transcript chunks. */
  generateMeetingPdf(
    payload: { title: string; startTime: number; chunks: { ts: number; text: string }[] }
  ): Promise<{ ok: boolean; filePath?: string; error?: string }> {
    return ipcRenderer.invoke('meeting:generate-pdf', payload);
  },

  /** Get current main-process timestamp (ms since epoch). */
  getMeetingTime(): Promise<number> {
    return ipcRenderer.invoke('meeting:get-time');
  },

  // ── Daily Planner ───────────────────────────────────────────────────────────

  loadDailyPlan(): Promise<unknown> {
    return ipcRenderer.invoke('planner:load');
  },
  saveTasksToday(tasks: unknown[]): Promise<void> {
    return ipcRenderer.invoke('planner:save-tasks', tasks);
  },
  setGreetedToday(): Promise<void> {
    return ipcRenderer.invoke('planner:set-greeted');
  },
  updateTask(id: string, patch: Record<string, unknown>): Promise<void> {
    return ipcRenderer.invoke('planner:update-task', id, patch);
  },
  getDueTasks(): Promise<unknown[]> {
    return ipcRenderer.invoke('planner:due-tasks');
  },

  /** Register a callback for planner events pushed from main (morning-greeting, check-reminders). */
  onPlannerEvent(callback: (e: { type: string }) => void): () => void {
    const h1 = () => callback({ type: 'morning-greeting' });
    const h2 = () => callback({ type: 'check-reminders' });
    ipcRenderer.on('planner:morning-greeting', h1);
    ipcRenderer.on('planner:check-reminders',  h2);
    return () => {
      ipcRenderer.removeListener('planner:morning-greeting', h1);
      ipcRenderer.removeListener('planner:check-reminders',  h2);
    };
  },

  /** Place an outbound call via Orbiv backend (no credentials needed in app). */
  twilioCall(cfg: { toPhone: string; tasks: unknown[] }): Promise<{ ok: boolean; callSid?: string; error?: string }> {
    return ipcRenderer.invoke('vc:twilio-call', cfg);
  },

  /** Persist phone config to main process (for auto-call scheduler). */
  saveTwilioSettings(cfg: { toPhone: string; autoCallTime: string; syncSid: string }): Promise<void> {
    return ipcRenderer.invoke('settings:save-twilio', cfg);
  },

  /** Register callback for auto-call trigger pushed from main scheduler. */
  onAutoCallTrigger(callback: () => void): () => void {
    const h = (_e: Electron.IpcRendererEvent) => callback();
    ipcRenderer.on('planner:auto-call-trigger', h);
    return () => ipcRenderer.removeListener('planner:auto-call-trigger', h);
  },

  /** Schedule an ad-hoc call reminder at a specific timestamp. */
  scheduleReminder(task: string, fireAtMs: number, toPhone: string): Promise<{ id: string }> {
    return ipcRenderer.invoke('planner:schedule-reminder', { task, fireAtMs, toPhone });
  },

  /** Register callback for when a task is marked done via phone keypress. */
  onTaskDoneViaPhone(callback: (r: { id: string }) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, r: { id: string }) => callback(r);
    ipcRenderer.on('planner:task-done-via-phone', h);
    return () => ipcRenderer.removeListener('planner:task-done-via-phone', h);
  },

  /** Register callback for when an ad-hoc reminder fires. */
  onAdHocReminder(callback: (r: { id: string; task: string }) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, r: { id: string; task: string }) => callback(r);
    ipcRenderer.on('planner:adhoc-reminder', h);
    return () => ipcRenderer.removeListener('planner:adhoc-reminder', h);
  },

  // ── Main → Renderer ────────────────────────────────────────────────────────

  /**
   * Register a callback for incoming notifications pushed from main.
   * Returns an unsubscribe function so the renderer can clean up.
   */
  onNotification(callback: (notification: Notification) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: Notification) => callback(data);
    ipcRenderer.on('notification:new', handler);
    // Return cleanup fn
    return () => ipcRenderer.removeListener('notification:new', handler);
  },
});

// ─── Type declaration (consumed by renderer.ts) ───────────────────────────────
// Declared here so TypeScript knows about `window.focusBubble` in the renderer.
export interface FocusBubbleAPI {
  expand(width: number, height: number): void;
  collapse(): void;
  move(dx: number, dy: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  onNotification(callback: (n: FBNotification) => void): () => void;
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
  speak(text: string, voiceId?: string): Promise<{ ok: boolean; dataUrl?: string }>;
  speakStop(): void;
  enterIdleMode(position: string): void;
  exitIdleMode(): void;
  idleMove(dx: number, dy: number): void;
  generateMeetingPdf(payload: { title: string; startTime: number; chunks: { ts: number; text: string }[] }): Promise<{ ok: boolean; filePath?: string; error?: string }>;
  getMeetingTime(): Promise<number>;
  loadDailyPlan(): Promise<unknown>;
  saveTasksToday(tasks: unknown[]): Promise<void>;
  setGreetedToday(): Promise<void>;
  updateTask(id: string, patch: Record<string, unknown>): Promise<void>;
  getDueTasks(): Promise<unknown[]>;
  onPlannerEvent(callback: (e: { type: string }) => void): () => void;
  twilioCall(cfg: { toPhone: string; tasks: unknown[] }): Promise<{ ok: boolean; callSid?: string; error?: string }>;
  saveTwilioSettings(cfg: { toPhone: string; autoCallTime: string; syncSid: string }): Promise<void>;
  onAutoCallTrigger(callback: () => void): () => void;
  scheduleReminder(task: string, fireAtMs: number, toPhone: string): Promise<{ id: string }>;
  onAdHocReminder(callback: (r: { id: string; task: string }) => void): () => void;
  onTaskDoneViaPhone(callback: (r: { id: string }) => void): () => void;
}

export interface FBNotification {
  platform: 'gmail' | 'outlook' | 'whatsapp' | 'slack' | 'teams' | 'instagram' | string;
  sender: string;
  preview: string;
  timestamp: string;
  avatar?: string;
  id?: string;
  urgency?: 'high' | 'medium' | 'low';
  messageId?: string; // Gmail message ID for body fetching
}
