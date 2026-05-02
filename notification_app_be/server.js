require('dotenv').config();
const express = require('express');
const { Log, expressLogger } = require('logging-middleware');
const { topPriorityInbox } = require('./priorityInbox');

const app = express();
const PORT = process.env.PORT || 4002;

app.use(express.json());
app.use(expressLogger('middleware'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/**
 * GET /notifications/priority?limit=10
 * Returns the top-N highest-priority notifications using the bounded
 * min-heap algorithm in priorityInbox.js.
 */
app.get('/notifications/priority', async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
  try {
    const top = await topPriorityInbox(limit);
    res.json({ count: top.length, notifications: top });
  } catch (err) {
    Log('backend', 'error', 'handler', `/notifications/priority failed: ${err.message}`);
    res.status(502).json({ error: 'failed to fetch priority inbox', detail: err.message });
  }
});

app.listen(PORT, () => {
  Log('backend', 'info', 'service', `notification_app_be listening on :${PORT}`);
  console.log(`notification_app_be listening on http://localhost:${PORT}`);
});
