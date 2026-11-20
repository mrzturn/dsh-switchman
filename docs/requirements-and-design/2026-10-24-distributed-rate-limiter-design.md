# Distributed Rate Limiter: Implementation Approaches — A Deep Analysis

> Independent systems-design research note. A synthesis of textbook algorithms and production patterns (Redis, Envoy, Sentinel, Google-SRE-style cells). Not tied to any specific codebase.

## 1. Problem Framing

A rate limiter makes one binary decision per request — **admit or reject** — against a quota. The engineering content lives entirely in how the quota is defined, shared, and enforced. Six framing decisions shape every implementation.

**Window semantics.** *Fixed window*: at most N per calendar interval (per minute, per day). *Sliding window*: at most N in any trailing interval of length W. *Continuous refill*: sustained rate ρ with burst capacity b (the token-bucket family). Billing wants calendar windows; abuse protection wants sliding or refill semantics.

**Burst tolerance.** A strict average (leaky-bucket-as-meter, GCRA with small τ) smooths traffic but rejects correlated bursts. Token buckets with capacity b tolerate bursts up to b while enforcing ρ long-term. The burst parameter is a product decision: payment APIs want smoothness; human-facing apps want headroom.

**Scope.** Global (service-wide cap), per-route, per-tenant, per-user/API-key, per-IP — or multi-dimensional combinations, e.g. Lyft-style *descriptors*: (user, endpoint, tier) tuples each carrying its own limit, all checked per request. More dimensions means more coordination per decision.

**Hard vs soft limits.** A *hard* limit is enforced deterministically at the boundary (billing, contractual quota). A *soft* limit is advisory — a target utilization enforced best-effort (load shedding, fairness). Most real limiters mix both: hard daily quota, soft per-second burst.

**Placement.** In the synchronous request path (proxy filter, gateway middleware, SDK interceptor): every decision pays the limiter's latency. Or *out of band*: count, observe, and block/reconcile after the fact. Out-of-band never bounds instantaneous damage; in-path bounds it at coordination cost.

**Guarantee taxonomy.** Exactness (no over-admission), no false rejection (no under-admission of legitimate traffic), and liveness under partial failure cannot all hold under partition. Section 3 formalizes why; Section 4 is a menu of tradeoffs along these three axes.

## 2. Core Single-Node Algorithms

All distributed schemes are compositions of these six, so their boundary artifacts propagate upward.

### 2.1 Fixed Window Counter

~~~text
state: count, window_id
on_request(t, cost):
  w = floor(t / W)
  if w != window_id: count = 0; window_id = w
  if count + cost <= N: count += cost; return ALLOW
  return REJECT
~~~

O(1) time and memory. One artifact dominates: a subject that spends N at the end of one window and N at the start of the next experiences 2N within W — a 2x boundary burst that neither counter sees.

### 2.2 Sliding Window Log

~~~text
state: log of admitted timestamps (per subject)
on_request(t, cost):
  evict all entries older than t - W
  if len(log) + cost <= N:
    append cost entries at t; return ALLOW
  return REJECT
~~~

Exact — no boundary artifacts — but memory is O(live admitted requests per window). At 1,000 req/min for 1M active subjects that is 10^9 live entries: feasible only for small populations or flagged top talkers. O(log n) per decision with a sorted set.

### 2.3 Sliding Window Counter (two-window interpolation)

Keep two counters and weight the previous one by its remaining relevance (the Cloudflare-style compromise):

~~~text
P = count in previous window; C = count so far in current window; a = elapsed/W
estimate = P*(1-a) + C
ALLOW iff estimate + cost <= N
~~~

O(1) memory. Analysis: at the boundary a is ~0, so a full P blocks immediately (fixed window's defect gone); allowable C grows as N*a, i.e. smoothly. Total traffic across two adjacent windows can still approach 2N, but spread over W rather than arriving as a spike — worst-case over-admission inside any short interval shrinks to roughly N*(elapsed/W).

### 2.4 Token Bucket

~~~text
state: tokens, last
on_request(t, cost):
  tokens = min(capacity, tokens + (t - last)*rho); last = t
  if tokens >= cost: tokens -= cost; return ALLOW
  return REJECT
~~~

O(1) time and memory. Enforces average rate ρ exactly over any sufficiently long horizon; permits bursts up to capacity. The default choice everywhere, and its state — two numbers — survives distribution well.

### 2.5 Leaky Bucket

Two distinct mechanisms share the name. As a *meter* it is the token bucket viewed backwards (fixed-rate outflow; equivalently GCRA below). As a *shaper* it queues non-conforming requests for later emission — which adds queue latency, requires queue bounds (an unbounded buffer becomes the outage), and converts rejection into delay. Metering belongs in rate limiters; shaping belongs in traffic managers (egress QoS), where delay is the point.

### 2.6 GCRA (Generic Cell Rate Algorithm)

GCRA — from ATM policing — is the token bucket compressed to a single timestamp, the *theoretical arrival time* (TAT):

~~~text
params: rate rho, burst tolerance tau = burst/rho (seconds of slack)
state: TAT
on_request(t, cost):
  if t >= TAT - tau:
    TAT = max(TAT, t) + cost/rho; return ALLOW      # retry_at = TAT - tau
  return REJECT
~~~

**Equivalence to token bucket:** TAT encodes both refill state and budget; one timestamp is the minimal state exactly equivalent to a token bucket. That is why the redis-cell module (GCRA exposed as the CL.THROTTLE command) runs a strict limiter on one small key. GCRA additionally yields an exact retry-after, which token-bucket code usually approximates.

### 2.7 Comparison

| Algorithm | Time | Memory | Exactness | Burst behavior |
|---|---|---|---|---|
| Fixed window | O(1) | O(1) | boundary artifact | up to 2N spike at boundary |
| Sliding log | O(log n) | O(live requests) | exact | none |
| Sliding counter | O(1) | O(1) | smoothed; total may still reach 2N across boundary | spread over W |
| Token bucket | O(1) | O(1) | exact average ρ | burst ≤ capacity |
| Leaky bucket (meter) | O(1) | O(1) | exact average ρ | smooths (rejects bursts) |
| GCRA | O(1) | one timestamp | exact | burst ≤ τ·ρ |

## 3. What Distribution Changes

1. **Shared quota.** N enforcers must agree on one budget. Every architecture in Section 4 is a choice of how fresh that agreement is: per-decision (synchronous), per-batch (leasing), or per-epoch (cells).
2. **Atomicity.** Check-and-decrement is a read-modify-write; concurrent enforcers race. A naive GET-then-SET at concurrency c over-admits up to c× per race window. Atomicity must be delegated to one serialization point per subject (Redis single thread + script, DB row lock, local mutex).
3. **Hot keys.** A per-subject key is usually fine; a *global* quota key receives every decision in the fleet. On Redis a hot key saturates one shard's single thread (~100k ops/s class) and degrades every other subject colocated on that shard.
4. **Clock skew.** Decisions computed from each enforcer's now() diverge (NTP steps, VM pauses, leap smears). Skew converts directly into quota error: ±500 ms of skew on a 1-minute window is roughly 1% error; trusting *client* timestamps is attacker-controlled refill.
5. **CAP.** A distributed limiter *is* a coordination service, and partition forces the classical choice: fail-closed (CP-flavored — protect the backend, reject during partitions) or fail-open with a bounded local fallback (AP-flavored — stay available, over-admit by a bound). For abuse protection, bounded over-admission is usually the right loss; for billing-grade quotas it is not — which is why billing limiters end up looking like databases (Section 4f).
6. **Cost floor.** Unbatched coordination costs at least one RTT per decision and caps fleet-wide decisions at the serialization point's throughput. Sections 4b–4e are strategies to amortize that RTT.

## 4. Distributed Implementation Approaches

### 4a. Centralized Redis + Atomic Lua Scripts

Architecture: one Redis primary (plus replicas) is the sole authority; every enforcer runs one atomic script per decision. Lua scripts execute atomically on Redis's single thread, turning multi-step read-modify-write into one operation — no WATCH/MULTI retry loops under contention. Ship scripts via EVALSHA so bodies are not re-sent.

**Fixed window (INCR + EXPIRE):**

~~~lua
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c                       -- ALLOW iff c <= limit
~~~

Wrap even this two-command sequence in a script: INCR and EXPIRE as separate round trips leave a crash window that produces immortal keys (a counter with no TTL) and double-INCR races.

**Sliding log (ZSET):** ZREMRANGEBYSCORE key 0 (now−W); ZCARD; if below limit, ZADD key now unique_member; PEXPIRE. Exact; the member must be unique (e.g. client request id) or two same-millisecond requests collapse. O(log n) time plus heavy memory — reserve for strict, small-population cases.

**Token bucket (the workhorse):**

~~~lua
-- KEYS[1]=bucket key  ARGV[1]=rate/s  ARGV[2]=capacity  ARGV[3]=cost
local rate = tonumber(ARGV[1])
local cap  = tonumber(ARGV[2])
local need = tonumber(ARGV[3])
local t  = redis.call('TIME')              -- seconds, microseconds
local now = tonumber(t[1]) + tonumber(t[2]) / 1e6
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens, ts = tonumber(b[1]), tonumber(b[2])
if tokens == nil then tokens, ts = cap, now end     -- first sight: full bucket
tokens = math.min(cap, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= need then tokens = tokens - need; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 2 * 1000))
return {allowed, math.floor(tokens)}
~~~

Two properties make this correct: (1) script atomicity — refill and consume cannot interleave; (2) Redis TIME as the *single time authority* — enforcers contribute no clocks. Classic Redis replicated scripts verbatim and required determinism; on modern Redis (5+, effects replication by default) calling TIME inside a script is safe on supported versions. The PEXPIRE keeps inactive subjects from leaking memory; 2x the full-refill time is the safe floor (tokens must be meaningless before the key dies).

Redis Cluster notes: multi-key scripts require all keys in one slot, so use hash tags — rl:{subject123}. Per-subject keys shard naturally; the failure mode is a *global* quota key (next section). Ceiling: one shard sustains roughly 50–150k simple ops/s, i.e. tens of thousands of script decisions per second (Section 6); a script runs to completion without preemption, so keep scripts O(1)-ish and small.

Pros: exact per subject, low complexity, well-trodden. Cons: one RTT per decision; Redis becomes a hard dependency (choose fail-open/closed explicitly, Section 5); hot-key ceiling for global quotas.

### 4b. Scaling with Redis Cluster: Per-Subject Sharding vs Centralized Quota, and Subkey Splitting

- **Per-subject limits** (exact per subject, approximate global): keys hash across shards; throughput scales linearly with shards; no cross-key coordination. This is the free lunch — most quota semantics are per-user/per-key anyway.
- **Global/service quotas** (exact global): the quota key is a hot key on one shard. Two mitigations:
  1. *Subkey splitting.* Split quota Q into K subkeys rl:{svc}:s0..s{K−1}, each Q/K. Each enforcer (or each request) selects a subkey — random or round-robin — and enforces its slice. The hot key's CPU divides by K across shards. Exactness: each subkey is an independent (approximate) window, so boundary artifacts exist per subkey; total overshoot stays in the same ~2x band as one fixed window but the serialization pressure per shard drops K-fold. Aggregate for observability by periodic scans — never in the decision path.
  2. *Tiered enforcement.* Most subjects are never hot; give the 99% exact per-subject keys and route only declared hot subjects (top tenants, service-global caps) through splitting or leasing (4c).

Client-side consistent hashing of subjects onto shards is an alternative to Redis Cluster with the same properties — exact per subject, and a hot global key stays hot wherever it lands.

### 4c. Two-Level Hierarchical: Local Buckets + Quota Leasing

Move the RTT off the request path: each node keeps an in-memory bucket and *leases* tokens in batches from the central store.

~~~text
local: pool[S], lease_deadline[S]      central: token bucket / counter per S
BATCH = e.g. 1-5% of window quota      LEASE_TTL = e.g. 1-5 s

on_request(S, cost):
  if lease_deadline[S] < now:                    # lease expired
    if not RENEW_SYNC(S): return DEGRADE(policy) # fail-open floor, or reject
  if pool[S] >= cost: pool[S] -= cost; return ALLOW
  if not RENEW_SYNC(S): return REJECT
  if pool[S] >= cost: pool[S] -= cost; return ALLOW
  return REJECT

RENEW_SYNC(S):
  B = min(BATCH, central_remaining(S))   # atomic decrement at the center
  pool[S] += B; lease_deadline[S] = now + LEASE_TTL
  return B

background: renew asynchronously when pool[S] < 30% of BATCH
shutdown:   return unused tokens (best effort)
~~~

Key numbers: the central store sees N_nodes renewals per LEASE_TTL — 20 nodes at 1 s leases is ~20 ops/s regardless of 100k RPS of real traffic. The over-admission bound is **BATCH × N_nodes per lease period** (a node that dies mid-lease holds dead tokens until TTL expiry). Size BATCH/TTL so this is tolerable: 10k RPS global, 20 nodes, 500-token leases → worst overshoot ≈ one lease period of traffic (≤10k requests for ≤1 s) — usually acceptable for abuse protection, not for billing.

Known instances of this pattern:

- **Envoy + global rate limit service.** Envoy's local rate-limit filter provides static per-instance token buckets — a floor, and the natural fail-open fallback. The global ratelimit service is normally called per-request over gRPC, which reintroduces the RTT; high-traffic deployments replace per-request global calls with leased local budgets, keeping the global service for slow-moving aggregate caps.
- **Alibaba Sentinel cluster flow control.** SDK clients request *batches* of tokens from a Token Server (standalone process, or embedded in one of the app instances); when the Token Server is unavailable, clients fall back to local-mode limits. Same math: overshoot = batch size × client count, and the fallback IS the local mode.
- Generic gateway/edge pattern: a regional budget cache synced from a global authority every second.

Pros: removes the RTT from the hot path; degrades gracefully; central load independent of traffic. Cons: bounded over-admission; lease lifecycle complexity (TTLs, dead-node token leaks, rebalancing as nodes scale); uneven utilization across nodes unless rebalanced.

### 4d. Cell-Based / Partitioned Quotas (Google-SRE-Style)

Divide the fleet into cells (per region, per availability zone, per service shard). The global quota Q is divided into weighted slices Q_i; each cell enforces its slice locally with any scheme above (usually 4a/4c inside the cell). Add a transfer protocol: a cell that exhausts its slice may borrow from a global reserve pool or from under-utilized cells, with reclaim on expiry.

Failure behavior is explicit and local: a dead cell forfeits its slice — global capacity under-utilizes until the reclaim timeout — but cannot overspend. The blast radius of both limiter failure and limiter-induced rejection stays inside the cell. Under partition, cells keep enforcing their last-known slice: bounded over-admission limited to slice re-assignment, never global collapse.

Pros: no global hot path anywhere; regional data residency is natural; failure isolation. Cons: fragmentation (a saturated cell cannot instantly use another cell's idle slice without the transfer protocol); global exactness is approximate by construction; more moving parts (slice manager, reclaim).

### 4e. Dedicated Rate-Limit Service / Sidecar

The Lyft **envoy-ratelimit** pattern: a standalone Go service exposing RateLimitService over gRPC; policies organized as *domains* (per service) containing *descriptors* (per dimension-value sets); backends are Redis or in-memory. Envoy — or any gRPC client — calls ShouldRateLimit per request; one service centralizes policy for many proxies and services.

This buys *policy centralization*: one place to define and audit limits across dozens of services, plus multi-dimensional checks. The costs: a new critical-path dependency (+1–5 ms per decision, and the ratelimit fleet now needs more care than the services it protects), and backend coupling — per-request Redis load hits Section 4a's ceiling, which is why large deployments put leasing in front of it anyway.

Build vs buy: managed edge (Cloudflare, AWS API Gateway usage plans, Apigee, Kong) prices per decision and handles HA; self-hosting the envoy-ratelimit pattern is well-trodden with open-source components. Build fully custom only for unusual semantics: cost-based quotas, weighted fair scheduling across tenants, or abuse scoring in the decision path.

### 4f. Consensus / DB-Based for Low-QPS Exactness

**Postgres/MySQL.** A token bucket is one row and one transaction:

~~~sql
BEGIN;
SELECT tokens, ts FROM token_buckets WHERE key = $subject FOR UPDATE;
-- app: tokens = min(cap, tokens + (now - ts) * rate)
UPDATE token_buckets SET tokens = $new_tokens, ts = now()
 WHERE key = $subject;
COMMIT;   -- allowed iff new_tokens >= cost
~~~

The row lock is the serialization point: exact, durable, and transactional *with the business data* — reserve quota and record the order atomically, the property no Redis setup gives you. Costs: per-subject lock contention (a hot subject serializes on one row), ~1–5k such transactions/s on modest hardware, 2–10 ms decisions. Right for low QPS (hundreds per second), for quota *reservations* (check once per workflow, not per request), and as the source of truth for reconciliation. Single-statement UPDATE ... RETURNING variants avoid round trips.

**etcd/ZooKeeper.** Raft consensus with fsync-per-write: a few thousand to ~10k writes/s and p99 in the tens of milliseconds. Correct use is *config distribution*: publish limit rules, let enforcers Watch and enforce locally at full speed. Name the anti-pattern explicitly: per-decision quota checks against etcd.

## 5. Correctness & Failure Deep-Dive

**Over-admission sources (quota leaks):**

1. *Replication loss on failover.* Async primary→replica replication loses the tail of writes; lost increments mean subjects re-earn quota. Over-admission ≈ rate × replication lag — typically milliseconds and small, spiking during failover storms. WAIT numreplicas bounds acknowledged loss at ~2x decision latency (an extra RTT to replicas); worth it for billing, overkill for abuse control, since fixed windows self-heal at the boundary.
2. *Lease staleness* (4c): the BATCH × N_nodes bound; dead nodes leak their leases until TTL.
3. *Retry-after-timeout double spend.* A client times out on a decision that actually committed and retries — its own quota is consumed twice (self-harm), or a second enforcer over-admits. Fix: idempotent decision ids (ZSET member, or a SET NX ticket) on money-adjacent paths.
4. *Fail-open without a cap.* The fallback must be a *local, smaller* cap — 10–50% of nominal per node — never unlimited. Unlimited fail-open converts any datastore outage into a backend outage minutes later.
5. *Clock/timestamp trust.* Refills computed from client-supplied timestamps are attacker-refillable; from skewed enforcers, noisy by skew × rate. One time authority per decision path — the store's clock.

**False-rejection sources (quota starvation):** under-sized leases during traffic shifts (nodes starve while global quota is unspent); fail-closed on transient blips; retry storms amplifying limiter load exactly when the backend is protected-but-alive (rejected clients retrying multiply limiter QPS — use jittered backoff and a retry budget); layered limiters with mismatched windows double-serializing subjects. Rule of thumb: one authority per scope; upper layers hold *fallback floors*, not second opinions.

**Clock skew handling, concretely:** compute time inside the authority (Redis TIME in-script; DB now()); store absolute timestamps in the key (TAT, ts) so state survives enforcer churn; use monotonic clocks only for local durations (lease TTLs); never compare clocks across machines — compare against a timestamp returned by the authority.

## 6. Performance Engineering

Decision cost ladder (same region, order-of-magnitude, commodity hardware):

| Path | p50 added latency | Throughput ceiling |
|---|---|---|
| In-memory local bucket | ~0.1–1 µs | CPU-bound: millions/s per node |
| Redis same-AZ GET/SET | ~0.3–1 ms incl. client stack | ~100–150k ops/s per shard; 0.6–1M/s pipelined |
| Redis Lua token bucket | same RTT + server CPU | ~30–80k decisions/s per shard |
| Redis ZSET sliding log | same RTT, heavier ops | ~10–40k/s per shard |
| +1 cross-AZ hop | +1–2 ms | unchanged |
| gRPC ratelimit service + Redis | ~2–5 ms | service-tier bound |
| Postgres FOR UPDATE | ~2–10 ms | ~1–5k TPS |

Planning rules of thumb: run the authority at ≤50% of its saturation number — Redis latency climbs steeply near saturation, and limiter latency multiplies into every request it guards. One hot key equals one core: subkey-split anything expected above ~10–20k decisions/s. Batch multi-dimension checks (several descriptors per request) into a single script call with hash-tagged keys instead of N round trips.

The amortization hierarchy, most to least RTT per quota unit: per-request decision (1 RTT/request) → pipelined multi-check (1 RTT/request, several quotas) → leasing (1 RTT per BATCH decisions; 500-token leases cut per-decision coordination cost ~500x, leaving the central store nearly idle) → cells (zero cross-region RTT; intra-cell leasing). Local decision caching — cache ALLOW for a subject for ~100 ms — is the poor man's lease: over-admission ≤ rate × TTL at ~zero latency.

## 7. Selection Matrix

| Approach | Exactness (over/under-admission) | Added latency (p50) | Max throughput | Availability coupling | Ops complexity | Best fit |
|---|---|---|---|---|---|---|
| In-process bucket only | over ≈ N_nodes × quota | ~0 | per-node CPU | none | trivial | internal self-protection |
| Redis fixed window (Lua) | ±2x boundary burst | 0.3–2 ms | ~50–100k/s per shard | Redis on critical path | low | simple per-user / daily caps |
| Redis sliding log (ZSET) | exact | 0.3–2 ms | ~10–40k/s per shard | Redis on critical path | low-med | strict, small populations |
| Redis token bucket (Lua) | exact per subject | 0.3–2 ms | ~30–80k/s per shard | Redis on critical path | low | default workhorse |
| Redis Cluster per-subject | exact per subject | 0.3–2 ms | linear in shards | cluster HA | medium | per-user fairness at scale |
| Subkey splitting | ±K window artifacts | 0.3–2 ms | ×K on hot keys | cluster HA | medium | global caps at high RPS |
| Two-level leasing | overshoot ≤ BATCH × N per TTL | ~0 local | 100k+ per region | central down → local floors | med-high | edge gateways, very high RPS |
| Cell-based slices | per-cell exact; global approximate | ~0 local | scales with cells | cell death shrinks global | high | multi-region global quotas |
| Dedicated service per-request | exact (backend-dependent) | +1–5 ms | service + backend bound | new critical dependency | med-high | unified multi-service policy |
| Postgres FOR UPDATE | exact, durable | 2–10 ms | ~1–5k TPS | DB HA | low | billing-grade, low QPS |
| etcd | exact | 5–20 ms | <10k writes/s | quorum | medium | config only — never decisions |

## 8. Concrete Recommendations

**Edge API gateway, ~100k RPS, abuse protection.** Two-level (4c): a static local token-bucket floor per proxy instance (10–20% of expected share — this is also the fail-open cap), global and per-tenant caps enforced via ~1 s leases from a Redis Cluster token bucket, and per-subject exactness at the edge only for flagged top talkers (4b). Fail open to the floor, never to unlimited. Put the rejection path (429 + Retry-After, computable exactly via GCRA) on the cheapest possible code path. Expected central load: tens of ops/s; added hot-path latency: one local memory access.

**Internal service self-protection.** In-process token bucket with limits pushed by a config service (etcd watch or equivalent); no runtime coordination at all. The purpose is shedding load during incidents, where ±N_nodes x correctness is irrelevant against a retry storm. Add async usage reporting for observability; graduate to leasing only when replicas must share a quota to protect a scarce downstream.

**Per-user fairness at scale.** Redis Cluster with per-user keys rl:{user}:tb and the Lua token bucket — exact per user, naturally sharded, no hot key until a single user is itself hot (then subkey-split that user). PEXPIRE every key so memory tracks active users only. Use the sliding log only as a forensic tool on suspicious subjects. This is the highest value-per-complexity configuration in the entire space.

**Billing-grade strict exactness.** Fail-closed synchronous token bucket on Redis Cluster with WAIT-bounded replication (or primary-region-only writes), idempotent decision ids to kill retry double-spend, and — decisively — an offline reconciliation loop: the limiter enforces in real time, the event log and DB are the source of truth, and drift is settled as compensation (credits or charges). If QPS is low (≤ ~1k) or the quota must be transactional with orders, use the Postgres row-lock bucket instead and stop operating Redis for this purpose. Never enforce a money-bearing quota with in-memory leases: the BATCH × N overshoot bound is a billing-dispute generator.
