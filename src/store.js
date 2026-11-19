// Where Nuance Hub keeps its data.
//
// The app works on an in-memory copy of the data (fast, simple code), and
// this store keeps that copy in step with real storage:
//
//   * Postgres (DATABASE_URL or POSTGRES_URL set) — for hosting, e.g. on Vercel
//     with Neon. Every request first pulls whatever other servers changed since
//     its last look (one small query), and saves its own changes before the
//     reply goes out, so many server instances can run side by side.
//   * A JSON file (NUANCE_DATA_FILE) — for running on your own computer.
//   * Memory only (dataFile: null) — for tests; nothing is kept.

import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['agents', 'labelers', 'queries', 'labels', 'checks'];
const EMPTY = () => Object.fromEntries(COLLECTIONS.map((c) => [c, []]));

export class Store {
  constructor({ file = null, databaseUrl = null } = {}) {
    this.file = file;
    this.databaseUrl = databaseUrl;
    this.data = EMPTY();
    this.dirty = new Map(); // "collection id" -> [collection, id]
    this.lastSeq = 0;
    this._timer = null;
    if (!databaseUrl && file && fs.existsSync(file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  }

  get kind() { return this.databaseUrl ? 'postgres' : this.file ? 'file' : 'memory'; }

  // ---- reading and writing (synchronous, on the in-memory copy) ----
  insert(collection, doc) { this.data[collection].push(doc); this._touch(collection, doc.id); return doc; }
  find(collection, pred) { return this.data[collection].find(pred); }
  filter(collection, pred) { return this.data[collection].filter(pred); }
  update(collection, id, patch) {
    const doc = this.data[collection].find((d) => d.id === id);
    if (!doc) return null;
    Object.assign(doc, patch);
    this._touch(collection, id);
    return doc;
  }

  _touch(collection, id) {
    this.dirty.set(`${collection} ${id}`, [collection, id]);
    if (this.kind === 'file') { clearTimeout(this._timer); this._timer = setTimeout(() => this.flush(), 50); }
  }

  // ---- keeping in step with storage (called around every request) ----
  async sync() {
    if (this.kind !== 'postgres') return;
    const pool = await this._pool();
    const { rows } = await pool.query('SELECT collection, id, data, seq FROM nuance_docs WHERE seq > $1 ORDER BY seq', [this.lastSeq]);
    for (const r of rows) {
      const list = this.data[r.collection];
      if (!list) continue;
      const i = list.findIndex((d) => d.id === r.id);
      if (i >= 0) list[i] = r.data; else list.push(r.data);
      this.lastSeq = Math.max(this.lastSeq, Number(r.seq));
    }
  }

  async commit() {
    if (this.kind === 'file') return this.flush();
    if (this.kind !== 'postgres' || !this.dirty.size) { this.dirty.clear(); return; }
    const items = [...this.dirty.values()];
    this.dirty.clear();
    const pool = await this._pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [collection, id] of items) {
        const doc = this.data[collection].find((d) => d.id === id);
        if (!doc) continue;
        await client.query(
          `INSERT INTO nuance_docs (collection, id, data, seq) VALUES ($1, $2, $3, nextval('nuance_seq'))
           ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, seq = EXCLUDED.seq`,
          [collection, id, JSON.stringify(doc)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      for (const [collection, id] of items) this.dirty.set(`${collection} ${id}`, [collection, id]);
      throw err;
    } finally {
      client.release();
    }
  }

  flush() {
    clearTimeout(this._timer);
    this.dirty.clear();
    if (this.kind !== 'file') return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  async close() {
    if (this._poolPromise) (await this._poolPromise).end();
  }

  _pool() {
    if (!this._poolPromise) {
      this._poolPromise = (async () => {
        const { default: pg } = await import('pg');
        // Hosted databases (Neon, Supabase, …) put "sslmode=require" in their address,
        // which turns on verified encryption; local ones don't need it.
        const pool = new pg.Pool({ connectionString: this.databaseUrl, max: 3 });
        await pool.query(`
          CREATE SEQUENCE IF NOT EXISTS nuance_seq;
          CREATE TABLE IF NOT EXISTS nuance_docs (
            collection text NOT NULL,
            id text NOT NULL,
            data jsonb NOT NULL,
            seq bigint NOT NULL,
            PRIMARY KEY (collection, id)
          );
          CREATE INDEX IF NOT EXISTS nuance_docs_seq ON nuance_docs (seq);
        `);
        return pool;
      })();
      this._poolPromise.catch(() => { this._poolPromise = null; });
    }
    return this._poolPromise;
  }
}
