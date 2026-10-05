'use strict';

/**
 * MySQL read-only validation: finite-state lexer + statement classification + LIMIT injection
 * Security core: reject any ambiguity (fail-closed); prefer false positives over misses
 *
 * Design notes:
 * - The state machine handles semicolons/keywords/doubled quotes inside quotes correctly
 * - Reject backslash escapes (NO_BACKSLASH_ESCAPES ambiguity)
 * - Reject all comments (blocks keyword-splitting bypasses)
 * - Allow only a single statement, with at most one trailing semicolon
 * - Reject NUL characters, unclosed quotes, unbalanced parentheses, oversized SQL
 */

const MAX_SQL_LENGTH = 64 * 1024; // 64KiB, guards against oversized payloads

// ── Lexer ──

/** Lexer state enum */
const STATE = {
  NORMAL: 0,
  SINGLE_QUOTE: 1,  // '...'
  DOUBLE_QUOTE: 2,  // "..."
  BACKTICK: 3,       // `...`
};

/**
 * Run a finite-state lexical scan over the SQL and return a token array
 * Each token: { type, value, depth }
 * type: 'word' | 'quoted' | 'number' | 'symbol' | 'semicolon' | 'whitespace'
 * depth: parenthesis nesting depth (content inside quotes keeps the outer depth)
 *
 * @param {string} sql
 * @returns {Array<{type: string, value: string, depth: number}>}
 */
function tokenizeMysql(sql) {
  if (typeof sql !== 'string') throw new ReadonlyError('SQL must be a string');
  if (sql.length === 0) throw new ReadonlyError('SQL must not be empty');
  if (sql.length > MAX_SQL_LENGTH) throw new ReadonlyError(`SQL too long (${sql.length} > ${MAX_SQL_LENGTH})`);

  // NUL bytes can truncate at the underlying C layer; always reject
  if (sql.includes('\0')) throw new ReadonlyError('SQL contains a NUL character');

  const tokens = [];
  let state = STATE.NORMAL;
  let parenDepth = 0;    // current parenthesis depth
  let i = 0;
  let wordBuf = '';       // accumulate unquoted identifier
  let numBuf = '';        // accumulate number

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
      // ── Comment detection (comments are unnecessary for query verification;
      // conservatively reject to block keyword-splitting bypasses) ──
      if (ch === '#') {
        throw new ReadonlyError('# comments are not allowed (prevents keyword-splitting bypasses)');
      }
      if (ch === '-' && i + 1 < sql.length && sql[i + 1] === '-') {
        // -- comment: the legal form is `-- ` (dashes + space), but reject regardless of the space
        throw new ReadonlyError('-- comments are not allowed (prevents keyword-splitting bypasses)');
      }
      if (ch === '/' && i + 1 < sql.length && sql[i + 1] === '*') {
        const nextCh = i + 2 < sql.length ? sql[i + 2] : '';
        if (nextCh === '!' || nextCh === '+') {
          throw new ReadonlyError(`/*${nextCh} ${nextCh === '!' ? 'version comment' : 'optimizer hint'} is not allowed (may contain executable code)`);
        }
        throw new ReadonlyError('/* */ block comments are not allowed (prevents keyword-splitting bypasses)');
      }

      // ── Quote state transitions ──
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

      // ── Parenthesis depth tracking ──
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
        if (parenDepth <= 0) throw new ReadonlyError('Unbalanced parentheses: extra )');
        emit('symbol', ')', parenDepth);
        parenDepth--;
        i++;
        continue;
      }

      // ── Semicolon ──
      if (ch === ';') {
        flushWord(parenDepth);
        flushNum(parenDepth);
        emit('semicolon', ';', parenDepth);
        i++;
        continue;
      }

      // ── Punctuation/symbols ──
      if (isSymbolChar(ch)) {
        // Detect the := assignment operator
        if (ch === ':' && i + 1 < sql.length && sql[i + 1] === '=') {
          throw new ReadonlyError(':= assignment operator is not allowed');
        }
        flushWord(parenDepth);
        flushNum(parenDepth);
        emit('symbol', ch, parenDepth);
        i++;
        continue;
      }

      // ── Whitespace ──
      if (/\s/.test(ch)) {
        flushWord(parenDepth);
        flushNum(parenDepth);
        i++;
        continue;
      }

      // ── Numbers ──
      if (/\d/.test(ch)) {
        flushWord(parenDepth);
        numBuf += ch;
        i++;
        continue;
      }

      // ── Identifiers/keywords (letters, underscore, $) ──
      if (/[a-zA-Z_$]/.test(ch)) {
        flushNum(parenDepth);
        wordBuf += ch;
        i++;
        continue;
      }

      // ── Unknown character ──
      throw new ReadonlyError(`SQL contains an unrecognized character: ${JSON.stringify(ch)} (position ${i})`);
    }

    // ── Single-quote state ──
    if (state === STATE.SINGLE_QUOTE) {
      if (ch === '\\') {
        // Backslash escapes mean something different under NO_BACKSLASH_ESCAPES,
        // and can split keywords to bypass detection; always reject
        throw new ReadonlyError("Backslash escapes are not allowed; use standard quote doubling ('') instead");
      }
      if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
        // Standard doubled-quote escape: '' is a literal single quote
        i += 2;
        continue;
      }
      if (ch === "'") {
        // Quote closes
        emit('quoted', "'", parenDepth);
        state = STATE.NORMAL;
        i++;
        continue;
      }
      // Quoted content is not recorded char by char; only the quote boundary token is kept
      i++;
      continue;
    }

    // ── Double-quote state ──
    if (state === STATE.DOUBLE_QUOTE) {
      if (ch === '\\') {
        throw new ReadonlyError('Backslash escapes are not allowed; use standard quote doubling ("") instead');
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

    // ── Backtick state ──
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

  // ── End-of-scan checks ──
  flushWord(parenDepth);
  flushNum(parenDepth);

  if (state !== STATE.NORMAL) {
    const stateName = state === STATE.SINGLE_QUOTE ? 'single quote' : state === STATE.DOUBLE_QUOTE ? 'double quote' : 'backtick';
    throw new ReadonlyError(`Unclosed ${stateName}`);
  }
  if (parenDepth !== 0) {
    throw new ReadonlyError(`Unbalanced parentheses: missing ${parenDepth} )`);
  }

  return tokens;
}

/** Check whether a character is SQL punctuation (not letter, digit, whitespace, quote, semicolon, or parenthesis) */
function isSymbolChar(ch) {
  return /[+\-*/%=<>!&|^~,.\:@]/.test(ch);
}

// ── Statement classification ──

/**
 * Classify the root statement from tokens
 * Only SELECT / WITH...SELECT / SHOW / DESCRIBE / EXPLAIN are allowed
 * @param {Array} tokens - tokenizeMysql return value
 * @returns {string} 'SELECT' | 'WITH_SELECT' | 'SHOW' | 'DESCRIBE' | 'EXPLAIN'
 */
function classifyMysqlStatement(tokens) {
  if (tokens.length === 0) throw new ReadonlyError('No valid tokens');

  // Find the first word token at depth=0 (leading whitespace is skipped; comments were rejected)
  let firstWord = null;
  let firstWordIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'word' && tokens[i].depth === 0) {
      firstWord = tokens[i].value.toUpperCase();
      firstWordIdx = i;
      break;
    }
  }

  if (!firstWord) throw new ReadonlyError('No root statement keyword found');

  switch (firstWord) {
    case 'SELECT':
      return 'SELECT';

    case 'WITH': {
      // CTE: the root query after WITH must be SELECT (reject WITH ... DELETE/UPDATE)
      // Strategy: scan word tokens at depth=0 for statement keywords; the first must be SELECT
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
            throw new ReadonlyError(`Root statement after a WITH CTE must be SELECT, found: ${w}`);
          }
          break;
        }
      }
      if (!foundSelect) {
        throw new ReadonlyError('No root SELECT query found after WITH');
      }
      return 'WITH_SELECT';
    }

    case 'SHOW':
      return 'SHOW';

    case 'DESCRIBE':
    case 'DESC':
      return 'DESCRIBE';

    case 'EXPLAIN': {
      // Only EXPLAIN [FORMAT=...] SELECT/WITH is allowed
      // Reject EXPLAIN ANALYZE (it actually executes the statement and causes
      // writes/locks) and EXPLAIN DML
      // Fix: the old implementation looked only at the first word after
      // EXPLAIN, misjudged FORMAT as illegal, and rejected valid
      // EXPLAIN FORMAT=JSON SELECT. Collect all following words instead.
      const wordsAfterExplain = [];
      for (let i = firstWordIdx + 1; i < tokens.length; i++) {
        if (tokens[i].type === 'word' && tokens[i].depth === 0) {
          wordsAfterExplain.push(tokens[i].value.toUpperCase());
        }
      }
      if (wordsAfterExplain.length === 0) {
        // No SELECT/WITH after EXPLAIN (e.g. legacy EXPLAIN tbl_name); unsupported
        throw new ReadonlyError('EXPLAIN must be followed by SELECT or WITH');
      }
      const explainFirst = wordsAfterExplain[0];
      if (explainFirst === 'ANALYZE') {
        throw new ReadonlyError('EXPLAIN ANALYZE is not allowed (it actually executes the statement)');
      }
      if (explainFirst === 'FORMAT') {
        // EXPLAIN FORMAT=JSON/TRADITIONAL/TREE/WIDTH SELECT ... 
        // (= is a non-word token and was skipped; wordsAfterExplain looks like [FORMAT, JSON, SELECT, ...])
        const EXPLAIN_FORMATS = new Set(['JSON', 'TRADITIONAL', 'TREE', 'WIDTH']);
        if (wordsAfterExplain.length < 2) {
          throw new ReadonlyError('EXPLAIN FORMAT= requires a format name (JSON/TRADITIONAL/TREE/WIDTH)');
        }
        const fmtName = wordsAfterExplain[1];
        if (!EXPLAIN_FORMATS.has(fmtName)) {
          throw new ReadonlyError(`EXPLAIN FORMAT= unsupported format name: ${fmtName}`);
        }
        // SELECT/WITH must immediately follow the format name
        let stmtWord = null;
        for (let k = 2; k < wordsAfterExplain.length; k++) {
          if (wordsAfterExplain[k] === 'SELECT' || wordsAfterExplain[k] === 'WITH') {
            stmtWord = wordsAfterExplain[k];
            break;
          }
        }
        if (!stmtWord) {
          throw new ReadonlyError('EXPLAIN FORMAT=... must be followed by SELECT or WITH');
        }
        return 'EXPLAIN';
      }
      if (explainFirst !== 'SELECT' && explainFirst !== 'WITH') {
        throw new ReadonlyError(`EXPLAIN ${explainFirst} is not allowed (only EXPLAIN [FORMAT=...] SELECT/WITH is allowed)`);
      }
      return 'EXPLAIN';
    }

    default:
      throw new ReadonlyError(`Statement type not allowed: ${firstWord}`);
  }
}

// ── Dangerous keyword/pattern detection ──

/** Keywords rejected when found in unquoted word tokens */
const FORBIDDEN_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE',
  'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'CALL', 'DO', 'LOAD',
  'INSTALL', 'UNINSTALL', 'LOCK', 'UNLOCK', 'SET', 'RESET', 'PURGE',
  'KILL', 'OPTIMIZE', 'REPAIR', 'ANALYZE', 'CHECK', 'USE',
  'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'XA',
  'PREPARE', 'EXECUTE', 'DEALLOCATE',
]);

/** Pattern keywords that need special detection */
const INTO_FORBIDDEN = 'INTO';
const FOR_UPDATE_PATTERN = ['FOR', 'UPDATE'];
const LOCK_SHARE_PATTERN = ['LOCK', 'IN', 'SHARE', 'MODE'];

/** Dangerous function names */
const DANGEROUS_FUNCTIONS = new Set([
  'SLEEP', 'BENCHMARK', 'GET_LOCK', 'RELEASE_LOCK',
  'IS_FREE_LOCK', 'IS_USED_LOCK', 'LOAD_FILE', 'MASTER_POS_WAIT',
]);

/**
 * Check the token stream for forbidden keywords/patterns
 * Reject any write keyword appearing inside SELECT/WITH
 */
function checkForbiddenPatterns(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'word') continue;

    const upper = tok.value.toUpperCase();

    // Dangerous function detection (rejected even inside subqueries)
    if (DANGEROUS_FUNCTIONS.has(upper)) {
      throw new ReadonlyError(`Dangerous function not allowed: ${upper}`);
    }

    // INTO can appear in various legal positions (SELECT INTO is uncommon but exists),
    // but SELECT INTO OUTFILE/DUMPFILE writes files — too risky, reject unconditionally
    if (upper === INTO_FORBIDDEN) {
      // Check whether OUTFILE/DUMPFILE or a variable-assignment pattern follows
      for (let j = i + 1; j < tokens.length && j < i + 4; j++) {
        const next = tokens[j];
        if (next.type !== 'word') continue;
        const nextUpper = next.value.toUpperCase();
        if (nextUpper === 'OUTFILE' || nextUpper === 'DUMPFILE' || nextUpper === '@') {
          throw new ReadonlyError(`INTO ${nextUpper} is not allowed (data exfiltration risk)`);
        }
      }
      // Conservative policy: reject INTO even outside OUTFILE/DUMPFILE
      // because INTO can also assign variables and indirectly cause writes
      throw new ReadonlyError('INTO is not allowed (covers OUTFILE/DUMPFILE/variable assignment)');
    }

    // FOR UPDATE lock detection
    if (upper === 'FOR' && tok.depth === 0) {
      const subsequent = getSubsequentRootWords(tokens, i);
      if (subsequent.length >= 1 && subsequent[0] === 'UPDATE') {
        throw new ReadonlyError('FOR UPDATE is not allowed (exclusive lock)');
      }
      if (subsequent.length >= 3 &&
          subsequent[0] === 'LOCK' && subsequent[1] === 'IN' && subsequent[2] === 'SHARE' && subsequent[3] === 'MODE') {
        throw new ReadonlyError('LOCK IN SHARE MODE is not allowed (shared lock)');
      }
    }

    // Forbidden keywords (inside SELECT/WITH)
    if (FORBIDDEN_WORDS.has(upper)) {
      throw new ReadonlyError(`Not allowed in read-only queries: ${upper}`);
    }
  }
}

/** Collect consecutive depth=0 word tokens after tokens[i] (skip whitespace/non-word) */
function getSubsequentRootWords(tokens, startIdx) {
  const result = [];
  for (let j = startIdx + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok.type === 'whitespace' || tok.type === 'symbol') continue;
    if (tok.type === 'word' && tok.depth === 0) {
      result.push(tok.value.toUpperCase());
    }
    if (result.length >= 4) break; // only the first few are needed
  }
  return result;
}

// ── Single-statement check ──

/**
 * Verify the SQL contains a single statement with at most one trailing semicolon
 * @param {Array} tokens
 */
function checkSingleStatement(tokens) {
  let semicolons = 0;
  for (const tok of tokens) {
    if (tok.type === 'semicolon') {
      semicolons++;
      // A semicolon must sit at depth=0 (not inside parentheses/subqueries)
      if (tok.depth !== 0) {
        throw new ReadonlyError('Semicolons inside parentheses are not allowed');
      }
    }
  }
  if (semicolons > 1) {
    throw new ReadonlyError(`Only a single statement is allowed; found ${semicolons} semicolons`);
  }
  // If there is a semicolon, it must be the last token
  if (semicolons === 1) {
    const last = tokens[tokens.length - 1];
    if (last.type !== 'semicolon') {
      throw new ReadonlyError('A semicolon is allowed only at the end of the SQL');
    }
  }
}

// ── LIMIT handling ──

/**
 * Analyze the depth=0 LIMIT clause, strictly allowing only three forms:
 *   LIMIT <single non-negative integer>
 *   LIMIT <non-negative integer> OFFSET <non-negative integer>
 *   LIMIT <non-negative integer>, <non-negative integer>  (MySQL legacy offset,count)
 * Any expression, variable, or operator → reject (prevents bypassing maxRows)
 *
 * @param {Array} tokens - tokenizeMysql return value
 * @param {number} maxRows - maximum allowed row count
 * @returns {{ hasLimit: boolean, limitCount: number }}
 */
function analyzeTopLevelLimit(tokens, maxRows) {
  // Locate the last LIMIT keyword at depth=0 (LIMITs inside subqueries sit at
  // depth>0 and are excluded naturally)
  let lastLimitIdx = -1;
  let foundSelect = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.depth > 0) continue;
    if (tok.type === 'word') {
      const upper = tok.value.toUpperCase();
      // A top-level SELECT/UNION keyword means a new query segment
      if (upper === 'SELECT' || upper === 'UNION') foundSelect = true;
    }
    if (tok.type === 'word' && tok.value.toUpperCase() === 'LIMIT' && tok.depth === 0 && foundSelect) {
      lastLimitIdx = i;
    }
  }
  if (lastLimitIdx === -1) return { hasLimit: false };

  // Collect depth=0 tokens after LIMIT (until end of statement or the next
  // top-level keyword)
  const limitTokens = [];
  for (let i = lastLimitIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.depth > 0) continue;
    // A top-level UNION keyword means the LIMIT belongs to the previous
    // segment; stop collecting
    if (tok.type === 'word' && tok.value.toUpperCase() === 'UNION') break;
    limitTokens.push(tok);
  }

  // Parse the token sequence after LIMIT; only the three forms are allowed
  return parseLimitClause(limitTokens, maxRows);
}

/**
 * Parse the LIMIT clause token sequence, strictly validating the form and count ≤ maxRows
 * @param {Array} limitTokens - depth=0 tokens after the LIMIT keyword
 * @param {number} maxRows
 * @returns {{ hasLimit: boolean, limitCount: number }}
 */
function parseLimitClause(limitTokens, maxRows) {
  // Drop whitespace; keep only meaningful tokens
  const meaningful = limitTokens.filter(t => t.type !== 'whitespace');

  if (meaningful.length === 0) throw new ReadonlyError('LIMIT is missing its arguments');

  // Must start with a number
  const first = meaningful[0];
  if (first.type !== 'number') throw new ReadonlyError('LIMIT arguments must be plain integers (expressions or variables are not accepted)');
  const firstVal = Number(first.value);
  if (!Number.isInteger(firstVal) || firstVal < 0) throw new ReadonlyError('LIMIT must be a non-negative integer');

  // ── Check the remainder for operators/placeholders (expression bypass) ──
  // Any symbol token after LIMIT (except ,) implies an expression
  for (const tok of meaningful) {
    if (tok.type === 'symbol' && tok.value !== ',') {
      throw new ReadonlyError(`LIMIT does not allow operator ${tok.value} (plain integers only)`);
    }
  }

  // ── Form 1: LIMIT <count> (single integer) ──
  if (meaningful.length === 1) {
    if (firstVal > maxRows) throw new ReadonlyError(`LIMIT ${firstVal} exceeds the maximum row count ${maxRows}`);
    return { hasLimit: true, limitCount: firstVal };
  }

  // ── Form 2: LIMIT <offset>, <count> (comma-separated) ──
  if (meaningful.length === 3 && meaningful[1].type === 'symbol' && meaningful[1].value === ',') {
    if (meaningful[2].type !== 'number') throw new ReadonlyError('LIMIT offset/count must be plain integers');
    const countVal = Number(meaningful[2].value);
    if (!Number.isInteger(countVal) || countVal < 0) throw new ReadonlyError('LIMIT count must be a non-negative integer');
    if (countVal > maxRows) throw new ReadonlyError(`LIMIT ${countVal} exceeds the maximum row count ${maxRows}`);
    return { hasLimit: true, limitCount: countVal };
  }

  // ── Form 3: LIMIT <count> OFFSET <offset> (keyword-separated) ──
  if (meaningful.length === 3 && meaningful[1].type === 'word' && meaningful[1].value.toUpperCase() === 'OFFSET') {
    if (meaningful[2].type !== 'number') throw new ReadonlyError('LIMIT OFFSET value must be a plain integer');
    const offsetVal = Number(meaningful[2].value);
    if (!Number.isInteger(offsetVal) || offsetVal < 0) throw new ReadonlyError('LIMIT OFFSET must be a non-negative integer');
    // firstVal is the count; the offset does not affect the returned row count
    if (firstVal > maxRows) throw new ReadonlyError(`LIMIT ${firstVal} exceeds the maximum row count ${maxRows}`);
    return { hasLimit: true, limitCount: firstVal };
  }

  // None of the allowed forms → reject
  throw new ReadonlyError('LIMIT only allows: plain integer / integer,integer / integer OFFSET integer');
}

// ── Main validation entry ──

/**
 * Fully validate the SQL as read-only and return the processed SQL plus metadata
 * Throw on any ambiguity; never let it pass
 *
 * @param {string} sql - raw SQL
 * @param {object} opts - { maxRows: number }
 * @returns {{ sql: string, kind: string, limitInjected: boolean }}
 */
function validateMysqlSql(sql, { maxRows } = {}) {
  if (!maxRows || maxRows < 1) maxRows = 200;

  const tokens = tokenizeMysql(sql);
  checkSingleStatement(tokens);

  const kind = classifyMysqlStatement(tokens);

  // Fix: SHOW/DESCRIBE are metadata queries whose text legally contains words
  // like CREATE/PROCEDURE (e.g. SHOW CREATE TABLE); running
  // checkForbiddenPatterns would false-positive on the forbidden-word list.
  // Both statement kinds are read-only metadata queries and safe, so return
  // early and skip the forbidden-word check.
  if (kind === 'SHOW' || kind === 'DESCRIBE') {
    return { sql: sql.trimEnd(), kind, limitInjected: false };
  }

  // Only SELECT / WITH_SELECT / EXPLAIN get the forbidden-keyword/dangerous-function check
  checkForbiddenPatterns(tokens);

  // LIMIT handling for SELECT / WITH_SELECT / EXPLAIN
  const limitInfo = analyzeTopLevelLimit(tokens, maxRows);

  if (limitInfo.hasLimit) {
    // analyzeTopLevelLimit already verified count ≤ maxRows; return directly
    return { sql: sql.trimEnd(), kind, limitInjected: false };
  }

  // No LIMIT → inject a truncation sentinel
  // Strip the trailing semicolon and append LIMIT (maxRows+1); the sentinel
  // detects truncation
  let boundedSql = sql.trimEnd();
  if (boundedSql.endsWith(';')) {
    boundedSql = boundedSql.slice(0, -1).trimEnd();
  }
  boundedSql = boundedSql + ` LIMIT ${maxRows + 1}`;

  return { sql: boundedSql, kind, limitInjected: true };
}

// ── Custom error ──

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
