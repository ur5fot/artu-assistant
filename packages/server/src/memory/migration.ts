import type Database from 'better-sqlite3';
import type { EmbeddingsClient } from './embeddings.js';

const KEY = 'embed_model';

function readStoredIdentity(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM memory_metadata WHERE key=?').get(KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeStoredIdentity(db: Database.Database, identity: string): void {
  db.prepare(
    `INSERT INTO memory_metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(KEY, identity);
}

function toBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

interface ReindexParams {
  db: Database.Database;
  embeddings: EmbeddingsClient;
  newIdentity: string;
}

async function wipeAndReindex({ db, embeddings, newIdentity }: ReindexParams): Promise<void> {
  const entries = db
    .prepare('SELECT id, content FROM memory_entries')
    .all() as Array<{ id: number; content: string }>;
  const facts = db
    .prepare(
      `SELECT id, key, value FROM memory_facts WHERE superseded_by IS NULL AND forgotten = 0`,
    )
    .all() as Array<{ id: number; key: string; value: string }>;

  console.log(
    `[memory] reindexing under ${newIdentity}: ${entries.length} entries, ${facts.length} facts`,
  );

  // Embeddings are awaited up-front so the schema rebuild + INSERTs run in a
  // single synchronous transaction (better-sqlite3 transactions must stay
  // synchronous — interleaved awaits would commit a half-rebuilt index).
  const entryVecs: Array<{ id: number; vec: number[] }> = [];
  for (const e of entries) {
    entryVecs.push({ id: e.id, vec: await embeddings.embedDocument(e.content) });
  }
  const factVecs: Array<{ id: number; vec: number[] }> = [];
  for (const f of facts) {
    factVecs.push({ id: f.id, vec: await embeddings.embedDocument(`${f.key}: ${f.value}`) });
  }

  const tx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS memory_vec_entries');
    db.exec('DROP TABLE IF EXISTS memory_vec_facts');
    db.exec(
      `CREATE VIRTUAL TABLE memory_vec_entries USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[${embeddings.dimension}] distance_metric=cosine
      )`,
    );
    db.exec(
      `CREATE VIRTUAL TABLE memory_vec_facts USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[${embeddings.dimension}] distance_metric=cosine
      )`,
    );

    const insE = db.prepare('INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)');
    for (const { id, vec } of entryVecs) {
      insE.run(BigInt(id), toBuffer(vec));
    }
    const insF = db.prepare('INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)');
    for (const { id, vec } of factVecs) {
      insF.run(BigInt(id), toBuffer(vec));
    }

    writeStoredIdentity(db, newIdentity);
  });
  tx();
}

export async function ensureEmbedModelMatches(
  db: Database.Database,
  embeddings: EmbeddingsClient,
): Promise<void> {
  const stored = readStoredIdentity(db);
  const current = embeddings.identity;

  if (stored === current) return;

  // stored===null is "first boot under this code version" — but the vec tables
  // may already exist at the OLD dimension (pre-1024 standard) because
  // `CREATE VIRTUAL TABLE IF NOT EXISTS … FLOAT[1024]` in db.ts is a no-op
  // when a 768-dim table is already there. Always run wipeAndReindex on the
  // null path so the schema gets rebuilt at `embeddings.dimension`. For a
  // truly empty DB this is a cheap DROP+CREATE with no embed calls.
  await wipeAndReindex({ db, embeddings, newIdentity: current });
}
