'use strict';

/**
 * 结果输出：表格/JSON 格式化 + 类型规范化 + 截断保护
 * JSON 写 stdout、状态信息写 stderr，保证 stdout 是合法 JSON
 */

// ── 类型规范化 ──

/**
 * 规范化单个值为安全输出格式
 * - BigInt → 十进制字符串
 * - Buffer/Uint8Array → UTF-8 可打印则字符串，否则 base64
 * - Date → ISO 字符串
 * - 其他对象 → 安全 JSON 化
 *
 * @param {*} val
 * @param {object} opts - { maxValueBytes: number }
 * @returns {{ value: *, truncated: boolean, byteLength?: number }}
 */
function normalizeValue(val, opts) {
  const maxSize = (opts && opts.maxValueBytes) || 4096;

  // BigInt 保留字符串精度
  if (typeof val === 'bigint') {
    return { value: val.toString(10), truncated: false };
  }

  // Buffer / Uint8Array 按二进制处理
  if (Buffer.isBuffer(val) || (val instanceof Uint8Array)) {
    return normalizeBuffer(val, maxSize);
  }

  // Date → ISO 字符串（dateStrings 已在连接选项中处理，这里兜底）
  if (val instanceof Date) {
    return { value: val.toISOString(), truncated: false };
  }

  // 对象（含数组）→ JSON 安全化
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

  // 基本类型直接返回
  return { value: val, truncated: false };
}

/**
 * Buffer/Uint8Array → 可打印 UTF-8 字符串或 base64
 * 超过 maxValueBytes 时截断并标注
 */
function normalizeBuffer(buf, maxSize) {
  // Uint8Array → Buffer（共享底层内存，零拷贝视图）
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);

  // 尝试 UTF-8 解码
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
    // 截断到 maxSize 字节再解码
    const sliced = buffer.subarray(0, maxSize);
    if (isPrintable) {
      str = sliced.toString('utf8') + '…';
    } else {
      str = sliced.toString('base64') + '…';
    }
  } else if (isPrintable) {
    str = str; // 已经解码
  } else {
    str = buffer.toString('base64');
  }

  return {
    value: str,
    truncated,
    byteLength,
  };
}

/** 检查字符串是否为可打印 UTF-8（无控制字符，允许常见空白） */
function isPrintableUtf8(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return false;
    if (code === 0x7F) return false; // DEL
    if (code >= 0xFFFE) return false; // 非字符
  }
  return true;
}

/**
 * 安全 JSON 字符串化，处理循环引用等异常
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

/** 截断字符串到指定字节数（UTF-8 安全） */
function truncateString(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return { value: str, truncated: false };
  // 找到不超过 maxBytes 的最后完整 UTF-8 字符边界
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--; // 跳过多字节续字节
  return { value: buf.subarray(0, end).toString('utf8') + '…', truncated: true };
}

// ── MySQL 表格输出 ──

/**
 * 格式化 MySQL 查询结果为表格（按 fields 顺序）
 * @param {Array} rows
 * @param {Array} fields - mysql2 返回的 field metadata
 * @param {object} opts - { maxRows, maxValueBytes, truncated }
 */
function formatMysqlTable(rows, fields, opts) {
  const maxRows = (opts && opts.maxRows) || 200;
  const maxValueBytes = (opts && opts.maxValueBytes) || 4096;
  const resultTruncated = opts && opts.truncated;

  // 规范化行数据
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
    return '(空结果集)';
  }

  // 计算列宽
  const colWidths = fieldNames.map((name, colIdx) => {
    let w = name.length;
    for (const row of normalizedRows) {
      w = Math.max(w, String(row[colIdx]).length);
    }
    return Math.min(w, 60); // 单列最大 60 字符
  });

  // 构建表格
  const sep = colWidths.map(w => '-'.repeat(w + 2)).join('+');
  const lines = [sep];

  // 表头
  lines.push('|' + fieldNames.map((name, i) => ' ' + name.padEnd(colWidths[i]) + ' ').join('|') + '|');
  lines.push(sep);

  // 数据行
  for (const row of normalizedRows) {
    lines.push('|' + row.map((cell, i) => ' ' + String(cell).padEnd(colWidths[i]) + ' ').join('|') + '|');
  }
  lines.push(sep);

  let output = lines.join('\n');
  if (resultTruncated) {
    output += `\n⚠ 结果已截断（仅显示前 ${maxRows} 行）`;
  }
  return output;
}

/** 格式化单个单元格（附加截断标记） */
function formatCell(norm) {
  if (norm.truncated && norm.byteLength) {
    return String(norm.value) + ` [${norm.byteLength}B]`;
  }
  if (norm.truncated) {
    return String(norm.value) + ' [截断]';
  }
  return norm.value;
}

// ── Redis 表格输出 ──

/**
 * 格式化 Redis 结果为可读表格
 * @param {*} result - Redis 返回的原始数据
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
    return String(norm.value) + (norm.truncated ? ' [截断]' : '');
  }

  // list
  if (shape === 'list') {
    const items = Array.isArray(result) ? result : [result];
    if (items.length === 0) return '(空列表)';
    const lines = [];
    const count = Math.min(items.length, maxItems);
    for (let i = 0; i < count; i++) {
      const norm = normalizeValue(items[i], { maxValueBytes: info && info.maxValueBytes });
      lines.push(`${i + 1}) ${String(norm.value)}${norm.truncated ? ' [截断]' : ''}`);
    }
    if (items.length > maxItems) lines.push(`⚠ 仅显示前 ${maxItems} 条（共 ${items.length} 条）`);
    return lines.join('\n');
  }

  // pairs (HGETALL 等)
  if (shape === 'pairs') {
    const arr = Array.isArray(result) ? result : [];
    if (arr.length === 0) return '(空映射)';
    const lines = [];
    const pairCount = Math.min(Math.floor(arr.length / 2), maxItems);
    for (let i = 0; i < pairCount; i++) {
      const field = String(arr[i * 2] || '');
      const val = normalizeValue(arr[i * 2 + 1], { maxValueBytes: info && info.maxValueBytes });
      lines.push(`${field}: ${String(val.value)}${val.truncated ? ' [截断]' : ''}`);
    }
    if (Math.floor(arr.length / 2) > maxItems) {
      lines.push(`⚠ 仅显示前 ${maxItems} 个字段`);
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
    if (items.length > maxItems) lines.push(`⚠ 仅显示前 ${maxItems} 条`);
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
        lines.push(`--- 客户端 ${i + 1} ---`);
        lines.push(clients[i]);
      }
      if (clients.length > maxItems) lines.push(`⚠ 仅显示前 ${maxItems} 个客户端`);
      return lines.join('\n');
    }
    return String(result);
  }

  return String(result);
}

// ── JSON envelope ──

/**
 * 构建 JSON 输出 envelope
 * @param {object} params - { source, target, elapsedMs, count, truncated, result }
 * @returns {string}
 */
function formatJson(params) {
  const envelope = {
    source: params.source,      // 'mysql' | 'redis'
    target: params.target,       // 脱敏目标
    elapsedMs: params.elapsedMs,
    count: params.count,         // 行/元素数
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
