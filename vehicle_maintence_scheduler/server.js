require('dotenv').config();
const express = require('express');
const { Log, expressLogger, authedGet } = require('logging-middleware');
const { solveKnapsack } = require('./solver');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());
app.use(expressLogger('middleware'));

async function fetchDepots() {
  Log('backend', 'info', 'repository', 'fetching depots from evaluation-service');
  const data = await authedGet('/depots');
  return data.depots || [];
}

async function fetchVehicles() {
  Log('backend', 'info', 'repository', 'fetching vehicles from evaluation-service');
  const data = await authedGet('/vehicles');
  return data.vehicles || [];
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/**
 * GET /schedule/:depotId
 * Returns the optimal subset of vehicles to service for the given depot,
 * maximising operational impact within MechanicHours.
 */
/**
 * The /depots endpoint returns a randomised subset on each call. To avoid
 * spurious 404s when the requested depot just happens to be absent, we retry
 * up to MAX_DEPOT_LOOKUP_ATTEMPTS times before giving up.
 */
const MAX_DEPOT_LOOKUP_ATTEMPTS = 8;

async function findDepotById(depotId) {
  const seenIds = new Set();
  for (let attempt = 1; attempt <= MAX_DEPOT_LOOKUP_ATTEMPTS; attempt++) {
    const depots = await fetchDepots();
    depots.forEach(d => seenIds.add(d.ID));
    const hit = depots.find(d => d.ID === depotId);
    if (hit) return { depot: hit, attempts: attempt };
    Log('backend', 'debug', 'service',
      `depot ${depotId} not in response (attempt ${attempt}); got [${depots.map(d => d.ID).join(',')}]`);
  }
  return { depot: null, attempts: MAX_DEPOT_LOOKUP_ATTEMPTS, seenIds: [...seenIds] };
}

app.get('/schedule/:depotId', async (req, res) => {
  const depotId = Number(req.params.depotId);
  if (!Number.isFinite(depotId)) {
    Log('backend', 'warn', 'handler', `invalid depotId: ${req.params.depotId}`);
    return res.status(400).json({ error: 'depotId must be numeric' });
  }

  try {
    const [{ depot, attempts, seenIds }, vehicles] = await Promise.all([
      findDepotById(depotId),
      fetchVehicles()
    ]);
    if (!depot) {
      Log('backend', 'warn', 'handler', `depot ${depotId} not found after ${attempts} attempts`);
      return res.status(404).json({
        error: `depot ${depotId} not found`,
        hint: 'the eval server returns a random subset of depots per call; observed IDs across attempts:',
        seenDepotIds: seenIds
      });
    }

    Log('backend', 'info', 'controller',
      `scheduling depot=${depotId} budget=${depot.MechanicHours}h vehicles=${vehicles.length}`
    );

    const result = solveKnapsack(vehicles, depot.MechanicHours);
    res.json({
      depotID: depot.ID,
      mechanicHoursBudget: depot.MechanicHours,
      totalImpact: result.totalImpact,
      totalDurationUsed: result.totalDuration,
      vehiclesScheduledCount: result.selectedTaskIDs.length,
      scheduledTaskIDs: result.selectedTaskIDs
    });
  } catch (err) {
    Log('backend', 'error', 'handler', `/schedule/${depotId} failed: ${err.message}`);
    res.status(502).json({ error: 'failed to compute schedule', detail: err.message });
  }
});

/**
 * GET /schedule
 * Convenience endpoint — returns a schedule for every depot in one call.
 */
app.get('/schedule', async (_req, res) => {
  try {
    // The eval server returns a random subset of depots each call, so poll a
    // few times and union the results to give the caller a complete picture.
    const merged = new Map();
    for (let i = 0; i < MAX_DEPOT_LOOKUP_ATTEMPTS; i++) {
      const batch = await fetchDepots();
      batch.forEach(d => merged.set(d.ID, d));
    }
    const depots = [...merged.values()].sort((a, b) => a.ID - b.ID);
    const vehicles = await fetchVehicles();
    Log('backend', 'info', 'controller',
      `scheduling all depots=${depots.length} vehicles=${vehicles.length}`
    );
    const schedules = depots.map(depot => {
      const r = solveKnapsack(vehicles, depot.MechanicHours);
      return {
        depotID: depot.ID,
        mechanicHoursBudget: depot.MechanicHours,
        totalImpact: r.totalImpact,
        totalDurationUsed: r.totalDuration,
        vehiclesScheduledCount: r.selectedTaskIDs.length,
        scheduledTaskIDs: r.selectedTaskIDs
      };
    });
    res.json({ schedules });
  } catch (err) {
    Log('backend', 'error', 'handler', `/schedule failed: ${err.message}`);
    res.status(502).json({ error: 'failed to compute schedules', detail: err.message });
  }
});

app.listen(PORT, () => {
  Log('backend', 'info', 'service', `vehicle scheduler listening on :${PORT}`);
  console.log(`vehicle_maintence_scheduler listening on http://localhost:${PORT}`);
});
