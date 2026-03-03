/**
 * FocusBubble — gmailPoller.ts
 *
 * Fetches unread Gmail messages from the last 24 hours using the Gmail API.
 * Uses OAuth 2.0 (desktop/installed-app flow) with credentials.json and
 * persists the refresh token in token.json so the user only authorises once.
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { parse as parseUrl } from 'url';
import { shell, app } from 'electron';

// ─── Paths ────────────────────────────────────────────────────────────────────
// Store credentials and token in userData so they persist across app updates
// and work in both dev and packaged builds.
const USER_DATA = app.getPath('userData');

const CREDENTIALS_PATH = path.join(USER_DATA, 'credentials.json');
const TOKEN_PATH = path.join(USER_DATA, 'token.json');

// ─── OAuth scopes ─────────────────────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// ─── Credential types ─────────────────────────────────────────────────────────
interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

// ─── Load credentials ─────────────────────────────────────────────────────────
function loadCredentials(): OAuthCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`credentials.json not found at ${CREDENTIALS_PATH}`);
  }
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const { installed } = JSON.parse(raw) as { installed: OAuthCredentials };
  return installed;
}

// ─── Build OAuth2 client ──────────────────────────────────────────────────────
function buildOAuth2Client() {
  const { client_id, client_secret, redirect_uris } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// ─── Token persistence ────────────────────────────────────────────────────────
function saveToken(token: object): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log('FocusBubble Gmail: token saved to', TOKEN_PATH);
}

function loadSavedToken(auth: ReturnType<typeof buildOAuth2Client>): boolean {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    auth.setCredentials(token);
    auth.on('tokens', (newTokens) => {
      saveToken({ ...token, ...newTokens });
    });
    return true;
  } catch {
    return false;
  }
}

// ─── First-time browser OAuth flow ───────────────────────────────────────────
function authorizeViaBrowser(auth: ReturnType<typeof buildOAuth2Client>): Promise<void> {
  return new Promise((resolve, reject) => {
    const redirectUri = 'http://localhost:3000';
    // Override the redirect URI on the client instance
    (auth as unknown as { redirectUri: string }).redirectUri = redirectUri;

    const authUrl = auth.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    console.log('FocusBubble Gmail: Opening browser for Gmail authorisation — please complete login.');
    shell.openExternal(authUrl);

    const server = http.createServer(async (req, res) => {
      try {
        const parsed = parseUrl(req.url ?? '', true);
        const code = parsed.query.code as string | undefined;
        if (!code) {
          res.end('Missing code. Please try again.');
          return;
        }
        res.end('<html><body><h2>FocusBubble: Gmail authorised! You can close this tab.</h2></body></html>');
        server.close();

        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        saveToken(tokens);
        auth.on('tokens', (newTokens) => {
          saveToken({ ...tokens, ...newTokens });
        });
        resolve();
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log('FocusBubble Gmail: Waiting for OAuth redirect on http://localhost:3000 ...');
    });

    server.on('error', reject);
  });
}

// ─── Session state ────────────────────────────────────────────────────────────
// Only surface messages that arrived AFTER the app started this session.
// We record the Unix epoch (seconds) at module load so the first poll uses it
// as the Gmail `after:` cutoff — no historical flood on startup.
const SESSION_START_EPOCH = Math.floor(Date.now() / 1000);

// IDs of messages we've already pushed to the renderer — prevents duplicates
// across successive poll cycles within the same session.
const seenMessageIds = new Set<string>();

// ─── Singleton auth client ────────────────────────────────────────────────────
let _auth: ReturnType<typeof buildOAuth2Client> | null = null;

async function getAuthClient(): Promise<ReturnType<typeof buildOAuth2Client>> {
  if (_auth) return _auth;
  const auth = buildOAuth2Client();
  if (!loadSavedToken(auth)) {
    await authorizeViaBrowser(auth);
  }
  _auth = auth;
  return auth;
}

// ─── Raw notification shape ───────────────────────────────────────────────────
export interface RawNotification {
  platform: string;
  sender: string;
  preview: string;
  timestamp: string;
  messageId?: string; // Gmail message ID for body fetching
}

// ─── Gmail fetch ──────────────────────────────────────────────────────────────
/**
 * Fetches unread Gmail messages received AFTER the app started this session.
 * Already-seen message IDs are skipped so each notification fires exactly once.
 * Returns [] on any error — never throws.
 */
export async function fetchNewGmailNotifications(): Promise<RawNotification[]> {
  try {
    const auth = await getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    // Use session start epoch so we never surface old mail from before launch
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${SESSION_START_EPOCH}`,
      maxResults: 20,
    });

    const messages = listRes.data.messages;
    if (!messages || messages.length === 0) {
      console.log('FocusBubble Gmail: No new messages since session start');
      return [];
    }

    // Filter out messages we've already surfaced in this session
    const unseen = messages.filter(m => m.id && !seenMessageIds.has(m.id));
    if (unseen.length === 0) {
      console.log('FocusBubble Gmail: All messages already seen this session');
      return [];
    }

    console.log(`FocusBubble Gmail: ${unseen.length} new message(s) since session start`);

    const results = await Promise.all(
      unseen.map(async (msg) => {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });

          const headers = detail.data.payload?.headers ?? [];
          const get = (name: string) => headers.find(h => h.name === name)?.value ?? '';

          const from = get('From');
          const subject = get('Subject') || '(no subject)';
          const dateStr = get('Date');

          const senderMatch = from.match(/^"?([^"<]+)"?\s*</);
          const sender = senderMatch
            ? senderMatch[1].trim()
            : from.replace(/<.*>/, '').trim() || from;

          // Mark as seen so subsequent polls skip it
          if (msg.id) seenMessageIds.add(msg.id);

          return {
            platform: 'Gmail',
            sender,
            preview: subject,
            timestamp: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
            messageId: msg.id ?? undefined,
          } as RawNotification;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          console.warn(`FocusBubble Gmail: Failed to fetch message ${msg.id} —`, m);
          return null;
        }
      })
    );

    return results.filter((r): r is RawNotification => r !== null);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error('FocusBubble Gmail: fetch failed —', m);
    return [];
  }
}

// ─── Email body fetch ─────────────────────────────────────────────────────────
/**
 * Fetches the plain-text body of a single Gmail message by its message ID.
 * Returns the decoded text, or an error string — never throws.
 */
export async function fetchEmailBody(messageId: string): Promise<string> {
  try {
    const auth = await getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    // Gmail uses base64url encoding but sometimes standard base64 — handle both
    function decodeBody(data: string): string {
      // base64url uses - and _ instead of + and /
      const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(normalized, 'base64').toString('utf8');
    }

    function stripHtml(html: string): string {
      return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // Walk the payload parts recursively — prefer text/plain, fall back to text/html
    function extractText(payload: typeof detail.data.payload): string {
      if (!payload) return '';

      // Direct plain-text body
      if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return decodeBody(payload.body.data);
      }

      // Direct HTML body
      if (payload.mimeType === 'text/html' && payload.body?.data) {
        return stripHtml(decodeBody(payload.body.data));
      }

      if (payload.parts) {
        // First pass: prefer plain text at any depth
        for (const part of payload.parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            return decodeBody(part.body.data);
          }
        }
        // Second pass: accept HTML
        for (const part of payload.parts) {
          if (part.mimeType === 'text/html' && part.body?.data) {
            return stripHtml(decodeBody(part.body.data));
          }
        }
        // Third pass: recurse into nested multipart/* parts
        for (const part of payload.parts) {
          const nested = extractText(part);
          if (nested) return nested;
        }
      }
      return '';
    }

    const body = extractText(detail.data.payload);
    return body.trim() || '(No readable content)';
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error('FocusBubble Gmail: body fetch failed —', m);
    return `Could not load email body: ${m}`;
  }
}
