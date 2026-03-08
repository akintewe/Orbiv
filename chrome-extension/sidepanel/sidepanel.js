/**
 * Orbiv Chrome Extension — Side Panel
 *
 * Features:
 * - Morphing liquid blob (simplex noise, same as Electron app)
 * - Voice commands via Web Speech API
 * - Local intent classification (regex heuristics)
 * - Daily planner (chrome.storage.sync)
 * - Notification hub
 * - Page-aware commands (summarize, extract)
 * - Tab management (find, close tabs)
 * - TTS via browser SpeechSynthesis or ElevenLabs
 * - Screenshot capture via chrome.tabs.captureVisibleTab
 */

// ═══════════════════════════════════════════════════════════════════════════════
// BLOB CONFIGURATION — identical to Electron app
// ═══════════════════════════════════════════════════════════════════════════════

const N_POINTS = 8;
const CX = 0, CY = 0;

const LAYERS = {
  base:   { radius: 82, idleDist: 13, noiseMult: 1.00, phaseShift: 0 },
  cyan:   { radius: 70, idleDist: 21, noiseMult: 1.30, phaseShift: 200 },
  blue:   { radius: 75, idleDist: 18, noiseMult: 1.15, phaseShift: 500 },
  purple: { radius: 65, idleDist: 24, noiseMult: 0.90, phaseShift: 800 },
};

const IDLE_NOISE_STEP = 0.007;
const ALERT_NOISE_STEP = 0.020;
const IDLE_DISPLACEMENT = 1.0;
const ALERT_DISPLACEMENT = 2.5;

const noiseA = createNoise2D();
const noiseB = createNoise2D();

// ═══ Blob state ═══
function makePoints(phaseShift) {
  return Array.from({ length: N_POINTS }, (_, i) => ({
    angle: (i / N_POINTS) * Math.PI * 2,
    noiseOffsetX: Math.random() * 1000 + phaseShift,
    noiseOffsetY: Math.random() * 1000 + phaseShift + 333,
  }));
}

const layerPoints = {
  base:   makePoints(LAYERS.base.phaseShift),
  cyan:   makePoints(LAYERS.cyan.phaseShift),
  blue:   makePoints(LAYERS.blue.phaseShift),
  purple: makePoints(LAYERS.purple.phaseShift),
};

let noiseStep = IDLE_NOISE_STEP;
let displacementMult = IDLE_DISPLACEMENT;
let morphRAF = 0;
let isMorphing = true;

// ═══ Catmull-Rom spline ═══
function mapRange(v, inMin, inMax, outMin, outMax) {
  return ((v - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

function pointsToPath(pts) {
  const n = pts.length;
  const d = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
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

// ═══ DOM refs ═══
const pathBase   = document.getElementById('blob-base');
const pathCyan   = document.getElementById('blob-cyan');
const pathBlue   = document.getElementById('blob-blue');
const pathPurple = document.getElementById('blob-purple');
const blobSpec   = document.getElementById('blob-spec');
const blobGlowWrap = document.getElementById('blob-glow-wrap');
const blobContainer = document.getElementById('blob-container');

const vcBars  = document.getElementById('vc-bars');
const vcLabel = document.getElementById('vc-label');

const cmdInput = document.getElementById('cmd-input');
const btnMic   = document.getElementById('btn-mic');
const btnSend  = document.getElementById('btn-send');

const responseArea  = document.getElementById('response-area');
const responseText  = document.getElementById('response-text');
const responseClose = document.getElementById('response-close');

const notifsPanel = document.getElementById('notifs-panel');
const notifsList  = document.getElementById('notifs-list');
const notifsEmpty = document.getElementById('notifs-empty');
const notifBadge  = document.getElementById('notif-badge');

const plannerPanel  = document.getElementById('planner-panel');
const plannerTasks  = document.getElementById('planner-tasks');
const plannerInput  = document.getElementById('planner-input');
const plannerAddBtn = document.getElementById('planner-add');

const settingsPanel = document.getElementById('settings-panel');

// ═══════════════════════════════════════════════════════════════════════════════
// BLOB MORPH LOOP
// ═══════════════════════════════════════════════════════════════════════════════

function buildLayerPts(pts, cfg) {
  const step = noiseStep * cfg.noiseMult;
  const dist = cfg.idleDist * displacementMult;
  return pts.map(pt => {
    pt.noiseOffsetX += step;
    pt.noiseOffsetY += step;
    const nx = noiseA(pt.noiseOffsetX, pt.angle);
    const ny = noiseB(pt.noiseOffsetY, pt.angle + 31.41);
    const n = (nx + ny) * 0.5;
    const r = cfg.radius + mapRange(n, -1, 1, -dist, dist);
    return { x: CX + Math.cos(pt.angle) * r, y: CY + Math.sin(pt.angle) * r };
  });
}

function morphFrame() {
  const basePts   = buildLayerPts(layerPoints.base, LAYERS.base);
  const cyanPts   = buildLayerPts(layerPoints.cyan, LAYERS.cyan);
  const bluePts   = buildLayerPts(layerPoints.blue, LAYERS.blue);
  const purplePts = buildLayerPts(layerPoints.purple, LAYERS.purple);

  pathBase.setAttribute('d', pointsToPath(basePts));
  pathCyan.setAttribute('d', pointsToPath(cyanPts));
  pathBlue.setAttribute('d', pointsToPath(bluePts));
  pathPurple.setAttribute('d', pointsToPath(purplePts));

  const specPts = basePts.map(p => ({
    x: CX + (p.x - CX) * 0.80,
    y: CY + (p.y - CY) * 0.80,
  }));
  blobSpec.setAttribute('d', pointsToPath(specPts));

  if (isMorphing) morphRAF = requestAnimationFrame(morphFrame);
}

function startMorph() {
  isMorphing = true;
  if (!morphRAF) morphRAF = requestAnimationFrame(morphFrame);
}

// Start blob immediately
startMorph();

// ═══ Alert state ═══
let isAlert = false;

function enterAlertState() {
  if (isAlert) return;
  isAlert = true;
  noiseStep = ALERT_NOISE_STEP;
  displacementMult = ALERT_DISPLACEMENT;
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow-alert)');
  setTimeout(() => {
    if (!isAlert) return;
    noiseStep = IDLE_NOISE_STEP * 1.5;
    displacementMult = IDLE_DISPLACEMENT * 1.4;
  }, 800);
}

function clearAlertState() {
  if (!isAlert) return;
  isAlert = false;
  noiseStep = IDLE_NOISE_STEP;
  displacementMult = IDLE_DISPLACEMENT;
  blobGlowWrap.setAttribute('filter', 'url(#outer-glow)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

let appSettings = {
  elevenLabsKey: '',
  voiceMode: 'browser',
  sttMode: 'browser',
};

async function loadSettings() {
  const data = await chrome.storage.sync.get('orbiv-settings');
  if (data['orbiv-settings']) {
    appSettings = { ...appSettings, ...data['orbiv-settings'] };
  }
  // Populate form
  document.getElementById('setting-elevenlabs-key').value = appSettings.elevenLabsKey || '';
  document.getElementById('setting-voice').value = appSettings.voiceMode || 'browser';
  document.getElementById('setting-stt').value = appSettings.sttMode || 'browser';
}

async function saveSettings() {
  appSettings.elevenLabsKey = document.getElementById('setting-elevenlabs-key').value.trim();
  appSettings.voiceMode = document.getElementById('setting-voice').value;
  appSettings.sttMode = document.getElementById('setting-stt').value;

  // Auto-switch to ElevenLabs if key is provided and voice is still on browser
  if (appSettings.elevenLabsKey && appSettings.voiceMode === 'browser') {
    appSettings.voiceMode = 'elevenlabs';
    document.getElementById('setting-voice').value = 'elevenlabs';
  }

  // Validate ElevenLabs API key if provided
  if (appSettings.elevenLabsKey && appSettings.voiceMode === 'elevenlabs') {
    const keyPreview = appSettings.elevenLabsKey.slice(0, 6) + '...' + appSettings.elevenLabsKey.slice(-4);
    showResponse(`Validating ElevenLabs key (${keyPreview}, ${appSettings.elevenLabsKey.length} chars)...`);
    try {
      const testResp = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': appSettings.elevenLabsKey },
      });
      if (!testResp.ok) {
        const errBody = await testResp.text().catch(() => '');
        showResponse(`ElevenLabs key rejected (HTTP ${testResp.status}). Key used: ${keyPreview} (${appSettings.elevenLabsKey.length} chars). Check that you copied the full key from elevenlabs.io/app/api-keys.`);
        console.warn('Orbiv: ElevenLabs validation failed:', testResp.status, errBody);
        appSettings.voiceMode = 'browser';
        document.getElementById('setting-voice').value = 'browser';
      } else {
        showResponse(`ElevenLabs key valid! Voice set to ElevenLabs.`);
        console.log('Orbiv: ElevenLabs API key validated successfully');
      }
    } catch (e) {
      showResponse('Could not reach ElevenLabs API. Check your internet connection.');
      appSettings.voiceMode = 'browser';
      document.getElementById('setting-voice').value = 'browser';
    }
  }

  await chrome.storage.sync.set({ 'orbiv-settings': appSettings });
  const voiceLabel = appSettings.voiceMode === 'elevenlabs' ? 'ElevenLabs' : 'Browser';
  showResponse(`Settings saved! Voice: ${voiceLabel}`);
  settingsPanel.hidden = true;
}

loadSettings();

// ═══════════════════════════════════════════════════════════════════════════════
// TTS
// ═══════════════════════════════════════════════════════════════════════════════

let _currentUtterance = null;

async function speak(text) {
  // Stop any current speech
  speechSynthesis.cancel();

  if (appSettings.voiceMode === 'elevenlabs' && appSettings.elevenLabsKey) {
    console.log('Orbiv TTS: using ElevenLabs, key length:', appSettings.elevenLabsKey.length);
    try {
      const resp = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': appSettings.elevenLabsKey,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (resp.ok) {
        console.log('Orbiv TTS: ElevenLabs response OK, playing audio');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        return new Promise(resolve => {
          const audio = new Audio(url);
          audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
          audio.onerror = (e) => { console.warn('Orbiv TTS: audio playback error', e); URL.revokeObjectURL(url); resolve(); };
          audio.play().catch((e) => { console.warn('Orbiv TTS: play() failed', e); resolve(); });
        });
      } else {
        const errBody = await resp.text().catch(() => '');
        console.warn('Orbiv TTS: ElevenLabs returned', resp.status, errBody);
        showResponse(`ElevenLabs TTS failed (HTTP ${resp.status}). Using browser voice.`);
      }
    } catch (e) {
      console.warn('Orbiv TTS: ElevenLabs fetch failed:', e);
      showResponse('ElevenLabs TTS unreachable. Using browser voice.');
    }
    console.log('Orbiv TTS: falling back to browser voice');
  }

  // Browser fallback
  return new Promise(resolve => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    utter.pitch = 1.05;
    utter.onend = resolve;
    utter.onerror = resolve;
    _currentUtterance = utter;
    speechSynthesis.speak(utter);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STT — Web Speech API
// ═══════════════════════════════════════════════════════════════════════════════

let recognition = null;
let isListening = false;
let micPermissionGranted = false;
let _finalTranscript = '';
let _processTimer = null;

function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.continuous = true;        // Keep listening — don't cut off at first pause
  rec.interimResults = true;    // Show partial results while speaking
  rec.lang = 'en-US';
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let interim = '';
    _finalTranscript = '';

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        _finalTranscript += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }

    // Show what we're hearing in real-time
    const display = _finalTranscript || interim;
    if (display) {
      vcLabel.textContent = `"${display}"`;
      vcLabel.classList.add('transcript');
    }

    // When we get a final result, stop immediately and process
    if (_finalTranscript.trim()) {
      const text = _finalTranscript.trim();
      console.log('Orbiv STT final:', text);
      stopListening();
      processTranscript(text);
    }
  };

  rec.onerror = (event) => {
    console.warn('Orbiv STT error:', event.error);
    if (event.error === 'not-allowed') {
      stopListening();
      micPermissionGranted = false;
      vcLabel.textContent = 'Mic setup needed — opening setup page...';
      chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
    } else if (event.error === 'no-speech') {
      // Don't stop — just keep listening
      vcLabel.textContent = 'Still listening... speak now.';
    } else if (event.error === 'aborted') {
      // Intentional stop, ignore
    } else {
      stopListening();
      vcLabel.textContent = 'Voice error — type your command.';
    }
  };

  rec.onend = () => {
    // If we're still supposed to be listening (no explicit stop), restart
    // This handles Chrome's auto-stop after ~5s of silence
    if (isListening) {
      try { rec.start(); } catch {}
    }
  };

  return rec;
}

// Listen for permission granted from the permissions page
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'mic-permission-granted') {
    micPermissionGranted = true;
    vcLabel.textContent = 'Mic enabled! Click the orb or press Space.';
  }
});

function startListening() {
  if (isListening) return;

  if (!recognition) recognition = initRecognition();
  if (!recognition) {
    vcLabel.textContent = 'Speech recognition not supported in this browser.';
    return;
  }

  _finalTranscript = '';
  if (_processTimer) { clearTimeout(_processTimer); _processTimer = null; }

  isListening = true;
  vcBars.className = 'listening';
  vcLabel.textContent = 'Listening...';
  vcLabel.classList.add('active');
  vcLabel.classList.remove('transcript');
  btnMic.classList.add('active');

  try {
    recognition.start();
  } catch (e) {
    // Already started
    stopListening();
  }
}

function stopListening() {
  isListening = false;
  if (_processTimer) { clearTimeout(_processTimer); _processTimer = null; }
  vcBars.className = 'idle';
  vcLabel.classList.remove('active');
  btnMic.classList.remove('active');
  // Fully stop and destroy recognition to prevent onend from restarting
  if (recognition) {
    try { recognition.abort(); } catch {}
    recognition = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT CLASSIFICATION — ported from Electron app's classifyLocally()
// ═══════════════════════════════════════════════════════════════════════════════

const SEARCH_NOISE = /\b(search|find|look|looking|locate|where|is|are|my|the|a|an|for|file|files|document|documents|show|me|can|you|please|i|need|want|get|fetch|pull|up|bring)\b/g;

/** Well-known sites — maps spoken name to URL. */
const KNOWN_SITES = {
  'youtube':    'https://www.youtube.com',
  'gmail':      'https://mail.google.com',
  'google':     'https://www.google.com',
  'twitter':    'https://twitter.com',
  'x':          'https://x.com',
  'facebook':   'https://www.facebook.com',
  'instagram':  'https://www.instagram.com',
  'reddit':     'https://www.reddit.com',
  'github':     'https://github.com',
  'linkedin':   'https://www.linkedin.com',
  'whatsapp':   'https://web.whatsapp.com',
  'netflix':    'https://www.netflix.com',
  'spotify':    'https://open.spotify.com',
  'amazon':     'https://www.amazon.com',
  'twitch':     'https://www.twitch.tv',
  'discord':    'https://discord.com/app',
  'slack':      'https://app.slack.com',
  'notion':     'https://www.notion.so',
  'figma':      'https://www.figma.com',
  'chatgpt':    'https://chat.openai.com',
  'claude':     'https://claude.ai',
  'maps':       'https://maps.google.com',
  'drive':      'https://drive.google.com',
  'docs':       'https://docs.google.com',
  'sheets':     'https://sheets.google.com',
  'calendar':   'https://calendar.google.com',
  'tiktok':     'https://www.tiktok.com',
  'pinterest':  'https://www.pinterest.com',
  'stackoverflow': 'https://stackoverflow.com',
};

/** Noise words for close/open commands. */
const CMD_NOISE = /\b(open|close|launch|go\s*to|navigate|visit|shut|kill|quit|exit|please|can|you|now|okay|the|a|an|any|all|every|related\s*to|that|this|my|for|me|i\s*want\s*to|tab|tabs|window|page|site|website)\b/g;

function classifyLocally(t) {
  const s = t.toLowerCase().replace(/['']/g, "'").trim();

  if (/^\(.*\)$/.test(s)) return { intent: 'unknown', query: t };

  // ── Reminders ──────────────────────────────────────────────────────────────
  // Helper: convert spoken numbers to digits
  const _numWords = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
    fifteen:15, twenty:20, thirty:30, forty:40, forty5:45, fifty:50, sixty:60 };
  function _parseNum(str) {
    const n = parseInt(str, 10);
    if (!isNaN(n)) return n;
    return _numWords[str.toLowerCase()] || null;
  }
  const _NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty)';
  const _UNIT = '(min(?:ute)?s?|hour|hours|hr|hrs|sec(?:ond)?s?)';

  // Pattern: "remind me to check gmail in 2 minutes [time]"
  const relA = s.match(new RegExp('\\b(?:remind|reminder|notify|alert|tell)\\s*(?:me)?\\s*(?:to|about|that)\\s+(.+?)\\s+in\\s+' + _NUM + '\\s*' + _UNIT + '(?:\\s*time)?\\b', 'i'));
  if (relA && _parseNum(relA[2])) {
    return { intent: 'set_reminder', time: `${_parseNum(relA[2])} ${relA[3]}`, task: relA[1].trim(), relative: true };
  }
  // Pattern: "remind me in 5 minutes to eat"
  const relB = s.match(new RegExp('\\b(?:remind|reminder|notify|alert|tell)\\s*(?:me)?\\s*(?:in)\\s+' + _NUM + '\\s*' + _UNIT + '(?:\\s*time)?\\s*(?:to|about|that)?\\s*(.*)', 'i'));
  if (relB && _parseNum(relB[1])) {
    return { intent: 'set_reminder', time: `${_parseNum(relB[1])} ${relB[2]}`, task: relB[3]?.trim() || 'your reminder', relative: true };
  }
  // Pattern: "set a reminder in 5 minutes to ..."
  const relC = s.match(new RegExp('\\b(?:set\\s*a?\\s*(?:reminder|alarm|notif|notification))\\s*(?:in)\\s+' + _NUM + '\\s*' + _UNIT + '(?:\\s*time)?\\s*(?:to|about|that)?\\s*(.*)', 'i'));
  if (relC && _parseNum(relC[1])) {
    return { intent: 'set_reminder', time: `${_parseNum(relC[1])} ${relC[2]}`, task: relC[3]?.trim() || 'your reminder', relative: true };
  }

  // Absolute: "remind me at 3pm to call John", "set a reminder for 10:30 to check email"
  const reminderMatch = s.match(/\b(?:remind|reminder|notify|alert|tell)\s*(?:me)?\s*(?:at|by|for)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|about|that)?\s*(.*)/i);
  if (reminderMatch) {
    const time = reminderMatch[1].trim();
    const task = reminderMatch[2]?.trim() || 'your reminder';
    return { intent: 'set_reminder', time, task };
  }
  // Also match "set a reminder for 10:30" or "send me a notif by 10:23"
  const reminderMatch2 = s.match(/\b(?:set\s*a?\s*(?:reminder|alarm|notif|notification)|send\s*(?:me)?\s*a?\s*(?:notif|notification|reminder))\s*(?:at|by|for|in)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|about|that)?\s*(.*)/i);
  if (reminderMatch2) {
    const time = reminderMatch2[1].trim();
    const task = reminderMatch2[2]?.trim() || 'your reminder';
    return { intent: 'set_reminder', time, task };
  }

  // ── Page-aware commands ────────────────────────────────────────────────────
  if (/\b(summarize?|summary|sum\s*up|tldr|what('?s|\s+is)\s+(this|the)\s+(page|article|site|website|tab))\b/.test(s))
    return { intent: 'summarize_page' };

  if (/\b(extract|pull\s*out|get\s*(the)?\s*(text|content|data)|scrape)\b/.test(s))
    return { intent: 'extract_page' };

  // ── Close tab/site — works with or without the word "tab" ─────────────────
  // Matches: "close wikipedia", "close YouTube tab", "close any tab related to mail.google.com"
  if (/\b(close|kill|shut|quit|exit)\b/.test(s)) {
    const query = s.replace(CMD_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();
    if (query) return { intent: 'close_tabs', query };
  }

  // ── Find tabs ──────────────────────────────────────────────────────────────
  if (/\b(find|show|list|where)\b.{0,20}\b(tab|tabs)\b/.test(s)) {
    const query = s.replace(CMD_NOISE, ' ').replace(/\b(find|show|list|where|search)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    return { intent: 'find_tabs', query };
  }

  // ── Screenshot ─────────────────────────────────────────────────────────────
  if (/\b(screenshot|screen\s*shot|capture\s*(the\s*)?(screen|page|tab)|snap\s*(the\s*)?(screen|page))\b/.test(s))
    return { intent: 'take_screenshot' };

  // ── Notifications ──────────────────────────────────────────────────────────
  if (/\b(notification|notifications|unread|what('?s|\s*is)\s*(new|up)|catch\s*me\s*up)\b/.test(s))
    return { intent: 'read_notifications' };

  // ── Planner ────────────────────────────────────────────────────────────────
  if (/\b(plan|planner|tasks?|todo|to-?do|my\s*day|daily)\b/.test(s))
    return { intent: 'open_planner' };

  // ── Time / Date ────────────────────────────────────────────────────────────
  if (/\b(what('?s|\s+is)\s+(the\s+)?(current\s+)?time|what\s+time\s+is\s+it|tell\s+me\s+the\s+time)\b/.test(s))
    return { intent: 'tell_time' };

  if (/\b(what('?s|\s+is)\s+(the\s+)?(today'?s?\s+)?date|what\s+day\s+is\s+(it|today)|what('?s|\s+is)\s+today)\b/.test(s))
    return { intent: 'tell_date' };

  // ── Conversational ─────────────────────────────────────────────────────────
  if (/\b(how\s+are\s+you|how'?s?\s+it\s+going|you\s+okay|you\s+alright)\b/.test(s))
    return { intent: 'greeting' };

  if (/\b(tell\s+(me\s+)?a\s+joke|got\s+a\s+joke|make\s+me\s+laugh|say\s+something\s+funny)\b/.test(s))
    return { intent: 'joke' };

  if (/\b(help|what\s+can\s+you\s+do|commands?|features?)\b/.test(s))
    return { intent: 'help' };

  // ── Open site/URL ──────────────────────────────────────────────────────────
  // First check for known sites: "open youtube", "open gmail and twitter", "open 3 youtube tabs"
  if (/\b(open|go\s*to|navigate|visit|launch)\b/.test(s)) {
    const cleaned = s.replace(CMD_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();

    // Parse a leading count: "open 3 youtube tabs" or "open three youtube tabs"
    const WORD_NUMS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
    const countDigitMatch = s.match(/\b(open|launch)\s+(\d+)\s+/);
    const countWordMatch = s.match(/\b(open|launch)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+/);
    const requestedCount = countDigitMatch ? parseInt(countDigitMatch[2], 10)
      : countWordMatch ? WORD_NUMS[countWordMatch[2]] : 1;

    // Collect ALL matching known sites
    const matched = [];
    for (const [name, url] of Object.entries(KNOWN_SITES)) {
      if (cleaned.includes(name) || s.includes(name)) {
        matched.push({ name, url });
      }
    }
    if (matched.length > 0) {
      // Apply count multiplier (e.g. "open 3 youtube tabs" → 3 copies of youtube)
      const urls = [];
      for (const m of matched) {
        const count = matched.length === 1 ? requestedCount : 1;
        for (let i = 0; i < count; i++) urls.push(m);
      }
      return { intent: 'open_urls', urls };
    }
    // Check for explicit URLs: "open github.com"
    const urlMatch = s.match(/(https?:\/\/\S+|[\w-]+\.(?:com|org|io|dev|net|tv|co)\S*)/);
    if (urlMatch) {
      return { intent: 'open_urls', urls: [{ url: urlMatch[1], name: urlMatch[1] }] };
    }
    // If there's a remaining word, try it as a site name via google "I'm feeling lucky"
    if (cleaned.length > 1) {
      return { intent: 'open_urls', urls: [{ url: `https://www.google.com/search?q=${encodeURIComponent(cleaned)}&btnI=1`, name: cleaned }] };
    }
  }

  // ── Web search ─────────────────────────────────────────────────────────────
  if (/\b(google|search\s*(for|the\s*web)?|look\s*up)\b/.test(s)) {
    const query = s.replace(/\b(google|search|for|the|web|look|up|please|can|you|it|on)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    return { intent: 'web_search', query: query || t };
  }

  return { intent: 'unknown', query: t };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS TRANSCRIPT — execute classified intent
// ═══════════════════════════════════════════════════════════════════════════════

async function processTranscript(transcript) {
  // Ensure mic is fully stopped before processing (prevents TTS feedback loop)
  stopListening();

  vcBars.className = 'processing';
  noiseStep = 0.022;
  displacementMult = 2.8;

  const intent = classifyLocally(transcript);
  const action = intent.intent;
  console.log('Orbiv intent:', JSON.stringify(intent));

  noiseStep = IDLE_NOISE_STEP;
  displacementMult = IDLE_DISPLACEMENT;
  vcBars.className = 'idle';

  if (action === 'summarize_page') {
    showResponse('Reading page...');
    enterAlertState();
    chrome.runtime.sendMessage({ type: 'get-page-content' }, async (resp) => {
      clearAlertState();
      if (resp?.ok && resp.text) {
        // Build a readable summary from headings + first paragraphs
        let summary = `${resp.title}\n`;
        if (resp.description) summary += `\n${resp.description}\n`;
        if (resp.headings && resp.headings.length > 0) {
          summary += `\nSections: ${resp.headings.join(' | ')}\n`;
        }
        // Show first ~1500 chars of actual content
        summary += `\n${resp.text.slice(0, 1500)}`;
        showResponse(summary);

        // Speak a concise version
        const spokenSummary = resp.description
          ? `This page is about ${resp.title}. ${resp.description}`
          : `This page is ${resp.title}. ${resp.text.slice(0, 300)}`;
        await speak(spokenSummary);
      } else {
        showResponse('Could not extract page content. The page might block content scripts.');
        await speak("I couldn't read this page's content.");
      }
    });

  } else if (action === 'extract_page') {
    showResponse('Extracting...');
    chrome.runtime.sendMessage({ type: 'get-page-content' }, (resp) => {
      if (resp?.ok) {
        let output = `Title: ${resp.title}\nURL: ${resp.url}\n`;
        if (resp.headings?.length) output += `\nHeadings:\n${resp.headings.map(h => '  - ' + h).join('\n')}\n`;
        output += `\n${resp.text.slice(0, 3000)}`;
        showResponse(output);
      } else {
        showResponse('Could not extract content.');
      }
    });

  } else if (action === 'close_tabs') {
    const query = intent.query || '';
    if (query) {
      chrome.runtime.sendMessage({ type: 'close-tabs-matching', query }, async (resp) => {
        const msg = resp?.count > 0 ? `Closed ${resp.count} tab${resp.count > 1 ? 's' : ''} matching "${query}".` : `No tabs found matching "${query}".`;
        showResponse(msg);
        await speak(msg);
      });
    } else {
      showResponse('Which tabs should I close? Try "close YouTube tabs".');
      await speak("Which tabs should I close?");
    }

  } else if (action === 'find_tabs') {
    const query = intent.query || '';
    chrome.runtime.sendMessage({ type: 'find-tabs', query }, (tabs) => {
      if (tabs && tabs.length > 0) {
        const list = tabs.slice(0, 10).map(t => `- ${t.title}`).join('\n');
        showResponse(`Found ${tabs.length} tab${tabs.length > 1 ? 's' : ''}:\n${list}`);
      } else {
        showResponse('No matching tabs found.');
      }
    });

  } else if (action === 'take_screenshot') {
    showResponse('Capturing...');
    enterAlertState();
    chrome.runtime.sendMessage({ type: 'capture-tab' }, async (resp) => {
      clearAlertState();
      if (resp?.ok && resp.dataUrl) {
        // Create download
        const a = document.createElement('a');
        a.href = resp.dataUrl;
        a.download = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        a.click();
        showResponse('Screenshot saved to Downloads!');
        await speak('Screenshot captured and saved.');
      } else {
        showResponse('Screenshot failed.');
      }
    });

  } else if (action === 'read_notifications') {
    openNotifications();
    const count = notifications.length;
    const msg = count === 0 ? "You're all caught up!" : `You have ${count} notification${count !== 1 ? 's' : ''}.`;
    await speak(msg);

  } else if (action === 'open_planner') {
    openPlanner();
    await speak("Here's your daily planner.");

  } else if (action === 'tell_time') {
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const m = now.getMinutes().toString().padStart(2, '0');
    const ampm = now.getHours() >= 12 ? 'PM' : 'AM';
    const msg = `It's ${h}:${m} ${ampm}.`;
    showResponse(msg);
    await speak(msg);

  } else if (action === 'tell_date') {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const now = new Date();
    const msg = `Today is ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}.`;
    showResponse(msg);
    await speak(msg);

  } else if (action === 'greeting') {
    const replies = [
      "I'm doing great! How can I help you today?",
      "All good here! What do you need?",
      "Ready to help! What's up?",
    ];
    const msg = replies[Math.floor(Math.random() * replies.length)];
    showResponse(msg);
    await speak(msg);

  } else if (action === 'joke') {
    const jokes = [
      "Why do programmers prefer dark mode? Because light attracts bugs!",
      "Why did the computer go to therapy? It had too many windows open.",
      "I told my computer I needed a break. Now it won't stop sending me Kit-Kat ads.",
      "Why do Java developers wear glasses? Because they don't C sharp!",
    ];
    const msg = jokes[Math.floor(Math.random() * jokes.length)];
    showResponse(msg);
    await speak(msg);

  } else if (action === 'help') {
    const msg = "I can: summarize pages, capture screenshots, manage tabs, track tasks in the planner, tell you the time/date, and more. Just speak or type naturally!";
    showResponse(msg);
    await speak(msg);

  } else if (action === 'open_urls') {
    const entries = intent.urls || [];
    if (entries.length > 0) {
      const tabUrls = entries.map(e => {
        let url = e.url || '';
        if (url && !url.startsWith('http')) url = 'https://' + url;
        return url;
      }).filter(Boolean);
      const names = [...new Set(entries.map(e => e.name).filter(Boolean))];
      const countStr = tabUrls.length > 1 ? ` (${tabUrls.length} tabs)` : '';
      // Route through background script for reliable multi-tab creation
      chrome.runtime.sendMessage({ type: 'open-tabs', urls: tabUrls }, (resp) => {
        console.log('Orbiv: open-tabs response', resp);
      });
      showResponse(`Opening ${names.join(', ')}${countStr}`);
      await speak(`Opening ${names.join(' and ')}${countStr}.`);
    } else {
      showResponse("I couldn't figure out what to open. Try again.");
    }

  } else if (action === 'web_search') {
    const query = intent.query || transcript;
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    chrome.tabs.create({ url });
    showResponse(`Searching for "${query}"...`);

  } else if (action === 'set_reminder') {
    const fireAt = parseReminderTime(intent.time, intent.relative);
    if (!fireAt) {
      showResponse(`Couldn't understand the time "${intent.time}". Try "remind me at 3pm to call John" or "remind me in 5 minutes to check email".`);
      await speak(`Sorry, I couldn't understand that time.`);
    } else {
      const readableTime = new Date(fireAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      chrome.runtime.sendMessage({ type: 'set-reminder', task: intent.task, fireAt }, (resp) => {
        if (resp?.ok) {
          showResponse(`Reminder set for ${readableTime}: "${intent.task}"`);
          // Add to notifications so user can see pending reminders
          notifications.push({
            sender: 'Reminder',
            preview: `${intent.task} — ${readableTime}`,
            time: 'Pending',
            urgency: 'medium',
          });
          updateNotifBadge();
        } else {
          showResponse(`Failed to set reminder: ${resp?.error || 'unknown error'}`);
        }
      });
      await speak(`Got it! I'll remind you at ${readableTime} to ${intent.task}.`);
    }

  } else {
    showResponse("I'm not sure what you meant. Try saying something like \"summarize this page\" or \"what time is it\".");
    await speak("Hmm, I'm not sure what you meant. Could you try again?");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REMINDER TIME PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a spoken time string into a ms timestamp.
 * Absolute: "3pm", "3:30pm", "15:00", "3 pm", "10:23"
 * Relative: "5 minutes", "2 hours", "30 seconds"
 */
function parseReminderTime(timeStr, isRelative) {
  if (!timeStr) return null;
  const s = timeStr.toLowerCase().trim();

  // Relative time: "5 minutes", "2 hours", "30 seconds"
  if (isRelative) {
    const rel = s.match(/^(\d+)\s*(min|minute|minutes|hour|hours|hr|hrs|sec|seconds?)$/);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const unit = rel[2];
      let ms;
      if (unit.startsWith('sec')) ms = n * 1000;
      else if (unit.startsWith('h')) ms = n * 60 * 60 * 1000;
      else ms = n * 60 * 1000; // minutes
      return Date.now() + ms;
    }
    return null;
  }

  // Absolute time
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  const d = new Date();
  d.setHours(hours, mins, 0, 0);
  // If the time has already passed today, schedule for tomorrow
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Listen for reminder notifications from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'reminder-fired') {
    enterAlertState();
    showResponse(`Reminder: ${message.task}`);
    speak(`Hey! Reminder: ${message.task}`).then(() => {
      setTimeout(clearAlertState, 2000);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function showResponse(text) {
  responseText.textContent = text;
  responseArea.hidden = false;
}

function hideResponse() {
  responseArea.hidden = true;
  responseText.textContent = '';
}

responseClose.addEventListener('click', hideResponse);

// ═══════════════════════════════════════════════════════════════════════════════
// PLANNER
// ═══════════════════════════════════════════════════════════════════════════════

let tasks = [];

async function loadTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await chrome.storage.sync.get('orbiv-planner');
  const saved = data['orbiv-planner'];
  if (saved && saved.date === today) {
    tasks = saved.tasks || [];
  } else {
    tasks = [];
  }
  renderTasks();
}

async function saveTasks() {
  const today = new Date().toISOString().slice(0, 10);
  await chrome.storage.sync.set({ 'orbiv-planner': { date: today, tasks } });
  renderTasks();
}

function renderTasks() {
  plannerTasks.innerHTML = '';
  tasks.forEach((task, idx) => {
    const div = document.createElement('div');
    div.className = `task-item${task.completed ? ' completed' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = task.completed;
    cb.addEventListener('change', () => {
      tasks[idx].completed = cb.checked;
      saveTasks();
    });

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.textContent = '\u00d7';
    del.addEventListener('click', () => {
      tasks.splice(idx, 1);
      saveTasks();
    });

    div.appendChild(cb);
    div.appendChild(title);
    if (task.dueTime) {
      const time = document.createElement('span');
      time.className = 'task-time';
      time.textContent = task.dueTime;
      div.appendChild(time);
    }
    div.appendChild(del);
    plannerTasks.appendChild(div);
  });
}

function addTask(title) {
  if (!title.trim()) return;

  // Parse optional time: "Call John at 3pm" → title="Call John", dueTime="3:00 PM"
  let dueTime = '';
  const timeMatch = title.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i);
  if (timeMatch) {
    dueTime = timeMatch[1].trim();
    title = title.replace(timeMatch[0], '').trim();
  }

  tasks.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    dueTime,
    completed: false,
  });
  saveTasks();
}

function openPlanner() {
  plannerPanel.hidden = false;
  loadTasks();
}

plannerAddBtn.addEventListener('click', () => {
  addTask(plannerInput.value);
  plannerInput.value = '';
  plannerInput.focus();
});

plannerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addTask(plannerInput.value);
    plannerInput.value = '';
  }
});

document.getElementById('planner-back').addEventListener('click', () => {
  plannerPanel.hidden = true;
});

loadTasks();

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

let notifications = [];

function openNotifications() {
  notifsPanel.hidden = false;
  renderNotifications();
}

function renderNotifications() {
  notifsList.innerHTML = '';
  if (notifications.length === 0) {
    notifsEmpty.hidden = false;
    return;
  }
  notifsEmpty.hidden = true;
  notifications.forEach(n => {
    const card = document.createElement('div');
    card.className = `notif-card urgency-${n.urgency || 'low'}`;

    const sender = document.createElement('div');
    sender.className = 'notif-sender';
    sender.textContent = n.sender || 'Unknown';

    const preview = document.createElement('div');
    preview.className = 'notif-preview';
    preview.textContent = n.preview || '';

    const time = document.createElement('div');
    time.className = 'notif-time';
    time.textContent = n.time || '';

    card.appendChild(sender);
    card.appendChild(preview);
    card.appendChild(time);
    notifsList.appendChild(card);
  });
}

function updateNotifBadge() {
  const count = notifications.length;
  notifBadge.textContent = String(count);
  notifBadge.hidden = count === 0;
  chrome.runtime.sendMessage({ type: 'set-badge', count });
}

document.getElementById('notifs-back').addEventListener('click', () => {
  notifsPanel.hidden = true;
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// Blob click → start listening
blobContainer.addEventListener('click', () => {
  if (isListening) {
    stopListening();
  } else {
    startListening();
  }
});

// Mic button
btnMic.addEventListener('click', () => {
  if (isListening) {
    stopListening();
  } else {
    startListening();
  }
});

// Send button / Enter on input
btnSend.addEventListener('click', () => {
  const text = cmdInput.value.trim();
  if (text) {
    cmdInput.value = '';
    vcLabel.textContent = `"${text}"`;
    vcLabel.classList.add('transcript');
    processTranscript(text);
  }
});

cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    btnSend.click();
  }
});

// Spacebar shortcut for voice (when input not focused)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== cmdInput && document.activeElement !== plannerInput) {
    e.preventDefault();
    if (isListening) stopListening();
    else startListening();
  }
});

// Header buttons
document.getElementById('btn-planner').addEventListener('click', openPlanner);
document.getElementById('btn-notifs').addEventListener('click', openNotifications);
document.getElementById('btn-settings').addEventListener('click', () => {
  settingsPanel.hidden = false;
});
document.getElementById('settings-back').addEventListener('click', () => {
  settingsPanel.hidden = true;
});
document.getElementById('settings-save').addEventListener('click', saveSettings);

// Welcome state
vcLabel.textContent = 'Click the orb or press Space';
