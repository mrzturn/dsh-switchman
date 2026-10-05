'use strict';

/**
 * Result output: table/JSON formatting + value normalization + truncation guards
 * JSON goes to stdout and status to stderr so stdout stays valid JSON
 */

// ── Value normalization ──

/**
 * Normalize a single value into a safe output format
 * - BigInt → decimal string
 * - Buffer/Uint8Array → string if printable UTF-8, otherwise base64
 * - Date → ISO string
 * - other objects → safe JSON
 *
 * @param {*} val
 * @param {object} opts - { maxValueBytes: number }
 * @returns {{ value: *, truncated: boolean, byteLength?: number }}
 */
function normalizeValue(val, opts) {
  const maxSize = (opts && opts.maxValueBytes) || 4096;

  // BigInt keeps string precision
  if (typeof val === 'bigint') {
    return { value: val.toString(10), truncated: false };
  }

  // Treat Buffer / Uint8Array as binary
  if (Buffer.isBuffer(val) || (val instanceof Uint8Array)) {
    return normalizeBuffer(val, maxSize);
  }

  // Date → ISO string (dateStrings already handles this in the connection
  // options; fallback here)
  if (val instanceof Date) {
    return { value: val.toISOString(), truncated: false };
  }

  // Objects (including arrays) → JSON-safe
  if (typeof val === 'object' && val !== null) {
    try {
      const json = safeJsonStringify(val);
      if (Buffer.byteLength(json, 'utf8') > maxSize) {
        const truncated = truncateString(json, maxSize);
        return { value: JSON.parse(truncated.value), truncated: truncated.truncated, byteLength: json.length };
      }
      return { value: val, truncated: false };
    } catch (_) {
      return { value: '[unserializable object]', truncated: false };
    }
  }

  // Primitives pass through
  return { value: val, truncated: false };
}

/**
 * Buffer/Uint8Array → printable UTF-8 string or base64
 * Truncate and mark when larger than maxValueBytes
 */
function normalizeBuffer(buf, maxSize) {
  // Uint8Array → Buffer (zero-copy view over the same memory)
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);

  // Try UTF-8 decoding
  let str;
  let isPrintable = false;
  try {
    str = buffer.toString('utf8');
    isPrintable = isPrintableUtf8(str);
  } catch (_) {
    str = null;
  }

  const byteLength = buffer.length;
  let truncated = false;

  if (byteLength > maxSize) {
    truncated = true;
    // Truncate to maxSize bytes, then decode
    const sliced = buffer.subarray(0, maxSize);
    if (isPrintable) {
      str = sliced.toString('utf8') + '…';
    } else {
      str = sliced.toString('base64') + '…';
    }
  } else if (isPrintable) {
    str = str; // already decoded
  } else {
    str = buffer.toString('base64');
  }

  return {
    value: str,
    truncated,
    byteLength,
  };
}

/** Check whether a string is printable UTF-8 (no control characters; common whitespace allowed) */
function isPrintableUtf8(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return false;
    if (code === 0x7F) return false; // DEL
    if (code >= 0xFFFE) return false; // noncharacter
  }
  return true;
}

/**
 * Safe JSON.stringify that handles circular references and similar pitfalls
 */
function safeJsonStringify(val) {
  const seen = new WeakSet();
  return JSON.stringify(val, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  });
}

/** Truncate a string to a byte budget (UTF-8 safe) */
function truncateString(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return { value: str, truncated: false };
  // Find the last complete UTF-8 character boundary not exceeding maxBytes
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--; // skip multibyte continuation bytes
  return { value: buf.subarray(0, end).toString('utf8') + '…', truncated: true };
}

// ── MySQL table output ──

/**
 * Format MySQL query results as a table (in field order)
 * @param {Array} rows
 * @param {Array} fields - field metadata returned by mysql2
 * @param {object} opts - { maxRows, maxValueBytes, truncated }
 */
function formatMysqlTable(rows, fields, opts) {
  const maxRows = (opts && opts.maxRows) || 200;
  const maxValueBytes = (opts && opts.maxValueBytes) || 4096;
  const resultTruncated = opts && opts.truncated;

  // Normalize row data
  const normalizedRows = [];
  const fieldNames = (fields || []).map(f => f.name);

  for (let i = 0; i < rows.length && i < maxRows; i++) {
    const row = rows[i];
    const outRow = [];
    for (const name of fieldNames) {
      const raw = row[name];
      const norm = normalizeValue(raw, { maxValueBytes });
      outRow.push(formatCell(norm));
    }
    normalizedRows.push(outRow);
  }

  if (normalizedRows.length === 0) {
    return '(empty result set)';
  }

  // Compute column widths
  const colWidths = fieldNames.map((name, colIdx) => {
    let w = name.length;
    for (const row of normalizedRows) {
      w = Math.max(w, String(row[colIdx]).length);
    }
    return Math.min(w, 60); // cap each column at 60 chars
  });

  // Build the table
  const sep = colWidths.map(w => '-'.repeat(w + 2)).join('+');
  const lines = [sep];

  // Header
  lines.push('|' + fieldNames.map((name, i) => ' ' + name.padEnd(colWidths[i]) + ' ').join('|') + '|');
  lines.push(sep);

  // Data rows
  for (const row of normalizedRows) {
    lines.push('|' + row.map((cell, i) => ' ' + String(cell).padEnd(colWidths[i]) + ' ').join('|') + '|');
  }
  lines.push(sep);

  let output = lines.join('\n');
  if (resultTruncated) {
    output += `\n⚠ Results truncated (showing first ${maxRows} rows)`;
  }
  return output;
}

/** Format a single cell (append truncation marker) */
function formatCell(norm) {
  if (norm.truncated && norm.byteLength) {
    return String(norm.value) + ` [${norm.byteLength}B]`;
  }
  if (norm.truncated) {
    return String(norm.value) + ' [truncated]';
  }
  return norm.value;
}

// ── Redis table output ──

/**
 * Format a Redis result as a readable table
 * @param {*} result - raw data returned by Redis
 * @param {object} info - { shape, command, maxItems, maxValueBytes }
 * @returns {string}
 */
function formatRedisTable(result, info) {
  const maxItems = (info && info.maxItems) || 200;
  const shape = (info && info.shape) || 'scalar';

  // scalar
  if (shape === 'scalar') {
    if (result === null) return '(nil)';
    if (typeof result === 'number') return String(result);
    const norm = normalizeValue(result, { maxValueBytes: info && info.maxValueBytes });
    return String(norm.value) + (norm.truncated ? ' [truncated]' : '');
  }

  // list
  if (shape === 'list') {
    const items = Array.isArray(result) ? result : [result];
    if (items.length === 0) return '(empty list)';
    const lines = [];
    const count = Math.min(items.length, maxItems);
    for (let i = 0; i < count; i++) {
      const norm = normalizeValue(items[i], { maxValueBytes: info && info.maxValueBytes });
      lines.push(`${i + 1}) ${String(norm.value)}${norm.truncated ? ' [truncated]' : ''}`);
    }
    if (items.length > maxItems) lines.push(`⚠ Showing first ${maxItems} of ${items.length} item(s)`);
    return lines.join('\n');
  }

  // pairs (HGETALL etc.)
  if (shape === 'pairs') {
    const arr = Array.isArray(result) ? result : [];
    if (arr.length === 0) return '(empty map)';
    const lines = [];
    const pairCount = Math.min(Math.floor(arr.length / 2), maxItems);
    for (let i = 0; i < pairCount; i++) {
      const field = String(arr[i * 2] || '');
      const val = normalizeValue(arr[i * 2 + 1], { maxValueBytes: info && info.maxValueBytes });
      lines.push(`${field}: ${String(val.value)}${val.truncated ? ' [truncated]' : ''}`);
    }
    if (Math.floor(arr.length / 2) > maxItems) {
      lines.push(`⚠ Showing first ${maxItems} field(s)`);
    }
    return lines.join('\n');
  }

  // scan
  if (shape === 'scan') {
    if (!Array.isArray(result)) return String(result);
    const cursor = result[0];
    const items = result[1] || [];
    const lines = [`cursor: ${cursor}`];
    const count = Math.min(items.length, maxItems);
    for (let i = 0; i < count; i++) {
      lines.push(`${i + 1}) ${String(items[i])}`);
    }
    if (items.length > maxItems) lines.push(`⚠ Showing first ${maxItems} item(s)`);
    return lines.join('\n');
  }

  // info sections
  if (shape === 'info') {
    return typeof result === 'string' ? result : String(result);
  }

  // client_list
  if (shape === 'client_list') {
    if (typeof result === 'string') {
      const clients = result.trim().split('\n');
      const count = Math.min(clients.length, maxItems);
      const lines = [];
      for (let i = 0; i < count; i++) {
        lines.push(`--- Client ${i + 1} ---`);
        lines.push(clients[i]);
      }
      if (clients.length > maxItems) lines.push(`⚠ Showing first ${maxItems} client(s)`);
      return lines.join('\n');
    }
    return String(result);
  }

  return String(result);
}

// ── JSON envelope ──

/**
 * Build the JSON output envelope
 * @param {object} params - { source, target, elapsedMs, count, truncated, result }
 * @returns {string}
 */
function formatJson(params) {
  const envelope = {
    source: params.source,      // 'mysql' | 'redis'
    target: params.target,       // sanitized target
    elapsedMs: params.elapsedMs,
    count: params.count,         // row/item count
    truncated: params.truncated,
    result: params.result,
  };
  return JSON.stringify(envelope, null, 2);
}

module.exports = {
  normalizeValue,
  formatMysqlTable,
  formatRedisTable,
  formatJson,
  truncateString,
};
