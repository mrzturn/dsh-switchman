'use strict';

/**
 * 配置解析：env 文件 / 环境变量 / 脱敏 / 安全错误格式化
 * dotenv 只用 parse()，不污染 process.env；POSIX 下检查 env 文件权限
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// ── env 文件加载（不污染 process.env）──

/**
 * 加载指定 env 文件，返回键值对
 * 不读 cwd 的 .env，防止意外泄露；group/other 可读时直接拒绝（凭据安全）
 * @param {string|undefined} envFile - env 文件路径
 * @returns {object} 键值对
 */
function loadEnvFile(envFile) {
  if (!envFile) return {};
  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`env 文件不存在: ${resolved}`);
  }

  // POSIX 下检查 group/other 权限：同机其他用户可读即泄露密码，直接拒绝
  try {
    const stat = fs.statSync(resolved);
    // eslint-disable-next-line no-bitwise
    if ((stat.mode & 0o077) !== 0) {
      throw new ConfigError(`env 文件 ${resolved} 权限过宽（group/other 可访问），请 chmod 600`);
    }
  } catch (e) {
    // 仅跳过 Windows 等非 POSIX 系统的权限检查错误；其余错误（权限过宽）往上抛
    if (e.message.includes('权限过宽')) throw e;
  }

  const content = fs.readFileSync(resolved, 'utf8');
  return dotenv.parse(content);
}

/**
 * 按 SKILL.md 优先级读取配置值：CLI > env 文件 > 进程环境变量 > undefined
 * @param {object} envPairs - dotenv.parse() 结果（显式 --env-file，权限受控）
 * @param {string} envKey - 环境变量名（如 DB_QUERY_MYSQL_HOST）
 * @param {*} cliValue - CLI 传入的值；undefined 表示 CLI 未指定
 * @returns {*} CLI 优先，其次 env 文件，再次进程环境变量，否则 undefined
 */
function resolveEnv(envPairs, envKey, cliValue) {
  if (cliValue !== undefined) return cliValue;
  // env 文件优先（显式指定、权限受控 0600），其次进程环境变量
  // （loadEnvFile 刻意不污染 process.env，必须在此显式读取兜底，否则 export DB_QUERY_* 不生效）
  if (envPairs[envKey] !== undefined) return envPairs[envKey];
  if (process.env[envKey] !== undefined) return process.env[envKey];
  return undefined;
}

/**
 * 从 env/CLI 解析数值并校验 min/max 边界
 * 所有来源（CLI / env 文件 / 环境变量）统一跑边界检查，防止 env 文件绕过硬上限
 *
 * @param {object} envPairs - dotenv.parse() 结果
 * @param {string} envKey - 环境变量名
 * @param {*} cliValue - CLI 传入的值（已由 cli.js 做过边界校验）
 * @param {object} bounds - { min?: number, max?: number }
 * @returns {number}
 */
class ConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigError'; }
}

function resolveEnvNumber(envPairs, envKey, cliValue, bounds) {
  // CLI 来源：cli.js 的 coerceValue 已做过边界检查，直接返回
  if (cliValue !== undefined) return cliValue;
  // env 文件优先，其次进程环境变量（与 resolveEnv 优先级一致，符合 SKILL.md 承诺）；
  // env 来源的值需统一解析 + 边界校验，防止 env 绕过硬上限
  const raw = envPairs[envKey] !== undefined ? envPairs[envKey] : process.env[envKey];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`环境变量 ${envKey}=${raw} 不是合法整数`);
  }
  if (bounds && bounds.min !== undefined && n < bounds.min) {
    throw new ConfigError(`环境变量 ${envKey}=${n} 低于最小值 ${bounds.min}`);
  }
  if (bounds && bounds.max !== undefined && n > bounds.max) {
    throw new ConfigError(`环境变量 ${envKey}=${n} 超过最大值 ${bounds.max}`);
  }
  return n;
}

// ── 连接目标脱敏 ──

/**
 * 生成脱敏的连接目标信息，绝不包含密码或含密码 URI
 * @param {object} opts - { host, port, user, database }
 * @returns {string}
 */
function sanitizeTarget(opts) {
  const parts = [`host=${opts.host || '127.0.0.1'}`, `port=${opts.port}`];
  if (opts.user) parts.push(`user=${opts.user}`);
  if (opts.database !== undefined) parts.push(`db=${opts.database}`);
  return parts.join(', ');
}

// ── 安全错误格式化 ──

// 屏蔽 URL/连接串里内联的密码（://user:password@host → ://user:***@host）。
// 用户名段用 * 以覆盖 redis 无用户名的标准形式（://:password@host），防御性脱敏
const URL_CRED_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]*:)[^/\s@]+(@)/g;

/**
 * 取错误 message 首行，脱敏截断：屏蔽内联凭据 + 截断到 200 字符防意外泄露
 * @param {string} s
 * @returns {string}
 */
function sanitizeErrorLine(s) {
  const line = String(s || '').split('\n')[0];
  const masked = line.replace(URL_CRED_PATTERN, '$1***$2');
  return masked.length > 200 ? masked.slice(0, 200) + '…' : masked;
}

// 连接/认证/握手阶段错误码 —— 归为「连接失败」，明确区分于查询执行错误
const CONNECTION_CODES = new Set([
  // Node 网络与系统错误
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EDESTADDRREQ',
  // DNS 解析错误
  'EAI_AGAIN', 'EAI_NONAME', 'EAI_SERVICE', 'EAI_FAIL', 'EAI_BADFLAGS',
  // TLS 错误
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_INVALID_PROTOCOL_METHOD',
  'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
  // mysql2 连接/握手/选库阶段
  'HANDSHAKE_ERROR', 'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR', 'ER_BAD_HOST_ERROR',
  // Redis 认证阶段
  'WRONGPASS', 'NOAUTH',
]);

// node-redis 命令执行阶段错误码（与连接阶段区分）
const REDIS_EXEC_CODES = new Set([
  'ERR', 'WRONGTYPE', 'WRONGINT', 'WRONGBIT', 'WRONGKEY',
  'EXECABORT', 'NOREPLICAS', 'MISCONF', 'BUSYGROUP', 'NOGROUP',
  'LOADING', 'MASTERDOWN', 'READONLY', 'MOVED', 'ASK', 'CROSSSLOT',
  'NOSCRIPT', 'BUSYKEY', 'NOSUBKEY',
]);

/**
 * 安全地格式化数据库错误，让排障 agent 能立刻看清真正的失败原因。
 *
 * 关键安全前提：mysql2 的 ER_* / node-redis 的命令错误，其 message 来自
 * 数据库服务端，不含客户端凭据（服务端不感知客户端密码）；Node 网络错误
 * message 形如 "connect ECONNREFUSED 127.0.0.1:3306" 也不含密码。因此按
 * code 分类后暴露 code + message 首行（已脱敏截断）是安全的，且能让 agent
 * 一次区分「连不上」还是「SQL 写错」，避免无效的二分排查。
 * 仅对「既无 code 也无 message」的极端异常给中性兜底，且不再误报成「连接失败」。
 * @param {Error} err
 * @returns {string}
 */
function safeMessage(err) {
  const code = err.code || err.errno;
  const line = sanitizeErrorLine(err.message);

  if (code) {
    const codeStr = String(code);
    if (CONNECTION_CODES.has(codeStr)) {
      return `连接失败 [${codeStr}]: ${line}`;
    }
    // mysql2 服务端执行错误：ER_BAD_FIELD_ERROR(1054)/ER_PARSE_ERROR/ER_NO_SUCH_TABLE 等
    if (/^ER_/.test(codeStr)) {
      return `查询执行错误 [${codeStr}]: ${line}`;
    }
    // node-redis 命令执行错误
    if (REDIS_EXEC_CODES.has(codeStr)) {
      return `查询执行错误 [${codeStr}]: ${line}`;
    }
    // 未知 code：仍暴露 code + 首行（已脱敏截断），比「详情已隐藏」更利于排障
    return `[${codeStr}] ${line}`;
  }

  // 无 code：无法分类，给中性措辞，不再误导成「连接失败」
  const name = err.name || 'Error';
  return `${name}: ${line || '（无错误信息，请检查 SQL/命令与连接参数）'}`;
}

// ── TLS 选项构建 ──

/**
 * 从 ca-file 路径构建 TLS 选项
 * @param {string|undefined} caFile
 * @returns {object|undefined}
 */
function buildTlsOptions(caFile) {
  if (!caFile) return undefined;
  const resolved = path.resolve(caFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CA 证书文件不存在: ${resolved}`);
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
