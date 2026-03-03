/**
 * Orbiv — task-response.js
 * Twilio Function: POST /task-response
 *
 * Called by Twilio after the user presses a key during an interactive call.
 * Handles:
 *   1 → mark task done (writes to Sync), advance to next task
 *   2 → skip task, advance to next task
 *   anything else → re-prompt
 *
 * Query/body params (passed from call-user.js Gather action URL):
 *   Digits    — key pressed (Twilio built-in)
 *   tasks     — JSON array of { id, title } (remaining tasks)
 *   taskIndex — index of current task in tasks array
 *   taskId    — ID of current task
 *   syncSid   — Twilio Sync Service SID
 *
 * Environment variables:
 *   SYNC_SERVICE_SID — ISxxxxxxxx
 *   DOMAIN_NAME      — orbivservice-2647.twil.io
 */
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'text/xml');

  const digits    = event.Digits || '';
  const syncSid   = event.syncSid || context.SYNC_SERVICE_SID || '';
  const taskId    = event.taskId  || '';
  const taskIndex = parseInt(event.taskIndex || '0', 10);

  let tasks = [];
  try { tasks = JSON.parse(decodeURIComponent(event.tasks || '[]')); } catch { tasks = []; }

  const sanitise = s => String(s)
    .replace(/&/g, 'and').replace(/[<>]/g, '').replace(/[""]/g, '"')
    .replace(/[''`]/g, "'").replace(/—|–/g, ', ').replace(/[^\x20-\x7E]/g, '').trim();

  // Handle keypress
  if (digits === '1' && taskId && syncSid) {
    // Mark task done in Sync
    try {
      const client = context.getTwilioClient();
      await client.sync.v1.services(syncSid)
        .documents.create({ uniqueName: `task-${taskId}`, data: { done: true } })
        .catch(() =>
          // Document may already exist — update instead
          client.sync.v1.services(syncSid)
            .documents(`task-${taskId}`)
            .update({ data: { done: true } })
        );
    } catch { /* non-fatal — continue call */ }
  }

  // Advance to next task
  const nextIndex = taskIndex + 1;
  const nextTask  = tasks[nextIndex];

  let twiml;
  if (!nextTask) {
    // No more tasks
    const doneMsg = digits === '1' ? 'Marked as done. ' : digits === '2' ? 'Skipped. ' : '';
    twiml = `<Response><Say voice="Polly.Joanna">${doneMsg}That's all your tasks. Have a great day! Goodbye.</Say></Response>`;
  } else {
    const doneMsg = digits === '1' ? 'Marked as done. ' : digits === '2' ? 'Skipped. ' : '';
    const tasksEncoded = encodeURIComponent(JSON.stringify(tasks));
    const gatherParams = [
      `tasks=${tasksEncoded}`,
      `taskIndex=${nextIndex}`,
      `taskId=${encodeURIComponent(nextTask.id)}`,
      `syncSid=${encodeURIComponent(syncSid)}`,
    ].join('&amp;');
    const gatherUrl = `https://${context.DOMAIN_NAME}/task-response?${gatherParams}`;
    twiml = `<Response><Say voice="Polly.Joanna">${doneMsg}Task ${nextIndex + 1}: ${sanitise(nextTask.title)}.</Say><Gather numDigits="1" action="${gatherUrl}" timeout="10"><Say voice="Polly.Joanna">Press 1 if completed, press 2 to skip.</Say></Gather><Say voice="Polly.Joanna">No input received. Goodbye!</Say></Response>`;
  }

  response.setBody(twiml);
  return callback(null, response);
};
