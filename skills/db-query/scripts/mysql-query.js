#!/usr/bin/env node
'use strict';

/**
 * MySQL 只读查询入口
 * 编排流程：CLI 解析 → SQL 只读校验 → 建连（只读事务+超时）→ 查询 → 输出 → 回滚关闭
 * 安全要点：客户端 timer + 服务端 MAX_EXECUTION_TIME 双保险；永远 ROLLBACK
 */

const fs = require('fs');
const path = require('path');

// ── 内部模块 ──
const { parseCli, CliError } = require('./lib/cli');
const { loadEnvFile, resolveEnv, resolveEnvNumber, ConfigError, sanitizeTarget, safeMessage, buildTlsOptions } = require('./lib/config');
const { validateMysqlSql, ReadonlyError } = require('./lib/mysql-readonly');
const { formatMysqlTable, formatJson } = require('./lib/output');

// ── CLI 参数规格 ──
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

/** 从文件读取 SQL（限 64KiB 普通文本） */
function readSqlFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`SQL 文件不存在: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.size > 64 * 1024) throw new Error(`SQL 文件超过 64KiB: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8');
}

/** 打印校验结果（--validate-only 模式） */
function printValidation(checked) {
  process.stderr.write(`✓ 校验通过: ${checked.kind}${checked.limitInjected ? ' (已注入 LIMIT 截断)' : ''}\n`);
  process.stderr.write(`处理后的 SQL:\n${checked.sql}\n`);
}

/** 带超时的查询执行（客户端 timer + 服务端 MAX_EXECUTION_TIME 双保险） */
function queryWithTimeout(conn, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // 客户端超时：销毁连接，避免服务端继续传输
      conn.destroy();
      reject(new Error(`查询超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    conn.query(sql)
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

/** 安全回滚（忽略错误，确保连接一定关闭） */
async function safeRollback(conn) {
  try { await conn.query('ROLLBACK'); } catch (_) { /* 事务不存在等错误忽略 */ }
}

/** 安全关闭连接 */
async function safeClose(conn) {
  try { await conn.end(); } catch (_) { /* 连接已断开等错误忽略 */ }
}

// ── 主函数 ──
async function main() {
  const { options, rest } = parseCli(process.argv.slice(2), MYSQL_SPEC);

  // SQL 来源校验：--file 和位置参数二选一
  if (options.file && rest.length > 0) {
    throw new CliError('--file 和位置参数 SQL 不能同时指定');
  }
  if (!options.file && rest.length === 0) {
    throw new CliError('必须指定 SQL（位置参数或 --file）');
  }

  // 读取 SQL（在任何连接操作之前）
  const rawSql = options.file ? readSqlFile(options.file) : rest[0];

  // 只读校验（纯离线，不依赖任何连接参数）
  const maxRows = options.maxRows;
  const checked = validateMysqlSql(rawSql, { maxRows });

  // --validate-only：纯离线校验，不解析凭据、不建连
  if (options['validate-only']) {
    return printValidation(checked);
  }

  // ── 以下为连库路径，需要连接参数 ──
  // 修复：env 文件加载必须在 user/database 必填检查之前，否则 env 文件提供的凭据读不到
  const envPairs = loadEnvFile(options['env-file']);

  // 合并环境变量覆盖（统一用 resolveEnvNumber 做边界校验，防 env 文件绕过硬上限）
  const host = resolveEnv(envPairs, ENV_PREFIX + 'HOST', options.host);
  const port = resolveEnvNumber(envPairs, ENV_PREFIX + 'PORT', options.port, { min: 1, max: 65535 });
  const user = resolveEnv(envPairs, ENV_PREFIX + 'USER', options.user);
  const password = resolveEnv(envPairs, ENV_PREFIX + 'PASSWORD', options.password);
  const database = resolveEnv(envPairs, ENV_PREFIX + 'DATABASE', options.database);

  // user 必填；database 放宽为可选——排查第一步常是 SHOW DATABASES / SELECT 1 /
  // 带库名前缀的表查询，不强制默认库；查表未指定库时 MySQL 会自报 ER_NO_DB_ERROR
  if (!user) throw new CliError('缺少 user（用 --user、DB_QUERY_MYSQL_USER、环境变量或 env 文件提供）');
  if (!database) {
    process.stderr.write('（未指定 database：仅能执行无默认库的查询，如 SHOW DATABASES / SELECT 1 / 带库名前缀的表）\n');
  }

  const maxRowsResolved = resolveEnvNumber(envPairs, ENV_PREFIX + 'MAX_ROWS', options.maxRows, { min: 1, max: 5000 });
  const maxValueBytes = resolveEnvNumber(envPairs, 'DB_QUERY_MAX_VALUE_BYTES', options['max-value-bytes'], { min: 256, max: 1048576 });
  const timeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'TIMEOUT_MS', options['timeout-ms'], { min: 1000, max: 60000 });
  const connectTimeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'CONNECT_TIMEOUT_MS', options['connect-timeout-ms'], { min: 1000, max: 30000 });

  // 打印脱敏目标（连库前确认去向，绝不暴露密码）
  const target = sanitizeTarget({ host, port, user, database });
  process.stderr.write(`→ MySQL ${target}\n`);

  // 动态加载 mysql2（只在需要连库时）
  const mysql = require('mysql2/promise');

  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password: password || undefined,
    database,
    connectTimeout: connectTimeoutMs,
    multipleStatements: false,   // 显式关闭，不依赖驱动默认值
    supportBigNumbers: true,
    bigNumberStrings: true,     // BIGINT/DECIMAL 保留字符串精度
    decimalNumbers: false,
    dateStrings: true,          // 日期保留服务端文本
    ...(options.tls || options['ca-file']
      ? { ssl: buildTlsOptions(options['ca-file']) || { rejectUnauthorized: true } }
      : {}),
  });

  const startMs = Date.now();
  try {
    // 服务端只读事务（不支持的版本会报错，fail-closed 不静默降级）
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('SET SESSION MAX_EXECUTION_TIME = ?', [timeoutMs]);
    await conn.query('START TRANSACTION READ ONLY');

    const [rows, fields] = await queryWithTimeout(conn, checked.sql, timeoutMs);
    const elapsedMs = Date.now() - startMs;

    // 判断是否有截断（LIMIT 注入了 maxRows+1 哨兵行）
    const truncated = checked.limitInjected && rows.length > maxRowsResolved;
    const displayRows = truncated ? rows.slice(0, maxRowsResolved) : rows;

    if (options.format === 'json') {
      // JSON 写 stdout，状态写 stderr，保证 stdout 是合法 JSON
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

    process.stderr.write(`✓ ${rows.length} 行${truncated ? '（已截断）' : ''}，${elapsedMs}ms\n`);
  } finally {
    // 永远 ROLLBACK，不发 COMMIT（防御性，确保不留事务）
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
