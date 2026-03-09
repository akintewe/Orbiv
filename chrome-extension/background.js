/**
 * Orbiv Chrome Extension — Background Service Worker
 *
 * Handles:
 * - Side panel open on action click
 * - Planner persistence via chrome.storage
 * - Tab management commands from side panel
 * - Badge count for notifications
 * - Reminders via chrome.alarms + chrome.notifications
 */

// Open side panel when the extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Restore alarms from storage on service worker startup
async function restoreReminders() {
  const data = await chrome.storage.local.get('orbiv-reminders');
  const reminders = data['orbiv-reminders'] || [];
  const now = Date.now();
  for (const r of reminders) {
    if (r.fireAt > now) {
      chrome.alarms.create(r.alarmName, { when: r.fireAt });
    }
  }
  // Clean up expired reminders
  const active = reminders.filter(r => r.fireAt > now);
  if (active.length !== reminders.length) {
    await chrome.storage.local.set({ 'orbiv-reminders': active });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK CHECK-IN ALARMS — fires at 9am, 11am, 1pm, 3pm, 5pm
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleNextCheckin() {
  chrome.alarms.clear('orbiv-checkin', () => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    const checkInHours = [9, 11, 13, 15, 17];

    // Find the next check-in hour that hasn't fired yet (allow exact hour if within first minute)
    const nextHour = checkInHours.find(h => h > currentHour || (h === currentHour && currentMin === 0));

    const target = new Date(now);
    if (nextHour === undefined) {
      // All done today — schedule 9am tomorrow
      target.setDate(target.getDate() + 1);
      target.setHours(9, 0, 0, 0);
    } else {
      target.setHours(nextHour, 0, 0, 0);
    }

    chrome.alarms.create('orbiv-checkin', { when: target.getTime() });
  });
}

// Run on install/update and on browser startup
chrome.runtime.onInstalled.addListener(() => { restoreReminders(); scheduleNextCheckin(); });
chrome.runtime.onStartup.addListener(() => { restoreReminders(); scheduleNextCheckin(); });

// ═══════════════════════════════════════════════════════════════════════════════
// REMINDERS — chrome.alarms fires, we show a chrome.notification
// ═══════════════════════════════════════════════════════════════════════════════

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // ── Task check-in ──────────────────────────────────────────────────────────
  if (alarm.name === 'orbiv-checkin') {
    const today = new Date().toISOString().slice(0, 10);
    const data = await chrome.storage.sync.get('orbiv-planner');
    const saved = data['orbiv-planner'];
    if (saved?.date === today) {
      const pending = (saved.tasks || []).filter(t => !t.completed);
      if (pending.length > 0) {
        const preview = pending.slice(0, 2).map(t => t.title).join(', ') + (pending.length > 2 ? '...' : '');
        chrome.notifications.create(`orbiv-checkin-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Orbiv Task Check-in',
          message: `${pending.length} pending task${pending.length > 1 ? 's' : ''}: ${preview}`,
          priority: 1,
          requireInteraction: false,
        });
        chrome.runtime.sendMessage({ type: 'checkin-fired', pending }).catch(() => {});
      }
    }
    scheduleNextCheckin();
    return;
  }

  // Alarm names are prefixed with "reminder:" followed by the task text
  if (alarm.name.startsWith('reminder:')) {
    const task = alarm.name.slice('reminder:'.length);

    // Show Chrome notification
    chrome.notifications.create(alarm.name, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Orbiv Reminder',
      message: task,
      priority: 2,
      requireInteraction: true,
    });

    // Also notify the side panel if it's open
    chrome.runtime.sendMessage({
      type: 'reminder-fired',
      task,
      time: Date.now(),
    }).catch(() => {
      // Side panel might not be open, that's fine
    });

    // Clean up stored reminder
    const data = await chrome.storage.local.get('orbiv-reminders');
    const reminders = (data['orbiv-reminders'] || []).filter(r => r.alarmName !== alarm.name);
    await chrome.storage.local.set({ 'orbiv-reminders': reminders });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-active-tab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse(tabs[0] ?? null);
    });
    return true;
  }

  if (message.type === 'close-tab') {
    chrome.tabs.remove(message.tabId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'find-tabs') {
    const query = (message.query || '').toLowerCase();
    chrome.tabs.query({}, (tabs) => {
      const matches = tabs.filter(t =>
        (t.title || '').toLowerCase().includes(query) ||
        (t.url || '').toLowerCase().includes(query)
      );
      sendResponse(matches.slice(0, 20));
    });
    return true;
  }

  // ── Open multiple tabs ────────────────────────────────────────────────────
  if (message.type === 'open-tabs') {
    const urls = message.urls || [];
    Promise.all(urls.map(url => chrome.tabs.create({ url }).catch(() => null)))
      .then(results => {
        sendResponse({ ok: true, count: results.filter(Boolean).length });
      });
    return true;
  }

  if (message.type === 'close-tabs-matching') {
    const query = (message.query || '').toLowerCase();
    chrome.tabs.query({}, (tabs) => {
      const matches = tabs.filter(t =>
        (t.title || '').toLowerCase().includes(query) ||
        (t.url || '').toLowerCase().includes(query)
      );
      const ids = matches.map(t => t.id).filter(Boolean);
      if (ids.length > 0) {
        chrome.tabs.remove(ids).then(() => sendResponse({ ok: true, count: ids.length }));
      } else {
        sendResponse({ ok: true, count: 0 });
      }
    });
    return true;
  }

  if (message.type === 'capture-tab') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      sendResponse({ ok: true, dataUrl });
    });
    return true;
  }

  if (message.type === 'set-badge') {
    const count = message.count || 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#f43f5e' });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'get-page-content') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) { sendResponse({ ok: false }); return; }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'extract-content' }, (response) => {
        sendResponse(response || { ok: false });
      });
    });
    return true;
  }

  // ── Set a reminder ──────────────────────────────────────────────────────────
  if (message.type === 'set-reminder') {
    const { task, fireAt } = message;
    const delayMs = fireAt - Date.now();
    if (delayMs <= 0) {
      sendResponse({ ok: false, error: 'Time is in the past.' });
      return false;
    }

    const alarmName = `reminder:${task}`;
    chrome.alarms.create(alarmName, { when: fireAt });

    // Persist so we can show in UI
    chrome.storage.local.get('orbiv-reminders', (data) => {
      const reminders = data['orbiv-reminders'] || [];
      reminders.push({ task, fireAt, alarmName, created: Date.now() });
      chrome.storage.local.set({ 'orbiv-reminders': reminders });
    });

    sendResponse({ ok: true, alarmName });
    return false;
  }

  // ── List active reminders ───────────────────────────────────────────────────
  if (message.type === 'list-reminders') {
    chrome.storage.local.get('orbiv-reminders', (data) => {
      const reminders = (data['orbiv-reminders'] || []).filter(r => r.fireAt > Date.now());
      sendResponse(reminders);
    });
    return true;
  }
});
