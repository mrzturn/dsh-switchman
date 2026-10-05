'use strict';

/**
 * Strict CLI argument parser
 * Supports --key=value, --key value, boolean flags, and -- to separate SQL/Redis commands
 * Unknown options, duplicate conflicts, out-of-range numbers → fail immediately (fail-closed)
 */

class CliError extends Error {
  constructor(msg) { super(msg); this.name = 'CliError'; }
}

/**
 * Parse CLI arguments and return { options: {}, rest: string[] }
 * @param {string[]} argv - process.argv.slice(2)
 * @param {object} spec - option spec { name: { type, default, min, max, alias } }
 */
function parseCli(argv, spec) {
  const options = {};
  const rest = [];
  const seen = new Set();

  // Fill in defaults
  for (const [key, def] of Object.entries(spec)) {
    if (def.default !== undefined) options[key] = def.default;
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // -- separator: everything after it is positional
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }

    // --option=value or --option value form
    if (arg.startsWith('--')) {
      let key, value;
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        // Look up the option's type in the spec
        const s = findSpec(spec, key);
        if (!s) throw new CliError(`Unknown option: --${key}`);
        if (s.type === 'boolean') {
          value = true;
        } else {
          i++;
          if (i >= argv.length) throw new CliError(`--${key} requires a value`);
          value = argv[i];
        }
      }

      const resolved = resolveAlias(spec, key);
      if (!resolved) throw new CliError(`Unknown option: --${key}`);

      // Duplicate option check
      if (seen.has(resolved)) throw new CliError(`Duplicate option: --${resolved}`);
      seen.add(resolved);

      const s = spec[resolved];
      options[resolved] = coerceValue(resolved, value, s);
    } else {
      // Non-option argument → positional
      rest.push(arg);
    }
    i++;
  }

  return { options, rest };
}

/** Find an option name in the spec or its aliases */
function findSpec(spec, key) {
  if (spec[key]) return spec[key];
  for (const s of Object.values(spec)) {
    if (s.alias === key) return s;
  }
  return null;
}

/** Resolve an alias to its canonical name */
function resolveAlias(spec, key) {
  if (spec[key]) return key;
  for (const [name, s] of Object.entries(spec)) {
    if (s.alias === key) return name;
  }
  return null;
}

/** Type coercion + bounds checking */
function coerceValue(key, raw, spec) {
  if (spec.type === 'boolean') {
    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;
    throw new CliError(`--${key} expects a boolean, got: ${raw}`);
  }
  if (spec.type === 'integer') {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new CliError(`--${key} expects an integer, got: ${raw}`);
    if (spec.min !== undefined && n < spec.min) throw new CliError(`--${key} minimum is ${spec.min}, got: ${n}`);
    if (spec.max !== undefined && n > spec.max) throw new CliError(`--${key} maximum is ${spec.max}, got: ${n}`);
    return n;
  }
  if (spec.type === 'string' && spec.choices) {
    const lower = String(raw).toLowerCase();
    if (!spec.choices.includes(lower)) throw new CliError(`--${key} must be one of ${spec.choices.join('|')}, got: ${raw}`);
    return lower;
  }
  return String(raw);
}

module.exports = { parseCli, CliError };
