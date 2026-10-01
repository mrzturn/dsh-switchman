#!/usr/bin/env node
'use strict';

/**
 * Redis 只读查询入口
 * 编排流程：CLI 解析 → 命令白名单校验 → 建连 → sendCommand → 输出 → 关闭
 * 安全要点：db 只通过连接配置选择（不开放 SELECT 命令）；
 *          客户端 timer 超时 destroy socket；
 *          Redis ACL 只读用户是服务端最终边界
 */

const { createClient } = require('redis');

// ── 内部模块 ──
const { parseCli, CliError } = require('./lib/cli');
const { loadEnvFile, resolveEnv, resolveEnvNumber, ConfigError, sanitizeTarget, safeMessage, buildTlsOptions } = require('./lib/config');
const { validateRedisCommand, RedisReadonlyError } = require('./lib/redis-readonly');
const { formatRedisTable, formatJson } = require('./lib/output');

// ── CLI 参数规格 ──
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

// ── 主函数 ──
async function main() {
  const { options, rest } = parseCli(process.argv.slice(2), REDIS_SPEC);

  // -- 后面必须是 Redis 命令
  if (rest.length === 0) {
    throw new CliError('必须在 -- 之后指定 Redis 命令（如 -- GET key）');
  }

  // 命令白名单校验（在任何连接操作之前）
  const validated = validateRedisCommand(rest, {
    maxItems: options.maxItems,
    allowUnbounded: options['allow-unbounded'],
  });

  // --validate-only：纯离线校验，不建连
  if (options['validate-only']) {
    process.stderr.write(`✓ 命令校验通过: ${validated.command} ${validated.args.join(' ')}\n`);
    process.stderr.write(`输出形状: ${validated.shape}${validated.unbounded ? ' (无界)' : ''}\n`);
    return;
  }

  // env 文件加载
  const envPairs = loadEnvFile(options['env-file']);

  // 合并环境变量覆盖（统一用 resolveEnvNumber 做边界校验，防 env 文件绕过硬上限）
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

  // 打印脱敏目标
  const target = sanitizeTarget({ host, port, user, database: db });
  process.stderr.write(`→ Redis ${target}\n`);

  // 构建 node-redis v4 客户端
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
    // 保留 Buffer 返回，避免自动字符串化丢二进制
    returnBuffers: true,
  };

  const client = createClient(clientConfig);

  // 超时定时器（connect + sendCommand 总超时）
  const timer = setTimeout(() => {
    client.destroy();
    // 不直接 reject（Promise 可能已 settle），通过 error 事件处理
  }, timeoutMsResolved);

  try {
    await client.connect();

    // sendCommand 以数组形式传参，绝不拼接后 split（防止参数含空格被截断）
    const cmdArgs = [validated.command, ...validated.args.map(String)];
    const startMs = Date.now();
    const result = await client.sendCommand(cmdArgs);
    const elapsedMs = Date.now() - startMs;

    clearTimeout(timer);

    // 判断截断
    let count = 0;
    let truncated = false;
    if (Array.isArray(result)) {
      count = result.length;
      truncated = count > maxItemsResolved;
    } else {
      count = 1;
    }

    if (options.format === 'json') {
      // JSON envelope 写 stdout
      process.stdout.write(JSON.stringify({
        source: 'redis',
        target,
        elapsedMs,
        count: truncated ? maxItemsResolved : count,
        truncated,
        // Buffer → base64 以确保 JSON 安全
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

    process.stderr.write(`✓ ${count} 条${truncated ? '（已截断）' : ''}，${elapsedMs}ms\n`);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  } finally {
    try { await client.quit(); } catch (_) { /* 忽略关闭错误 */ }
  }
}

/** 递归将 Buffer 转为 base64，确保 JSON 安全 */
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
  // 校验类/配置类错误直接显示消息（不是连接错误，不需要脱敏）
  if (e instanceof CliError || e instanceof RedisReadonlyError || e instanceof ConfigError) {
    process.stderr.write('✗ ' + e.message + '\n');
  } else {
    process.stderr.write('✗ ' + safeMessage(e) + '\n');
  }
  process.exit(1);
});
