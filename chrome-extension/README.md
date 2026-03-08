# Orbiv Chrome Extension

A voice-powered AI assistant that lives in your browser's side panel. Speak or type natural-language commands to manage tabs, set reminders, summarize pages, and more.

## Installation

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `chrome-extension/` folder.
4. Pin the Orbiv icon in the toolbar for quick access.

## Getting Started

Click the Orbiv toolbar icon to open the side panel. You can interact in two ways:

- **Voice** — Click the orb (or press **Space**) to start listening. Speak your command and Orbiv processes it when you finish.
- **Text** — Type a command in the input bar and press **Enter** or click Send.

## Features

### Tab Management

| Command | Example |
|---|---|
| Open one or more sites | "open youtube", "open gmail and twitter" |
| Open multiple tabs | "open 3 youtube tabs", "open five reddit tabs" |
| Close matching tabs | "close all youtube tabs", "close wikipedia" |
| Find open tabs | "find tabs with google", "show my github tabs" |

Orbiv recognises 25+ popular sites by name (YouTube, Gmail, Reddit, GitHub, Spotify, Discord, Notion, Figma, etc.). You can also open any URL directly: "open example.com".

### Reminders

Set reminders using relative or absolute times. Orbiv creates a Chrome alarm and shows a system notification when it fires.

| Command | Example |
|---|---|
| Relative time | "remind me to check gmail in 5 minutes" |
| Relative (spoken) | "remind me to stand up in thirty minutes time" |
| Absolute time | "remind me at 3pm to call John" |
| Alt syntax | "set a reminder in 10 minutes to review PR" |

Pending reminders appear in the Notifications panel and survive browser restarts.

### Page Commands

| Command | What it does |
|---|---|
| "summarize this page" | Extracts headings, meta description, and body text; reads a spoken summary |
| "extract content" | Pulls title, headings, and full text from the current tab |
| "take a screenshot" | Captures the visible tab and saves a PNG to Downloads |

### Daily Planner

Open with the calendar icon or say "open planner". Tasks are stored per day in `chrome.storage.sync` and reset the next day.

- Add tasks via the input field or voice ("open planner").
- Check off completed tasks.
- Optionally include a due time: "Call John at 3pm".

### Notifications

Click the bell icon or say "notifications" / "catch me up". Shows pending reminders and any future notification integrations. A badge count appears on the toolbar icon.

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

| Setting | Options |
|---|---|
| **ElevenLabs API Key** | Paste your key from [elevenlabs.io/app/api-keys](https://elevenlabs.io/app/api-keys). On save, the key is validated against the ElevenLabs API. |
| **Voice** | *Browser (Free)* — uses Web Speech Synthesis. *ElevenLabs (Premium)* — uses ElevenLabs TTS with the Rachel voice. Auto-switches to ElevenLabs when a valid key is saved. |
| **Speech-to-Text** | Web Speech API (built-in, free). |

Settings are synced across Chrome profiles via `chrome.storage.sync`.

## Architecture

```
chrome-extension/
  manifest.json          # MV3 manifest — permissions, side panel, service worker
  background.js          # Service worker: tab ops, alarms, reminders, badge
  content.js             # Content script: page text extraction for summaries
  content.css            # Minimal injected styles
  permissions.html/js    # Mic permission helper page
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

- **Liquid Blob** — Animated N-point simplex-noise morph (same as the Electron app). Enters an alert state on notifications/actions.
- **Intent Classifier** (`classifyLocally`) — Regex-based local classifier that maps natural language to intents: `open_urls`, `close_tabs`, `set_reminder`, `summarize_page`, etc. No network calls needed.
- **Voice Pipeline** — Web Speech API for STT (`SpeechRecognition`). Browser `SpeechSynthesis` or ElevenLabs API for TTS.
- **Background Service Worker** — Handles privileged Chrome APIs (`chrome.tabs`, `chrome.alarms`, `chrome.notifications`). Restores alarms on startup.

### Permissions

| Permission | Why |
|---|---|
| `sidePanel` | Side panel UI |
| `tabs` | Open, close, query tabs |
| `activeTab` | Capture active tab for screenshots |
| `storage` | Persist settings, planner, reminders |
| `alarms` | Schedule reminder notifications |
| `notifications` | Show system notifications for reminders |
| `host_permissions: api.elevenlabs.io` | ElevenLabs TTS API calls |
