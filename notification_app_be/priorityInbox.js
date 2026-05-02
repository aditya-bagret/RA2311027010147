/**
 * Stage 6 — Priority Inbox top-N implementation.
 *
 * Approach
 * --------
 * Priority is a function of (a) notification type weight and (b) recency.
 *   weight: Placement = 3, Result = 2, Event = 1
 *   recency: linear decay over a 7-day half-life window so that older
 *            notifications drift down even if they're high-weight
 *
 *   score = weight * 100 + recencyBonus
 *   where recencyBonus = max(0, 100 - hoursOld * (100 / (7 * 24)))
 *
 * To keep the top-N efficient as new notifications stream in, we use a
 * **bounded min-heap of size N**:
 *   - inserting a new notification is O(log N)
 *   - if its score beats the heap root we replace and sift down — also O(log N)
 *   - we never sort the full stream, so the data structure is incremental and
 *     ideal for a long-running service
 *
 * For this CLI we fetch the full list once via the Notification API and run
 * every entry through the heap; in production the same heap would sit behind
 * a Kafka consumer and update continuously.
 */

require('dotenv').config();
const { Log, authedGet } = require('logging-middleware');

const TOP_N = Number(process.env.TOP_N || 10);

const TYPE_WEIGHT = { Placement: 3, Result: 2, Event: 1 };
const RECENCY_WINDOW_HOURS = 7 * 24; // notifications older than a week earn no recency bonus

function priorityScore(notification, nowMs = Date.now()) {
  const weight = TYPE_WEIGHT[notification.Type] || 0;
  const ts = Date.parse(notification.Timestamp);
  const hoursOld = Number.isFinite(ts) ? (nowMs - ts) / 3_600_000 : RECENCY_WINDOW_HOURS;
  const recencyBonus = Math.max(0, 100 - hoursOld * (100 / RECENCY_WINDOW_HOURS));
  return weight * 100 + recencyBonus;
}

/** Bounded min-heap that retains only the top-N highest-scoring items. */
class TopNHeap {
  constructor(n) {
    this.n = n;
    this.heap = []; // each entry: { score, item }
  }
  _swap(i, j) { [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]]; }
  _siftUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[p].score > this.heap[i].score) { this._swap(p, i); i = p; } else break;
    }
  }
  _siftDown(i) {
    const len = this.heap.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let smallest = i;
      if (l < len && this.heap[l].score < this.heap[smallest].score) smallest = l;
      if (r < len && this.heap[r].score < this.heap[smallest].score) smallest = r;
      if (smallest === i) break;
      this._swap(i, smallest); i = smallest;
    }
  }
  offer(score, item) {
    if (this.heap.length < this.n) {
      this.heap.push({ score, item });
      this._siftUp(this.heap.length - 1);
    } else if (score > this.heap[0].score) {
      this.heap[0] = { score, item };
      this._siftDown(0);
    }
  }
  toSortedArray() {
    return [...this.heap]
      .sort((a, b) => b.score - a.score)
      .map(({ score, item }) => ({ ...item, _score: Number(score.toFixed(2)) }));
  }
}

async function fetchNotifications() {
  Log('backend', 'info', 'repository', 'fetching notifications from evaluation-service');
  const data = await authedGet('/notifications');
  return data.notifications || [];
}

async function topPriorityInbox(n = TOP_N) {
  const notifications = await fetchNotifications();
  const now = Date.now();
  const heap = new TopNHeap(n);
  for (const note of notifications) {
    heap.offer(priorityScore(note, now), note);
  }
  const top = heap.toSortedArray();
  Log('backend', 'info', 'service',
    `priority inbox computed: scanned=${notifications.length} returned=${top.length}`
  );
  return top;
}

if (require.main === module) {
  topPriorityInbox()
    .then(top => {
      console.log(JSON.stringify(top, null, 2));
    })
    .catch(err => {
      Log('backend', 'error', 'handler', `priority inbox failed: ${err.message}`);
      console.error('error:', err.message);
      process.exit(1);
    });
}

module.exports = { topPriorityInbox, priorityScore, TopNHeap };
