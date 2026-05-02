const { Log } = require('logging-middleware');

/**
 * Solve 0/1 knapsack: choose a subset of tasks maximising total impact
 * subject to sum(duration) <= capacity.
 *
 * Time:  O(n * capacity)
 * Space: O(capacity)  (we reconstruct the chosen set with a parent-bitset)
 *
 * Durations are integers in the spec (hours), and capacity (MechanicHours) is
 * also an integer, so classic integer DP applies. For real-world scale we use
 * a 1-D rolling array plus a per-item taken[] bitmap to keep memory at
 * O(n * capacity / 8) instead of O(n * capacity) ints.
 */
function solveKnapsack(tasks, capacity) {
  const n = tasks.length;
  const cap = Math.max(0, Math.floor(capacity));

  if (n === 0 || cap === 0) {
    return { totalImpact: 0, totalDuration: 0, selectedTaskIDs: [] };
  }

  // dp[w] = best impact achievable using a subset of items considered so far with total duration == w
  const dp = new Int32Array(cap + 1);
  // taken[i] is a bitmap of length cap+1 — taken[i][w] === 1 iff item i is in the optimal subset for capacity w
  const taken = Array.from({ length: n }, () => new Uint8Array(cap + 1));

  for (let i = 0; i < n; i++) {
    const d = Math.floor(tasks[i].Duration);
    const v = Math.floor(tasks[i].Impact);
    if (d <= 0 || d > cap) continue; // skip items that can never fit
    for (let w = cap; w >= d; w--) {
      const candidate = dp[w - d] + v;
      if (candidate > dp[w]) {
        dp[w] = candidate;
        taken[i][w] = 1;
      }
    }
  }

  // pick the best capacity row (allow under-utilising the budget)
  let bestW = 0;
  for (let w = 1; w <= cap; w++) if (dp[w] > dp[bestW]) bestW = w;

  // reconstruct
  const selectedTaskIDs = [];
  let totalDuration = 0;
  let w = bestW;
  for (let i = n - 1; i >= 0; i--) {
    if (w < 0) break;
    if (taken[i][w]) {
      selectedTaskIDs.push(tasks[i].TaskID);
      const d = Math.floor(tasks[i].Duration);
      totalDuration += d;
      w -= d;
    }
  }
  selectedTaskIDs.reverse();

  Log('backend', 'debug', 'service',
    `knapsack solved: n=${n} cap=${cap} chose=${selectedTaskIDs.length} impact=${dp[bestW]} duration=${totalDuration}`
  );

  return { totalImpact: dp[bestW], totalDuration, selectedTaskIDs };
}

module.exports = { solveKnapsack };
