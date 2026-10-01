<!-- [2026-09-05]-[translated to English (skill is now English-only)]-[content unchanged] -->
# MySQL Syntax Matrix & Query Recipes

## Allowed / Rejected Statement Matrix

### ✅ Allowed

| Statement type | Example | Notes |
|----------|------|------|
| `SELECT` | `SELECT id, name FROM users WHERE id = 42` | Most common |
| `WITH...SELECT` | `WITH c AS (SELECT 1) SELECT * FROM c` | CTE supported |
| `SHOW` | `SHOW TABLES`, `SHOW CREATE TABLE t` | Metadata queries |
| `DESCRIBE` / `DESC` | `DESC users`, `DESCRIBE users name` | Table structure |
| `EXPLAIN SELECT` | `EXPLAIN SELECT * FROM users` | EXPLAIN SELECT only, no ANALYZE |

### ❌ Rejected

| Statement type | Rejection reason |
|----------|----------|
| `INSERT / UPDATE / DELETE / REPLACE` | Write operations |
| `DROP / ALTER / CREATE / TRUNCATE / RENAME` | DDL |
| `GRANT / REVOKE` | Privilege management |
| `SET` | Session variable changes |
| `LOCK / UNLOCK TABLES` | Explicit locks |
| `CALL / EXECUTE` | Stored procedures |
| `LOAD DATA / INTO OUTFILE` | File operations |
| `START TRANSACTION / COMMIT / ROLLBACK` | Transaction control is managed by the script |
| `HANDLER` | Low-level table access interface |
| All comments (`#`, `-- `, `/* */`, `/*! */`, `/*+ */`) | Can nest malicious SQL |
| Backslash escapes (`\`) | Can craft dangerous syntax |
| Multiple statements (`;` separated) | Prevents concatenation injection |
| `FOR UPDATE` / `LOCK IN SHARE MODE` | Explicit locking |
| `SLEEP()` / `BENCHMARK()` / `GET_LOCK()` | Potential DoS |
| `INTO OUTFILE` | Server-side file writes |
| `EXPLAIN ANALYZE` | Actually executes the query; blocked as a security trade-off |

### Common "legal" forms that get rejected, and alternatives

| Intent | Rejected form | Alternative |
|--------|-------------|----------|
| Query SQL with comments | `SELECT 1 /* comment */` | Remove the comment |
| Backticks + trailing comment | `` SELECT `id` FROM `t` -- comment `` | Remove the comment |
| Dynamic LIMIT (variables) | `PREPARE` + `EXECUTE` | Write a literal number |
| Execution analysis | `EXPLAIN ANALYZE SELECT ...` | Use `EXPLAIN SELECT ...` (no execution) |
| Multiple statements at once | `SELECT 1; SELECT 2` | Split into separate calls |
| Write inside a subquery | `SELECT (UPDATE ...)` | Not allowed; all writes are refused |

## Common read-only recipes

### Single record by primary key

```bash
./scripts/mysql-query.js --user=reader --database=mydb \
  'SELECT id, username, email, status FROM users WHERE id = 42'
```

### Recent changes by time range

```bash
./scripts/mysql-query.js --user=reader --database=mydb --max-rows=50 \
  "SELECT id, status, updated_at FROM orders WHERE updated_at >= '2024-06-01 00:00:00' ORDER BY updated_at DESC"
```

### Aggregate counts (grouped by status)

```bash
./scripts/mysql-query.js --user=reader --database=mydb \
  'SELECT status, COUNT(*) AS cnt FROM users GROUP BY status ORDER BY cnt DESC'
```

### JOIN to verify related data

```bash
# Verify order ↔ user consistency
./scripts/mysql-query.js --user=reader --database=mydb --max-rows=30 \
  'SELECT o.id AS order_id, o.user_id, u.username, o.amount FROM orders o JOIN users u ON o.user_id = u.id WHERE o.status = "pending" ORDER BY o.created_at DESC'
```

### Execution plan

```bash
./scripts/mysql-query.js --user=reader --database=mydb \
  'EXPLAIN SELECT * FROM orders WHERE user_id = 100 AND created_at >= "2024-01-01"'
```

### Table structure

```bash
./scripts/mysql-query.js --user=reader --database=mydb 'DESCRIBE orders'

# or use SHOW
./scripts/mysql-query.js --user=reader --database=mydb 'SHOW CREATE TABLE orders'
```

### Connectivity test

```bash
./scripts/mysql-query.js --user=reader --database=mydb 'SELECT 1'
```

## LIMIT & truncation behavior

| Scenario | Behavior |
|------|------|
| SQL has no `LIMIT` clause | Script auto-injects `LIMIT <max-rows>` (default 200) |
| SQL has `LIMIT n` with `n <= max-rows` | Executed as-is |
| SQL has `LIMIT n` with `n > max-rows` | Validation rejects it: LIMIT exceeds the cap |
| Actual rows reach `max-rows` | Trailing notice "result truncated"; refine the query and re-run |

> ⚠️ The auto-injected LIMIT applies to the outermost query. Subqueries and UNION internals are unaffected (the outer LIMIT still protects).

## Field type output conventions

| MySQL type | Output form | Notes |
|------------|----------|------|
| INT / TINYINT / SMALLINT / MEDIUMINT | Number | Normal range |
| BIGINT | String | Avoids exceeding JS Number.MAX_SAFE_INTEGER |
| DECIMAL / NUMERIC | String | Avoids floating-point precision loss |
| FLOAT / DOUBLE | Number | Precision loss possible |
| DATE / DATETIME / TIMESTAMP | String | `dateStrings` mode, no timezone conversion |
| CHAR / VARCHAR / TEXT | String | As-is |
| JSON | Formatted string | Pretty-printed after JSON.parse |
| BLOB / BINARY | Base64 string | Binary-safe representation |
| NULL | `null` | null in JSON, NULL in table output |

## Offline validation

Use `--validate-only` to check SQL safety without connecting:

```bash
# Validate first, then execute
./scripts/mysql-query.js --validate-only 'SELECT id FROM users WHERE id = 42'
# Once it passes, drop --validate-only and execute
./scripts/mysql-query.js --user=reader --database=mydb 'SELECT id FROM users WHERE id = 42'
```

Validation covers: statement type allowlist, comments/backslash/multi-statement/dangerous functions, and LIMIT compliance.
