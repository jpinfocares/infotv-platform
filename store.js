// INFO TV APP - pure-JS datastore (no native modules, runs anywhere)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.DATA_ROOT || __dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'db.json');

const empty = { users: [], content: [], websites: [], groups: [], screens: [], playlist: [], seq: {} };
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
  db[table].push(row);
  saveNow();
  return row;
}
function all(table, pred) { return pred ? db[table].filter(pred) : db[table].slice(); }
function find(table, pred) { return db[table].find(pred); }
function update(table, id, patch) {
  const row = db[table].find(r => r.id === id);
  if (row) { Object.assign(row, patch); saveNow(); }
  return row;
}
function remove(table, pred) {
  const before = db[table].length;
  db[table] = db[table].filter(r => !pred(r));
  if (db[table].length !== before) saveNow();
}

load();

module.exports = { db, insert, all, find, update, remove, nextId, nowISO, saveNow };
