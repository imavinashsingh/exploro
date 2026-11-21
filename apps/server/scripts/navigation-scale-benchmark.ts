#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalJsonInEffect:off - Standalone benchmark owns synchronous fixture I/O, timing, and JSON reports.

import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Navigation from "../src/memory/ProjectNavigationMemory.ts";
import { navigationDestinationWords } from "../src/memory/navigation.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    states: { type: "string", default: "1000000" },
    db: { type: "string" },
    out: { type: "string", default: ".exploro/bench/navigation-results.json" },
    reuse: { type: "boolean", default: false },
    "skip-backfill": { type: "boolean", default: false },
  },
});
const count = Number(values.states);
if (!Number.isSafeInteger(count) || count < 10000)
  throw new Error("--states must be at least 10000");
if (!values.db) throw new Error("Pass --db <fresh path inside .exploro/bench>");
const bench = NodePath.resolve(import.meta.dirname, "../../../.exploro/bench");
NodeFS.mkdirSync(bench, { recursive: true });
const filename = NodePath.resolve(values.db);
if (!filename.startsWith(`${bench}/`))
  throw new Error("Fixture databases must be inside .exploro/bench");
if (
  NodeFS.existsSync(filename) &&
  !NodeFS.realpathSync(filename).startsWith(`${NodeFS.realpathSync(bench)}/`)
)
  throw new Error("Fixture database resolves outside .exploro/bench");
NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
if (
  !NodeFS.realpathSync(NodePath.dirname(filename)).startsWith(`${NodeFS.realpathSync(bench)}/`) &&
  NodeFS.realpathSync(NodePath.dirname(filename)) !== NodeFS.realpathSync(bench)
) {
  throw new Error("Fixture databases must be inside this worktree's .exploro/bench");
}
if (NodeFS.existsSync(filename) && !values.reuse)
  throw new Error("Database already exists; choose a fresh path or --reuse");
const project = ProjectId.make("scale-project");
const other = ProjectId.make("isolation-project");
const time = "2026-01-01T00:00:00.000Z";
const words = [
  "employee",
  "payroll",
  "benefits",
  "recruitment",
  "attendance",
  "leave",
  "expense",
  "report",
  "directory",
  "settings",
  "account",
  "profile",
  "salary",
  "training",
  "schedule",
  "review",
];
const id = (i: number) => `state-${String(i).padStart(9, "0")}`;
const edgeId = (i: number) => `edge-${String(i).padStart(10, "0")}`;
const groupsFor = (n: number) => {
  const weights = Array.from({ length: 40 }, (_, g) => 1 / (g + 1) ** 1.5);
  const sum = weights.reduce((a, b) => a + b, 0);
  const groups: Array<{ start: number; end: number; environment: string; pathGroup: string }> = [];
  let start = 0;
  for (let env = 0; env < 2; env++)
    for (let g = 0; g < 40; g++) {
      const end = env === 1 && g === 39 ? n : start + Math.floor(((n / 2) * weights[g]!) / sum);
      groups.push({
        start,
        end,
        environment: `https://hr-${env}.example.test`,
        pathGroup: g === 0 ? "/pim" : `/module${g}`,
      });
      start = end;
    }
  return groups;
};
const stateFor = (i: number, group: ReturnType<typeof groupsFor>[number]) => ({
  id: id(i),
  name: `${i === 777 ? "zygomorphic " : ""}${words[i % words.length]} employee ${i}`,
  aliases: [`staff profile ${i}`],
  environment: group.environment,
  path: `${group.pathGroup}/viewEmployee/${i}`,
  context: { authenticated: "true" },
  checks: [{ kind: "textVisible" as const, text: `Employee ${i}` }],
});

// Fixture writes bypass observe, retaining only a transaction-sized batch in memory.
function load(path: string, n: number, legacy: boolean) {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-262144; PRAGMA wal_autocheckpoint=4096;",
  );
  const indexes = db
    .prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN
    ('project_navigation_states', 'project_navigation_terms', 'project_navigation_connections',
     'project_navigation_observations', 'project_navigation_feedback')`)
    .all();
  // Rebuild the real secondary indexes in order, rather than churning their pages per row.
  for (const index of indexes) db.exec(`DROP INDEX "${String(index.name).replaceAll('"', '""')}"`);
  const groups = groupsFor(n);
  const stateInsert = db.prepare(
    legacy
      ? "INSERT INTO project_navigation_states(project_id,state_id,data) VALUES(?,?,?)"
      : "INSERT INTO project_navigation_states(project_id,state_id,data,environment,path,path_group,check_count) VALUES(?,?,?,?,?,?,1)",
  );
  const termInsert = legacy
    ? null
    : db.prepare("INSERT INTO project_navigation_terms VALUES(?,?,?,?,?)");
  const ftsInsert = legacy
    ? null
    : db.prepare("INSERT INTO project_navigation_search(rowid,text) VALUES(?,?)");
  db.exec("BEGIN");
  for (const group of groups)
    for (let i = group.start; i < group.end; i++) {
      const state = stateFor(i, group);
      const result = legacy
        ? stateInsert.run(project, state.id, JSON.stringify(state))
        : stateInsert.run(
            project,
            state.id,
            JSON.stringify(state),
            state.environment,
            state.path,
            group.pathGroup,
          );
      if (termInsert && ftsInsert) {
        const names = [state.name, ...state.aliases].map((s) => s.toLowerCase());
        for (const term of [state.id, ...names])
          termInsert.run(project, state.environment, "name", term, state.id);
        for (const term of navigationDestinationWords(names.join(" ")))
          termInsert.run(project, state.environment, "word", term, state.id);
        ftsInsert.run(result.lastInsertRowid, `${names.join(" ")} ${state.path.toLowerCase()}`);
      }
      if (i % 10000 === 9999) db.exec("COMMIT; BEGIN");
    }
  const small = stateFor(0, groups[0]!);
  stateInsert.run(
    ...(legacy
      ? [other, small.id, JSON.stringify(small)]
      : [other, small.id, JSON.stringify(small), small.environment, small.path, "/pim"]),
  );
  if (termInsert && ftsInsert) {
    const row = db
      .prepare("SELECT rowid FROM project_navigation_states WHERE project_id=?")
      .get(other)!;
    ftsInsert.run(row.rowid!, `${small.name} ${small.aliases.join(" ")} ${small.path}`);
    for (const term of [small.id, small.name, ...small.aliases])
      termInsert.run(other, small.environment, "name", term, small.id);
    for (const term of navigationDestinationWords(`${small.name} ${small.aliases.join(" ")}`))
      termInsert.run(other, small.environment, "word", term, small.id);
  }
  db.exec("COMMIT");
  console.error(`Loaded ${n} states; loading connections and observations`);
  const connectionInsert = legacy
    ? null
    : db.prepare(
        "INSERT INTO project_navigation_connections(project_id,transition_id,from_state_id,to_state_id,action,conditions_json,last_run_id,last_thread_id,last_observed_at,observation_count,last_mismatch_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );
  const observationInsert = db.prepare(
    `INSERT INTO project_navigation_observations(observation_id,project_id,thread_id,run_id,tab_id,state_id,step_index,transition_json,observed_at${legacy ? "" : ",transition_id"}) VALUES(${Array.from({ length: legacy ? 9 : 10 }, () => "?").join(",")})`,
  );
  const feedbackInsert = db.prepare("INSERT INTO project_navigation_feedback VALUES(?,?,?,?,?,?)");
  let e = 0;
  const incoming = new Int32Array(n);
  const outgoing = new Int32Array(n);
  const insert = (from: number, to: number) => {
    const transition = {
      id: edgeId(e),
      from: id(from),
      to: id(to),
      action: `Open employee ${to}`,
      conditions: { authenticated: "true" },
      runId: `run-${e % 5000}`,
      threadId: `thread-${e % 100}`,
      observedAt: time,
      available: true,
    };
    const mismatch = e % 37 === 0 ? "2026-01-02T00:00:00.000Z" : null;
    const repeats = e % 2 === 0 ? 2 : 1;
    connectionInsert?.run(
      project,
      transition.id,
      transition.from,
      transition.to,
      transition.action,
      JSON.stringify(transition.conditions),
      transition.runId,
      transition.threadId,
      time,
      repeats,
      mismatch,
    );
    for (let j = 0; j < repeats; j++) {
      const args = [
        `observation-${e}-${j}`,
        project,
        transition.threadId,
        transition.runId,
        `tab-${from}`,
        transition.to,
        e,
        JSON.stringify(transition),
        time,
      ];
      observationInsert.run(...(legacy ? args : [...args, transition.id]));
    }
    if (mismatch)
      feedbackInsert.run(
        `feedback-${e}`,
        project,
        transition.id,
        transition.runId,
        "mismatch",
        mismatch,
      );
    incoming[to]!++;
    outgoing[from]!++;
    e++;
    if (e % 5000 === 0) db.exec("COMMIT; BEGIN");
    if (e % 500000 === 0) console.error(`Loaded ${e} connections`);
  };
  db.exec("BEGIN");
  for (const [g, group] of groups.entries())
    for (let i = group.start; i < group.end - 1; i++) {
      for (let offset = 1; offset <= 2; offset++)
        insert(
          i,
          group.start + ((i - group.start + offset) % Math.max(1, group.end - group.start - 1)),
        );
      if (i % 5 < 2)
        insert(
          i,
          i % 20 === 0
            ? groups[(g + 1) % groups.length]!.start + 1
            : group.start + ((i * 13 + 17) % Math.max(1, group.end - group.start - 1)),
        );
    }
  for (let h = 0; h < 20; h++) {
    const group = groups[h % 2 === 0 ? 0 : 40]!;
    const degree = Math.min(Math.floor(n * (0.01 + (h * 0.04) / 19)), group.end - group.start - 2);
    for (let j = 0; j < degree; j++) insert(group.start + h, group.start + 30 + j);
  }
  db.exec("COMMIT");
  if (!legacy) {
    const update = db.prepare(
      "UPDATE project_navigation_states SET incoming_count=?,outgoing_count=? WHERE project_id=? AND state_id=?",
    );
    db.exec("BEGIN");
    for (let i = 0; i < n; i++) update.run(incoming[i]!, outgoing[i]!, project, id(i));
    db.exec("COMMIT");
  }
  for (const index of indexes) db.exec(String(index.sql));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.error(`Loaded ${e} connections (~${Math.round(e * 1.5)} observations)`);
}

const databaseLayer = (path: string) =>
  NodeSqliteClient.layer({ filename: path, readerWorker: true, writerWorker: true });
const migrate = async (path: string, through?: number) => {
  const runtime = ManagedRuntime.make(databaseLayer(path));
  try {
    await runtime.runPromise(runMigrations({ toMigrationInclusive: through }));
  } finally {
    await runtime.dispose();
  }
};
if (!values.reuse) {
  await migrate(filename);
  load(filename, count, false);
}
// --reuse also accepts a Phase 1 fixture so before/after runs share identical rows.
{
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec(`CREATE TABLE IF NOT EXISTS project_navigation_clusters (
    project_id TEXT NOT NULL, environment TEXT NOT NULL, path_group TEXT NOT NULL,
    state_count INTEGER NOT NULL, incoming_count INTEGER NOT NULL, outgoing_count INTEGER NOT NULL,
    PRIMARY KEY(project_id,environment,path_group)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS project_navigation_cluster_connections (
    project_id TEXT NOT NULL, from_environment TEXT NOT NULL, from_path_group TEXT NOT NULL,
    to_environment TEXT NOT NULL, to_path_group TEXT NOT NULL, connection_count INTEGER NOT NULL,
    PRIMARY KEY(project_id,from_environment,from_path_group,to_environment,to_path_group)) WITHOUT ROWID;
    BEGIN;
    DELETE FROM project_navigation_clusters;
    DELETE FROM project_navigation_cluster_connections;
    INSERT INTO project_navigation_clusters
    SELECT project_id,environment,path_group,COUNT(*),SUM(incoming_count),SUM(outgoing_count)
      FROM project_navigation_states GROUP BY project_id,environment,path_group;
    INSERT INTO project_navigation_cluster_connections
    SELECT c.project_id,f.environment,f.path_group,t.environment,t.path_group,COUNT(*)
      FROM project_navigation_connections c
      JOIN project_navigation_states f ON f.project_id=c.project_id AND f.state_id=c.from_state_id
      JOIN project_navigation_states t ON t.project_id=c.project_id AND t.state_id=c.to_state_id
      GROUP BY c.project_id,f.environment,f.path_group,t.environment,t.path_group;
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);`);
  db.close();
}
const runtime = ManagedRuntime.make(
  Navigation.layer.pipe(
    Layer.provideMerge(Sqlite.layerFromPath(filename)),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  ),
);
const memory = await runtime.runPromise(Navigation.ProjectNavigationMemory);
const rows: Array<{
  query: string;
  iterations: number;
  p50: number;
  p95: number;
  max: number;
  bytes: number;
}> = [];
async function measure<A, E>(
  query: string,
  operation: Effect.Effect<A, E>,
  rollback = false,
  iterations = 20,
) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = -3; i < iterations; i++) {
    const timed = Effect.gen(function* () {
      const start = performance.now();
      const result = yield* operation;
      const elapsed = performance.now() - start;
      if (i >= 0) {
        times.push(elapsed);
        bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(result ?? null)));
      }
    });
    await runtime.runPromise(
      rollback
        ? Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql
              .withTransaction(
                timed.pipe(Effect.andThen(Effect.fail("benchmark-rollback" as const))),
              )
              .pipe(
                Effect.catchIf(
                  (e) => e === "benchmark-rollback",
                  () => Effect.void,
                ),
              );
          })
        : timed,
    );
  }
  times.sort((a, b) => a - b);
  const row = {
    query,
    iterations,
    p50: times[Math.ceil(times.length * 0.5) - 1]!,
    p95: times[Math.ceil(times.length * 0.95) - 1]!,
    max: times.at(-1)!,
    bytes,
  };
  rows.push(row);
  console.error(`${query}: p95=${row.p95.toFixed(2)} ms, ${bytes} bytes`);
}
try {
  const groups = groupsFor(count);
  const group = groups[0]!;
  const base = { projectId: project, limit: 50 };
  await measure("overview", memory.navigationOverview({ projectId: project }));
  await measure("overview/isolation", memory.navigationOverview({ projectId: other }));
  await measure(
    "children/first",
    memory.navigationChildren({
      ...base,
      environment: group.environment,
      pathGroup: group.pathGroup,
    }),
  );
  await measure(
    "children/deep",
    memory.navigationChildren({
      ...base,
      environment: group.environment,
      pathGroup: group.pathGroup,
      cursor: Buffer.from(JSON.stringify(id(Math.floor(group.end * 0.9)))).toString("base64url"),
    }),
  );
  for (const [label, stateId] of [
    ["normal", id(1000)],
    ["hub", id(groups[40]!.start + 19)],
  ] as const)
    for (const filter of ["all", "available", "needs-recheck"] as const)
      await measure(
        `neighborhood/${label}/${filter}`,
        memory.navigationNeighborhood({ ...base, stateId, filter }),
      );
  for (const query of ["em", "employee", "zygomorphic", "nosuchwordxqz"])
    await measure(`search/${query}`, memory.navigationSearch({ ...base, query }));
  await measure(
    "details/hub",
    memory.navigationDetails({ projectId: project, stateId: id(groups[40]!.start + 19) }),
  );
  for (const [label, from, to] of [
    ["short", 1001, 1002],
    ["cross-group", 1000, groups[1]!.start + 1],
    ["unreachable", 1000, count - 1],
  ] as const)
    await measure(
      `route-preview/${label}`,
      memory.navigationRoutePreview({
        projectId: project,
        fromStateId: id(from),
        toStateId: id(to),
      }),
    );
  await measure(
    "recognize/address",
    memory.statesAtAddress(project, group.environment, stateFor(1000, group).path),
  );
  await measure(
    "destination/exact",
    memory.destinations(project, group.environment, stateFor(1000, group).name),
  );
  await measure("destination/loose", memory.destinations(project, group.environment, "employees"));
  await measure(
    "agent/route",
    memory.navigationRoute(project, id(1001), stateFor(1002, group).name),
  );
  const writeSource = await runtime.runPromise(
    memory.observe(project, {
      state: stateFor(1000, group),
      runId: "benchmark-write",
      threadId: "benchmark",
      tabId: "tab",
      stepIndex: 0,
    }),
  );
  const writeState = { ...stateFor(count + 1, group), name: "Benchmark write employee" };
  await measure(
    "observe",
    memory.observe(project, {
      state: writeState,
      runId: "benchmark-write",
      threadId: "benchmark",
      tabId: "tab",
      stepIndex: 1,
      action: "Open profile",
    }),
    true,
  );
  await runtime.runPromise(memory.deleteRecord(project, writeSource.id));
  await measure(
    "feedback",
    memory.feedback(project, "benchmark-feedback", edgeId(10), "mismatch"),
    true,
  );
  await measure("deleteRecord/hub", memory.deleteRecord(project, id(groups[40]!.start + 19)), true);
} finally {
  await runtime.dispose();
}
let backfillMs: number | null = null;
if (!values["skip-backfill"]) {
  const legacy = `${filename}.${values.reuse ? "after" : "before"}.pre105`;
  if (NodeFS.existsSync(legacy)) throw new Error(`Legacy fixture already exists: ${legacy}`);
  await migrate(legacy, 104);
  load(legacy, 100000, true);
  const start = performance.now();
  await migrate(legacy);
  backfillMs = performance.now() - start;
}
const db = new NodeSqlite.DatabaseSync(filename);
db.exec("PRAGMA temp_store=MEMORY");
const groupByBaseline = [];
for (const [query, statement] of [
  [
    "overview/GROUP-BY-states",
    "SELECT environment,path_group,COUNT(*),SUM(incoming_count),SUM(outgoing_count) FROM project_navigation_states WHERE project_id='scale-project' GROUP BY environment,path_group ORDER BY environment,path_group LIMIT 201",
  ],
  [
    "overview/GROUP-BY-connections",
    "SELECT f.environment,f.path_group,t.environment,t.path_group,COUNT(*) AS count FROM project_navigation_connections c JOIN project_navigation_states f ON f.project_id=c.project_id AND f.state_id=c.from_state_id JOIN project_navigation_states t ON t.project_id=c.project_id AND t.state_id=c.to_state_id WHERE c.project_id='scale-project' GROUP BY f.environment,f.path_group,t.environment,t.path_group ORDER BY count DESC,f.environment,f.path_group,t.environment,t.path_group LIMIT 201",
  ],
] as const) {
  const prepared = db.prepare(statement);
  const times = [];
  let bytes = 0;
  for (let i = -1; i < 5; i++) {
    const start = performance.now();
    const result = prepared.all();
    const elapsed = performance.now() - start;
    if (i >= 0) times.push(elapsed);
    bytes = Buffer.byteLength(JSON.stringify(result));
  }
  times.sort((a, b) => a - b);
  groupByBaseline.push({
    query,
    iterations: times.length,
    p50: times[2]!,
    p95: times.at(-1)!,
    max: times.at(-1)!,
    bytes,
  });
  console.error(`${query}: p95=${times.at(-1)!.toFixed(2)} ms`);
}
const fixture = {
  states: db
    .prepare("SELECT COUNT(*) AS count FROM project_navigation_states WHERE project_id=?")
    .get(project)!.count,
  connections: db
    .prepare("SELECT COUNT(*) AS count FROM project_navigation_connections WHERE project_id=?")
    .get(project)!.count,
  observations: db
    .prepare("SELECT COUNT(*) AS count FROM project_navigation_observations WHERE project_id=?")
    .get(project)!.count,
  hubs: db
    .prepare(
      "SELECT state_id,incoming_count,outgoing_count FROM project_navigation_states WHERE project_id=? ORDER BY outgoing_count DESC LIMIT 20",
    )
    .all(project),
};
const plans = Object.fromEntries(
  [
    [
      "overview-states",
      "SELECT environment,path_group,COUNT(*),SUM(incoming_count),SUM(outgoing_count) FROM project_navigation_states WHERE project_id='scale-project' GROUP BY environment,path_group",
    ],
    [
      "overview-connections",
      "SELECT f.environment,f.path_group,t.environment,t.path_group,COUNT(*) FROM project_navigation_connections c JOIN project_navigation_states f ON f.project_id=c.project_id AND f.state_id=c.from_state_id JOIN project_navigation_states t ON t.project_id=c.project_id AND t.state_id=c.to_state_id WHERE c.project_id='scale-project' GROUP BY f.environment,f.path_group,t.environment,t.path_group",
    ],
    [
      "overview-stored",
      "SELECT * FROM project_navigation_clusters WHERE project_id='scale-project' ORDER BY environment,path_group LIMIT 201",
    ],
    [
      "overview-connections-stored",
      "SELECT * FROM project_navigation_cluster_connections WHERE project_id='scale-project' ORDER BY connection_count DESC,from_environment,from_path_group,to_environment,to_path_group LIMIT 201",
    ],
    [
      "search-probe",
      `SELECT s.state_id FROM
      (SELECT rowid,state_id FROM project_navigation_states WHERE project_id='scale-project' AND state_id>'' ORDER BY state_id LIMIT 256) s
      WHERE EXISTS(SELECT 1 FROM project_navigation_search f WHERE f.rowid=s.rowid AND project_navigation_search MATCH '"employee"')
      ORDER BY s.state_id LIMIT 51`,
    ],
    [
      "route-batch",
      `SELECT c.transition_id,s.data FROM json_each('[{"id":"state-000001000","ordinal":0}]') f
      CROSS JOIN project_navigation_connections c ON c.rowid IN (
        SELECT rowid FROM project_navigation_connections WHERE project_id='scale-project'
        AND from_state_id=json_extract(f.value,'$.id') AND available=1 ORDER BY transition_id LIMIT 2001)
      LEFT JOIN project_navigation_states s ON s.project_id=c.project_id AND s.state_id=c.to_state_id
      ORDER BY CAST(json_extract(f.value,'$.ordinal') AS INTEGER),c.transition_id LIMIT 2001`,
    ],
    [
      "search-short",
      "SELECT DISTINCT state_id FROM (SELECT state_id FROM project_navigation_terms WHERE project_id='scale-project' AND kind='word' AND term>='em' AND term<'en' LIMIT -1) ORDER BY state_id LIMIT 51",
    ],
    [
      "search-common",
      `SELECT s.state_id FROM project_navigation_search f CROSS JOIN project_navigation_states s ON s.rowid=f.rowid WHERE project_navigation_search MATCH '"employee"' AND s.project_id='scale-project' ORDER BY s.state_id LIMIT 51`,
    ],
  ].map(([name, sql]) => [name, db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()]),
);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
const results = {
  states: count,
  fixture,
  reusedFixture: values.reuse,
  rows,
  backfillMs,
  groupByBaseline,
  databaseBytes: NodeFS.statSync(filename).size,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  plans,
  node: process.version,
  notes:
    "20 iterations after 3 warmups; writes rolled back outside timed region; agent paths use memory methods called by NavigationCapture",
};
const out = NodePath.resolve(values.out);
NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
NodeFS.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log("| Query | p50 ms | p95 ms | max ms | JSON bytes |\n|---|---:|---:|---:|---:|");
for (const row of rows)
  console.log(
    `| ${row.query} | ${row.p50.toFixed(2)} | ${row.p95.toFixed(2)} | ${row.max.toFixed(2)} | ${row.bytes} |`,
  );
console.log(
  `\nBackfill (100k): ${backfillMs?.toFixed(2) ?? "skipped"} ms; DB: ${results.databaseBytes} bytes; peak RSS: ${results.peakRssBytes} bytes. JSON: ${out}`,
);
