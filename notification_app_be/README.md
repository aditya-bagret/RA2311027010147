# Notification App — Backend

Express service exposing the notification APIs designed in [`../notification_system_design.md`](../notification_system_design.md). Stage 6's **Priority Inbox** is implemented as real, runnable code (no pseudo-code).

## Endpoints

| Method | Path                                | Description                                                  |
|--------|-------------------------------------|--------------------------------------------------------------|
| GET    | `/health`                           | Liveness probe                                               |
| GET    | `/notifications/priority?limit=10`  | Top-N highest-priority notifications (Stage 6)              |

## Stage 6 — Priority Inbox

Implementation lives in [`priorityInbox.js`](./priorityInbox.js).

### Scoring

```
score = typeWeight × 100 + recencyBonus
typeWeight: Placement = 3, Result = 2, Event = 1
recencyBonus = max(0, 100 − hoursOld × (100 / 168))   # linear decay over 7 days
```

This gives placement notifications dominance (300+ vs ≤200 for results vs ≤100 for events) while still letting recency break ties within a type.

### Why a bounded min-heap?

The spec calls out that *new notifications keep coming in*, so we need an algorithm that updates incrementally rather than re-sorting the world on each insert.

A **min-heap of fixed size N** is the standard answer:
- The heap root is always the *weakest* of the current top-N.
- An incoming notification is compared to the root in `O(1)`.
- If it beats the root, replace and sift down — `O(log N)`.
- If not, discard.

So per insert the cost is `O(log N) = O(log 10) ≈ 4` comparisons regardless of how big the stream gets. Memory is `O(N)` — exactly 10 items.

In a real deployment the same `TopNHeap` would sit behind a Kafka / SQS consumer; for this CLI we just feed every record from the Notification API into it.

## Running

```bash
cd ../logging-middleware && npm install
cd ../notification_app_be && npm install
cp .env.example .env

# CLI: print top-10 to stdout
npm run topten

# OR start the HTTP server
npm start
# then GET http://localhost:4002/notifications/priority?limit=10
```

Capture the request, response body, and response time from Postman / Insomnia and add the screenshots to this folder per the submission guidelines.
