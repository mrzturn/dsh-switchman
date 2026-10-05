#!/usr/bin/env node
'use strict';

/**
 * Redis read-only query entry point
 * Pipeline: CLI parsing → command allowlist validation → connect → sendCommand → output → close
 * Security: the db is selected only via connection config (the SELECT command is not exposed);
 *           a client-side timer destroys the socket on timeout;
 *           a Redis ACL read-only user is the final server-side boundary
 */

const { createClient } = require('redis');

// ── Internal modules ──
const { parseCli, CliError } = require('./lib/cli');
const { loadEnvFile, resolveEnv, resolveEnvNumber, ConfigError, sanitizeTarget, safeMessage, buildTlsOptions } = require('./lib/config');
const { validateRedisCommand, RedisReadonlyError } = require('./lib/redis-readonly');
const { formatRedisTable, formatJson } = require('./lib/output');

// ── CLI option spec ──
const REDIS_SPEC = {
  host:              { type: 'string', default: '127.0.0.1' },
  port:              { type: 'integer', default: 6379, min: 1, max: 65535 },
  user:              { type: 'string', default: 'default' },
  password:          { type: 'string', default: undefined },
  db:                { type: 'integer', default: 0, min: 0, max: 15 },
  tls:               { type: 'boolean', default: false },
  'ca-file':         { type: 'string', default: undefined },
  'connect-timeout-ms': { type: 'integer', default: 5000, min: 1000, max: 30000 },
  'timeout-ms':      { type: 'integer', default: 10000, min: 1000, max: 60000 },
  'max-items':       { type: 'integer', default: 200, min: 1, max: 5000 },
  'max-value-bytes': { type: 'integer', default: 4096, min: 256, max: 1048576 },
  format:            { type: 'string', default: 'table', choices: ['table', 'json'] },
  'env-file':        { type: 'string', default: undefined },
  'validate-only':   { type: 'boolean', default: false },
  'allow-unbounded': { type: 'boolean', default: false },
};

const ENV_PREFIX = 'DB_QUERY_REDIS_';

// ── Main ──
async function main() {
  const { options, rest } = parseCli(process.argv.slice(2), REDIS_SPEC);

  // A Redis command must follow --
  if (rest.length === 0) {
    throw new CliError('A Redis command must follow -- (e.g. -- GET key)');
  }

  // Command allowlist validation (before any connection setup)
  const validated = validateRedisCommand(rest, {
    maxItems: options.maxItems,
    allowUnbounded: options['allow-unbounded'],
  });

  // --validate-only: pure offline validation, no connection
  if (options['validate-only']) {
    process.stderr.write(`✓ Command validation passed: ${validated.command} ${validated.args.join(' ')}\n`);
    process.stderr.write(`Output shape: ${validated.shape}${validated.unbounded ? ' (unbounded)' : ''}\n`);
    return;
  }

  // Load env file
  const envPairs = loadEnvFile(options['env-file']);

  // Merge environment overrides (resolveEnvNumber uniformly enforces bounds,
  // so env files cannot bypass hard limits)
  const host = resolveEnv(envPairs, ENV_PREFIX + 'HOST', options.host);
  const port = resolveEnvNumber(envPairs, ENV_PREFIX + 'PORT', options.port, { min: 1, max: 65535 });
  const user = resolveEnv(envPairs, ENV_PREFIX + 'USER', options.user);
  const password = resolveEnv(envPairs, ENV_PREFIX + 'PASSWORD', options.password);
  const db = resolveEnvNumber(envPairs, ENV_PREFIX + 'DB', options.db, { min: 0, max: 15 });
  const maxItems = resolveEnvNumber(envPairs, ENV_PREFIX + 'MAX_ITEMS', options.maxItems, { min: 1, max: 5000 });
  const maxItemsResolved = maxItems;
  const maxValueBytes = resolveEnvNumber(envPairs, 'DB_QUERY_MAX_VALUE_BYTES', options['max-value-bytes'], { min: 256, max: 1048576 });
  const maxValueBytesResolved = maxValueBytes;
  const timeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'TIMEOUT_MS', options['timeout-ms'], { min: 1000, max: 60000 });
  const timeoutMsResolved = timeoutMs;
  const connectTimeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'CONNECT_TIMEOUT_MS', options['connect-timeout-ms'], { min: 1000, max: 30000 });
  const connectTimeoutMsResolved = connectTimeoutMs;

  // Print sanitized target
  const target = sanitizeTarget({ host, port, user, database: db });
  process.stderr.write(`→ Redis ${target}\n`);

  // Build the node-redis v4 client
  const clientConfig = {
    socket: {
      host,
      port,
      connectTimeout: connectTimeoutMs,
      // TLS
      ...(options.tls || options['ca-file']
        ? { tls: buildTlsOptions(options['ca-file']) || { rejectUnauthorized: true } }
        : {}),
    },
    database: db,
    password: password || undefined,
    username: user,
    // Keep Buffer results to avoid losing binary data via auto stringification
    returnBuffers: true,
  };

  const client = createClient(clientConfig);

  // Timeout timer (covers connect + sendCommand)
  const timer = setTimeout(() => {
    client.destroy();
    // Do not reject directly (the promise may already be settled); handled via the error event
  }, timeoutMsResolved);

  try {
    await client.connect();

    // sendCommand takes args as an array; never join-then-split
    // (prevents truncation of arguments containing spaces)
    const cmdArgs = [validated.command, ...validated.args.map(String)];
    const startMs = Date.now();
    const result = await client.sendCommand(cmdArgs);
    const elapsedMs = Date.now() - startMs;

    clearTimeout(timer);

    // Detect truncation
    let count = 0;
    let truncated = false;
    if (Array.isArray(result)) {
      count = result.length;
      truncated = count > maxItemsResolved;
    } else {
      count = 1;
    }

    if (options.format === 'json') {
      // JSON envelope to stdout
      process.stdout.write(JSON.stringify({
        source: 'redis',
        target,
        elapsedMs,
        count: truncated ? maxItemsResolved : count,
        truncated,
        // Buffer → base64 to keep the JSON safe
        result: sanitizeForJson(result),
      }, null, 2) + '\n');
    } else {
      process.stdout.write(formatRedisTable(result, {
        shape: validated.shape,
        command: validated.command,
        maxItems: maxItemsResolved,
        maxValueBytes: maxValueBytesResolved,
      }) + '\n');
    }

    process.stderr.write(`✓ ${count} item(s)${truncated ? ' (truncated)' : ''} in ${elapsedMs}ms\n`);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  } finally {
    try { await client.quit(); } catch (_) { /* ignore close errors */ }
  }
}

/** Recursively convert Buffers to base64 to keep the JSON safe */
function sanitizeForJson(val) {
  if (Buffer.isBuffer(val)) return val.toString('base64');
  if (Array.isArray(val)) return val.map(sanitizeForJson);
  if (val && typeof val === 'object' && val.constructor === Object) {
    const out = {};
    for (const k of Object.keys(val)) out[k] = sanitizeForJson(val[k]);
    return out;
  }
  return val;
}

main().catch(e => {
  // Validation/config errors show their message directly (not connection
  // errors, no sanitizing needed)
  if (e instanceof CliError || e instanceof RedisReadonlyError || e instanceof ConfigError) {
    process.stderr.write('✗ ' + e.message + '\n');
  } else {
    process.stderr.write('✗ ' + safeMessage(e) + '\n');
  }
  process.exit(1);
});
