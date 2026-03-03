/**
 * Orbiv — check-done.js
 * Twilio Function: GET /check-done
 *
 * Called by the Orbiv app to check whether a task has been marked done
 * via phone keypress (press 1 during call). Uses Twilio Sync to store state.
 *
 * Query params:
 *   taskId  — the task ID to check
 *   syncSid — Twilio Sync Service SID (ISxxxxxxxx)
 *
 * Returns:
 *   { done: true }  — user pressed 1 for this task
 *   { done: false } — not yet marked done
 *
 * Environment variables (set in Twilio Console → Functions → Environment Variables):
 *   SYNC_SERVICE_SID — ISxxxxxxxx (default Sync service SID)
 */
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');
  response.appendHeader('Access-Control-Allow-Origin', '*');

  const taskId  = event.taskId;
  const syncSid = event.syncSid || context.SYNC_SERVICE_SID || '';

  if (!taskId || !syncSid) {
    response.setStatusCode(400);
    response.setBody(JSON.stringify({ done: false, error: 'Missing taskId or syncSid' }));
    return callback(null, response);
  }

  try {
    const client = context.getTwilioClient();
    // Each task gets a Sync Document named "task-<taskId>"
    const doc = await client.sync.v1.services(syncSid)
      .documents(`task-${taskId}`)
      .fetch();

    const done = doc.data && doc.data.done === true;
    response.setStatusCode(200);
    response.setBody(JSON.stringify({ done }));
  } catch (err) {
    // 404 means the document hasn't been created yet (task not acted on)
    if (err.status === 404 || err.code === 20404) {
      response.setStatusCode(200);
      response.setBody(JSON.stringify({ done: false }));
    } else {
      response.setStatusCode(500);
      response.setBody(JSON.stringify({ done: false, error: err.message }));
    }
  }

  return callback(null, response);
};
