---
name: db-query
description: Read-only MySQL/Redis queries via built-in scripts — verify table records, cache keys/fields/TTL, and cross-store consistency. Trigger when the user asks to check or verify database data, including "run this SQL", "check the table", or any MySQL/Redis look-up. If the access address or credentials are unknown, stop and ask the user first; never search for them yourself. Refuse all writes, deletes, DDL, or TTL changes.
compatibility: Node.js 18+, npm, MySQL 5.7.8+/8.0, Redis 5+; dedicated read-only account required for shared/production environments
---

<!-- [2026-09-05]-[full English rewrite; top rule: unknown DB access info → stop and ask, never hunt/guess]-[blocks blind or self-sourced connections] -->
<!-- [2026-09-16]-[broaden the trigger sentence: run-this-SQL / check-the-table phrasings now match too]-[natural trigger rate rises alongside the [DB] hint surfaces] -->
<!-- [2026-10-01]-[Language section: honor a [SWITCHMAN:LANG] system-prompt line over the English default]-[aligns with the host-side language-preference layer] -->
# Database Query & Verification

Safely query MySQL and Redis via built-in read-only scripts for debugging, data verification, and cache inspection.
**Core red line: this skill is read-only; every write operation is refused.**

## Trigger guide

| Scenario | Trigger? | Notes |
|------|----------|------|
| Query MySQL records / verify field values | ✅ | Read-only verification |
| Query Redis keys/values/TTL/fields | ✅ | Read-only verification |
| Verify MySQL ↔ Redis consistency | ✅ | Read both sides, then compare |
| Inspect table structure, indexes, execution plans | ✅ | SHOW / DESCRIBE / EXPLAIN |
| Count rows, aggregate analysis | ✅ | SELECT COUNT/SUM etc. |
| Insert/update/delete records | ❌ | Refuse; suggest a read-only verification plan |
| Create/alter/migrate tables | ❌ | Refuse; out of scope |
| Change Redis TTL | ❌ | Refuse; EXPIRE is a write command |
| Flush cache / delete keys | ❌ | Refuse; offer a read-only inspection instead |
| Export data to files | ❌ | Refuse (INTO OUTFILE is blocked); query and let the user handle results |

## Mandatory read-only rules

> **Highest priority.** Violating any item counts as a security violation.

1. **Missing access info → stop and ask**: if the database address or credentials are unknown, stop immediately and ask the user. Never search config files/history on your own, guess, or probe hosts/ports. Without explicit access info, refuse to act rather than act blindly.
2. **Built-in scripts only**: queries must go through `scripts/mysql-query.js` or `scripts/redis-query.js`; no fallback to `mysql` / `redis-cli` or ad-hoc code.
3. **Never bypass the validator**: do not circumvent SQL/command safety checks by any means other than `--validate-only`.
4. **Refuse all write requests**: on any write/modify/delete/DDL request, tell the user "this skill supports read-only verification only" and proactively offer a read-only alternative (e.g. "I can query the current value and status; you apply the change after confirming").
5. **Confirm non-local targets first**: before connecting to any database other than `127.0.0.1` / `localhost`, confirm the target address and purpose with the user.
6. **Read-only account in production**: production or shared environments must use a dedicated read-only MySQL account and Redis ACL user; see [references/security.md](references/security.md).

## Environment setup

Script dependencies are installed **inside the skill directory** — the `skills/db-query` folder of the dsh-switchman bundle (reported as this skill's base directory), so they never touch your project. After the bundle is updated (e.g. its checkout is pulled or reinstalled), re-run the setup once.
Before first use, run:

```bash
# from the skill root
bash scripts/setup.sh
```

This checks Node.js 18+, installs `mysql2`, `redis` (node-redis v4), `dotenv` into the skill directory, and runs the built-in tests.

## Connection config & password safety

### Precedence

**CLI options > explicit `--env-file` > process env vars > defaults**

`--max-value-bytes` shares the env var `DB_QUERY_MAX_VALUE_BYTES` (common to MySQL/Redis).

### MySQL env vars

| CLI option | Env var | Default | Notes |
|----------|----------|--------|------|
| `--host` | `DB_QUERY_MYSQL_HOST` | `127.0.0.1` | Host |
| `--port` | `DB_QUERY_MYSQL_PORT` | `3306` | Port |
| `--user` | `DB_QUERY_MYSQL_USER` | **(required)** | Username; no root default |
| `--password` | `DB_QUERY_MYSQL_PASSWORD` | empty | Password; prefer env vars |
| `--database` | `DB_QUERY_MYSQL_DATABASE` | empty | Database name; if empty, only queries without a default db work (`SHOW DATABASES`, `SELECT 1`, db-prefixed tables) |
| `--tls` | `DB_QUERY_MYSQL_TLS` | `false` | Enable TLS |
| `--ca-file` | `DB_QUERY_MYSQL_CA_FILE` | — | CA certificate path |
| `--connect-timeout-ms` | `DB_QUERY_MYSQL_CONNECT_TIMEOUT_MS` | `5000` | Connect timeout (max 30000) |
| `--timeout-ms` | `DB_QUERY_MYSQL_TIMEOUT_MS` | `10000` | Query timeout (max 60000) |
| `--max-rows` | `DB_QUERY_MYSQL_MAX_ROWS` | `200` | Max rows returned (max 5000) |
| `--max-value-bytes` | `DB_QUERY_MAX_VALUE_BYTES` | `4096` | Max bytes per field value |
| `--format` | `DB_QUERY_MYSQL_FORMAT` | `table` | Output format: `table` / `json` |

### Redis env vars

| CLI option | Env var | Default | Notes |
|----------|----------|--------|------|
| `--host` | `DB_QUERY_REDIS_HOST` | `127.0.0.1` | Host |
| `--port` | `DB_QUERY_REDIS_PORT` | `6379` | Port |
| `--user` | `DB_QUERY_REDIS_USER` | `default` | Username |
| `--password` | `DB_QUERY_REDIS_PASSWORD` | empty | Password; prefer env vars |
| `--db` | `DB_QUERY_REDIS_DB` | `0` | Database number (connect option only; SELECT command is not exposed) |
| `--tls` | `DB_QUERY_REDIS_TLS` | `false` | Enable TLS |
| `--ca-file` | `DB_QUERY_REDIS_CA_FILE` | — | CA certificate path |
| `--connect-timeout-ms` | `DB_QUERY_REDIS_CONNECT_TIMEOUT_MS` | `5000` | Connect timeout (max 30000) |
| `--timeout-ms` | `DB_QUERY_REDIS_TIMEOUT_MS` | `10000` | Command timeout (max 60000) |
| `--max-items` | `DB_QUERY_REDIS_MAX_ITEMS` | `200` | Max items returned (max 5000) |
| `--max-value-bytes` | `DB_QUERY_MAX_VALUE_BYTES` | `4096` | Max bytes per value |
| `--format` | `DB_QUERY_REDIS_FORMAT` | `table` | Output format: `table` / `json` |

### Password safety

```bash
# ❌ Don't do this (password lands in shell history)
./scripts/mysql-query.js --user=admin --password=secret --database=mydb 'SELECT 1'

# ✅ Recommended: env var
export DB_QUERY_MYSQL_PASSWORD=secret
./scripts/mysql-query.js --user=admin --database=mydb 'SELECT 1'

# ✅ Recommended: env file (0600 permissions)
./scripts/mysql-query.js --env-file=~/.db-query.env --user=admin --database=mydb 'SELECT 1'

# ✅ Recommended: same for Redis
export DB_QUERY_REDIS_PASSWORD=secret
./scripts/redis-query.js --db=0 -- GET user:42
```

## Standard workflow

1. **Confirm target and verification goal**: what to query (which table, fields, key) and why (bug investigation, deployment check, consistency). If the access address or credentials are unknown, stop and ask the user; never hunt for them yourself.
2. **Write the narrowest query**: prefer primary-key lookups over full scans; add time ranges and LIMIT where possible.
3. **Offline validation**: validate SQL/command syntax with `--validate-only` first to confirm it passes safety checks.
4. **Confirm non-local targets**: any non-local database must be confirmed with the user first.
5. **Execute**: run the script and read the output.
6. **Check truncation/timeouts**: if results are truncated (`[TRUNCATED]` marker) or time out, refine the query and re-run.
7. **Summarize findings and uncertainties**: state conclusions and clearly flag uncertainties (e.g. time-window inconsistencies, possible misses from truncation).

## MySQL query guide

### Invocation

```bash
./scripts/mysql-query.js [connection options] 'SELECT ...'
./scripts/mysql-query.js [connection options] --file=/abs/path.sql
./scripts/mysql-query.js --validate-only 'SELECT ...'
```

### Allowed statements

| Type | Example |
|------|------|
| `SELECT` | `SELECT id, name FROM users WHERE id = 42` |
| `WITH...SELECT` (CTE) | `WITH cte AS (SELECT ...) SELECT * FROM cte` |
| `SHOW` | `SHOW TABLES`, `SHOW CREATE TABLE users` |
| `DESCRIBE` / `DESC` | `DESCRIBE users` |
| `EXPLAIN SELECT` | `EXPLAIN SELECT * FROM users WHERE id = 42` |

> Note: `EXPLAIN ANALYZE` is **not supported** (security trade-off).

### LIMIT & timeout rules

- Without `LIMIT` in the SQL, the script **auto-injects** a top-level `LIMIT` (default 200, adjustable via `--max-rows`, max 5000).
- With `LIMIT` present, only **plain integers** are accepted (`LIMIT ?`, `LIMIT @a`, `LIMIT 1+1` and other expressions/placeholders/variables are rejected), and the count is checked against `--max-rows`; `LIMIT offset, count` and `LIMIT n OFFSET m` validate the count part.
- Query timeout defaults to 10000ms (adjustable via `--timeout-ms`, max 60000ms).

### Practical read-only examples

```bash
# Connectivity test
./scripts/mysql-query.js --user=reader --database=mydb 'SELECT 1'

# Single record by primary key
./scripts/mysql-query.js --user=reader --database=mydb \
  'SELECT id, username, status, created_at FROM users WHERE id = 42'

# Recent records by time range
./scripts/mysql-query.js --user=reader --database=mydb --max-rows=50 \
  "SELECT id, status, updated_at FROM orders WHERE created_at >= '2024-01-01' ORDER BY created_at DESC"

# Aggregate counts
./scripts/mysql-query.js --user=reader --database=mydb \
  'SELECT status, COUNT(*) AS cnt FROM users GROUP BY status'

# Table structure
./scripts/mysql-query.js --user=reader --database=mydb 'DESCRIBE users'

# Execution plan
./scripts/mysql-query.js --user=reader --database=mydb \
  'EXPLAIN SELECT * FROM orders WHERE user_id = 100'
```

## Redis query guide

### Invocation

Use `--` to separate connection options from the Redis command:

```bash
./scripts/redis-query.js [connection options] -- <command> [args...]
./scripts/redis-query.js --validate-only -- <command> [args...]
```

### Whitelist by category

| Category | Commands |
|------|------|
| **General** | PING, EXISTS, TYPE, TTL, PTTL, SCAN, KEYS†, DBSIZE, TIME |
| **String** | GET, MGET, STRLEN |
| **Hash** | HGET, HMGET, HEXISTS, HLEN, HGETALL†, HKEYS†, HVALS†, HSCAN |
| **List** | LINDEX, LLEN, LRANGE |
| **Set** | SISMEMBER, SCARD, SMEMBERS†, SSCAN |
| **ZSet** | ZCARD, ZCOUNT, ZSCORE, ZRANK, ZREVRANK, ZRANGE, ZRANGEBYSCORE, ZSCAN |
| **Server info** | INFO, CLIENT LIST, CONFIG GET† |

> † Requires `--allow-unbounded` (in production prefer SCAN over KEYS/HGETALL and other full-key commands).

### TYPE/TTL first, then query by type

```bash
# Step 1: confirm the key exists and check its type
./scripts/redis-query.js -- TTL user:42
./scripts/redis-query.js -- TYPE user:42

# Step 2: pick the command by type
# if it's a hash
./scripts/redis-query.js -- HGET user:42 name
./scripts/redis-query.js -- HGETALL user:42          # full dump (needs --allow-unbounded)
./scripts/redis-query.js -- HSCAN user:42 0 COUNT 100  # safe batching

# if it's a string
./scripts/redis-query.js -- GET user:42
```

### Safe per-type examples

```bash
# Connectivity test
./scripts/redis-query.js -- PING

# String: batch-check keys
./scripts/redis-query.js -- MGET config:timeout config:max-retry

# Hash: batched scan
./scripts/redis-query.js -- HSCAN session:abc123 0 COUNT 50

# List: head/tail of a queue
./scripts/redis-query.js -- LRANGE task:queue 0 9
./scripts/redis-query.js -- LLEN task:queue

# Set: membership check
./scripts/redis-query.js -- SISMEMBER online:users user:42
./scripts/redis-query.js -- SCARD online:users

# ZSet: score range
./scripts/redis-query.js -- ZRANGEBYSCORE leaderboard 100 999 WITHSCORES
./scripts/redis-query.js -- ZRANK leaderboard user:42

# TTL check
./scripts/redis-query.js -- TTL cache:homepage
# -1 = no expiry, -2 = key missing, >= 0 = seconds remaining
```

## Cross MySQL/Redis verification

Recommended steps for consistency checks:

1. **Get business keys from MySQL**: query the key set to verify first.
2. **Targeted Redis lookups**: check Redis per key (or batched); avoid `KEYS *` on the whole db.
3. **Compare differences**: compare values and TTL field by field.

```bash
# Step 1: recently updated user IDs from MySQL
./scripts/mysql-query.js --user=reader --database=mydb --max-rows=20 \
  "SELECT id, username, updated_at FROM users WHERE updated_at > '2024-06-01'"

# Step 2: verify each in Redis
./scripts/redis-query.js -- GET user:1001
./scripts/redis-query.js -- TTL user:1001
./scripts/redis-query.js -- TYPE user:1001
```

> ⚠️ **Time-window warning**: data may change between the two reads; you **cannot claim transactional consistency**. Always state "checked at <time>; concurrent changes possible in between" in conclusions.

## Output & error handling

### Output format

Controlled by `--format`:

| Format | Notes |
|------|------|
| `table` | Table output, human-readable |
| `json` | JSON output, machine-readable |

### Type conversion

- Date fields output as strings (`dateStrings` mode); no JS Date conversion.
- BIGINT / DECIMAL output as strings to avoid precision loss.
- JSON fields output as formatted strings.
- Buffer / binary fields rendered as base64 or hex strings.

### Truncation markers

- Field values exceeding `--max-value-bytes` (default 4096) are marked `[TRUNCATED]`.
- Row counts exceeding `--max-rows` (MySQL) / `--max-items` (Redis) truncate the result set with a trailing notice.
- On truncation, refine the query and re-run; **never draw conclusions from truncated results**.

### Error output

Errors are classified by code with sanitized messages, so failures are easy to tell apart:

- **Connection failure [code]: message** — connection/auth/handshake errors (`ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, `WRONGPASS`, etc.) — couldn't connect.
- **Query execution error [code]: message** — SQL/command execution errors (`ER_BAD_FIELD_ERROR`(1054), `ER_PARSE_ERROR`, `WRONGTYPE`, etc.) — connected, but the SQL/command itself is wrong (bad column name, type mismatch, etc.).
- Messages are first-line only and truncated (≤200 chars), inline credentials masked (`://user:pass@host` → `://user:***@host`); passwords from connection strings or full stacks are never echoed.
- SQL/command validation failures print the concrete rejection reason (e.g. "contains comments", "contains a write operation").

> **"Connection failure" → investigate network/credentials; "query execution error" → fix the SQL/command from the message, don't chase connection issues.**

## Post-run self-check

After every execution, verify:

- [ ] **Read-only**: SQL is SELECT/SHOW/DESCRIBE/EXPLAIN; Redis command is whitelisted.
- [ ] **Right target**: connected to the intended db/instance, not production (unless explicitly confirmed).
- [ ] **No truncation**: results not truncated (`[TRUNCATED]` marker); re-query if they were.
- [ ] **Conclusions hold**: results actually support the claim; flag any uncertainties.
- [ ] **Sensitive data**: mask as needed when reporting (phone numbers, password hashes, etc.).

## Language

English by default; use the project's configured language when a `[SWITCHMAN:LANG]` line in the system prompt specifies one, or when the user explicitly requests it.

## References

- [references/security.md](references/security.md) — read-only security model in depth
- [references/mysql.md](references/mysql.md) — MySQL syntax matrix & query recipes
- [references/redis.md](references/redis.md) — Redis command whitelist & query patterns
