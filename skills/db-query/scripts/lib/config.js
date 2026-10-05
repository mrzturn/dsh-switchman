'use strict';

/**
 * Configuration: env file / environment variables / sanitizing / safe error formatting
 * Only dotenv.parse() is used so process.env stays untouched; env file
 * permissions are checked on POSIX
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// ── Env file loading (does not touch process.env) ──

/**
 * Load the given env file and return key/value pairs
 * Never reads .env from cwd to avoid accidental leaks; rejects outright when
 * group/other can read it (credential safety)
 * @param {string|undefined} envFile - env file path
 * @returns {object} key/value pairs
 */
function loadEnvFile(envFile) {
  if (!envFile) return {};
  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Env file not found: ${resolved}`);
  }

  // Check group/other permissions on POSIX: if other local users can read the
  // file the password leaks — reject outright
  try {
    const stat = fs.statSync(resolved);
    // eslint-disable-next-line no-bitwise
    if ((stat.mode & 0o077) !== 0) {
      throw new ConfigError(`Env file ${resolved} permissions too broad (accessible by group/other), run chmod 600`);
    }
  } catch (e) {
    // Only skip the permission-check error on Windows and other non-POSIX
    // systems; rethrow everything else (permissions too broad)
    if (e.message.includes('permissions too broad')) throw e;
  }

  const content = fs.readFileSync(resolved, 'utf8');
  return dotenv.parse(content);
}

/**
 * Read a config value with SKILL.md precedence: CLI > env file > process env > undefined
 * @param {object} envPairs - dotenv.parse() result (explicit --env-file, permission-controlled)
 * @param {string} envKey - environment variable name (e.g. DB_QUERY_MYSQL_HOST)
 * @param {*} cliValue - value from the CLI; undefined means not given on the CLI
 * @returns {*} CLI first, then env file, then process env, otherwise undefined
 */
function resolveEnv(envPairs, envKey, cliValue) {
  if (cliValue !== undefined) return cliValue;
  // Env file first (explicitly given, permission-controlled 0600), then the
  // process environment (loadEnvFile deliberately leaves process.env
  // untouched, so fall back to it here or `export DB_QUERY_*` would not work)
  if (envPairs[envKey] !== undefined) return envPairs[envKey];
  if (process.env[envKey] !== undefined) return process.env[envKey];
  return undefined;
}

/**
 * Parse a number from env/CLI and validate min/max bounds
 * Every source (CLI / env file / environment) runs the same bounds check so
 * an env file cannot bypass hard limits
 *
 * @param {object} envPairs - dotenv.parse() result
 * @param {string} envKey - environment variable name
 * @param {*} cliValue - value from the CLI (bounds already checked by cli.js)
 * @param {object} bounds - { min?: number, max?: number }
 * @returns {number}
 */
class ConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigError'; }
}

function resolveEnvNumber(envPairs, envKey, cliValue, bounds) {
  // CLI source: cli.js coerceValue already checked the bounds, return as-is
  if (cliValue !== undefined) return cliValue;
  // Env file first, then process env (same precedence as resolveEnv, per the
  // SKILL.md contract); env-sourced values are parsed and bounds-checked
  // uniformly so env cannot bypass hard limits
  const raw = envPairs[envKey] !== undefined ? envPairs[envKey] : process.env[envKey];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`Environment variable ${envKey}=${raw} is not a valid integer`);
  }
  if (bounds && bounds.min !== undefined && n < bounds.min) {
    throw new ConfigError(`Environment variable ${envKey}=${n} is below the minimum ${bounds.min}`);
  }
  if (bounds && bounds.max !== undefined && n > bounds.max) {
    throw new ConfigError(`Environment variable ${envKey}=${n} exceeds the maximum ${bounds.max}`);
  }
  return n;
}

// ── Connection target sanitizing ──

/**
 * Build sanitized connection target info; never includes the password or a
 * password-bearing URI
 * @param {object} opts - { host, port, user, database }
 * @returns {string}
 */
function sanitizeTarget(opts) {
  const parts = [`host=${opts.host || '127.0.0.1'}`, `port=${opts.port}`];
  if (opts.user) parts.push(`user=${opts.user}`);
  if (opts.database !== undefined) parts.push(`db=${opts.database}`);
  return parts.join(', ');
}

// ── Safe error formatting ──

// Mask passwords inlined in URLs/connection strings (://user:password@host → ://user:***@host).
// The username segment uses * to also cover the standard no-username Redis
// form (://:password@host); defensive sanitizing
const URL_CRED_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]*:)[^/\s@]+(@)/g;

/**
 * Take the first line of an error message, sanitized and truncated: mask
 * inline credentials + cut at 200 chars to prevent accidental leaks
 * @param {string} s
 * @returns {string}
 */
function sanitizeErrorLine(s) {
  const line = String(s || '').split('\n')[0];
  const masked = line.replace(URL_CRED_PATTERN, '$1***$2');
  return masked.length > 200 ? masked.slice(0, 200) + '…' : masked;
}

// Connection/auth/handshake error codes — classified as "connection failure",
// clearly distinct from query execution errors
const CONNECTION_CODES = new Set([
  // Node network and system errors
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EDESTADDRREQ',
  // DNS resolution errors
  'EAI_AGAIN', 'EAI_NONAME', 'EAI_SERVICE', 'EAI_FAIL', 'EAI_BADFLAGS',
  // TLS errors
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_INVALID_PROTOCOL_METHOD',
  'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
  // mysql2 connection/handshake/db-selection stage
  'HANDSHAKE_ERROR', 'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR', 'ER_BAD_HOST_ERROR',
  // Redis auth stage
  'WRONGPASS', 'NOAUTH',
]);

// node-redis command execution error codes (distinct from the connection stage)
const REDIS_EXEC_CODES = new Set([
  'ERR', 'WRONGTYPE', 'WRONGINT', 'WRONGBIT', 'WRONGKEY',
  'EXECABORT', 'NOREPLICAS', 'MISCONF', 'BUSYGROUP', 'NOGROUP',
  'LOADING', 'MASTERDOWN', 'READONLY', 'MOVED', 'ASK', 'CROSSSLOT',
  'NOSCRIPT', 'BUSYKEY', 'NOSUBKEY',
]);

/**
 * Format a database error safely so a triaging agent can see the real failure
 * at a glance.
 *
 * Key security premise: messages of mysql2 ER_* / node-redis command errors
 * come from the database server and contain no client credentials (the server
 * never sees the client password); Node network errors such as
 * "connect ECONNREFUSED 127.0.0.1:3306" contain no password either. So
 * exposing the code plus the sanitized first message line, classified by
 * code, is safe and lets the agent tell "cannot connect" from "bad SQL" in
 * one step, avoiding pointless bisection. Only pathological errors with
 * neither code nor message get a neutral fallback, no longer misreported as
 * "connection failure".
 * @param {Error} err
 * @returns {string}
 */
function safeMessage(err) {
  const code = err.code || err.errno;
  const line = sanitizeErrorLine(err.message);

  if (code) {
    const codeStr = String(code);
    if (CONNECTION_CODES.has(codeStr)) {
      return `Connection failed [${codeStr}]: ${line}`;
    }
    // mysql2 server-side execution errors: ER_BAD_FIELD_ERROR(1054)/ER_PARSE_ERROR/ER_NO_SUCH_TABLE etc.
    if (/^ER_/.test(codeStr)) {
      return `Query execution error [${codeStr}]: ${line}`;
    }
    // node-redis command execution errors
    if (REDIS_EXEC_CODES.has(codeStr)) {
      return `Query execution error [${codeStr}]: ${line}`;
    }
    // Unknown code: still expose code + first line (sanitized and
    // truncated); more useful for triage than "details hidden"
    return `[${codeStr}] ${line}`;
  }

  // No code: cannot classify, use neutral wording instead of a misleading
  // "connection failure"
  const name = err.name || 'Error';
  return `${name}: ${line || '(no error message; check the SQL/command and connection parameters)'}`;
}

// ── TLS options ──

/**
 * Build TLS options from a ca-file path
 * @param {string|undefined} caFile
 * @returns {object|undefined}
 */
function buildTlsOptions(caFile) {
  if (!caFile) return undefined;
  const resolved = path.resolve(caFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CA certificate file not found: ${resolved}`);
  }
  const ca = fs.readFileSync(resolved);
  return { ca, rejectUnauthorized: true };
}

module.exports = {
  loadEnvFile,
  resolveEnv,
  resolveEnvNumber,
  ConfigError,
  sanitizeTarget,
  safeMessage,
  buildTlsOptions,
};
