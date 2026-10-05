#!/usr/bin/env node
'use strict';

/**
 * MySQL read-only query entry point
 * Pipeline: CLI parsing → SQL read-only validation → connect (read-only txn + timeout) → query → output → rollback & close
 * Security: client-side timer + server-side MAX_EXECUTION_TIME as dual safeguards; always ROLLBACK
 */

const fs = require('fs');
const path = require('path');

// ── Internal modules ──
const { parseCli, CliError } = require('./lib/cli');
const { loadEnvFile, resolveEnv, resolveEnvNumber, ConfigError, sanitizeTarget, safeMessage, buildTlsOptions } = require('./lib/config');
const { validateMysqlSql, ReadonlyError } = require('./lib/mysql-readonly');
const { formatMysqlTable, formatJson } = require('./lib/output');

// ── CLI option spec ──
const MYSQL_SPEC = {
  host:              { type: 'string', default: '127.0.0.1' },
  port:              { type: 'integer', default: 3306, min: 1, max: 65535 },
  user:              { type: 'string', default: undefined },
  password:          { type: 'string', default: undefined },
  database:          { type: 'string', default: undefined },
  tls:               { type: 'boolean', default: false },
  'ca-file':         { type: 'string', default: undefined },
  'connect-timeout-ms': { type: 'integer', default: 5000, min: 1000, max: 30000 },
  'timeout-ms':      { type: 'integer', default: 10000, min: 1000, max: 60000 },
  'max-rows':        { type: 'integer', default: 200, min: 1, max: 5000 },
  'max-value-bytes': { type: 'integer', default: 4096, min: 256, max: 1048576 },
  format:            { type: 'string', default: 'table', choices: ['table', 'json'] },
  'env-file':        { type: 'string', default: undefined },
  'validate-only':   { type: 'boolean', default: false },
  file:              { type: 'string', default: undefined },
};

const ENV_PREFIX = 'DB_QUERY_MYSQL_';

/** Read SQL from a file (plain text, max 64KiB) */
function readSqlFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`SQL file not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.size > 64 * 1024) throw new Error(`SQL file exceeds 64KiB: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8');
}

/** Print validation result (--validate-only mode) */
function printValidation(checked) {
  process.stderr.write(`✓ Validation passed: ${checked.kind}${checked.limitInjected ? ' (LIMIT injected for truncation)' : ''}\n`);
  process.stderr.write(`Processed SQL:\n${checked.sql}\n`);
}

/** Execute the query with a timeout (client-side timer + server-side MAX_EXECUTION_TIME as dual safeguards) */
function queryWithTimeout(conn, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Client-side timeout: destroy the connection to stop server transmission
      conn.destroy();
      reject(new Error(`Query timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    conn.query(sql)
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

/** Roll back safely (ignore errors so the connection always closes) */
async function safeRollback(conn) {
  try { await conn.query('ROLLBACK'); } catch (_) { /* ignore errors such as no active transaction */ }
}

/** Close the connection safely */
async function safeClose(conn) {
  try { await conn.end(); } catch (_) { /* ignore errors such as connection already closed */ }
}

// ── Main ──
async function main() {
  const { options, rest } = parseCli(process.argv.slice(2), MYSQL_SPEC);

  // SQL source check: --file and a positional argument are mutually exclusive
  if (options.file && rest.length > 0) {
    throw new CliError('--file and a positional SQL argument cannot both be given');
  }
  if (!options.file && rest.length === 0) {
    throw new CliError('SQL must be provided (positional argument or --file)');
  }

  // Read the SQL (before any connection setup)
  const rawSql = options.file ? readSqlFile(options.file) : rest[0];

  // Read-only validation (fully offline, independent of connection parameters)
  const maxRows = options.maxRows;
  const checked = validateMysqlSql(rawSql, { maxRows });

  // --validate-only: pure offline validation, no credential resolution, no connection
  if (options['validate-only']) {
    return printValidation(checked);
  }

  // ── Connection path below: requires connection parameters ──
  // Fix: env file loading must happen before the required user/database checks,
  // otherwise credentials provided by the env file are not visible
  const envPairs = loadEnvFile(options['env-file']);

  // Merge environment overrides (resolveEnvNumber uniformly enforces bounds,
  // so env files cannot bypass hard limits)
  const host = resolveEnv(envPairs, ENV_PREFIX + 'HOST', options.host);
  const port = resolveEnvNumber(envPairs, ENV_PREFIX + 'PORT', options.port, { min: 1, max: 65535 });
  const user = resolveEnv(envPairs, ENV_PREFIX + 'USER', options.user);
  const password = resolveEnv(envPairs, ENV_PREFIX + 'PASSWORD', options.password);
  const database = resolveEnv(envPairs, ENV_PREFIX + 'DATABASE', options.database);

  // user is required; database is optional — the first triage step is often
  // SHOW DATABASES / SELECT 1 / db-prefixed table queries with no default db;
  // MySQL itself reports ER_NO_DB_ERROR when a table query omits the database
  if (!user) throw new CliError('Missing user (provide via --user, DB_QUERY_MYSQL_USER, environment variable, or env file)');
  if (!database) {
    process.stderr.write('(no database specified: only queries that need no default db will work, e.g. SHOW DATABASES / SELECT 1 / db-prefixed tables)\n');
  }

  const maxRowsResolved = resolveEnvNumber(envPairs, ENV_PREFIX + 'MAX_ROWS', options.maxRows, { min: 1, max: 5000 });
  const maxValueBytes = resolveEnvNumber(envPairs, 'DB_QUERY_MAX_VALUE_BYTES', options['max-value-bytes'], { min: 256, max: 1048576 });
  const timeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'TIMEOUT_MS', options['timeout-ms'], { min: 1000, max: 60000 });
  const connectTimeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'CONNECT_TIMEOUT_MS', options['connect-timeout-ms'], { min: 1000, max: 30000 });

  // Print sanitized target (confirm the destination before connecting; never expose the password)
  const target = sanitizeTarget({ host, port, user, database });
  process.stderr.write(`→ MySQL ${target}\n`);

  // Load mysql2 lazily (only when a connection is needed)
  const mysql = require('mysql2/promise');

  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password: password || undefined,
    database,
    connectTimeout: connectTimeoutMs,
    multipleStatements: false,   // explicitly disabled; do not rely on driver defaults
    supportBigNumbers: true,
    bigNumberStrings: true,     // keep BIGINT/DECIMAL as strings for precision
    decimalNumbers: false,
    dateStrings: true,          // keep dates as server-side text
    ...(options.tls || options['ca-file']
      ? { ssl: buildTlsOptions(options['ca-file']) || { rejectUnauthorized: true } }
      : {}),
  });

  const startMs = Date.now();
  try {
    // Server-side read-only transaction (unsupported versions raise an error;
    // fail-closed, no silent downgrade)
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('SET SESSION MAX_EXECUTION_TIME = ?', [timeoutMs]);
    await conn.query('START TRANSACTION READ ONLY');

    const [rows, fields] = await queryWithTimeout(conn, checked.sql, timeoutMs);
    const elapsedMs = Date.now() - startMs;

    // Detect truncation (LIMIT injected a maxRows+1 sentinel row)
    const truncated = checked.limitInjected && rows.length > maxRowsResolved;
    const displayRows = truncated ? rows.slice(0, maxRowsResolved) : rows;

    if (options.format === 'json') {
      // JSON to stdout, status to stderr, so stdout stays valid JSON
      process.stdout.write(JSON.stringify({
        source: 'mysql',
        target,
        elapsedMs,
        count: truncated ? maxRowsResolved : rows.length,
        truncated,
        result: displayRows,
      }, null, 2) + '\n');
    } else {
      process.stdout.write(formatMysqlTable(displayRows, fields, {
        maxRows: maxRowsResolved,
        maxValueBytes,
        truncated,
      }) + '\n');
    }

    process.stderr.write(`✓ ${rows.length} row(s)${truncated ? ' (truncated)' : ''} in ${elapsedMs}ms\n`);
  } finally {
    // Always ROLLBACK, never COMMIT (defensive: guarantees no transaction is left open)
    await safeRollback(conn);
    await safeClose(conn);
  }
}

main().catch(e => {
  if (e instanceof CliError || e instanceof ReadonlyError || e instanceof ConfigError) {
    process.stderr.write('✗ ' + e.message + '\n');
  } else {
    process.stderr.write('✗ ' + safeMessage(e) + '\n');
  }
  process.exit(1);
});
