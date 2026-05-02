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

