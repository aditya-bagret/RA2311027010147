# Logging Middleware

A reusable logging package that forwards every log entry to the evaluation server.

## API

```js
const { Log, expressLogger } = require('logging-middleware');

await Log('backend', 'info', 'controller', 'depots fetched: 5 records');
await Log('backend', 'error', 'handler', 'received string, expected bool');
```

`Log(stack, level, package, message)` — all four arguments are required and validated against the allowed enum values from the spec.

`expressLogger(packageName)` returns a connect-style middleware that logs every request and its response status/latency.

## Configuration

The package authenticates against the evaluation server. Provide either a static `ACCESS_TOKEN` env var, or the registration credentials so it can mint and refresh its own token:

```
EVAL_BASE_URL=http://20.207.122.201/evaluation-service
EMAIL=...
NAME=...
ROLL_NO=...
ACCESS_CODE=...
CLIENT_ID=...
CLIENT_SECRET=...
```

Tokens are cached in-process and refreshed 30 seconds before expiry.

## Constraints honoured

- `stack` ∈ {backend, frontend}
- `level` ∈ {debug, info, warn, error, fatal}
- `package` validated against the backend / frontend / shared sets defined in the spec
- Transport failures never throw — the host application keeps running
