'use strict';

/**
 * 严格 CLI 参数解析器
 * 支持 --key=value、--key value、布尔 flag、-- 分隔 SQL/Redis 命令
 * 未知选项、重复冲突、越界数字 → 立即失败（fail-closed）
 */

class CliError extends Error {
  constructor(msg) { super(msg); this.name = 'CliError'; }
}

/**
 * 解析 CLI 参数，返回 { options: {}, rest: string[] }
 * @param {string[]} argv - process.argv.slice(2)
 * @param {object} spec - 参数规格 { name: { type, default, min, max, alias } }
 */
function parseCli(argv, spec) {
  const options = {};
  const rest = [];
  const seen = new Set();

  // 填充默认值
  for (const [key, def] of Object.entries(spec)) {
    if (def.default !== undefined) options[key] = def.default;
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // -- 分隔符：后续全部作为位置参数
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }

    // --option=value 或 --option value 形式
    if (arg.startsWith('--')) {
      let key, value;
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        // 查找规格中该选项的类型
        const s = findSpec(spec, key);
        if (!s) throw new CliError(`未知选项: --${key}`);
        if (s.type === 'boolean') {
          value = true;
        } else {
          i++;
          if (i >= argv.length) throw new CliError(`--${key} 需要值`);
          value = argv[i];
        }
      }

      const resolved = resolveAlias(spec, key);
      if (!resolved) throw new CliError(`未知选项: --${key}`);

      // 重复选项检查
      if (seen.has(resolved)) throw new CliError(`重复选项: --${resolved}`);
      seen.add(resolved);

      const s = spec[resolved];
      options[resolved] = coerceValue(resolved, value, s);
    } else {
      // 非选项参数 → 位置参数
      rest.push(arg);
    }
    i++;
  }

  return { options, rest };
}

/** 在 spec 或 alias 中查找选项名 */
function findSpec(spec, key) {
  if (spec[key]) return spec[key];
  for (const s of Object.values(spec)) {
    if (s.alias === key) return s;
  }
  return null;
}

/** 解析别名到规范名 */
function resolveAlias(spec, key) {
  if (spec[key]) return key;
  for (const [name, s] of Object.entries(spec)) {
    if (s.alias === key) return name;
  }
  return null;
}

/** 类型转换 + 边界检查 */
function coerceValue(key, raw, spec) {
  if (spec.type === 'boolean') {
    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;
    throw new CliError(`--${key} 期望布尔值，收到: ${raw}`);
  }
  if (spec.type === 'integer') {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new CliError(`--${key} 期望整数，收到: ${raw}`);
    if (spec.min !== undefined && n < spec.min) throw new CliError(`--${key} 最小值 ${spec.min}，收到: ${n}`);
    if (spec.max !== undefined && n > spec.max) throw new CliError(`--${key} 最大值 ${spec.max}，收到: ${n}`);
    return n;
  }
  if (spec.type === 'string' && spec.choices) {
    const lower = String(raw).toLowerCase();
    if (!spec.choices.includes(lower)) throw new CliError(`--${key} 必须为 ${spec.choices.join('|')} 之一，收到: ${raw}`);
    return lower;
  }
  return String(raw);
}

module.exports = { parseCli, CliError };
