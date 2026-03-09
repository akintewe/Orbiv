# Orbiv Chrome Extension

A voice-powered AI assistant that lives in your browser's side panel. Speak or type natural-language commands to manage tabs, set reminders, summarize pages, record meetings, and more.

## Installation (Developer Mode)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `chrome-extension/` folder.
4. Pin the Orbiv icon in the toolbar for quick access.

## Microphone Setup

Voice commands require microphone access. On first use, Orbiv will prompt Chrome's native permission dialog in place. If the prompt is dismissed, click the orb — you'll be asked again automatically.

## Getting Started

Click the Orbiv toolbar icon to open the side panel. Interact in two ways:

- **Voice** — Click the orb (or press **Space**) to start listening. Speak your command; Orbiv processes it when you finish.
- **Text** — Type a command in the input bar and press **Enter** or click Send.

## Features

### Reminders

Set reminders using natural speech — you don't need to include the time upfront. If you leave it out, Orbiv asks and waits for your answer.

| Command | Example |
|---|---|
| Absolute time | "remind me at 3pm to call John" |
| Relative time | "remind me in 5 minutes to check email" |
| No time (asks follow-up) | "remind me to read a React article" → "at 3pm" |
| Natural phrasing | "at noon", "around 3 o'clock", "in thirty minutes" |

When a reminder fires, Chrome shows a system notification **and** the reminder appears in the Notifications panel with a badge count. Reminders survive browser restarts via `chrome.alarms`.

### Morning Greeting

On first open between 5 am and 11 am, Orbiv greets you and reads out how many tasks you have planned for today (or encourages you to plan your day if the planner is empty). Only fires once per day.

### Task Check-in Notifications

The background service worker fires task check-ins at **9 am, 11 am, 1 pm, 3 pm, and 5 pm**. If you have pending planner tasks, a Chrome notification appears and the side panel shows a summary when opened. Check-in times advance automatically — no setup needed.

### Tab Management

| Command | Example |
|---|---|
| Open one or more sites | "open youtube", "open gmail and twitter" |
| Close matching tabs | "close all youtube tabs", "close wikipedia" |
| Find open tabs | "find tabs with google", "show my github tabs" |
| Open any URL | "open example.com" |

Orbiv recognises 25+ popular sites by name (YouTube, Gmail, Reddit, GitHub, Spotify, Discord, Notion, Figma, etc.).

### Page Commands

| Command | What it does |
|---|---|
| "summarize this page" | Extracts headings, meta description, and body text; reads a spoken summary |
| "extract content" | Pulls title, headings, and full text from the current tab |
| "take a screenshot" | Captures the visible tab and saves a PNG to Downloads |

### Meeting Recorder

Say **"start meeting"** to begin a timestamped transcript. Everything spoken is captured with `[MM:SS]` timestamps. Say **"stop meeting"** (or click Stop) to end — then click **Export** to download the transcript as a `.txt` file.

### Daily Planner

Open with the calendar icon or say **"open planner"**. Tasks are stored per day in `chrome.storage.sync` and reset the next day.

- Add tasks via the input field or voice.
- Check off completed tasks.
- Optionally include a due time: "Call John at 3pm".

### Notifications

Click the bell icon or say "notifications" / "catch me up". Shows fired reminders and task check-ins with a badge count on the toolbar icon.

### Conversational

| Command | Response |
|---|---|
| "what time is it" | Speaks and displays the current time |
| "what's today's date" | Speaks and displays today's date |
| "tell me a joke" | Random programming joke |
| "how are you" | Friendly greeting |
| "help" | Lists available features |

### Web Search

Say "search for best mechanical keyboards" or "google climate change" to open a Google search in a new tab.

## Settings

Open Settings via the gear icon in the header.

| Setting | Details |
|---|---|
| **Airia API Key** | Optional. When set, unknown commands fall back to the Airia AI classifier for smarter intent recognition. Get a key at [airia.ai](https://airia.ai). |
| **ElevenLabs API Key** | Optional. Enables high-quality TTS. Get a key at [elevenlabs.io](https://elevenlabs.io/app/api-keys). Auto-switches voice mode to ElevenLabs on save. |
| **Voice** | *Browser (Free)* — Web Speech Synthesis. *ElevenLabs* — ElevenLabs TTS with the Rachel voice. |
| **Speech-to-Text** | Web Speech API (built-in, always free). |

Settings are synced across Chrome profiles via `chrome.storage.sync`.

## Architecture

```
chrome-extension/
  manifest.json          # MV3 manifest — permissions, side panel, service worker
  background.js          # Service worker: alarms, reminders, task check-ins, badge
  content.js             # Content script: page text extraction for summaries
  content.css            # Minimal injected styles
  permissions.html/js    # Mic permission helper page (fallback)
  sidepanel/
    sidepanel.html       # Side panel UI
    sidepanel.css        # Styles — blob, panels, inputs, animations
    sidepanel.js         # Core logic: blob morph, STT, intent classifier, TTS, UI
  lib/
    simplex-noise.min.js # Simplex noise for blob animation
  icons/
    icon16/48/128.png    # Extension icons
```

### Key Components

- **Liquid Blob** — Animated N-point simplex-noise morph. Enters an alert state on notifications/actions.
- **Intent Classifier** (`classifyLocally`) — Regex-based local classifier for all common intents. Falls back to Airia AI API for ambiguous commands when an API key is configured.
- **Pending Reminder State** — When a reminder is set without a time, `pendingReminderTask` captures the task and the next voice/text input is parsed as a time (handles "at 3pm", "noon", "in 10 minutes", word numbers, etc.).
- **Voice Pipeline** — Web Speech API for STT. Browser `SpeechSynthesis` or ElevenLabs for TTS. Mic permission requested inline on first use.
- **Background Service Worker** — Manages `chrome.alarms`, `chrome.notifications`, task check-in scheduling, and reminder persistence across restarts.

### Permissions

| Permission | Why |
|---|---|
| `sidePanel` | Side panel UI |
| `tabs` | Open, close, query tabs |
| `activeTab` | Capture active tab for screenshots |
| `tabCapture` | Tab screenshot capture |
| `storage` | Persist settings, planner, notifications, reminders |
| `alarms` | Schedule reminder and check-in notifications |
| `notifications` | Show system notifications for reminders and check-ins |
| `microphone` | Microphone access for voice commands |
| `identity` | Future auth integrations |
| `host_permissions: api.elevenlabs.io` | ElevenLabs TTS API |
| `host_permissions: api.airia.ai` | Airia intent classification fallback |
