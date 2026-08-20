// INFO TV APP - pure-JS datastore (no native modules, runs anywhere)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.DATA_ROOT || __dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'db.json');

const empty = { users: [], content: [], websites: [], groups: [], screens: [], playlist: [], usage: [], seq: {} };
let db = empty;

function load() {
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const k of Object.keys(empty)) if (db[k] === undefined) db[k] = empty[k];
  } catch { db = JSON.parse(JSON.stringify(empty)); save(); }
}
let saveTimer = null;
function save() {
  // debounce writes so rapid ops don't thrash disk
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error('save error', e); }
  }, 50);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error('save error', e); }
}

function nextId(table) {
  db.seq[table] = (db.seq[table] || 0) + 1;
  return db.seq[table];
}
function nowISO() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// generic helpers
function insert(table, obj) {
  const row = Object.assign({ id: nextId(table), created_at: nowISO() }, obj);
  tbl(table).push(row);
  saveNow();
  return row;
}
function tbl(t) { if (!db[t]) db[t] = []; return db[t]; }
function all(table, pred) { const t = tbl(table); return pred ? t.filter(pred) : t.slice(); }
function find(table, pred) { return tbl(table).find(pred); }
function update(table, id, patch) {
  const row = tbl(table).find(r => r.id === id);
  if (row) { Object.assign(row, patch); saveNow(); }
  return row;
}
function remove(table, pred) {
  const t = tbl(table);
  const before = t.length;
  db[table] = t.filter(r => !pred(r));
  if (db[table].length !== before) saveNow();
}

load();

module.exports = { db, insert, all, find, update, remove, nextId, nowISO, saveNow };
