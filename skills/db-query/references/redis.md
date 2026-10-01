<!-- [2026-09-05]-[translated to English (skill is now English-only)]-[content unchanged] -->
# Redis Command Whitelist & Query Patterns

## Full command-args-return reference

### General / key operations

| Command | Args | Return form | Notes |
|------|------|----------|------|
| `PING` | none | `PONG` (string) | Connectivity test |
| `GET key` | key | String value or `(nil)` | Read a String value |
| `MGET key [key ...]` | 1+ keys | Array of values (in order) | Batch read Strings |
| `EXISTS key [key ...]` | 1+ keys | Count of existing keys | Check key existence |
| `TYPE key` | key | Type string | Key's data type |
| `TTL key` | key | Remaining seconds (integer) | Time until expiry |
| `PTTL key` | key | Remaining milliseconds (integer) | Expiry in ms precision |
| `STRLEN key` | key | String length | Byte length of String value |
| `SCAN cursor [MATCH pattern] [COUNT count]` | cursor, optional args | Cursor + key list | Incremental key iteration |
| `KEYS pattern`† | pattern | Key list | Full key match (blocking risk) |
| `DBSIZE` | none | Total key count | Key count in current db |
| `TIME` | none | Unix timestamp (sec.µs) | Server current time |

### Hash operations

| Command | Args | Return form | Notes |
|------|------|----------|------|
| `HGET key field` | key, field | Field value or `(nil)` | Read a single field |
| `HMGET key field [field ...]` | key, 1+ fields | Array of values | Batch read fields |
| `HEXISTS key field` | key, field | 1 (exists) / 0 (missing) | Check field existence |
| `HLEN key` | key | Field count | Number of hash fields |
| `HGETALL key`† | key | Alternating field-value array | Full dump (blocking risk) |
| `HKEYS key`† | key | Field name array | All field names (blocking risk) |
| `HVALS key`† | key | Value array | All values (blocking risk) |
| `HSCAN key cursor [MATCH pattern] [COUNT count]` | key, cursor, optional | Cursor + field-value pairs | Incremental hash iteration |

### List operations

| Command | Args | Return form | Notes |
|------|------|----------|------|
| `LINDEX key index` | key, index | Element or `(nil)` | Element by index |
| `LLEN key` | key | List length | Element count |
| `LRANGE key start stop` | key, start/stop indexes | Element array | Elements in range |

### Set operations

| Command | Args | Return form | Notes |
|------|------|----------|------|
| `SISMEMBER key member` | key, member | 1 (member) / 0 (not) | Membership check |
| `SCARD key` | key | Member count | Set size |
| `SMEMBERS key`† | key | Member array | Full dump (blocking risk) |
| `SSCAN key cursor [MATCH pattern] [COUNT count]` | key, cursor, optional | Cursor + member list | Incremental set iteration |

### ZSet operations

| Command | Args | Return form | Notes |
|------|------|----------|------|
| `ZCARD key` | key | Member count | ZSet size |
| `ZCOUNT key min max` | key, score range | Count | Count by score range |
| `ZSCORE key member` | key, member | Score or `(nil)` | Member's score |
| `ZRANK key member` | key, member | Rank or `(nil)` | Ascending rank (0-based) |
| `ZREVRANK key member` | key, member | Rank or `(nil)` | Descending rank (0-based) |
| `ZRANGE key start stop [WITHSCORES]` | key, start/stop, optional | Member (+score) array | Query by rank range |
| `ZRANGEBYSCORE key min max [WITHSCORES]` | key, score range, optional | Member (+score) array | Query by score range |
| `ZSCAN key cursor [MATCH pattern] [COUNT count]` | key, cursor, optional | Cursor + member-score pairs | Incremental zset iteration |

### Server info

| Command | Args | Return form | Notes |
|------|------|----------|------|
| `INFO [section]` | optional section | Info text block | Server info & stats |
| `CLIENT LIST` | none | Client connection list | Current connections |
| `CONFIG GET parameter`† | Parameter name | Parameter value | Read config (safe items only) |

> † Requires the `--allow-unbounded` flag.

## SCAN-family cursor usage

SCAN-family commands iterate incrementally with a cursor and never block Redis.

### Basic pattern

```bash
# SCAN instead of KEYS to iterate keys
./scripts/redis-query.js -- SCAN 0 MATCH user:* COUNT 100
# Returns: next cursor + key list
# Cursor 0 means iteration is complete

# Multi-round iteration (manual loop)
./scripts/redis-query.js -- SCAN 0 MATCH user:* COUNT 100
# Returns cursor=42, keys=[user:1, user:2, ...]
./scripts/redis-query.js -- SCAN 42 MATCH user:* COUNT 100
# Returns cursor=0 (done)
```

### Per-type SCAN

```bash
# Incremental hash iteration
./scripts/redis-query.js -- HSCAN session:abc 0 COUNT 50
./scripts/redis-query.js -- HSCAN session:abc 128 COUNT 50  # next round

# Incremental set iteration
./scripts/redis-query.js -- SSCAN online:users 0 COUNT 100

# Incremental zset iteration
./scripts/redis-query.js -- ZSCAN leaderboard 0 COUNT 100
```

### SCAN caveats

- `COUNT` is a hint; actual batch sizes may differ (Redis internals).
- Cursor `0` means done, but keys added/removed during iteration may be missed or repeated.
- `MATCH` filters server-side: it reduces network transfer, not traversal work.

## TTL / PTTL return values

| Return | Meaning | Notes |
|--------|------|------|
| `>= 0` | Remaining lifetime | TTL in seconds, PTTL in milliseconds |
| `-1` | No expiry | Key exists without a TTL set |
| `-2` | Key missing | Expired and removed, or never created |

```bash
./scripts/redis-query.js -- TTL cache:homepage
# 300 → expires in 5 minutes
# -1 → no expiry
# -2 → key missing
```

## Safe query steps per data type

Recommended pattern: **run `TYPE` first, then pick the matching command**.

### String

```bash
./scripts/redis-query.js -- TYPE user:42          # confirm it's a string
./scripts/redis-query.js -- GET user:42           # read value
./scripts/redis-query.js -- TTL user:42           # check expiry
./scripts/redis-query.js -- STRLEN user:42        # check length
```

### Hash

```bash
./scripts/redis-query.js -- TYPE user:42          # confirm it's a hash
./scripts/redis-query.js -- HLEN user:42          # field count (size hint)
./scripts/redis-query.js -- HGET user:42 name     # single field
./scripts/redis-query.js -- HMGET user:42 name email status  # batch fields
./scripts/redis-query.js -- HSCAN user:42 0 COUNT 100  # batched iteration (recommended)
# For small keys, HGETALL works (needs --allow-unbounded)
./scripts/redis-query.js --allow-unbounded -- HGETALL user:42
```

### List

```bash
./scripts/redis-query.js -- TYPE task:queue       # confirm it's a list
./scripts/redis-query.js -- LLEN task:queue       # length
./scripts/redis-query.js -- LRANGE task:queue 0 9 # first 10 (non-negative indexes, range ≤ max-items)
# For the tail: LLEN first, then compute a non-negative index; negative-index LRANGE ranges are unpredictable and need --allow-unbounded
./scripts/redis-query.js -- LLEN task:queue
./scripts/redis-query.js --allow-unbounded -- LRANGE task:queue -10 -1  # explicitly allowed negative range
./scripts/redis-query.js -- LINDEX task:queue -1  # last element (single value; negative index unrestricted)
```

### Set

```bash
./scripts/redis-query.js -- TYPE online:users     # confirm it's a set
./scripts/redis-query.js -- SCARD online:users    # member count
./scripts/redis-query.js -- SISMEMBER online:users user:42  # membership check
./scripts/redis-query.js -- SSCAN online:users 0 COUNT 100  # batched iteration
```

### ZSet

```bash
./scripts/redis-query.js -- TYPE leaderboard      # confirm it's a zset
./scripts/redis-query.js -- ZCARD leaderboard     # member count
./scripts/redis-query.js -- ZSCORE leaderboard user:42   # score lookup
./scripts/redis-query.js -- ZRANK leaderboard user:42    # ascending rank
./scripts/redis-query.js -- ZRANGEBYSCORE leaderboard 100 999 WITHSCORES  # score range
./scripts/redis-query.js -- ZSCAN leaderboard 0 COUNT 100  # batched iteration
```

## Unbounded command risks & SCAN alternatives

These commands can block Redis for a long time on big keys (single-threaded model) and **require `--allow-unbounded` by default**:

| Dangerous command | Reason | SCAN alternative |
|----------|------|-----------|
| `KEYS pattern` | O(N) over all keys | `SCAN 0 MATCH pattern COUNT 100` |
| `HGETALL key` | O(N) returns all fields | `HSCAN key 0 COUNT 100` |
| `HKEYS key` | O(N) returns all field names | `HSCAN key 0 COUNT 100` (ignore values) |
| `HVALS key` | O(N) returns all values | `HSCAN key 0 COUNT 100` (ignore field names) |
| `SMEMBERS key` | O(N) returns all members | `SSCAN key 0 COUNT 100` |

**Production principle**: prefer SCAN; use `--allow-unbounded` only when the key is known to be small.

## CONFIG GET safe-parameter whitelist

`CONFIG GET` only allows these parameters (no credential leaks, no service behavior impact):

| Parameter | Notes |
|------|------|
| `maxmemory` | Max memory limit |
| `maxmemory-policy` | Eviction policy |
| `timeout` | Client idle timeout |
| `tcp-keepalive` | TCP keepalive interval |
| `databases` | Number of databases |

Querying other parameters (e.g. `requirepass`, `masterauth`, `save`) is rejected to prevent leaking sensitive config.
