/**
 * Orbiv — call-user.js
 * Twilio Function: POST /call-user
 *
 * Called by the Orbiv app to place an outbound call to a user.
 * Your Twilio credentials never leave the server.
 *
 * Expected body params:
 *   toPhone  — user's phone number e.g. +15551234567
 *   tasks    — JSON array of { id, title, dueTime? }
 *   syncSid  — (optional) Twilio Sync SID for interactive mode
 *
 * Environment variables (set in Twilio Console → Functions → Environment Variables):
 *   TWILIO_FROM_PHONE  — your Twilio number e.g. +15559876543
 *   SYNC_SERVICE_SID   — ISxxxxxxxx (optional, for press-1-to-complete)
 *   DOMAIN_NAME        — orbivservice-2647.twil.io
 */
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  const toPhone   = event.toPhone;
  const syncSid   = event.syncSid || context.SYNC_SERVICE_SID || '';
  const fromPhone = context.TWILIO_FROM_PHONE;

  if (!toPhone || !fromPhone) {
    response.setStatusCode(400);
    response.setBody(JSON.stringify({ ok: false, error: 'Missing toPhone or TWILIO_FROM_PHONE env var' }));
    return callback(null, response);
  }

  let tasks = [];
  try { tasks = JSON.parse(event.tasks || '[]'); } catch { tasks = []; }

  const pending = tasks.filter(t => !t.completed);
  const count   = pending.length;

  // Sanitise text for TwiML XML
  const sanitise = s => String(s)
    .replace(/&/g, 'and').replace(/[<>]/g, '').replace(/[""]/g, '"')
    .replace(/[''`]/g, "'").replace(/—|–/g, ', ').replace(/[^\x20-\x7E]/g, '').trim();

  let twiml;

  if (syncSid && count > 0) {
    // Interactive mode — Gather keypresses, post back to /gather
    const tasksEncoded = encodeURIComponent(JSON.stringify(
      pending.map(t => ({ id: t.id, title: sanitise(t.title) }))
    ));
    const firstTask   = pending[0];
    const gatherParams = [
      `tasks=${tasksEncoded}`,
      `taskIndex=0`,
      `taskId=${encodeURIComponent(firstTask.id)}`,
      `syncSid=${encodeURIComponent(syncSid)}`,
    ].join('&amp;');
    const gatherUrl = `https://${context.DOMAIN_NAME}/gather?${gatherParams}`;
    twiml = `<Response><Say>Hi! This is Orbiv, your focus assistant. You have ${count} pending ${count === 1 ? 'task' : 'tasks'}.</Say><Gather numDigits="1" action="${gatherUrl}" timeout="10"><Say>Task 1: ${sanitise(firstTask.title)}. Press 1 if completed, press 2 to skip.</Say></Gather><Say>No input received. Check the Orbiv app. Goodbye!</Say></Response>`;
  } else {
    // Simple mode — just read tasks aloud
    const taskLines = pending.map((t, i) =>
      `Task ${i + 1}: ${sanitise(t.title)}${t.dueTime ? `, due at ${t.dueTime}` : ''}.`
    ).join(' ');
    const bodyText = count === 0
      ? `Hi! This is Orbiv. You have no pending tasks. Great work today!`
      : `Hi! This is Orbiv. You have ${count} pending ${count === 1 ? 'task' : 'tasks'} today. ${taskLines} Have a productive day!`;
    twiml = `<Response><Say>${bodyText}</Say></Response>`;
  }

  try {
    const client = context.getTwilioClient();
    const call   = await client.calls.create({ to: toPhone, from: fromPhone, twiml });
    response.setStatusCode(200);
    response.setBody(JSON.stringify({ ok: true, callSid: call.sid }));
  } catch (err) {
    response.setStatusCode(500);
    response.setBody(JSON.stringify({ ok: false, error: err.message }));
  }

  return callback(null, response);
};
