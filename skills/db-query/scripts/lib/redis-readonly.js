'use strict';

/**
 * Redis 只读命令白名单校验
 * 未知命令一律拒绝（fail-closed）；精确参数保护
 *
 * 设计要点：
 * - Object.freeze 白名单，运行时不可篡改
 * - policy.shape 指导输出格式
 * - KEYS/HGETALL 等无界命令需显式 --allow-unbounded
 * - SCAN 类命令只接受结构化参数（MATCH/COUNT/TYPE）
 */

// ── 白名单策略 ──

/**
 * 策略字段说明：
 * - arity: 参数个数（不含命令本身），null 表示不固定
 * - shape: 输出形状 'scalar' | 'list' | 'pairs' | 'scan' | 'info' | 'client_list'
 * - validate: (args) => void，参数校验函数
 * - unbounded: true 表示结果集可能很大，需要 --allow-unbounded
 */
const _READ_ONLY_COMMANDS = {
  // ── 通用/键 ──
  PING:       { arity: 0, shape: 'scalar', validate: () => {} },
  GET:        { arity: 1, shape: 'scalar', validate: () => {} },
  MGET:       { arity: null, shape: 'list', validate: (a) => { if (!a.length) throw 'MGET 至少需要一个 key'; } },
  EXISTS:     { arity: null, shape: 'scalar', validate: (a) => { if (!a.length) throw 'EXISTS 至少需要一个 key'; } },
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
  HMGET:      { arity: null, shape: 'list', validate: (a) => { if (a.length < 2) throw 'HMGET 至少需要 field 和 2 个参数'; } },
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

  // ── 服务信息 ──
  INFO:       { arity: null, shape: 'info', validate: () => {} },
  CLIENT:     { arity: null, shape: 'client_list', validate: validateClient },
  CONFIG:     { arity: null, shape: 'list', validate: validateConfig },
};

/** 冻结白名单防止运行时篡改 */
const READ_ONLY_COMMANDS = Object.freeze(_READ_ONLY_COMMANDS);

// ── 参数校验函数 ──

/**
 * SCAN/HSCAN/SSCAN/ZSCAN 参数结构化校验
 * 只接受 MATCH pattern COUNT n [TYPE type]；不允许重复选项
 *
 * 修复：cursor 位置因命令而异——SCAN 无 key 前缀，cursor 在首位；
 * HSCAN/SSCAN/ZSCAN 第一个参数是 key，cursor 在第二位。
 * 旧实现统一按 SCAN 处理，导致 HSCAN/SSCAN/ZSCAN 合法的 cursor=0 被误拒。
 */
function validateScan(args, command) {
  // SCAN 的参数布局：cursor 在首位；其余三个命令首位是 key，第二位才是 cursor
  const hasKey = command !== 'SCAN';
  let i;
  if (hasKey) {
    if (args.length < 2) throw `${command} 至少需要 key 和 cursor`;
    const cursor = Number(args[1]);
    if (!Number.isInteger(cursor) || cursor < 0) throw 'cursor 必须是非负整数';
    i = 2; // 选项从第三位开始解析
  } else {
    if (args.length === 0) throw 'SCAN 至少需要 cursor 参数';
    const cursor = Number(args[0]);
    if (!Number.isInteger(cursor) || cursor < 0) throw 'cursor 必须是非负整数';
    i = 1; // 选项从第二位开始解析
  }

  const seen = new Set();
  for (; i < args.length; i++) {
    const opt = String(args[i]).toUpperCase();
    if (seen.has(opt)) throw `重复的 SCAN 选项: ${opt}`;
    seen.add(opt);

    if (opt === 'MATCH') {
      if (i + 1 >= args.length) throw 'MATCH 需要一个 pattern 参数';
      i++; // 跳过 pattern 值
    } else if (opt === 'COUNT') {
      if (i + 1 >= args.length) throw 'COUNT 需要一个数值参数';
      const count = Number(args[i + 1]);
      if (!Number.isInteger(count) || count < 1) throw 'COUNT 必须是正整数';
      if (count > 5000) throw 'COUNT 超过上限 5000';
      i++;
    } else if (opt === 'TYPE') {
      // TYPE 只支持 SCAN，HSCAN/SSCAN/ZSCAN 不支持 TYPE 选项（交给服务端拒不如显式拒绝）
      if (hasKey) throw `${command} 不支持 TYPE 选项（仅 SCAN 支持）`;
      if (i + 1 >= args.length) throw 'TYPE 需要一个类型名参数';
      i++;
    } else {
      throw `SCAN 不支持的选项: ${opt}`;
    }
  }
}

/**
 * LRANGE 范围校验：防客户端内存 DoS
 * stop < 0（负索引）→ 长度未知，要求 --allow-unbounded
 * start < 0 或 stop ≥ 0 时，检查 (stop - start + 1) ≤ maxItems
 */
function validateLrange(args, command, limits) {
  if (args.length < 3) throw '至少需要 3 个参数（key start stop）';
  const start = Number(args[1]);
  const stop = Number(args[2]);
  if (!Number.isInteger(start) || !Number.isInteger(stop)) {
    throw 'start/stop 必须是整数';
  }
  const maxItems = (limits && limits.maxItems) || 200;

  // 负索引（stop < 0）表示到末尾，实际长度未知 → 要求显式放行
  if (stop < 0) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'stop 为负索引时范围不确定，需 --allow-unbounded 或用 SCAN/LRANGE + 正索引';
    }
    return; // 已放行，不再算范围
  }
  // start 为负索引时，Redis 换算后实际起始位置不确定 → 同样要求放行
  if (start < 0) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'start 为负索引时范围不确定，需 --allow-unbounded 或用 LRANGE + 正索引';
    }
    return;
  }
  // 双方都是非负索引，可精确计算返回数量
  const count = stop - start + 1;
  if (count > maxItems) {
    throw `范围 ${start}..${stop} 共 ${count} 项，超过 maxItems=${maxItems}`;
  }
}

/**
 * ZRANGE Redis 6.2+ 完整语法校验
 * 支持 BYSCORE / BYLEX / REV / LIMIT / WITHSCORES 选项
 * BYLEX 模式无 LIMIT 时要求 --allow-unbounded（词法范围可能很长）
 * 含 LIMIT 时 count 必须 ≤ maxItems
 */
function validateZrange(args, command, limits) {
  if (args.length < 3) throw 'ZRANGE 至少需要 key min max';
  const maxItems = (limits && limits.maxItems) || 200;

  // 收集选项关键字（跳过前 3 个必选参数 key min max）
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
      // LIMIT 后需要 offset 和 count
      if (i + 2 >= optsUpper.length) throw 'LIMIT 需要 offset 和 count';
      const offset = Number(args[3 + i + 1]); // 原始 args 中对应位置
      limitCount = Number(args[3 + i + 2]);
      if (!Number.isInteger(offset) || !Number.isInteger(limitCount) || offset < 0 || limitCount < 0) {
        throw 'LIMIT offset/count 必须是非负整数';
      }
      if (limitCount > maxItems) throw `LIMIT count ${limitCount} 超过 maxItems=${maxItems}`;
      i += 2; // 跳过 offset 和 count
      continue;
    }
    throw `ZRANGE 不支持的选项: ${opt}`;
  }

  // BYLEX 模式无 LIMIT → 词法范围可能很大，要求放行
  if (hasBylex && !hasLimit) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'BYLEX 模式无 LIMIT 时范围不确定，需 --allow-unbounded';
    }
  }
  // BYSCORE 默认索引范围（如 0 -1）无 LIMIT → 同样要求放行
  if (hasByscore && !hasLimit) {
    if (!(limits && limits.allowUnbounded)) {
      throw 'BYSCORE 模式无 LIMIT 时范围不确定，需 --allow-unbounded';
    }
  }
  // 默认索引模式（非 BYSCORE/BYLEX），检查 min/max 范围
  if (!hasByscore && !hasBylex) {
    // min/max 作为 rank 索引时，负索引表示到末尾，范围不确定
    const minVal = Number(args[1]);
    const maxVal = Number(args[2]);
    if ((minVal < 0 || maxVal < 0) && !hasLimit) {
      if (!(limits && limits.allowUnbounded)) {
        throw 'ZRANGE 含负索引且无 LIMIT，范围不确定，需 --allow-unbounded';
      }
    }
    // 非负索引且有 LIMIT 时，LIMIT 已校验 count，安全
    // 非负索引且无 LIMIT 时，需计算范围
    if (minVal >= 0 && maxVal >= 0 && !hasLimit) {
      const rangeCount = maxVal - minVal + 1;
      if (rangeCount > maxItems) {
        throw `范围 ${minVal}..${maxVal} 共 ${rangeCount} 项，超过 maxItems=${maxItems}`;
      }
    }
  }
}

/**
 * ZRANGEBYSCORE 必须带 LIMIT offset count 且 count 不超上限
 */
function validateZrangeByScore(args) {
  if (args.length < 3) throw 'ZRANGEBYSCORE 至少需要 key min max';
  // 检查是否含 LIMIT
  const argsUpper = args.map(a => String(a).toUpperCase());
  const limitIdx = argsUpper.indexOf('LIMIT');
  if (limitIdx === -1) {
    throw 'ZRANGEBYSCORE 必须带 LIMIT 子句（防止无界结果集）';
  }
  if (limitIdx + 2 >= args.length) {
    throw 'LIMIT 需要 offset 和 count 两个参数';
  }
  const count = Number(args[limitIdx + 2]);
  if (!Number.isInteger(count) || count < 0) throw 'LIMIT count 必须是非负整数';
  if (count > 5000) throw 'LIMIT count 超过上限 5000';
}

/**
 * CLIENT 只允许 LIST 子命令
 * KILL/PAUSE/UNBLOCK 可中断其他连接，拒绝
 */
function validateClient(args) {
  if (args.length === 0) throw 'CLIENT 需要子命令';
  const sub = String(args[0]).toUpperCase();
  if (sub !== 'LIST') throw `不允许 CLIENT ${sub}（只允许 CLIENT LIST）`;
}

/**
 * CONFIG 只允许 GET 子命令，且 config key 在安全白名单内
 * 拒绝 *（转储全部配置）、requirepass、masterauth 等敏感项
 */
function validateConfig(args) {
  if (args.length === 0) throw 'CONFIG 需要子命令';
  const sub = String(args[0]).toUpperCase();
  if (sub !== 'GET') throw `不允许 CONFIG ${sub}（只允许 CONFIG GET）`;

  if (args.length < 2) throw 'CONFIG GET 至少需要一个参数';

  // 安全白名单：只允许查看非敏感的运行时配置
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
    if (key === '*') throw '不允许 CONFIG GET *（会转储全部配置含密码）';
    if (key === 'requirepass' || key === 'masterauth') {
      throw `不允许查询 ${key}（可能暴露密码）`;
    }
    // 包含 tls/key/pass/secret/acl 等关键词的一律拒绝
    if (/tls[_-]?key|pass|secret|acl[_-]file|unixsocket/i.test(key)) {
      throw `不允许查询敏感配置: ${key}`;
    }
    if (!SAFE_CONFIG_KEYS.has(key)) {
      throw `CONFIG GET ${key} 不在安全白名单中`;
    }
  }
}

// ── 主校验入口 ──

/**
 * 校验 Redis 命令是否在只读白名单内，并校验参数
 * 未知命令一律拒绝（fail-closed）
 *
 * @param {string[]} argv - 完整命令数组，[cmd, ...args]
 * @param {object} limits - { maxItems: number, allowUnbounded: boolean }
 * @returns {{ command: string, args: string[], shape: string, unbounded: boolean }}
 */
function validateRedisCommand(argv, limits) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new RedisReadonlyError('Redis 命令不能为空');
  }

  const command = String(argv[0]).toUpperCase();
  const policy = READ_ONLY_COMMANDS[command];

  if (!policy) {
    throw new RedisReadonlyError(`不允许的命令: ${command}（不在只读白名单中）`);
  }

  // 检查 arity（参数个数约束）
  if (policy.arity !== null && argv.length - 1 !== policy.arity) {
    throw new RedisReadonlyError(`${command} 需要 ${policy.arity} 个参数，收到 ${argv.length - 1} 个`);
  }

  // 无界命令需要显式放行
  if (policy.unbounded && !(limits && limits.allowUnbounded)) {
    throw new RedisReadonlyError(
      `${command} 可能返回大量数据，需添加 --allow-unbounded 参数确认（建议优先使用 SCAN 类命令）`
    );
  }

  // 运行策略特定的参数校验；传入命令名和 limits 以便各函数做范围/无界校验
  const args = argv.slice(1);
  try {
    policy.validate(args, command, limits);
  } catch (msg) {
    throw new RedisReadonlyError(`${command} 参数错误: ${msg}`);
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
