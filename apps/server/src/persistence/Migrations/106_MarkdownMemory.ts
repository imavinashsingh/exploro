import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_docs (
    doc_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('playbook', 'guide')), slug TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL, environment TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed')),
    routes_json TEXT NOT NULL, keywords_json TEXT NOT NULL, body TEXT NOT NULL,
    updated_at TEXT NOT NULL, sha256 TEXT NOT NULL, UNIQUE(project_id, kind, slug)
  )`;
  yield* sql`CREATE INDEX memory_docs_project_idx ON memory_docs(project_id, environment)`;
  yield* sql`CREATE VIRTUAL TABLE memory_docs_fts USING fts5(
    doc_id UNINDEXED, project_id UNINDEXED, title, keywords, body, tokenize = 'porter unicode61'
  )`;
  yield* sql`CREATE TABLE memory_proposals (
    proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_doc_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('playbook', 'guide')), title TEXT NOT NULL,
    proposed_markdown TEXT NOT NULL, rationale TEXT NOT NULL, source_run_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'dismissed')), created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX memory_proposals_project_idx ON memory_proposals(project_id, status)`;
});
