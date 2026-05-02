# Campus Notification System — Design

Backend design for a campus notification platform. Students receive real-time updates about **Placements, Events, and Results**.

---

## Stage 1

### Core actions the platform must support

| # | Action                          | Who         |
|---|---------------------------------|-------------|
| 1 | List notifications (paginated)  | Student     |
| 2 | Filter by type / read state     | Student     |
| 3 | Mark a notification as read     | Student     |
| 4 | Mark all as read                | Student     |
| 5 | Get the unread count            | Student     |
| 6 | Push a new notification         | Admin / HR  |
| 7 | Bulk push (Notify All)          | Admin / HR  |
| 8 | Receive notifications in real-time | Student  |

### REST API contract

Base URL: `/api/v1`

All endpoints (except the public health check) require:

```
Authorization: Bearer <jwt>
Accept: application/json
Content-Type: application/json     (for POST / PATCH)
X-Request-Id: <uuid>               (set by client or middleware; echoed in responses)
```

#### `GET /notifications`

Query parameters:

| Param      | Type     | Default | Notes                                                   |
|------------|----------|---------|---------------------------------------------------------|
| `limit`    | int      | 20      | 1–100                                                   |
| `cursor`   | string   | —       | opaque pagination cursor (base64-encoded `(createdAt, id)`) |
| `type`     | enum     | —       | `Placement` \| `Result` \| `Event`                      |
| `isRead`   | boolean  | —       | filter by read state                                    |

Response `200 OK`:

```json
{
  "notifications": [
    {
      "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
      "type": "Result",
      "message": "mid-sem",
      "createdAt": "2026-04-22T17:51:30Z",
      "isRead": false
    }
  ],
  "nextCursor": "eyJ0IjoiMjAyNi0wNC0yMlQxNzo1MTozMFoiLCJpZCI6ImQxNDYwOTVhIn0=",
  "unreadCount": 37
}
```

#### `GET /notifications/{id}`

Returns a single notification or `404`.

#### `PATCH /notifications/{id}/read`

Body: `{ "isRead": true }`. Idempotent. Returns the updated record.

#### `POST /notifications/read-all`

Marks every notification of the caller as read. Returns `{ "updatedCount": 37 }`.

#### `GET /notifications/unread-count`

Cheap endpoint for badges. Response: `{ "count": 37 }`.

#### `GET /notifications/priority?limit=10`

Stage 6 endpoint — returns the top-N highest-priority unread notifications.

#### `POST /admin/notifications` *(admin only)*

```json
{
  "type": "Placement",
  "message": "CSX Corporation hiring",
  "audience": { "kind": "all" }
}
```

`audience.kind` can be `all`, `cohort` (with `cohortId`), or `students` (with `studentIds[]`). Returns `202 Accepted` with a `jobId`.

#### Standard error envelope

```json
{
  "error": { "code": "NOTIFICATION_NOT_FOUND", "message": "...", "requestId": "..." }
}
```

### Real-time notifications

Three options were considered. **WebSocket** is the chosen primary, with **SSE** as fallback for restrictive networks and **FCM/APNs** for mobile push when the app is backgrounded.

| Mechanism          | Pros                                    | Cons                                  |
|--------------------|-----------------------------------------|---------------------------------------|
| Long polling       | Trivial to implement                    | Wasted requests, latency 1-2s         |
| **WebSocket**      | Truly bidirectional, sub-second latency | Stateful connections, scale via sticky LB or pub/sub fan-out |
| Server-Sent Events | Simple, works through HTTP/2            | One-way only                          |
| FCM / APNs         | Reaches a closed app                    | Vendor-dependent, no in-app delivery  |

**Wire format** for the WebSocket channel `/ws/notifications`:

```json
{
  "event": "notification.created",
  "data": { /* same shape as GET /notifications item */ }
}
```

The server publishes new notifications onto a Redis Pub/Sub channel keyed per student; each WebSocket worker subscribes only to channels for the students currently connected to it. This keeps the design horizontally scalable.

---

## Stage 2

### DB choice — **PostgreSQL** (relational)

Why:

- **Strong, well-understood query patterns** — every API call is a slice on `(studentId, type, isRead, createdAt)`. SQL with the right composite index makes this trivial.
- **Strong consistency** matters for "mark read" — students are confused when a notification reappears.
- **Mature ecosystem**: partitioning, logical replication, extensions like `pg_partman`, JSONB for forward-compatible payloads.
- **Easy reporting** for admins (campus-wide stats, audit trails) — much harder on a document store.

NoSQL alternatives (MongoDB, DynamoDB) would scale writes more easily but at the cost of rich querying and aggregations the admin dashboards need. We solve write scale with partitioning + read-replicas instead.

### Schema

```sql
CREATE TYPE notification_type AS ENUM ('Placement', 'Result', 'Event');

CREATE TABLE students (
  id          BIGSERIAL PRIMARY KEY,
  email       CITEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  cohort_id   BIGINT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- One row per delivered notification (per student).
CREATE TABLE notifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         BIGINT NOT NULL REFERENCES students(id),
  notification_type  notification_type NOT NULL,
  message            TEXT NOT NULL,
  payload            JSONB,
  is_read            BOOLEAN NOT NULL DEFAULT FALSE,
  read_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- monthly partitions, e.g.
CREATE TABLE notifications_2026_05
  PARTITION OF notifications FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- The single most important index for the inbox query:
CREATE INDEX idx_notif_student_unread_recent
  ON notifications (student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;

CREATE INDEX idx_notif_student_type_recent
  ON notifications (student_id, notification_type, created_at DESC);
```

### Sample queries that back the REST API

```sql
-- GET /notifications  (paginated by createdAt)
SELECT id, notification_type, message, is_read, created_at
FROM notifications
WHERE student_id = $1
  AND ($2::notification_type IS NULL OR notification_type = $2)
  AND ($3::boolean IS NULL OR is_read = $3)
  AND created_at < $4
ORDER BY created_at DESC
LIMIT $5;

-- GET /notifications/unread-count
SELECT COUNT(*) FROM notifications
WHERE student_id = $1 AND is_read = FALSE;

-- PATCH /notifications/:id/read
UPDATE notifications
SET is_read = TRUE, read_at = NOW()
WHERE id = $1 AND student_id = $2 AND is_read = FALSE;

-- POST /admin/notifications  (insert in batch)
INSERT INTO notifications (student_id, notification_type, message, payload)
SELECT id, $1, $2, $3 FROM students WHERE cohort_id = $4;
```

### Problems as data grows, and mitigations

| Problem                                         | Mitigation                                                   |
|-------------------------------------------------|--------------------------------------------------------------|
| Table bloat from 5M+ rows hot                   | **Range partition by `created_at`** monthly; old partitions detached / archived to cold storage |
| Inbox query degrades on cold rows               | **Partial index** on `is_read = FALSE` keeps the working set tiny |
| Write storm during bulk Notify-All               | Batched inserts via `COPY` + a queue (see Stage 5)           |
| Read fanout (badges polled every page load)     | Cache (see Stage 4)                                          |
| `UPDATE` on every read causes index bloat       | `HOT` updates work because `is_read` isn't in most indexes; periodic `REINDEX CONCURRENTLY` |
| Backups taking too long                         | Per-partition backups; archive cold partitions to S3         |

---

## Stage 3

### Reviewing the existing query

```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

**Is it accurate?** Functionally yes — it returns the rows the user expects.

**Why is it slow?**

1. **`SELECT *`** drags every column, including big `payload`/`message` blobs the inbox listing doesn't need.
2. **No `LIMIT`** — for a heavy user with thousands of unreads the DB has to materialise and sort the whole set every time.
3. **Likely no usable index** — without `(studentID, isRead, createdAt DESC)` the planner runs a sequential scan or an index scan that still has to filter and re-sort. With 5M rows this is many seconds.
4. **Sort cost** — `ORDER BY createdAt DESC` on millions of rows blows out work_mem and spills to disk.
5. **Live-data hotspot** — every page load runs this; cumulative cost dominates DB CPU.

**Computational cost (roughly):**
- Without index: O(N) scan + O(K log K) sort, where N = total rows in the table (5M), K = matching rows.
- With the right composite index: O(log N + K) — basically instant.

### "Add an index on every column" — is that safe?

**No.** Indexes are not free:

- Each index adds write amplification — every `INSERT`/`UPDATE` rewrites every relevant index.
- Indexes consume storage and buffer cache, evicting useful pages.
- The planner gets confused with too many overlapping indexes and may pick a worse plan.
- Single-column indexes don't help compound predicates the way composite indexes do.

The right answer is a **small number of carefully chosen composite indexes** that match the actual query patterns — for the inbox, a partial composite is ideal:

```sql
CREATE INDEX idx_notif_student_unread_recent
  ON notifications (student_id, created_at DESC)
  WHERE is_read = FALSE;
```

This index is *small* (only unread rows), *aligned with the predicate*, and serves the query without an extra sort. Combined with a `LIMIT` and column projection:

```sql
SELECT id, notification_type, message, created_at
FROM notifications
WHERE student_id = 1042 AND is_read = FALSE
ORDER BY created_at DESC
LIMIT 20;
```

…the query runs in single-digit milliseconds even on the 5M-row table.

### Find all students who got a placement notification in the last 7 days

```sql
SELECT DISTINCT student_id
FROM notifications
WHERE notification_type = 'Placement'
  AND created_at >= NOW() - INTERVAL '7 days';
```

Index supporting this:

```sql
CREATE INDEX idx_notif_type_recent
  ON notifications (notification_type, created_at DESC);
```

If we need student details too, join after the filter:

```sql
SELECT s.id, s.name, s.email
FROM students s
JOIN (
  SELECT DISTINCT student_id
  FROM notifications
  WHERE notification_type = 'Placement'
    AND created_at >= NOW() - INTERVAL '7 days'
) n ON n.student_id = s.id;
```

---

## Stage 4

The DB gets hammered because **every page load** re-runs an inbox query that almost always returns the same data. This is a textbook caching problem. Strategies, ordered by how I'd layer them:

### 1. Read-through cache for the inbox payload (Redis)

- **Key:** `inbox:{studentId}:v{cacheVersion}` → JSON of the first page (20 most recent).
- **TTL:** 60 seconds (good enough for "near real-time"; the WebSocket push covers true-real-time anyway).
- **Invalidation:** bump `cacheVersion` for the student whenever a new notification arrives, or when the user marks something as read. Cheaper than deleting the key from N different workers.
- **Tradeoff:** stale reads up to 60s if the WebSocket push misses; eliminated by also publishing a cache-bust on the same channel.

### 2. Unread-count cache (Redis counter)

- `unread:{studentId}` → integer, INCR on insert, DECR on mark-read.
- **Tradeoff:** counter drift if a write fails between DB and Redis. Mitigated by a nightly job that recomputes the counter from the DB.

### 3. CDN / browser cache for static parts

- The notification list itself can't be edge-cached, but the metadata (types, icons, copy templates) can. Set `Cache-Control: max-age=300` on those.

### 4. WebSocket push instead of polling

- Once the client opens a socket, it doesn't need to re-fetch on every page load — the server sends deltas. **The single biggest reduction in DB load.**
- **Tradeoff:** stateful connections are harder to scale; needs sticky LB or a pub/sub fan-out (Redis / NATS).

### 5. Read replicas for inbox queries

- Route all `GET /notifications` traffic to a follower; writes still hit the primary.
- **Tradeoff:** replication lag (usually <100ms) means a freshly created notification might not be visible on the next read. Acceptable when paired with the WebSocket push.

### 6. Materialised "feed" table per student (last-resort)

- Pre-aggregate the top 20 per student into a denormalised table updated by a worker.
- **Tradeoff:** great read performance, but writes get more complex and the storage cost roughly doubles.

**Recommended layered solution:** WebSocket push + Redis page cache + Redis unread counter + read replica. This handles the 80/20 case and keeps the architecture simple.

---

## Stage 5

### Shortcomings of the proposed `notify_all`

```python
function notify_all(student_ids, message):
    for student_id in student_ids:
        send_email(student_id, message)
        save_to_db(student_id, message)
        push_to_app(student_id, message)
```

1. **Synchronous & sequential** — 50 000 students × ~300ms per loop = ~4 hours. The HR's request times out.
2. **No retries** — when `send_email` fails for 200 students mid-way, those students never get the email. There is no record of which ones failed and no way to resume.
3. **Coupled side effects** — if `save_to_db` fails for a student the email may already be out the door (or vice-versa); the system ends up in an inconsistent state.
4. **No idempotency** — re-running spams everyone who already received the email.
5. **No backpressure or rate-limiting** — one giant burst can blow your SMTP quota or push provider's limits.
6. **No observability** — no per-student status to debug "did Alice get her notification?".

### Should DB save and email send happen together?

**No.** They are *independent* side effects with different failure modes, latency profiles, and providers. You want:

1. Atomically persist the notification to the DB and enqueue a delivery job. (DB write is the source of truth.)
2. Workers asynchronously pick up jobs and deliver via email / push.
3. Each delivery is tracked separately with its own state machine: `PENDING → SENT | FAILED`.

This way a failed email retries without touching the DB; a successful email updates only the `email_status` column.

### Redesigned approach

```
function notify_all(student_ids, message):
  notification_id = persist_template(message)              # 1 DB row, the canonical record
  for batch in chunks(student_ids, 1000):                   # batch to avoid huge transactions
    transaction:
      bulk_insert_notifications(notification_id, batch)     # one row per (student, channel)
      enqueue_delivery_jobs(notification_id, batch)         # outbox row
    end transaction

# Delivery worker
function deliver_job(job):
  try:
    if job.channel == "email":
      send_email_with_idempotency_key(job.id, ...)
    else:
      push_to_app(job.student_id, job.message)
    mark_job(job.id, "SENT")
  except RetryableError:
    schedule_retry_with_backoff(job, attempts < 5)
  except FatalError as e:
    mark_job(job.id, "FAILED", reason=str(e))
    emit_metric("notify.delivery.failed", channel=job.channel)
```

**Key elements:**
- **Transactional outbox pattern** — DB write and job enqueue happen in the same transaction, then a relay process publishes to the queue. Guarantees at-least-once without distributed transactions.
- **Idempotency key per job** — the email provider dedupes if the worker retries.
- **Exponential backoff with jitter** for transient failures.
- **Dead-letter queue** for jobs that exhaust retries — surfaced on an admin "delivery health" dashboard.
- **Separate channels** — email and in-app push are independent jobs so a stuck SMTP doesn't block in-app notifications.
- **Rate-limited workers** to respect provider quotas.

### What about the 200 mid-way email failures?

With the redesign each of those 200 jobs is just sitting at `PENDING` (or `FAILED` after retries). We do **not** re-run the whole `notify_all`. Instead the operator runs:

```sql
UPDATE delivery_jobs
SET status = 'PENDING', next_attempt_at = NOW()
WHERE notification_id = :id AND status = 'FAILED' AND channel = 'email';
```

…or simply lets the auto-retry worker drain them. No duplicate emails to the 49 800 who already got it.

---

## Stage 6

### Approach

Implemented as runnable code in [`notification_app_be/priorityInbox.js`](notification_app_be/priorityInbox.js) and exposed as `GET /notifications/priority?limit=10` from `notification_app_be/server.js`.

### Scoring formula

```
score = typeWeight × 100 + recencyBonus
typeWeight: Placement = 3, Result = 2, Event = 1
recencyBonus = max(0, 100 − hoursOld × (100 / (7 × 24)))
```

The `× 100` keeps weight categories cleanly separated (Placement starts at 300, Result at 200, Event at 100) while letting recency act as a tiebreaker within a category. Any unread Placement always outranks any Result; recency only matters when types match.

### Data structure — bounded min-heap

Because new notifications are arriving constantly we must **not** re-sort the whole list on every insert. A min-heap of fixed size N gives us:

- Peek-the-weakest in `O(1)` (the heap root).
- Decide-or-discard a new candidate in `O(log N)`.
- For top-10 that's ~3-4 comparisons per incoming notification, regardless of total volume.

In production the same `TopNHeap` would sit behind a stream consumer (Kafka / SQS) and update continuously; for this CLI we simply feed every record from the Notification API into it.

### Maintaining the top-10 efficiently as new notifications arrive

1. Keep one heap **per student** in memory (or in Redis sorted sets if we need cross-instance state).
2. On every notification create event, compute its score and `offer()` to that student's heap. `O(log 10)` work.
3. Periodically (every few minutes) re-score the top-N because recency decays — items drift down even when no new notifications arrive. A cheap timer that just rebuilds a single 10-item heap from itself is sufficient.
4. Persist a snapshot to Redis on change so other instances / a server restart don't lose the priority cache.

### Output

The CLI prints the top-10 to stdout for screenshot capture:

```bash
cd notification_app_be
npm run topten
```

The HTTP endpoint returns the same data as JSON for Postman screenshots.
