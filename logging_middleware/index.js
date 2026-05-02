const axios = require('axios');

const BASE_URL = process.env.EVAL_BASE_URL || 'http://20.207.122.201/evaluation-service';

const VALID_STACKS = new Set(['backend', 'frontend']);
const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const VALID_PACKAGES = new Set([
  'cache', 'controller', 'cron_job', 'db', 'domain', 'handler', 'repository', 'route', 'service',
  'api', 'component', 'hook', 'page', 'state', 'style',
  'auth', 'config', 'middleware', 'utils'
]);

let tokenCache = { accessToken: null, expiresAt: 0 };
let inflightFetch = null;

function hasCredentials() {
  return !!(process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.EMAIL &&
            process.env.NAME && process.env.ROLL_NO && process.env.ACCESS_CODE);
}

async function fetchToken() {
  // de-duplicate concurrent refresh attempts
  if (inflightFetch) return inflightFetch;
  inflightFetch = (async () => {
    const body = {
      email: process.env.EMAIL,
      name: process.env.NAME,
      rollNo: process.env.ROLL_NO,
      accessCode: process.env.ACCESS_CODE,
      clientID: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET
    };
    const resp = await axios.post(`${BASE_URL}/auth`, body, { timeout: 10000 });
    tokenCache.accessToken = resp.data.access_token;
    // expires_in here is an absolute UNIX timestamp (seconds) per the API spec
    tokenCache.expiresAt = (resp.data.expires_in || 0) * 1000;
    process.stderr.write(`[auth] minted fresh token, expires in ${Math.round((tokenCache.expiresAt - Date.now())/1000)}s\n`);
    return tokenCache.accessToken;
  })().finally(() => { inflightFetch = null; });
  return inflightFetch;
}

async function getToken({ forceRefresh = false } = {}) {
  const nowMs = Date.now();
  const expiringSoon = tokenCache.expiresAt > 0 && tokenCache.expiresAt - nowMs < 30_000;

  if (forceRefresh || !tokenCache.accessToken || expiringSoon) {
    if (hasCredentials()) {
      try {
        await fetchToken();
      } catch (e) {
        process.stderr.write(`[auth] token mint failed: ${e.message}\n`);
        // fall through to whatever we have (possibly env ACCESS_TOKEN)
      }
    }
  }

  // First-time bootstrap: if we still have nothing, fall back to a static env token.
  if (!tokenCache.accessToken && process.env.ACCESS_TOKEN) {
    tokenCache.accessToken = process.env.ACCESS_TOKEN;
    tokenCache.expiresAt = 0; // unknown — will be invalidated on 401
  }

  return tokenCache.accessToken;
}

function invalidateToken() {
  tokenCache.accessToken = null;
  tokenCache.expiresAt = 0;
}

/**
 * Reusable Log function. Sends a structured log entry to the evaluation server.
 * Auto-refreshes on 401 and retries once. Never throws back to the caller.
 */
async function Log(stack, level, pkg, message) {
  try {
    if (!VALID_STACKS.has(stack)) throw new Error(`invalid stack: ${stack}`);
    if (!VALID_LEVELS.has(level)) throw new Error(`invalid level: ${level}`);
    if (!VALID_PACKAGES.has(pkg)) throw new Error(`invalid package: ${pkg}`);
    if (typeof message !== 'string' || !message.length) throw new Error('message must be a non-empty string');

    return await postLogWithRetry({ stack, level, package: pkg, message });
  } catch (err) {
    process.stderr.write(`[Log transport failed] ${err.message}\n`);
    return null;
  }
}

async function postLogWithRetry(body, attempt = 0) {
  const token = await getToken({ forceRefresh: attempt > 0 });
  if (!token) throw new Error('no access token available');
  try {
    const resp = await axios.post(`${BASE_URL}/logs`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    return resp.data;
  } catch (err) {
    if (err.response && err.response.status === 401 && attempt === 0 && hasCredentials()) {
      invalidateToken();
      return postLogWithRetry(body, 1);
    }
    throw err;
  }
}

/**
 * Authenticated GET helper for callers (scheduler / notifications service).
 * Retries once on 401 with a freshly minted token.
 */
async function authedGet(path, attempt = 0) {
  const token = await getToken({ forceRefresh: attempt > 0 });
  if (!token) throw new Error('no access token available');
  try {
    const resp = await axios.get(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });
    return resp.data;
  } catch (err) {
    if (err.response && err.response.status === 401 && attempt === 0 && hasCredentials()) {
      invalidateToken();
      return authedGet(path, 1);
    }
    throw err;
  }
}

/** Express middleware that logs every request and its response status/latency. */
function expressLogger(packageName = 'middleware') {
  return function (req, res, next) {
    const start = Date.now();
    Log('backend', 'info', packageName, `incoming ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      const ms = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      Log('backend', level, packageName, `${req.method} ${req.originalUrl} -> ${res.statusCode} in ${ms}ms`);
    });
    next();
  };
}

module.exports = { Log, expressLogger, getToken, authedGet, invalidateToken };
