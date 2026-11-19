// Tiny JSON-file database. Good enough for a prototype and a few thousand
// questions; swap for Postgres/SQLite/Firestore behind the same functions
// when you scale (see README "Going to production").

import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ agents: [], labelers: [], queries: [], labels: [] });

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
    this._timer = null;
  }

  save() {
    if (!this.file) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this._timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---- generic helpers ----
  insert(collection, doc) { this.data[collection].push(doc); this.save(); return doc; }
  find(collection, pred) { return this.data[collection].find(pred); }
  filter(collection, pred) { return this.data[collection].filter(pred); }
  update(collection, id, patch) {
    const doc = this.data[collection].find((d) => d.id === id);
    if (!doc) return null;
    Object.assign(doc, patch);
    this.save();
    return doc;
  }
}
