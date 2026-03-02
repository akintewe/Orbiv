# Orbiv — AI-Powered Focus Bubble

> An always-on-top, transparent macOS desktop assistant that lives as a morphing water-droplet bubble on your screen. Speak to it. It listens, thinks, and acts.

https://github.com/user-attachments/assets/9bbdf102-3618-40a7-97c0-799f4bb0e857

---

## What is Orbiv?

Orbiv is a voice-first ADHD-focused productivity assistant built with Electron. It floats on your desktop as a living, iridescent liquid-glass orb — invisible until you need it, always there when you do.

Double-click the orb → it activates your mic → speak naturally → Orbiv transcribes, classifies your intent, and acts: plays music, opens apps, searches files, takes screenshots, reads your Gmail, summarises notifications, manages your daily task list, and answers questions — all without touching your keyboard.

---

## Demo

https://github.com/user-attachments/assets/9bbdf102-3618-40a7-97c0-799f4bb0e857

---

## Features

| Feature | Details |
|---|---|
| **Voice Commands** | Fully offline STT via `whisper-tiny.en` (ONNX WebWorker — no cloud) |
| **AI Intent Engine** | Airia Brain pipeline classifies natural language → structured intent JSON |
| **TTS** | ElevenLabs neural voice (primary) → macOS `say` (fallback) |
| **Gmail** | Live unread notifications pulled via Google OAuth2 + Gmail API |
| **Notification Brain** | Airia summarises & prioritises notifications into actionable cards |
| **Spotify** | Voice-controlled playback via AppleScript |
| **App Control** | Open / close any macOS app by voice |
| **File Search** | Spotlight-backed file search with voice query |
| **Screenshots** | Full-screen capture saved to Downloads |
| **Meeting Recorder** | Continuous audio capture + ElevenLabs STT meeting transcription |
| **Daily Planner** | Voice-dictated task list with checkbox UI |
| **Liquid Glass Orb** | 4-layer iridescent SVG blob with GSAP + simplex-noise morphing |
| **Always on Top** | Floats above full-screen apps (`screen-saver` level) |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Electron Main                     │
│  • BrowserWindow (transparent / frameless)          │
│  • IPC handlers for every voice intent              │
│  • Gmail OAuth2 polling (60s interval)              │
│  • Airia Brain API — notification summarisation     │
│  • Airia — intent classification                    │
│  • ElevenLabs TTS → afplay MP3                      │
│  • Spotify / App control via AppleScript            │
│  • Screenshot via screencapture                     │
│  • SFSpeechRecognizer (Swift) — meeting STT         │
└────────────────────┬────────────────────────────────┘
                     │ IPC (contextBridge)
┌────────────────────▼────────────────────────────────┐
│                   Renderer Process                   │
│  • Liquid-glass SVG orb (GSAP + simplex-noise)      │
│  • Silence-detection VAD → Whisper WebWorker STT    │
│  • Notification panel with tabbed cards             │
│  • Daily planner UI                                 │
│  • Meeting transcript viewer                        │
└────────────────────┬────────────────────────────────┘
                     │ Worker postMessage
┌────────────────────▼────────────────────────────────┐
│              whisper.worker.ts (WebWorker)           │
│  • @xenova/transformers — whisper-tiny.en (ONNX)    │
│  • Silence detection → Float32Array → transcript    │
│  • 100% offline after first model download (~40MB)  │
└─────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 40 + Electron Forge + Vite + TypeScript |
| Animations | GSAP 3 + simplex-noise 4 |
| STT (voice commands) | `@xenova/transformers` — `Xenova/whisper-tiny.en` ONNX WebWorker |
| STT (meetings) | ElevenLabs Speech-to-Text API |
| TTS | ElevenLabs + macOS `say` fallback |
| Intent AI | Airia Brain pipeline API |
| Notifications | Gmail API via `googleapis` |
| Music | Spotify via AppleScript |
| Meeting STT (offline) | Apple `SFSpeechRecognizer` via Swift CLI |

---

## Getting Started

### Prerequisites

- macOS (required — uses AppleScript, SFSpeechRecognizer, screencapture)
- Node.js 18+
- A Google Cloud project with Gmail API enabled + OAuth2 credentials
- API keys for Airia and ElevenLabs

### Install

```bash
git clone https://github.com/akintewe/focus-bubble.git
cd focus-bubble
npm install
```

### Configure

Create a `.env` file in the project root:

```env
AIRIA_API_KEY=your_airia_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
```

Place your Google OAuth2 credentials at `credentials.json` in the project root (downloaded from Google Cloud Console).

### Run

```bash
npm run start
```

On first launch:
1. A browser window opens for Google OAuth2 — sign in to grant Gmail read access
2. The orb appears on screen
3. The Whisper model downloads in the background (~40MB, one-time)
4. Once the orb pulses, it's ready — double-click to speak

---

## Voice Commands

| Say | Action |
|---|---|
| `"Open Spotify"` | Launches Spotify |
| `"Close Slack"` | Quits Slack |
| `"Play Blinding Lights"` | Plays song on Spotify |
| `"Take a screenshot"` | Saves screenshot to Downloads |
| `"Search for project proposal"` | Spotlight file search |
| `"Read my notifications"` | TTS reads notification summary |
| `"What time is it?"` | Speaks current time |
| `"Start recording meeting"` | Begins meeting transcription |
| `"Add task: review PR"` | Adds to daily planner |
| `"Tell me a joke"` | Orbiv tells a joke |

---

## Project Structure

```
src/
├── main.ts              # Electron main — IPC, Gmail, AI, TTS, system control
├── renderer.ts          # UI logic — orb animation, voice pipeline, panels
├── preload.ts           # contextBridge API surface
├── whisper.worker.ts    # Offline STT WebWorker (Whisper ONNX)
├── index.css            # All styles — glass panel, orb, notification cards
├── global.d.ts          # window.focusBubble type declarations
├── stt-helper.swift     # macOS SFSpeechRecognizer CLI for meeting transcription
├── fileConverter.ts     # PDF/DOCX → plain text for file search
└── notifications/
    └── gmailPoller.ts   # Gmail API polling + OAuth2 refresh
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AIRIA_API_KEY` | Yes | Airia Brain API key for intent classification + notification summarisation |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key for neural TTS and meeting transcription |

Google OAuth tokens are stored in `token.json` after first login (auto-refreshed).

---

## License

MIT
