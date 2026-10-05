'use strict';

/**
 * Redis read-only command allowlist validation
 * Unknown commands are always rejected (fail-closed); precise argument protection
 *
 * Design notes:
 * - Object.freeze'd allowlist, tamper-proof at runtime
 * - policy.shape drives the output format
 * - Unbounded commands like KEYS/HGETALL require an explicit --allow-unbounded
 * - SCAN-family commands accept only structured arguments (MATCH/COUNT/TYPE)
 */

// ── Allowlist policy ──

/**
 * Policy fields:
 * - arity: argument count (excluding the command itself), null for variable
 * - shape: output shape 'scalar' | 'list' | 'pairs' | 'scan' | 'info' | 'client_list'
 * - validate: (args) => void, argument validation function
 * - unbounded: true means the result set can be large and needs --allow-unbounded
 */
const _READ_ONLY_COMMANDS = {
  // ── Generic/keys ──
  PING:       { arity: 0, shape: 'scalar', validate: () => {} },
  GET:        { arity: 1, shape: 'scalar', validate: () => {} },
  MGET:       { arity: null, shape: 'list', validate: (a) => { if (!a.length) throw 'MGET requires at least one key'; } },
  EXISTS:     { arity: null, shape: 'scalar', validate: (a) => { if (!a.length) throw 'EXISTS requires at least one key'; } },
  TYPE:       { arity: 1, shape: 'scalar', validate: () => {} },
  TTL:        { arity: 1, shape: 'scalar', validate: () => {} },
  PTTL:       { arity: 1, shape: 'scalar', validate: () => {} },
  STRLEN:     { arity: 1, shape: 'scalar', validate: () => {} },
  SCAN:       { arity: null, shape: 'scan', validate: validateScan },
  KEYS:       { arity: 1, shape: 'list', unbounded: true, validate: () => {} },
  DBSIZE:     { arity: 0, shape: 'scalar', validate: () => {} },
  TIME:       { arity: 0, shape: 'scalar', validate: () => {} },

  // ── Hash ──
  HGET:       { arity: 2, shape: 'scalar', validate: () => {} },
  HMGET:      { arity: null, shape: 'list', validate: (a) => { if (a.length < 2) throw 'HMGET requires at least a key and one field'; } },
  HEXISTS:    { arity: 2, shape: 'scalar', validate: () => {} },
  HLEN:       { arity: 1, shape: 'scalar', validate: () => {} },
  HGETALL:    { arity: 1, shape: 'pairs', unbounded: true, validate: () => {} },
  HKEYS:      { arity: 1, shape: 'list', unbounded: true, validate: () => {} },
  HVALS:      { arity: 1, shape: 'list', unbounded: true, validate: () => {} },
  HSCAN:      { arity: null, shape: 'scan', validate: validateScan },

  // ── List ──
  LINDEX:     { arity: 2, shape: 'scalar', validate: () => {} },
  LLEN:       { arity: 1, shape: 'scalar', validate: () => {} },
  LRANGE:     { arity: null, shape: 'list', validate: validateLrange },

  // ── Set ──
  SISMEMBER:  { arity: 2, shape: 'scalar', validate: () => {} },
  SCARD:      { arity: 1, shape: 'scalar', validate: () => {} },
  SMEMBERS:   { arity: 1, shape: 'list', unbounded: true, validate: () => {} },
  SSCAN:      { arity: null, shape: 'scan', validate: validateScan },

  // ── ZSet ──
  ZCARD:      { arity: 1, shape: 'scalar', validate: () => {} },
  ZCOUNT:     { arity: 3, shape: 'scalar', validate: () => {} },
  ZSCORE:     { arity: 2, shape: 'scalar', validate: () => {} },
  ZRANK:      { arity: 2, shape: 'scalar', validate: () => {} },
  ZREVRANK:   { arity: 2, shape: 'scalar', validate: () => {} },
  ZRANGE:     { arity: null, shape: 'list', validate: validateZrange },
  ZRANGEBYSCORE: { arity: null, shape: 'list', validate: validateZrangeByScore },
  ZSCAN:      { arity: null, shape: 'scan', validate: validateScan },

  // ── Server info ──
  INFO:       { arity: null, shape: 'info', validate: () => {} },
  CLIENT:     { arity: null, shape: 'client_list', validate: validateClient },
  CONFIG:     { arity: null, shape: 'list', validate: validateConfig },
};

/** Freeze the allowlist to prevent runtime tampering */
const READ_ONLY_COMMANDS = Object.freeze(_READ_ONLY_COMMANDS);

// ── Argument validators ──

/**
 * Structured argument validation for SCAN/HSCAN/SSCAN/ZSCAN
 * Only MATCH pattern COUNT n [TYPE type] are accepted; duplicate options are rejected
 *
 * Fix: the cursor position differs per command — SCAN has no key prefix and
 * the cursor comes first; HSCAN/SSCAN/ZSCAN take a key first, so the cursor
 * is second. The old implementation treated everything like SCAN and wrongly
 * rejected a legal cursor=0 for HSCAN/SSCAN/ZSCAN.
 */
function validateScan(args, command) {
  // SCAN argument layout: the cursor comes first; the other three commands
  // take a key first and the cursor second
  const hasKey = command !== 'SCAN';
  let i;
  if (hasKey) {
    if (args.length < 2) throw `${command} requires at least a key and a cursor`;
    const cursor = Number(args[1]);
    if (!Number.isInteger(cursor) || cursor < 0) throw 'cursor must be a non-negative integer';
    i = 2; // options start at the third position
  } else {
    if (args.length === 0) throw 'SCAN requires at least a cursor argument';
    const cursor = Number(args[0]);
    if (!Number.isInteger(cursor) || cursor < 0) throw 'cursor must be a non-negative integer';
    i = 1; // options start at the second position
  }

  const seen = new Set();
  for (; i < args.length; i++) {
    const opt = String(args[i]).toUpperCase();
    if (seen.has(opt)) throw `Duplicate SCAN option: ${opt}`;
    seen.add(opt);

    if (opt === 'MATCH') {
      if (i + 1 >= args.length) throw 'MATCH requires a pattern argument';
      i++; // skip the pattern value
    } else if (opt === 'COUNT') {
      if (i + 1 >= args.length) throw 'COUNT requires a numeric argument';
      const count = Number(args[i + 1]);
      if (!Number.isInteger(count) || count < 1) throw 'COUNT must be a positive integer';
      if (count > 5000) throw 'COUNT exceeds the cap of 5000';
      i++;
    } else if (opt === 'TYPE') {
      // TYPE is SCAN-only; HSCAN/SSCAN/ZSCAN do not support it (reject
      // explicitly rather than deferring to the server)
      if (hasKey) throw `${command} does not support the TYPE option (SCAN only)`;
      if (i + 1 >= args.length) throw 'TYPE requires a type-name argument';
      i++;
    } else {
      throw `Unsupported SCAN option: ${opt}`;
    }
  }
}

/**
 * LRANGE range validation: prevents client-side memory DoS
 * stop < 0 (negative index) → length unknown, require --allow-unbounded
 * when start < 0 or stop ≥ 0, check (stop - start + 1) ≤ maxItems
 */
function validateLrange(args, command, limits) {
  if (args.length < 3) throw 'At least 3 arguments required (key start stop)';
  const start = Number(args[1]);
  const stop = Number(args[2]);
  if (!Number.isInteger(start) || !Number.isInteger(stop)) {
    throw 'start/stop must be integers';
  }
  const maxItems = (limits && limits.maxItems) || 200;

  // A negative stop index means "to the end"; the actual length is unknown → require explicit opt-in
  if (stop < 0) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'A negative stop index makes the range unbounded; use --allow-unbounded or SCAN/LRANGE with non-negative indexes';
    }
    return; // opted in; skip the range check
  }
  // A negative start index resolves to an unpredictable position in Redis → also require opt-in
  if (start < 0) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'A negative start index makes the range unbounded; use --allow-unbounded or LRANGE with non-negative indexes';
    }
    return;
  }
  // Both indexes non-negative: the returned count can be computed exactly
  const count = stop - start + 1;
  if (count > maxItems) {
    throw `Range ${start}..${stop} yields ${count} items, exceeding maxItems=${maxItems}`;
  }
}

/**
 * Full ZRANGE syntax validation for Redis 6.2+
 * Supports BYSCORE / BYLEX / REV / LIMIT / WITHSCORES options
 * BYLEX without LIMIT requires --allow-unbounded (lexicographic ranges can be long)
 * With LIMIT, count must be ≤ maxItems
 */
function validateZrange(args, command, limits) {
  if (args.length < 3) throw 'ZRANGE requires at least key min max';
  const maxItems = (limits && limits.maxItems) || 200;

  // Collect option keywords (skip the 3 required arguments key min max)
  const optsUpper = args.slice(3).map(a => String(a).toUpperCase());
  let hasByscore = false;
  let hasBylex = false;
  let hasRev = false;
  let hasLimit = false;
  let limitCount = null;

  for (let i = 0; i < optsUpper.length; i++) {
    const opt = optsUpper[i];
    if (opt === 'BYSCORE') { hasByscore = true; continue; }
    if (opt === 'BYLEX') { hasBylex = true; continue; }
    if (opt === 'REV') { hasRev = true; continue; }
    if (opt === 'WITHSCORES') { continue; }
    if (opt === 'LIMIT') {
      hasLimit = true;
      // LIMIT takes offset and count
      if (i + 2 >= optsUpper.length) throw 'LIMIT requires offset and count';
      const offset = Number(args[3 + i + 1]); // corresponding position in the original args
      limitCount = Number(args[3 + i + 2]);
      if (!Number.isInteger(offset) || !Number.isInteger(limitCount) || offset < 0 || limitCount < 0) {
        throw 'LIMIT offset/count must be non-negative integers';
      }
      if (limitCount > maxItems) throw `LIMIT count ${limitCount} exceeds maxItems=${maxItems}`;
      i += 2; // skip offset and count
      continue;
    }
    throw `Unsupported ZRANGE option: ${opt}`;
  }

  // BYLEX without LIMIT → the lexicographic range can be huge; require opt-in
  if (hasBylex && !hasLimit) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'BYLEX without LIMIT has an unbounded range; use --allow-unbounded';
    }
  }
  // BYSCORE with the default index range (e.g. 0 -1) and no LIMIT → also require opt-in
  if (hasByscore && !hasLimit) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'BYSCORE without LIMIT has an unbounded range; use --allow-unbounded';
    }
  }
  // Default index mode (not BYSCORE/BYLEX): check the min/max range
  if (!hasByscore && !hasBylex) {
    // With min/max as rank indexes, a negative index means "to the end"; the
    // range is unbounded
    const minVal = Number(args[1]);
    const maxVal = Number(args[2]);
    if ((minVal < 0 || maxVal < 0) && !hasLimit) {
      if (!(limits && limits.allowUnbounded)) {
        throw 'ZRANGE with a negative index and no LIMIT has an unbounded range; use --allow-unbounded';
      }
    }
    // Non-negative indexes with LIMIT: LIMIT already validated the count; safe
    // Non-negative indexes without LIMIT: compute the range
    if (minVal >= 0 && maxVal >= 0 && !hasLimit) {
      const rangeCount = maxVal - minVal + 1;
      if (rangeCount > maxItems) {
        throw `Range ${minVal}..${maxVal} yields ${rangeCount} items, exceeding maxItems=${maxItems}`;
      }
    }
  }
}

/**
 * ZRANGEBYSCORE must carry LIMIT offset count, and count must not exceed the cap
 */
function validateZrangeByScore(args) {
  if (args.length < 3) throw 'ZRANGEBYSCORE requires at least key min max';
  // Check for LIMIT
  const argsUpper = args.map(a => String(a).toUpperCase());
  const limitIdx = argsUpper.indexOf('LIMIT');
  if (limitIdx === -1) {
    throw 'ZRANGEBYSCORE requires a LIMIT clause (prevents unbounded result sets)';
  }
  if (limitIdx + 2 >= args.length) {
    throw 'LIMIT requires both offset and count arguments';
  }
  const count = Number(args[limitIdx + 2]);
  if (!Number.isInteger(count) || count < 0) throw 'LIMIT count must be a non-negative integer';
  if (count > 5000) throw 'LIMIT count exceeds the cap of 5000';
}

/**
 * CLIENT allows only the LIST subcommand
 * KILL/PAUSE/UNBLOCK can disrupt other connections; reject them
 */
function validateClient(args) {
  if (args.length === 0) throw 'CLIENT requires a subcommand';
  const sub = String(args[0]).toUpperCase();
  if (sub !== 'LIST') throw `CLIENT ${sub} is not allowed (only CLIENT LIST is allowed)`;
}

/**
 * CONFIG allows only the GET subcommand, and the config key must be on the safe list
 * Reject * (dumps the whole config) and sensitive keys like requirepass and masterauth
 */
function validateConfig(args) {
  if (args.length === 0) throw 'CONFIG requires a subcommand';
  const sub = String(args[0]).toUpperCase();
  if (sub !== 'GET') throw `CONFIG ${sub} is not allowed (only CONFIG GET is allowed)`;

  if (args.length < 2) throw 'CONFIG GET requires at least one argument';

  // Safe list: only non-sensitive runtime configs may be viewed
  const SAFE_CONFIG_KEYS = new Set([
    'databases', 'maxmemory', 'maxmemory-policy', 'maxmemory-samples',
    'timeout', 'tcp-keepalive', 'appendonly', 'appendfsync',
    'hz', 'save', 'rdbcompression', 'rdbchecksum',
    'lazyfree-lazy-eviction', 'lazyfree-lazy-expire',
    'io-threads', 'io-threads-do-reads',
    'cluster-enabled', 'cluster-node-timeout',
  ]);

  for (let i = 1; i < args.length; i++) {
    const key = String(args[i]).toLowerCase();
    if (key === '*') throw 'CONFIG GET * is not allowed (dumps the entire config including passwords)';
    if (key === 'requirepass' || key === 'masterauth') {
      throw `Querying ${key} is not allowed (may expose passwords)`;
    }
    // Reject any key containing markers like tls/key/pass/secret/acl
    if (/tls[_-]?key|pass|secret|acl[_-]file|unixsocket/i.test(key)) {
      throw `Querying sensitive config is not allowed: ${key}`;
    }
    if (!SAFE_CONFIG_KEYS.has(key)) {
      throw `CONFIG GET ${key} is not on the safe list`;
    }
  }
}

// ── Main validation entry ──

/**
 * Validate that a Redis command is on the read-only allowlist and validate its arguments
 * Unknown commands are always rejected (fail-closed)
 *
 * @param {string[]} argv - full command array, [cmd, ...args]
 * @param {object} limits - { maxItems: number, allowUnbounded: boolean }
 * @returns {{ command: string, args: string[], shape: string, unbounded: boolean }}
 */
function validateRedisCommand(argv, limits) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new RedisReadonlyError('Redis command must not be empty');
  }

  const command = String(argv[0]).toUpperCase();
  const policy = READ_ONLY_COMMANDS[command];

  if (!policy) {
    throw new RedisReadonlyError(`Command not allowed: ${command} (not on the read-only allowlist)`);
  }

  // Check arity (argument count constraint)
  if (policy.arity !== null && argv.length - 1 !== policy.arity) {
    throw new RedisReadonlyError(`${command} requires ${policy.arity} argument(s), got ${argv.length - 1}`);
  }

  // Unbounded commands require explicit opt-in
  if (policy.unbounded && !(limits && limits.allowUnbounded)) {
    throw new RedisReadonlyError(
      `${command} may return a large amount of data; add --allow-unbounded to confirm (prefer SCAN-family commands)`
    );
  }

  // Run the policy-specific argument validator; pass the command name and
  // limits so each function can do range/unbounded checks
  const args = argv.slice(1);
  try {
    policy.validate(args, command, limits);
  } catch (msg) {
    throw new RedisReadonlyError(`${command} argument error: ${msg}`);
  }

  return {
    command,
    args,
    shape: policy.shape,
    unbounded: !!policy.unbounded,
  };
}

class RedisReadonlyError extends Error {
  constructor(msg) { super(msg); this.name = 'RedisReadonlyError'; }
}

module.exports = {
  validateRedisCommand,
  READ_ONLY_COMMANDS,
  RedisReadonlyError,
};
