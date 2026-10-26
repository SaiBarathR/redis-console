/**
 * Offline tutorials and recipes (v0.2.1, RI parity F12). Static, reviewed text shipped with the app: nothing is
 * fetched, nothing runs by itself. A step's `script` can be inserted into the workbench, where every line is
 * checked against the user's role and the database's policy before it runs.
 *
 * Every key a tutorial writes lives under `tutorial:` and gets an expiry, so practice data cleans itself up.
 */
export interface TutorialStep {
  title: string;
  /** Plain paragraphs (rendered as text). */
  text: string[];
  /** Application code to read (not run here), e.g. a Spring or Node.js snippet. */
  code?: { label: string; text: string };
  /** Redis commands for the workbench, one per line; # lines are comments. */
  script?: string;
}

export interface Tutorial {
  id: string;
  title: string;
  summary: string;
  /** The Redis module the tutorial needs (matched against the database's modules). */
  module?: "search" | "json" | "timeseries";
  kind: "Tutorial" | "Recipe";
  steps: TutorialStep[];
}

export const TUTORIALS: Tutorial[] = [
  {
    id: "search",
    title: "Search: index hashes and query them",
    summary: "Create a few product hashes, index them, then search, sort, aggregate and read the query plan.",
    module: "search",
    kind: "Tutorial",
    steps: [
      {
        title: "Write some documents",
        text: [
          "A search index covers keys by prefix. These three hashes share the prefix tutorial:product: and expire after an hour.",
        ],
        script: [
          'HSET tutorial:product:1 name "Blue gadget" price 25 category tools',
          'HSET tutorial:product:2 name "Red gadget" price 40 category toys',
          'HSET tutorial:product:3 name "Green widget" price 15 category tools',
          "EXPIRE tutorial:product:1 3600",
          "EXPIRE tutorial:product:2 3600",
          "EXPIRE tutorial:product:3 3600",
        ].join("\n"),
      },
      {
        title: "Create the index",
        text: [
          "TEXT fields are searched by words, TAG fields by exact values, NUMERIC fields by ranges. SORTABLE lets SORTBY use a field.",
          "FT.CREATE needs a Redis user that may run it. If your role's user may not, use Search → New index after an administrator grants it, or ask an admin to run this step. The index wizard (Search → New index, or Make searchable on a key) builds the same command from sampled keys.",
        ],
        script: "FT.CREATE idx:tutorial:products ON HASH PREFIX 1 tutorial:product: SCHEMA name TEXT price NUMERIC SORTABLE category TAG",
      },
      {
        title: "Search",
        text: [
          "@field:word searches a TEXT field, @field:{value} a TAG, @field:[min max] a NUMERIC range. Terms side by side must all match.",
          "Switch the workbench to Tree / table, or use each result's Table toggle, to read FT.SEARCH replies as a table.",
        ],
        script: [
          'FT.SEARCH idx:tutorial:products "@name:gadget"',
          'FT.SEARCH idx:tutorial:products "@category:{tools} @price:[10 30]" SORTBY price ASC',
          'FT.SEARCH idx:tutorial:products "*" RETURN 2 name price LIMIT 0 10',
        ].join("\n"),
      },
      {
        title: "Aggregate",
        text: ["FT.AGGREGATE groups and reduces matches: products and average price per category."],
        script: 'FT.AGGREGATE idx:tutorial:products "*" GROUPBY 1 @category REDUCE COUNT 0 AS products REDUCE AVG 1 @price AS avg_price',
      },
      {
        title: "Read the plan",
        text: [
          "FT.EXPLAIN shows how the query is parsed; FT.PROFILE runs it and times each step. Both show as trees in the workbench.",
          "FT.EXPLAIN is only in Redis's @search ACL category, so a read-only Redis user may be refused it; FT.PROFILE shows the same plan with timings.",
        ],
        script: ['FT.EXPLAIN idx:tutorial:products "@name:gadget @price:[10 30]"', 'FT.PROFILE idx:tutorial:products SEARCH QUERY "@name:gadget"'].join("\n"),
      },
      {
        title: "Clean up",
        text: [
          "Dropping an index keeps its documents. It is an admin action with a typed confirmation; the keys expire on their own within the hour.",
        ],
        script: "FT.DROPINDEX idx:tutorial:products",
      },
    ],
  },
  {
    id: "json",
    title: "JSON documents: read and change single paths",
    summary: "Store a document with RedisJSON, then read and update parts of it without rewriting the whole value.",
    module: "json",
    kind: "Tutorial",
    steps: [
      {
        title: "Store a document",
        text: ["JSON.SET writes a document at the root path $. Single quotes keep the double quotes of the JSON text."],
        script: [
          `JSON.SET tutorial:user:1 $ '{"name":"Ada","email":"ada@example.com","age":36,"tags":["admin","beta"],"address":{"city":"London"}}'`,
          "EXPIRE tutorial:user:1 3600",
        ].join("\n"),
      },
      {
        title: "Read paths",
        text: ["A JSONPath selects parts of the document. Several paths in one JSON.GET return an object keyed by path."],
        script: ["JSON.GET tutorial:user:1 $.name $.address.city", "JSON.TYPE tutorial:user:1 $.tags", "JSON.OBJKEYS tutorial:user:1 $"].join("\n"),
      },
      {
        title: "Change paths",
        text: ["Each command changes one path; the rest of the document is not read or rewritten by the client."],
        script: [
          "JSON.NUMINCRBY tutorial:user:1 $.age 1",
          `JSON.ARRAPPEND tutorial:user:1 $.tags '"editor"'`,
          `JSON.SET tutorial:user:1 $.address.city '"Paris"'`,
          "JSON.DEL tutorial:user:1 $.email",
          "JSON.GET tutorial:user:1",
        ].join("\n"),
      },
      {
        title: "Index JSON for search (needs Search)",
        text: [
          "JSON fields are indexed by JSONPath with an alias. $.tags[*] indexes each array element as a tag. The index wizard suggests these paths from sampled documents.",
        ],
        script: [
          "FT.CREATE idx:tutorial:users ON JSON PREFIX 1 tutorial:user: SCHEMA $.name AS name TEXT $.age AS age NUMERIC $.tags[*] AS tags TAG",
          'FT.SEARCH idx:tutorial:users "@tags:{admin}"',
          "FT.DROPINDEX idx:tutorial:users",
        ].join("\n"),
      },
    ],
  },
  {
    id: "streams",
    title: "Streams: queues with consumer groups",
    summary: "Append events, read them as a group of workers, see what is pending and acknowledge or claim it.",
    kind: "Tutorial",
    steps: [
      {
        title: "Append entries",
        text: ["XADD with * lets Redis choose the entry ID (milliseconds-sequence). XRANGE reads oldest first."],
        script: [
          "XADD tutorial:orders * item book qty 1",
          "XADD tutorial:orders * item lamp qty 2",
          "XADD tutorial:orders * item desk qty 1",
          "EXPIRE tutorial:orders 3600",
          "XRANGE tutorial:orders - + COUNT 10",
        ].join("\n"),
      },
      {
        title: "Create a consumer group",
        text: [
          "A consumer group remembers which entries it delivered. Create it in Diagnostics → Streams (or in the key inspector's stream view): enter tutorial:orders, group shipping, start ID 0. The console only accepts the XGROUP subcommands it lists, so this step has no script.",
        ],
      },
      {
        title: "Read as a worker",
        text: [
          "> asks for entries never delivered to this group. Each delivered entry stays pending for worker-1 until it is acknowledged.",
        ],
        script: ["XREADGROUP GROUP shipping worker-1 COUNT 2 STREAMS tutorial:orders >", "XPENDING tutorial:orders shipping"].join("\n"),
      },
      {
        title: "Acknowledge or claim",
        text: [
          "XACK removes an entry from the pending list (copy an ID from the reply above). XAUTOCLAIM hands entries idle for longer than the given milliseconds to another worker, which is how a crashed worker's messages are recovered.",
        ],
        script: [
          "# XACK tutorial:orders shipping <id from XREADGROUP>",
          "XAUTOCLAIM tutorial:orders shipping worker-2 0 0-0 COUNT 10",
          "XPENDING tutorial:orders shipping - + 10",
        ].join("\n"),
      },
      {
        title: "Keep it bounded",
        text: ["Streams used as logs grow until trimmed. MAXLEN ~ trims to about that many entries, cheaply."],
        script: "XTRIM tutorial:orders MAXLEN ~ 1000",
      },
    ],
  },
  {
    id: "timeseries",
    title: "TimeSeries: samples, ranges and aggregation",
    summary: "Create two labelled series, add samples, then chart ranges, averages and several series at once.",
    module: "timeseries",
    kind: "Tutorial",
    steps: [
      {
        title: "Create labelled series",
        text: ["Labels describe a series, so queries can select several series by label. RETENTION drops samples older than one day."],
        script: [
          "TS.CREATE tutorial:temp:kitchen RETENTION 86400000 LABELS sensor temperature room kitchen",
          "TS.CREATE tutorial:temp:office RETENTION 86400000 LABELS sensor temperature room office",
          "EXPIRE tutorial:temp:kitchen 3600",
          "EXPIRE tutorial:temp:office 3600",
        ].join("\n"),
      },
      {
        title: "Add samples",
        text: ["Timestamps are milliseconds since the epoch (use * for now). These are one minute apart."],
        script: [
          "TS.MADD tutorial:temp:kitchen 1767225600000 21.5 tutorial:temp:office 1767225600000 19.0",
          "TS.MADD tutorial:temp:kitchen 1767225660000 21.9 tutorial:temp:office 1767225660000 19.4",
          "TS.MADD tutorial:temp:kitchen 1767225720000 22.4 tutorial:temp:office 1767225720000 19.1",
          "TS.MADD tutorial:temp:kitchen 1767225780000 22.0 tutorial:temp:office 1767225780000 19.8",
        ].join("\n"),
      },
      {
        title: "Ranges and aggregation",
        text: [
          "- and + are the first and last sample. AGGREGATION avg 120000 averages two-minute buckets. The workbench draws TS.RANGE and TS.MRANGE replies as charts.",
        ],
        script: [
          "TS.RANGE tutorial:temp:kitchen - +",
          "TS.RANGE tutorial:temp:kitchen - + AGGREGATION avg 120000",
          "TS.MRANGE - + WITHLABELS FILTER sensor=temperature",
          "TS.INFO tutorial:temp:kitchen",
        ].join("\n"),
      },
    ],
  },
  {
    id: "spring-cache",
    title: "Spring Boot caching (@Cacheable) in Redis",
    summary: "Recognise Spring's cache keys, check their expiry and serialization, and evict entries safely.",
    kind: "Recipe",
    steps: [
      {
        title: "How Spring names cache keys",
        text: [
          "With Spring Data Redis, RedisCacheManager stores an entry of cache products with key 42 as products::42 (the cache name, two colons, the key). Without further configuration entries never expire, and values are Java-serialized (they start with the bytes \\xac\\xed, which the key browser detects as Java serialization).",
          "Configure a time-to-live and a JSON serializer once, for every cache:",
        ],
        code: {
          label: "Java (Spring Boot)",
          text: [
            "@Bean",
            "RedisCacheConfiguration cacheConfiguration() {",
            "  return RedisCacheConfiguration.defaultCacheConfig()",
            "      .entryTtl(Duration.ofMinutes(10))",
            "      .serializeValuesWith(RedisSerializationContext.SerializationPair",
            "          .fromSerializer(new GenericJackson2JsonRedisSerializer()));",
            "}",
          ].join("\n"),
        },
        script: 'SCAN 0 MATCH "*::*" COUNT 200',
      },
      {
        title: "Practise on a cache entry",
        text: ["This writes an entry the way the configuration above would: JSON, with a ten-minute expiry."],
        script: [`SET tutorial:products::42 '{"id":42,"name":"Blue gadget"}' EX 600`, "TTL tutorial:products::42", "GET tutorial:products::42"].join("\n"),
      },
      {
        title: "Find entries that never expire",
        text: [
          "TTL -1 means no expiry. Diagnostics → Memory analysis reports cache-like keys without a TTL as a recommendation, with the namespaces they are in.",
        ],
        script: "TTL tutorial:products::42",
      },
      {
        title: "Evict",
        text: [
          "@CacheEvict(key = ...) deletes one entry. @CacheEvict(allEntries = true) clears a cache with KEYS by default, which blocks Redis on big keyspaces; configure the cache writer with BatchStrategies.scan(1000) instead. UNLINK frees memory in the background.",
        ],
        code: {
          label: "Java (Spring Boot)",
          text: "RedisCacheWriter writer = RedisCacheWriter.nonLockingRedisCacheWriter(connectionFactory, BatchStrategies.scan(1000));",
        },
        script: "UNLINK tutorial:products::42",
      },
      {
        title: "Spring Session",
        text: [
          "Spring Session keeps each HTTP session in a hash named spring:session:sessions:<id> with an expiry equal to the session timeout. Read its fields with HSCAN rather than HGETALL when sessions hold large attributes.",
        ],
        script: 'SCAN 0 MATCH "spring:session:sessions:*" COUNT 200',
      },
    ],
  },
  {
    id: "node-cache",
    title: "Node.js caching patterns",
    summary: "Cache-aside with an expiry and jitter, a stampede lock, a fixed-window rate limit and invalidation.",
    kind: "Recipe",
    steps: [
      {
        title: "Cache-aside with an expiry",
        text: ["Read the cache; on a miss load from the database and write the value back with an expiry (EX seconds)."],
        code: {
          label: "JavaScript (node-redis)",
          text: [
            "const cached = await redis.get(`user:${id}`);",
            "if (cached) return JSON.parse(cached);",
            "const user = await db.users.find(id);",
            "await redis.set(`user:${id}`, JSON.stringify(user), { EX: 300 + Math.floor(Math.random() * 60) });",
            "return user;",
          ].join("\n"),
        },
        script: [`SET tutorial:node:user:42 '{"id":42,"name":"Ada"}' EX 317`, "GET tutorial:node:user:42", "TTL tutorial:node:user:42"].join("\n"),
      },
      {
        title: "Jitter the expiry",
        text: [
          "Entries written together with the same TTL expire together, and every client then reloads them at once. A random extra few seconds (the Math.random() above) spreads the expiries. Memory analysis flags keys that expire in the same minute.",
        ],
      },
      {
        title: "Stampede lock",
        text: [
          "Only the client that gets the lock reloads a hot entry; others wait briefly or serve the stale value. NX sets only when absent; PX expires the lock even if its holder crashes. The second SET below returns (nil): the lock is taken.",
        ],
        script: ["SET tutorial:node:lock:user:42 worker-1 NX PX 5000", "SET tutorial:node:lock:user:42 worker-2 NX PX 5000"].join("\n"),
      },
      {
        title: "Fixed-window rate limit",
        text: ["INCR counts requests in the current window; EXPIRE … NX sets the window's expiry only on the first request (Redis 7 or later)."],
        code: {
          label: "JavaScript (node-redis)",
          text: [
            "const key = `rate:${ip}:${Math.floor(Date.now() / 60000)}`;",
            "const n = await redis.incr(key);",
            "if (n === 1) await redis.expire(key, 60);",
            "if (n > 100) throw new TooManyRequests();",
          ].join("\n"),
        },
        script: ["INCR tutorial:node:rate:203.0.113.7", "EXPIRE tutorial:node:rate:203.0.113.7 60 NX", "TTL tutorial:node:rate:203.0.113.7"].join("\n"),
      },
      {
        title: "Invalidate on write",
        text: ["After updating the database, delete the cache entry so the next read loads the new value. UNLINK frees memory in the background."],
        script: "UNLINK tutorial:node:user:42",
      },
    ],
  },
];
