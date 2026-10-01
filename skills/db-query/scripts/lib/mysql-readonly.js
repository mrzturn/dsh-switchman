'use strict';

/**
 * MySQL 只读校验：有限状态词法扫描器 + 语句分类 + LIMIT 注入
 * 安全核心：任何歧义都拒绝（fail-closed），宁可误杀不可漏过
 *
 * 设计要点：
 * - 状态机正确处理引号内分号/关键字/ doubled quote
 * - 拒绝反斜杠转义（NO_BACKSLASH_ESCAPES 歧义）
 * - 拒绝所有注释（堵住关键字拆分绕过）
 * - 只允许单条语句，最多末尾一个分号
 * - 拒绝 NUL 字符、未闭合引号、括号不平衡、超长 SQL
 */

const MAX_SQL_LENGTH = 64 * 1024; // 64KiB，防超大 payload

// ── 词法扫描器 ──

/** 词法状态枚举 */
const STATE = {
  NORMAL: 0,
  SINGLE_QUOTE: 1,  // '...'
  DOUBLE_QUOTE: 2,  // "..."
  BACKTICK: 3,       // `...`
};

/**
 * 对 SQL 做有限状态词法扫描，返回 token 数组
 * 每个_token: { type, value, depth }
 * type: 'word' | 'quoted' | 'number' | 'symbol' | 'semicolon' | 'whitespace'
 * depth: 括号嵌套深度（引号内也算外层的 depth）
 *
 * @param {string} sql
 * @returns {Array<{type: string, value: string, depth: number}>}
 */
function tokenizeMysql(sql) {
  if (typeof sql !== 'string') throw new ReadonlyError('SQL 必须是字符串');
  if (sql.length === 0) throw new ReadonlyError('SQL 不能为空');
  if (sql.length > MAX_SQL_LENGTH) throw new ReadonlyError(`SQL 超长（${sql.length} > ${MAX_SQL_LENGTH}）`);

  // NUL 字节可能导致底层 C 层截断，一律拒绝
  if (sql.includes('\0')) throw new ReadonlyError('SQL 含 NUL 字符');

  const tokens = [];
  let state = STATE.NORMAL;
  let parenDepth = 0;    // 当前括号深度
  let i = 0;
  let wordBuf = '';       // 累积未引用标识符
  let numBuf = '';        // 累积数字

  const emit = (type, value, d) => {
    tokens.push({ type, value, depth: d });
  };

  const flushWord = (d) => {
    if (wordBuf.length > 0) {
      emit('word', wordBuf, d);
      wordBuf = '';
    }
  };

  const flushNum = (d) => {
    if (numBuf.length > 0) {
      emit('number', numBuf, d);
      numBuf = '';
    }
  };

  while (i < sql.length) {
    const ch = sql[i];

    if (state === STATE.NORMAL) {
      // ── 注释检测（注释非查询核验必需，保守拒绝堵住关键字拆分绕过）──
      if (ch === '#') {
        throw new ReadonlyError('不允许 # 注释（防止关键字拆分绕过）');
      }
      if (ch === '-' && i + 1 < sql.length && sql[i + 1] === '-') {
        // -- 注释：合法形式是 `-- `（双横线+空格），但不管空格与否一律拒绝
        throw new ReadonlyError('不允许 -- 注释（防止关键字拆分绕过）');
      }
      if (ch === '/' && i + 1 < sql.length && sql[i + 1] === '*') {
        const nextCh = i + 2 < sql.length ? sql[i + 2] : '';
        if (nextCh === '!' || nextCh === '+') {
          throw new ReadonlyError(`不允许 /*${nextCh} ${nextCh === '!' ? 'version comment' : 'optimizer hint'}（可能含可执行代码）`);
        }
        throw new ReadonlyError('不允许 /* */ 块注释（防止关键字拆分绕过）');
      }

      // ── 引号状态切换 ──
      if (ch === "'") {
        flushWord(parenDepth);
        flushNum(parenDepth);
        state = STATE.SINGLE_QUOTE;
        i++;
        continue;
      }
      if (ch === '"') {
        flushWord(parenDepth);
        flushNum(parenDepth);
        state = STATE.DOUBLE_QUOTE;
        i++;
        continue;
      }
      if (ch === '`') {
        flushWord(parenDepth);
        flushNum(parenDepth);
        state = STATE.BACKTICK;
        i++;
        continue;
      }

      // ── 括号深度追踪 ──
      if (ch === '(') {
        flushWord(parenDepth);
        flushNum(parenDepth);
        parenDepth++;
        emit('symbol', '(', parenDepth);
        i++;
        continue;
      }
      if (ch === ')') {
        flushWord(parenDepth);
        flushNum(parenDepth);
        if (parenDepth <= 0) throw new ReadonlyError('括号不匹配：多余的 )');
        emit('symbol', ')', parenDepth);
        parenDepth--;
        i++;
        continue;
      }

      // ── 分号 ──
      if (ch === ';') {
        flushWord(parenDepth);
        flushNum(parenDepth);
        emit('semicolon', ';', parenDepth);
        i++;
        continue;
      }

      // ── 标点/符号 ──
      if (isSymbolChar(ch)) {
        // 检测 := 赋值运算符
        if (ch === ':' && i + 1 < sql.length && sql[i + 1] === '=') {
          throw new ReadonlyError('不允许 := 赋值运算符');
        }
        flushWord(parenDepth);
        flushNum(parenDepth);
        emit('symbol', ch, parenDepth);
        i++;
        continue;
      }

      // ── 空白 ──
      if (/\s/.test(ch)) {
        flushWord(parenDepth);
        flushNum(parenDepth);
        i++;
        continue;
      }

      // ── 数字 ──
      if (/\d/.test(ch)) {
        flushWord(parenDepth);
        numBuf += ch;
        i++;
        continue;
      }

      // ── 标识符/关键字（字母、下划线、$）──
      if (/[a-zA-Z_$]/.test(ch)) {
        flushNum(parenDepth);
        wordBuf += ch;
        i++;
        continue;
      }

      // ── 不明字符 ──
      throw new ReadonlyError(`SQL 含无法识别的字符: ${JSON.stringify(ch)} (位置 ${i})`);
    }

    // ── 单引号状态 ──
    if (state === STATE.SINGLE_QUOTE) {
      if (ch === '\\') {
        // 反斜杠转义在 NO_BACKSLASH_ESCAPES 模式下语义不同，
        // 且可能用于拆分关键字绕过检测，一律拒绝
        throw new ReadonlyError('不允许反斜杠转义，请改用标准双引号转义（\'\'）');
      }
      if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
        // 标准双引号转义：'' 转义为单引号
        i += 2;
        continue;
      }
      if (ch === "'") {
        // 引号闭合
        emit('quoted', "'", parenDepth);
        state = STATE.NORMAL;
        i++;
        continue;
      }
      // 引号内内容不逐字符记录，只保留引号边界 token
      i++;
      continue;
    }

    // ── 双引号状态 ──
    if (state === STATE.DOUBLE_QUOTE) {
      if (ch === '\\') {
        throw new ReadonlyError('不允许反斜杠转义，请改用标准双引号转义（""）');
      }
      if (ch === '"' && i + 1 < sql.length && sql[i + 1] === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        emit('quoted', '"', parenDepth);
        state = STATE.NORMAL;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // ── 反引号状态 ──
    if (state === STATE.BACKTICK) {
      if (ch === '`' && i + 1 < sql.length && sql[i + 1] === '`') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        emit('quoted', '`', parenDepth);
        state = STATE.NORMAL;
        i++;
        continue;
      }
      i++;
      continue;
    }
  }

  // ── 扫描结束检查 ──
  flushWord(parenDepth);
  flushNum(parenDepth);

  if (state !== STATE.NORMAL) {
    const stateName = state === STATE.SINGLE_QUOTE ? '单引号' : state === STATE.DOUBLE_QUOTE ? '双引号' : '反引号';
    throw new ReadonlyError(`未闭合的${stateName}`);
  }
  if (parenDepth !== 0) {
    throw new ReadonlyError(`括号不匹配：缺少 ${parenDepth} 个 )`);
  }

  return tokens;
}

/** 判断是否为 SQL 标点符号字符（非字母、非数字、非空白、非引号、非分号、非括号） */
function isSymbolChar(ch) {
  return /[+\-*/%=<>!&|^~,.\:@]/.test(ch);
}

// ── 语句分类 ──

/**
 * 根据 token 判断根语句类型
 * 只允许 SELECT / WITH...SELECT / SHOW / DESCRIBE / EXPLAIN
 * @param {Array} tokens - tokenizeMysql 返回值
 * @returns {string} 'SELECT' | 'WITH_SELECT' | 'SHOW' | 'DESCRIBE' | 'EXPLAIN'
 */
function classifyMysqlStatement(tokens) {
  if (tokens.length === 0) throw new ReadonlyError('无有效 token');

  // 找到 depth=0 的首个 word token（跳过前导空白/注释已被拒绝）
  let firstWord = null;
  let firstWordIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'word' && tokens[i].depth === 0) {
      firstWord = tokens[i].value.toUpperCase();
      firstWordIdx = i;
      break;
    }
  }

  if (!firstWord) throw new ReadonlyError('未找到根语句关键字');

  switch (firstWord) {
    case 'SELECT':
      return 'SELECT';

    case 'WITH': {
      // CTE：WITH 后的根查询必须是 SELECT（拒绝 WITH ... DELETE/UPDATE）
      // 策略：找 depth=0 上出现过的所有「语句类关键字」，第一个必须是 SELECT
      const STATEMENT_KW = new Set([
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CALL', 'DO',
      ]);
      let foundSelect = false;
      for (let i = firstWordIdx + 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.type !== 'word' || tok.depth !== 0) continue;
        const w = tok.value.toUpperCase();
        if (STATEMENT_KW.has(w)) {
          if (w === 'SELECT') {
            foundSelect = true;
          } else {
            throw new ReadonlyError(`WITH CTE 后的根语句必须是 SELECT，发现: ${w}`);
          }
          break;
        }
      }
      if (!foundSelect) {
        throw new ReadonlyError('WITH 后未找到根查询 SELECT 语句');
      }
      return 'WITH_SELECT';
    }

    case 'SHOW':
      return 'SHOW';

    case 'DESCRIBE':
    case 'DESC':
      return 'DESCRIBE';

    case 'EXPLAIN': {
      // 只允许 EXPLAIN [FORMAT=...] SELECT/WITH
      // 拒绝 EXPLAIN ANALYZE（会实际执行语句并产生写入/锁）、EXPLAIN DML
      // 修复：旧实现只看 EXPLAIN 后第一个 word，遇到 FORMAT 就误判为非法，
      // 导致合法的 EXPLAIN FORMAT=JSON SELECT 被拒。这里收集后续所有 word 再判定。
      const wordsAfterExplain = [];
      for (let i = firstWordIdx + 1; i < tokens.length; i++) {
        if (tokens[i].type === 'word' && tokens[i].depth === 0) {
          wordsAfterExplain.push(tokens[i].value.toUpperCase());
        }
      }
      if (wordsAfterExplain.length === 0) {
        // EXPLAIN 后没有 SELECT/WITH（如旧式 EXPLAIN tbl_name），不支持
        throw new ReadonlyError('EXPLAIN 后必须跟 SELECT 或 WITH');
      }
      const explainFirst = wordsAfterExplain[0];
      if (explainFirst === 'ANALYZE') {
        throw new ReadonlyError('不允许 EXPLAIN ANALYZE（会实际执行语句）');
      }
      if (explainFirst === 'FORMAT') {
        // EXPLAIN FORMAT=JSON/TRADITIONAL/TREE/WIDTH SELECT ... 
        // （= 是非 word token，已被跳过；wordsAfterExplain 形如 [FORMAT, JSON, SELECT, ...]）
        const EXPLAIN_FORMATS = new Set(['JSON', 'TRADITIONAL', 'TREE', 'WIDTH']);
        if (wordsAfterExplain.length < 2) {
          throw new ReadonlyError('EXPLAIN FORMAT= 需要格式名（JSON/TRADITIONAL/TREE/WIDTH）');
        }
        const fmtName = wordsAfterExplain[1];
        if (!EXPLAIN_FORMATS.has(fmtName)) {
          throw new ReadonlyError(`EXPLAIN FORMAT= 不支持的格式名: ${fmtName}`);
        }
        // 格式名之后必须紧跟 SELECT/WITH
        let stmtWord = null;
        for (let k = 2; k < wordsAfterExplain.length; k++) {
          if (wordsAfterExplain[k] === 'SELECT' || wordsAfterExplain[k] === 'WITH') {
            stmtWord = wordsAfterExplain[k];
            break;
          }
        }
        if (!stmtWord) {
          throw new ReadonlyError('EXPLAIN FORMAT=... 后必须是 SELECT 或 WITH');
        }
        return 'EXPLAIN';
      }
      if (explainFirst !== 'SELECT' && explainFirst !== 'WITH') {
        throw new ReadonlyError(`不允许 EXPLAIN ${explainFirst}（只允许 EXPLAIN [FORMAT=...] SELECT/WITH）`);
      }
      return 'EXPLAIN';
    }

    default:
      throw new ReadonlyError(`不允许的语句类型: ${firstWord}`);
  }
}

// ── 危险关键字/模式检测 ──

/** 非引用 word token 中遇到即拒绝的关键字 */
const FORBIDDEN_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE',
  'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'CALL', 'DO', 'LOAD',
  'INSTALL', 'UNINSTALL', 'LOCK', 'UNLOCK', 'SET', 'RESET', 'PURGE',
  'KILL', 'OPTIMIZE', 'REPAIR', 'ANALYZE', 'CHECK', 'USE',
  'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'XA',
  'PREPARE', 'EXECUTE', 'DEALLOCATE',
]);

/** 需要特殊检测的模式关键字 */
const INTO_FORBIDDEN = 'INTO';
const FOR_UPDATE_PATTERN = ['FOR', 'UPDATE'];
const LOCK_SHARE_PATTERN = ['LOCK', 'IN', 'SHARE', 'MODE'];

/** 危险函数名 */
const DANGEROUS_FUNCTIONS = new Set([
  'SLEEP', 'BENCHMARK', 'GET_LOCK', 'RELEASE_LOCK',
  'IS_FREE_LOCK', 'IS_USED_LOCK', 'LOAD_FILE', 'MASTER_POS_WAIT',
]);

/**
 * 检查 token 流中是否包含禁止的关键字/模式
 * SELECT/WITH 内出现任何写操作关键字都拒绝
 */
function checkForbiddenPatterns(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'word') continue;

    const upper = tok.value.toUpperCase();

    // 危险函数检测（即使在子查询中也拒绝）
    if (DANGEROUS_FUNCTIONS.has(upper)) {
      throw new ReadonlyError(`不允许危险函数: ${upper}`);
    }

    // INTO 可以出现在各种合法位置（SELECT INTO 不常见但存在），
    // 但 SELECT INTO OUTFILE/DUMPFILE 是写文件操作，风险太高一律拒绝
    if (upper === INTO_FORBIDDEN) {
      // 检查后续是否紧跟 OUTFILE/DUMPFILE 或变量赋值模式
      for (let j = i + 1; j < tokens.length && j < i + 4; j++) {
        const next = tokens[j];
        if (next.type !== 'word') continue;
        const nextUpper = next.value.toUpperCase();
        if (nextUpper === 'OUTFILE' || nextUpper === 'DUMPFILE' || nextUpper === '@') {
          throw new ReadonlyError(`不允许 INTO ${nextUpper}（数据写出风险）`);
        }
      }
      // 保守策略：即使不是 OUTFILE/DUMPFILE 也拒绝 INTO
      // 因为 INTO 还能做变量赋值，可能间接导致写操作
      throw new ReadonlyError('不允许 INTO（覆盖 OUTFILE/DUMPFILE/变量赋值）');
    }

    // FOR UPDATE 锁定检测
    if (upper === 'FOR' && tok.depth === 0) {
      const subsequent = getSubsequentRootWords(tokens, i);
      if (subsequent.length >= 1 && subsequent[0] === 'UPDATE') {
        throw new ReadonlyError('不允许 FOR UPDATE（排他锁定）');
      }
      if (subsequent.length >= 3 &&
          subsequent[0] === 'LOCK' && subsequent[1] === 'IN' && subsequent[2] === 'SHARE' && subsequent[3] === 'MODE') {
        throw new ReadonlyError('不允许 LOCK IN SHARE MODE（共享锁定）');
      }
    }

    // 禁止关键字（在 SELECT/WITH 内）
    if (FORBIDDEN_WORDS.has(upper)) {
      throw new ReadonlyError(`不允许在只读查询中使用: ${upper}`);
    }
  }
}

/** 从 tokens[i] 之后取连续 depth=0 的 word token（跳过空白/非word） */
function getSubsequentRootWords(tokens, startIdx) {
  const result = [];
  for (let j = startIdx + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok.type === 'whitespace' || tok.type === 'symbol') continue;
    if (tok.type === 'word' && tok.depth === 0) {
      result.push(tok.value.toUpperCase());
    }
    if (result.length >= 4) break; // 只需检查前几个
  }
  return result;
}

// ── 单语句校验 ──

/**
 * 校验 SQL 只包含一条语句，最多末尾一个分号
 * @param {Array} tokens
 */
function checkSingleStatement(tokens) {
  let semicolons = 0;
  for (const tok of tokens) {
    if (tok.type === 'semicolon') {
      semicolons++;
      // 分号必须在 depth=0（不在括号/子查询内）
      if (tok.depth !== 0) {
        throw new ReadonlyError('语句中括号内不允许分号');
      }
    }
  }
  if (semicolons > 1) {
    throw new ReadonlyError(`只允许单条语句，发现 ${semicolons} 个分号`);
  }
  // 如果有分号，必须在最后一个 token
  if (semicolons === 1) {
    const last = tokens[tokens.length - 1];
    if (last.type !== 'semicolon') {
      throw new ReadonlyError('分号只能在 SQL 末尾');
    }
  }
}

// ── LIMIT 处理 ──

/**
 * 分析 depth=0 层的 LIMIT 子句，严格只允许三种形式：
 *   LIMIT <单个非负整数>
 *   LIMIT <非负整数> OFFSET <非负整数>
 *   LIMIT <非负整数>, <非负整数>  （MySQL 旧式 offset,count）
 * 任何表达式、变量、运算符 → 拒绝（防绕过 maxRows）
 *
 * @param {Array} tokens - tokenizeMysql 返回值
 * @param {number} maxRows - 允许的最大行数
 * @returns {{ hasLimit: boolean, limitCount: number }}
 */
function analyzeTopLevelLimit(tokens, maxRows) {
  // 定位 depth=0 的最后一个 LIMIT 关键字（子查询内的 LIMIT 在 depth>0，自然排除）
  let lastLimitIdx = -1;
  let foundSelect = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.depth > 0) continue;
    if (tok.type === 'word') {
      const upper = tok.value.toUpperCase();
      // 遇到 SELECT/UNION 等顶层关键字说明有新的子查询段
      if (upper === 'SELECT' || upper === 'UNION') foundSelect = true;
    }
    if (tok.type === 'word' && tok.value.toUpperCase() === 'LIMIT' && tok.depth === 0 && foundSelect) {
      lastLimitIdx = i;
    }
  }
  if (lastLimitIdx === -1) return { hasLimit: false };

  // 收集 LIMIT 之后的 depth=0 token（到语句结尾或下一个顶层关键字）
  const limitTokens = [];
  for (let i = lastLimitIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.depth > 0) continue;
    // 遇到 UNION 等顶层关键字说明 LIMIT 属于前一个段，停止收集
    if (tok.type === 'word' && tok.value.toUpperCase() === 'UNION') break;
    limitTokens.push(tok);
  }

  // 解析 LIMIT 后的 token 序列，只允许三种形式
  return parseLimitClause(limitTokens, maxRows);
}

/**
 * 解析 LIMIT 子句 token 序列，严格校验形式和 count ≤ maxRows
 * @param {Array} limitTokens - LIMIT 关键字之后、depth=0 的 token
 * @param {number} maxRows
 * @returns {{ hasLimit: boolean, limitCount: number }}
 */
function parseLimitClause(limitTokens, maxRows) {
  // 过滤空白，只保留有意义的 token
  const meaningful = limitTokens.filter(t => t.type !== 'whitespace');

  if (meaningful.length === 0) throw new ReadonlyError('LIMIT 后缺少参数');

  // 必须以 number 开头
  const first = meaningful[0];
  if (first.type !== 'number') throw new ReadonlyError('LIMIT 参数必须是纯整数（不接受表达式或变量）');
  const firstVal = Number(first.value);
  if (!Number.isInteger(firstVal) || firstVal < 0) throw new ReadonlyError('LIMIT 必须是非负整数');

  // ── 检查后续是否含运算符/占位符（表达式绕过）──
  // LIMIT 后的任何 symbol token（, 除外）都说明是表达式
  for (const tok of meaningful) {
    if (tok.type === 'symbol' && tok.value !== ',') {
      throw new ReadonlyError(`LIMIT 不允许运算符 ${tok.value}（必须是纯整数）`);
    }
  }

  // ── 形式 1：LIMIT <count>（单个整数）──
  if (meaningful.length === 1) {
    if (firstVal > maxRows) throw new ReadonlyError(`LIMIT ${firstVal} 超过最大行数 ${maxRows}`);
    return { hasLimit: true, limitCount: firstVal };
  }

  // ── 形式 2：LIMIT <offset>, <count>（逗号分隔）──
  if (meaningful.length === 3 && meaningful[1].type === 'symbol' && meaningful[1].value === ',') {
    if (meaningful[2].type !== 'number') throw new ReadonlyError('LIMIT 偏移量/行数必须是纯整数');
    const countVal = Number(meaningful[2].value);
    if (!Number.isInteger(countVal) || countVal < 0) throw new ReadonlyError('LIMIT 行数必须是非负整数');
    if (countVal > maxRows) throw new ReadonlyError(`LIMIT ${countVal} 超过最大行数 ${maxRows}`);
    return { hasLimit: true, limitCount: countVal };
  }

  // ── 形式 3：LIMIT <count> OFFSET <offset>（关键字分隔）──
  if (meaningful.length === 3 && meaningful[1].type === 'word' && meaningful[1].value.toUpperCase() === 'OFFSET') {
    if (meaningful[2].type !== 'number') throw new ReadonlyError('LIMIT OFFSET 值必须是纯整数');
    const offsetVal = Number(meaningful[2].value);
    if (!Number.isInteger(offsetVal) || offsetVal < 0) throw new ReadonlyError('LIMIT OFFSET 必须是非负整数');
    // firstVal 是 count，offset 不影响返回行数
    if (firstVal > maxRows) throw new ReadonlyError(`LIMIT ${firstVal} 超过最大行数 ${maxRows}`);
    return { hasLimit: true, limitCount: firstVal };
  }

  // 不符合以上任何形式 → 拒绝
  throw new ReadonlyError('LIMIT 只允许：纯整数 / 整数,整数 / 整数 OFFSET 整数');
}

// ── 主校验入口 ──

/**
 * 对 SQL 做完整只读校验，返回处理后的 SQL 和元信息
 * 任何歧义都 throw，绝不放过
 *
 * @param {string} sql - 原始 SQL
 * @param {object} opts - { maxRows: number }
 * @returns {{ sql: string, kind: string, limitInjected: boolean }}
 */
function validateMysqlSql(sql, { maxRows } = {}) {
  if (!maxRows || maxRows < 1) maxRows = 200;

  const tokens = tokenizeMysql(sql);
  checkSingleStatement(tokens);

  const kind = classifyMysqlStatement(tokens);

  // 修复：SHOW/DESCRIBE 是元数据查询，其文本里合法包含 CREATE/PROCEDURE 等词
  // （如 SHOW CREATE TABLE），若走 checkForbiddenPatterns 会被禁止词表误杀。
  // 这两类语句全部为只读元数据查询，安全，提前返回跳过禁止词检查。
  if (kind === 'SHOW' || kind === 'DESCRIBE') {
    return { sql: sql.trimEnd(), kind, limitInjected: false };
  }

  // SELECT / WITH_SELECT / EXPLAIN 才做禁止关键字/危险函数检查
  checkForbiddenPatterns(tokens);

  // SELECT / WITH_SELECT / EXPLAIN 处理 LIMIT
  const limitInfo = analyzeTopLevelLimit(tokens, maxRows);

  if (limitInfo.hasLimit) {
    // analyzeTopLevelLimit 已校验 count ≤ maxRows，这里直接返回
    return { sql: sql.trimEnd(), kind, limitInjected: false };
  }

  // 无 LIMIT → 注入截断哨兵
  // 去掉尾部分号后追加 LIMIT (maxRows+1)，哨兵用于判断是否有截断
  let boundedSql = sql.trimEnd();
  if (boundedSql.endsWith(';')) {
    boundedSql = boundedSql.slice(0, -1).trimEnd();
  }
  boundedSql = boundedSql + ` LIMIT ${maxRows + 1}`;

  return { sql: boundedSql, kind, limitInjected: true };
}

// ── 自定义错误 ──

class ReadonlyError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ReadonlyError';
  }
}

module.exports = {
  tokenizeMysql,
  classifyMysqlStatement,
  validateMysqlSql,
  ReadonlyError,
};
