<!-- [2026-09-05]-[translated to English (skill is now English-only)]-[content unchanged] -->
# Read-Only Security Model

Security core of this skill: **three layers of defense guarantee read-only; any write operation is intercepted before it reaches the database**.
Application-layer interception cannot replace database privileges, though — production must use a dedicated read-only account.

## Threat model & attack surface

### Who can trigger this skill

- A user asking (via conversation) to query the database → the agent invokes the script
- A user unintentionally or deliberately passing SQL/commands containing writes

### Attack surface

1. **SQL injection**: achieving writes via SQL syntax (nested comments, newlines inside strings, etc.)
2. **Dangerous functions**: calling `SLEEP()`, `BENCHMARK()`, `GET_LOCK()` etc. through a legal SELECT (DoS)
3. **Multi-statement injection**: concatenating write statements with semicolons
4. **Redis command injection**: executing write commands via arguments or variants

## MySQL three-layer defense

### Layer 1: SQL lexical scanner

Before connecting, the script lexically scans the raw SQL text.

**Allowed statement types:**
- `SELECT ...`
- `WITH ... SELECT ...` (CTE)
- `SHOW ...`
- `DESCRIBE` / `DESC ...`
- `EXPLAIN SELECT ...`

**Rejected writes:** INSERT / UPDATE / DELETE / REPLACE / DROP / ALTER / CREATE / TRUNCATE / RENAME / GRANT / REVOKE / SET / LOCK / UNLOCK / CALL / LOAD DATA etc.

**Rejected comment forms (all banned, including legal SQL inside comments):**
- `#` single-line comment
- `-- ` (double dash + space) single-line comment
- `/* */` multi-line comment
- `/*! */` MySQL version comment
- `/*+ */` optimizer hint

> **Why ban comments?** Comments can nest malicious SQL (e.g. `SELECT 1; /* */ DROP TABLE x;`) and hide version-specific syntax. A lexical scanner cannot safely parse comment contents, so they are rejected outright.

**Additional restrictions:**
- No backslash escapes (`\`) — prevents crafting legal-but-dangerous syntax via escapes
- No multi-statements (`;` separated) — prevents concatenated writes
- No `INTO OUTFILE` (exports to the server filesystem)
- No `FOR UPDATE` / `LOCK IN SHARE MODE` (explicit locking)
- No potential DoS functions like `SLEEP()` / `BENCHMARK()` / `GET_LOCK()`
- Auto-inject a top-level `LIMIT` when none is present (prevents long-blocking full scans)

> **Why a lexical scanner instead of regex?** Regex cannot reliably handle SQL string literals, identifier quoting (backticks), and operator ambiguity. A token-by-token scanner is more reliable than regex, yet it is still not a full SQL parser — complex but legal SQL may be rejected. That is a security trade-off.

### Layer 2: connection-level protection

Once connected:
- `multipleStatements: false`: the mysql2 driver explicitly disables multi-statement execution; even if the scanner misses a semicolon, subsequent statements never run
- `START TRANSACTION READ ONLY`: an explicit read-only transaction; the MySQL server itself rejects writes
- Always `ROLLBACK` after the query; never `COMMIT`

> **Why START TRANSACTION READ ONLY + ROLLBACK?** Defense in depth: even if the lexical scanner were bypassed (theoretically possible), the read-only transaction intercepts writes server-side, and ROLLBACK guarantees no side effects.

### Layer 3: account-level privileges

**Strongly recommended**: a dedicated read-only MySQL account granted only SELECT and SHOW VIEW.
This is the final boundary — even if both layers above fail, account privileges still block writes.

> ⚠️ **The admin commands below are for DBAs only; this skill's scripts never execute them:**

```sql
-- Read-only account setup example (for reference only)
CREATE USER 'db_query_reader'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT, SHOW VIEW ON `mydb`.* TO 'db_query_reader'@'%';
FLUSH PRIVILEGES;
```

## Redis security model

### Whitelist design

Redis uses a **command whitelist**, not a blacklist.

**Why a whitelist?**
- A blacklist must enumerate every dangerous command, but Redis keeps adding new ones and Redis Modules can register custom commands. A whitelist rejects unknown commands by default (fail-closed) — safer.
- Blacklists are easily bypassed by new/module commands.

### Allowed commands (full list)

| Category | Commands | Notes |
|------|------|------|
| **General** | PING, GET, MGET, EXISTS, TYPE, TTL, PTTL, STRLEN, SCAN, KEYS†, DBSIZE, TIME | |
| **Hash** | HGET, HMGET, HEXISTS, HLEN, HGETALL†, HKEYS†, HVALS†, HSCAN | |
| **List** | LINDEX, LLEN, LRANGE | |
| **Set** | SISMEMBER, SCARD, SMEMBERS†, SSCAN | |
| **ZSet** | ZCARD, ZCOUNT, ZSCORE, ZRANK, ZREVRANK, ZRANGE, ZRANGEBYSCORE, ZSCAN | |
| **Server info** | INFO, CLIENT LIST, CONFIG GET† | CONFIG GET limited to safe items |

> † Requires `--allow-unbounded`. These can block Redis on big keys; prefer SCAN in production.

### Rejected commands

Everything not on the whitelist is rejected (fail-closed), including but not limited to:
- **Write commands**: SET, DEL, EXPIRE, INCR, DECR, HSET, LPUSH, SADD, ZADD, PFADD etc.
- **Dangerous commands**: FLUSHALL, FLUSHDB, SHUTDOWN, DEBUG, EVAL, EVALSHA, SCRIPT
- **Admin commands**: CONFIG SET, RENAME, MOVE, RESTORE, MIGRATE, SORT (may write to external storage)
- **Unrecognized commands**: including those registered by Redis Modules

### db is chosen via connection config

The Redis `db` number can only be set through the `--db` connection option; the **`SELECT` command is not exposed**.
This prevents switching databases mid-query and avoids touching the wrong db.

### Gate mechanism for KEYS and other big commands

`KEYS`, `HGETALL`, `HKEYS`, `HVALS`, `SMEMBERS` can block Redis for a long time on big keys (single-threaded model).
They are rejected by default and require an explicit `--allow-unbounded`, forcing awareness of the risk.

**Production alternative — SCAN-family commands:**
- `KEYS pattern` → `SCAN 0 MATCH pattern COUNT 100`
- `HGETALL key` → `HSCAN key 0 COUNT 100`
- `SMEMBERS key` → `SSCAN key 0 COUNT 100`

### CONFIG GET safe-parameter whitelist

`CONFIG GET` only allows these safe parameters (read-only config that doesn't affect service behavior):
- `maxmemory`
- `maxmemory-policy`
- `timeout`
- `tcp-keepalive`
- `databases`

Other config items (e.g. `requirepass`, `masterauth`) may leak credentials and are always rejected.

### Redis ACL as the final server-side boundary

**Strongly recommended**: a dedicated Redis ACL user for queries:
```
# Redis ACL example (for DBAs/ops only)
ACL SETUSER db_query_reader on >password ~* +@read +ping +info +client|list +config|get
```

> ⚠️ A client-side timeout (`--timeout-ms`) only closes the client socket; it **does not cancel the command running server-side**. If a command takes too long on the server (e.g. `KEYS *` over a million keys), Redis keeps executing it after the client disconnects, blocking other requests meanwhile. This is inherent to Redis's single-threaded model, which is why the script gates dangerous commands client-side.

## Credentials & TLS conventions

### Password safety

- **No CLI `--password`**: command-line arguments land in shell history (`~/.bash_history` / `~/.zsh_history`) and may be readable by others.
- **Recommended**:
  1. Environment variables (`DB_QUERY_MYSQL_PASSWORD` / `DB_QUERY_REDIS_PASSWORD`)
  2. Env file (`--env-file=<path>`) with `0600` permissions
- Scripts never echo passwords in output.

### TLS

- Both MySQL and Redis support `--tls` for encrypted connections.
- `--ca-file` specifies a CA certificate for server identity verification.
- **Enable TLS** for cross-network connections in production.

## Failure mode: fail-closed

All safety checks follow the **fail-closed** principle:
- Unknown token in the SQL lexical scan → reject
- Unknown Redis command → reject
- Timeout → disconnect, never continue
- No "lenient mode" or fallback — a rejection is a rejection

## Known limitations

| Limitation | Impact | Mitigation |
|------|------|------|
| Lexer is not a full SQL parser | Complex but legal SQL (comments, backslash escapes, dynamic LIMIT, EXPLAIN ANALYZE) is rejected | Security trade-off; no lenient fallback added |
| MySQL `MAX_EXECUTION_TIME` only on 5.7.8+/8.0 | Query timeout not guaranteed on MariaDB | Dedicated read-only account + connection-level timeout as backstop |
| Redis client timeout doesn't cancel server-side commands | Big-key commands can keep blocking Redis | Gate dangerous commands client-side; restrict via ACL server-side |
| Application-layer checks can't replace DB privileges | A script bug could bypass client-side checks | Dedicated read-only account + ACL mandatory in production/shared environments |
