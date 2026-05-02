# Vehicle Maintenance Scheduler

A microservice that, for any depot, returns the subset of vehicles to service today such that **total operational impact is maximised** without exceeding the depot's `MechanicHours` budget.

## The problem

Per the spec each task has a `Duration` (hours) and an `Impact` (importance score). A depot has a daily budget `MechanicHours`. Because we either service a vehicle or we don't, this is the classic **0/1 knapsack** problem:

- items     = vehicles
- weights   = `Duration`
- values    = `Impact`
- capacity  = `MechanicHours`

A greedy approach (sort by impact-per-hour) does not guarantee optimality, so we use dynamic programming.

## Algorithm

`solveKnapsack(tasks, capacity)` in [`solver.js`](./solver.js):

- Builds a 1-D rolling DP table `dp[w]` of best impact achievable for each capacity `w ∈ [0, capacity]`.
- Iterates each item and updates `dp[w] = max(dp[w], dp[w - duration] + impact)` walking `w` from high to low so each item is used at most once.
- Records a per-item taken-bitmap so we can reconstruct *which* tasks were chosen — not just the score.
- Picks the best `w ≤ capacity`, allowing the schedule to leave the budget under-utilised when adding the next-best vehicle would exceed it.

**Complexity:** time `O(n · capacity)`, memory `O(n · capacity / 8)` thanks to `Uint8Array` bitmaps. With the spec's capacities (≤ 200ish hours) this scales to millions of vehicles comfortably.

No external algorithm libraries are used.

## Endpoints

| Method | Path                     | Description                                           |
|--------|--------------------------|-------------------------------------------------------|
| GET    | `/health`                | Liveness probe                                        |
| GET    | `/schedule/:depotId`     | Optimal schedule for one depot                        |
| GET    | `/schedule`              | Optimal schedule for every depot in a single call     |

### Sample response

```json
{
  "depotID": 1,
  "mechanicHoursBudget": 60,
  "totalImpact": 87,
  "totalDurationUsed": 60,
  "vehiclesScheduledCount": 14,
  "scheduledTaskIDs": ["264e638f-...", "4b6e22ee-...", "..."]
}
```

## Running locally

```bash
cd logging-middleware && npm install
cd ../vehicle_maintence_scheduler && npm install
cp .env.example .env       # fill in CLIENT_ID / CLIENT_SECRET
npm start
```

Then hit:

```
GET http://localhost:4001/schedule/1
GET http://localhost:4001/schedule
```

Capture the request, response body, and response time from Postman / Insomnia and add the screenshots to this folder per the submission guidelines.

## Logging

Every meaningful event — incoming requests, upstream calls, knapsack runs, errors — is sent through the reusable `Log()` function from `../logging-middleware`. No `console.log` is used in the request path.
