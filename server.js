// INFO TV APP - digital signage platform server (no native dependencies)
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- file uploads (persistent disk aware) ----------
const UPLOAD_DIR = path.join(process.env.DATA_ROOT || __dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Track bandwidth: count a content file's size against its owner when a TV loads it
app.use('/uploads', (req, res, next) => {
  try {
    const fname = decodeURIComponent((req.path || '').replace(/^\//, ''));
    const range = req.headers.range;
    // count once per full load (ignore seek/range re-requests to avoid over-counting)
    if (fname && (!range || /^bytes=0-/.test(range))) {
      const c = store.find('content', x => x.filename === fname);
      if (c && c.user_id && c.size) addUsage(c.user_id, c.size);
    }
  } catch (e) {}
  next();
});
app.use('/uploads', express.static(UPLOAD_DIR));

function today() { return new Date().toISOString().slice(0, 10); }
function addUsage(userId, bytes) {
  const day = today();
  let row = store.find('usage', u => u.user_id === userId && u.day === day);
  if (row) store.update('usage', row.id, { bytes: (row.bytes || 0) + bytes });
  else store.insert('usage', { user_id: userId, day, bytes });
}
function sumUsage(userId, from, to) {
  return store.all('usage', u => u.user_id === userId && (!from || u.day >= from) && (!to || u.day <= to))
    .reduce((s, r) => s + (r.bytes || 0), 0);
}

// ---------- file uploads ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, crypto.randomBytes(10).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ---------- auth helpers ----------
function sign(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired, sign in again' }); }
}

// ================= AUTH =================
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (store.find('users', u => u.email === email))
    return res.status(409).json({ error: 'An account with this email already exists' });
  const hash = bcrypt.hashSync(password, 10);
  const isFirst = store.all('users').length === 0;
  const user = store.insert('users', {
    email, password_hash: hash, name: name || email.split('@')[0],
    role: isFirst ? 'admin' : 'user',
    approved: isFirst ? 1 : 0
  });
  if (!user.approved) {
    return res.json({ pending: true, message: 'Account created. An admin must approve it before you can sign in.' });
  }
  res.json({ token: sign(user), user: { id: user.id, email, name: user.name, role: user.role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = store.find('users', u => u.email === email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'Wrong email or password' });
  if (!user.approved)
    return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
  res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get('/api/me', auth, (req, res) => {
  const u = store.find('users', x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role || 'user', approved: u.approved ? 1 : 0 });
});

// ---- admin middleware ----
function admin(req, res, next) {
  const u = store.find('users', x => x.id === req.user.id);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Bandwidth usage — current user's own total for a date range
app.get('/api/usage', auth, (req, res) => {
  const from = req.query.from || '', to = req.query.to || '';
  res.json({ bytes: sumUsage(req.user.id, from, to), from, to });
});
// Bandwidth usage — admin sees every user for a date range
app.get('/api/admin/usage', auth, admin, (req, res) => {
  const from = req.query.from || '', to = req.query.to || '';
  const rows = store.all('users').map(u => ({
    id: u.id, email: u.email, name: u.name,
    bytes: sumUsage(u.id, from, to)
  })).sort((a, b) => b.bytes - a.bytes);
  res.json({ from, to, users: rows });
});

// ---- subscription / plan helpers ----
function subActive(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const now = Date.now();
  if (user.sub_start) { const s = new Date(user.sub_start + 'T00:00:00Z').getTime(); if (!isNaN(s) && now < s) return false; }
  if (user.sub_expiry) { const e = new Date(user.sub_expiry + 'T23:59:59Z').getTime(); if (!isNaN(e) && now > e) return false; }
  return true;
}
function screenLimit(user) {
  if (!user) return 0;
  if (user.role === 'admin') return 0; // 0 = unlimited
  return user.screen_limit == null ? 1 : Number(user.screen_limit);
}
function screenActive(screen) {
  // per-screen date window (independent of user subscription)
  if (!screen) return false;
  const now = Date.now();
  if (screen.start_date) { const s = new Date(screen.start_date + 'T00:00:00Z').getTime(); if (!isNaN(s) && now < s) return false; }
  if (screen.expiry_date) { const e = new Date(screen.expiry_date + 'T23:59:59Z').getTime(); if (!isNaN(e) && now > e) return false; }
  return true;
}

// ================= ADMIN: USER MANAGEMENT =================
app.get('/api/admin/users', auth, admin, (req, res) => {
  res.json(store.all('users').map(u => ({
    id: u.id, email: u.email, name: u.name, role: u.role || 'user',
    approved: u.approved ? 1 : 0, created_at: u.created_at,
    screen_limit: u.screen_limit == null ? 1 : Number(u.screen_limit),
    sub_start: u.sub_start || '', sub_expiry: u.sub_expiry || '',
    screens_used: store.all('screens', s => s.user_id === u.id).length,
    active: subActive(u)
  })).reverse());
});
app.post('/api/admin/users', auth, admin, (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (store.find('users', u => u.email === email))
    return res.status(409).json({ error: 'An account with this email already exists' });
  const u = store.insert('users', {
    email, password_hash: bcrypt.hashSync(password, 10),
    name: name || email.split('@')[0], role: role === 'admin' ? 'admin' : 'user', approved: 1
  });
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role, approved: 1 });
});
app.patch('/api/admin/users/:id', auth, admin, (req, res) => {
  const id = +req.params.id;
  const u = store.find('users', x => x.id === id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const patch = {};
  if (req.body.approved !== undefined) patch.approved = req.body.approved ? 1 : 0;
  if (req.body.role !== undefined) patch.role = req.body.role === 'admin' ? 'admin' : 'user';
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.password) patch.password_hash = bcrypt.hashSync(req.body.password, 10);
  if (req.body.screen_limit !== undefined) patch.screen_limit = Math.max(0, Number(req.body.screen_limit) || 0);
  if (req.body.sub_start !== undefined) patch.sub_start = req.body.sub_start || '';
  if (req.body.sub_expiry !== undefined) patch.sub_expiry = req.body.sub_expiry || '';
  store.update('users', id, patch);
  const n = store.find('users', x => x.id === id);
  res.json({ id: n.id, email: n.email, name: n.name, role: n.role, approved: n.approved });
});
app.delete('/api/admin/users/:id', auth, admin, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  store.remove('users', u => u.id === id);
  res.json({ ok: true });
});

// Admin: all screens across users (for approval / oversight)
app.get('/api/admin/screens', auth, admin, (req, res) => {
  const rows = store.all('screens', s => s.paired).map(s => {
    const owner = store.find('users', u => u.id === s.user_id);
    return {
      id: s.id, name: s.name, device_id: s.device_id,
      owner_email: owner ? owner.email : '(none)',
      approved: s.approved ? 1 : 0, paused: s.paused ? 1 : 0,
      start_date: s.start_date || '', expiry_date: s.expiry_date || '',
      active: screenActive(s), last_seen: s.last_seen || null
    };
  }).reverse();
  res.json(rows);
});
// Admin: a specific user's content + websites (oversight)
app.get('/api/admin/users/:id/library', auth, admin, (req, res) => {
  const uid = +req.params.id;
  const owner = store.find('users', u => u.id === uid);
  if (!owner) return res.status(404).json({ error: 'User not found' });
  const base = baseUrl(req);
  const content = store.all('content', c => c.user_id === uid).reverse().map(c => ({
    id: c.id, title: c.title, type: c.type, filename: c.filename,
    url: `${base}/uploads/${c.filename}`, size: c.size || 0, created_at: c.created_at
  }));
  const websites = store.all('websites', w => w.user_id === uid).reverse().map(w => ({
    id: w.id, title: w.title, url: w.url, duration: w.duration, created_at: w.created_at
  }));
  res.json({ email: owner.email, name: owner.name, content, websites });
});
// Admin: delete any user's content
app.delete('/api/admin/content/:id', auth, admin, (req, res) => {
  const id = +req.params.id;
  const row = store.find('content', c => c.id === id);
  if (!row) return res.status(404).json({ error: 'Content not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, row.filename)); } catch {}
  store.remove('content', c => c.id === id);
  store.remove('playlist', p => p.item_type === 'content' && p.item_id === id);
  res.json({ ok: true });
});
// Admin: delete any user's website
app.delete('/api/admin/websites/:id', auth, admin, (req, res) => {
  const id = +req.params.id;
  store.remove('websites', w => w.id === id);
  store.remove('playlist', p => p.item_type === 'website' && p.item_id === id);
  res.json({ ok: true });
});
app.patch('/api/admin/screens/:id', auth, admin, (req, res) => {
  const id = +req.params.id;
  const s = store.find('screens', x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Screen not found' });
  const patch = {};
  if (req.body.approved !== undefined) patch.approved = req.body.approved ? 1 : 0;
  if (req.body.paused !== undefined) patch.paused = req.body.paused ? 1 : 0;
  if (req.body.start_date !== undefined) patch.start_date = req.body.start_date || '';
  if (req.body.expiry_date !== undefined) patch.expiry_date = req.body.expiry_date || '';
  store.update('screens', id, patch);
  res.json({ ok: true });
});

// ================= CONTENT =================
app.get('/api/content', auth, (req, res) => {
  res.json(store.all('content', c => c.user_id === req.user.id).reverse());
});
app.post('/api/content', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const type = (req.file.mimetype || '').startsWith('video') ? 'video' : 'image';
  const row = store.insert('content', {
    user_id: req.user.id,
    title: req.body.title || req.file.originalname,
    filename: req.file.filename,
    type,
    orientation: req.body.orientation || 'landscape',
    duration: type === 'video' ? 0 : 10,
    size: req.file.size
  });
  res.json(row);
});
app.delete('/api/content/:id', auth, (req, res) => {
  const id = +req.params.id;
  const row = store.find('content', c => c.id === id && c.user_id === req.user.id);
  if (!row) return res.status(404).json({ error: 'Content not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, row.filename)); } catch {}
  store.remove('content', c => c.id === id);
  store.remove('playlist', p => p.item_type === 'content' && p.item_id === id);
  res.json({ ok: true });
});
app.patch('/api/content/:id', auth, (req, res) => {
  const id = +req.params.id;
  const row = store.find('content', c => c.id === id && c.user_id === req.user.id);
  if (!row) return res.status(404).json({ error: 'Content not found' });
  const patch = {};
  if (req.body.title !== undefined) patch.title = req.body.title;
  if (req.body.duration !== undefined) { const d = Number(req.body.duration); patch.duration = isNaN(d) ? 0 : d; }
  res.json(store.update('content', id, patch));
});

// ================= WEBSITES =================
app.get('/api/websites', auth, (req, res) => {
  res.json(store.all('websites', w => w.user_id === req.user.id).reverse());
});
// Turn any YouTube link into a clean autoplaying embed URL.
// Handles: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID, /shorts/ID, /live/ID
function youtubeEmbed(url) {
  try {
    let id = null;
    const u = String(url).trim();
    let m;
    if ((m = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/\/embed\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/\/shorts\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/\/live\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    if (!id) return null;
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=0&controls=0&rel=0&playsinline=1&loop=1&playlist=${id}`;
  } catch { return null; }
}

app.post('/api/websites', auth, (req, res) => {
  const { title, url, duration } = req.body || {};
  if (!url) return res.status(400).json({ error: 'A website URL is required' });
  const isYT = /youtube\.com|youtu\.be/.test(url);
  const finalUrl = isYT ? (youtubeEmbed(url) || url) : url;
  res.json(store.insert('websites', { user_id: req.user.id, title: title || url, url: finalUrl, duration: Number(duration) || 0 }));
});
app.delete('/api/websites/:id', auth, (req, res) => {
  const id = +req.params.id;
  store.remove('websites', w => w.id === id && w.user_id === req.user.id);
  store.remove('playlist', p => p.item_type === 'website' && p.item_id === id);
  res.json({ ok: true });
});
app.patch('/api/websites/:id', auth, (req, res) => {
  const id = +req.params.id;
  const row = store.find('websites', w => w.id === id && w.user_id === req.user.id);
  if (!row) return res.status(404).json({ error: 'Website not found' });
  const patch = {};
  if (req.body.title !== undefined) patch.title = req.body.title;
  if (req.body.duration !== undefined) patch.duration = Number(req.body.duration) || 0;
  if (req.body.url !== undefined) {
    const isYT = /youtube\.com|youtu\.be/.test(req.body.url);
    patch.url = isYT ? (youtubeEmbed(req.body.url) || req.body.url) : req.body.url;
  }
  res.json(store.update('websites', id, patch));
});

// ================= GROUPS =================
app.get('/api/groups', auth, (req, res) => {
  const groups = store.all('groups', g => g.user_id === req.user.id).reverse();
  groups.forEach(g => { g.screen_count = store.all('screens', s => s.group_id === g.id).length; });
  res.json(groups);
});
app.post('/api/groups', auth, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'A group name is required' });
  res.json(store.insert('groups', { user_id: req.user.id, name }));
});
app.delete('/api/groups/:id', auth, (req, res) => {
  const id = +req.params.id;
  store.all('screens', s => s.group_id === id).forEach(s => store.update('screens', s.id, { group_id: null }));
  store.remove('groups', g => g.id === id && g.user_id === req.user.id);
  store.remove('playlist', p => p.target_type === 'group' && p.target_id === id);
  res.json({ ok: true });
});
app.patch('/api/groups/:id', auth, (req, res) => {
  const id = +req.params.id;
  const row = store.find('groups', g => g.id === id && g.user_id === req.user.id);
  if (!row) return res.status(404).json({ error: 'Group not found' });
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.sync !== undefined) { patch.sync = req.body.sync ? 1 : 0; patch.sync_epoch = Date.now(); }
  if (req.body.audio_screen_id !== undefined) patch.audio_screen_id = req.body.audio_screen_id ? Number(req.body.audio_screen_id) : null;
  res.json(store.update('groups', id, patch));
});
// Resync: restart every screen in the group together (fresh shared start time)
app.post('/api/groups/:id/resync', auth, (req, res) => {
  const id = +req.params.id;
  const row = store.find('groups', g => g.id === id && g.user_id === req.user.id);
  if (!row) return res.status(404).json({ error: 'Group not found' });
  store.update('groups', id, { sync_epoch: Date.now(), sync: 1 });
  res.json({ ok: true });
});

// ================= SCREENS =================
app.get('/api/screens', auth, (req, res) => {
  res.json(store.all('screens', s => s.user_id === req.user.id).reverse());
});
app.post('/api/screens/pair', auth, (req, res) => {
  const { code, name, group_id } = req.body || {};
  const owner = store.find('users', u => u.id === req.user.id);
  if (!subActive(owner)) return res.status(403).json({ error: 'Your subscription is not active. Contact admin.' });
  const limit = screenLimit(owner);
  const count = store.all('screens', s => s.user_id === req.user.id).length;
  if (limit > 0 && count >= limit) return res.status(403).json({ error: `Screen limit reached (${limit}). Contact admin to add more.` });
  const screen = store.find('screens', s => s.pair_code === (code || '').toUpperCase() && !s.paired);
  if (!screen) return res.status(404).json({ error: 'No screen is showing that pairing code' });
  store.update('screens', screen.id, {
    user_id: req.user.id, name: name || 'Screen', group_id: group_id ? Number(group_id) : null,
    paired: 1, pair_code: null, approved: (owner.role === 'admin' ? 1 : 0)
  });
  res.json(store.find('screens', s => s.id === screen.id));
});
app.patch('/api/screens/:id', auth, (req, res) => {
  const id = +req.params.id;
  const s = store.find('screens', x => x.id === id && x.user_id === req.user.id);
  if (!s) return res.status(404).json({ error: 'Screen not found' });
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.group_id !== undefined) patch.group_id = req.body.group_id ? Number(req.body.group_id) : null;
  if (req.body.paused !== undefined) patch.paused = req.body.paused ? 1 : 0;
  res.json(store.update('screens', id, patch));
});
app.delete('/api/screens/:id', auth, (req, res) => {
  const id = +req.params.id;
  store.remove('screens', s => s.id === id && s.user_id === req.user.id);
  store.remove('playlist', p => p.target_type === 'screen' && p.target_id === id);
  res.json({ ok: true });
});

// ================= PLAYLIST =================
app.get('/api/playlist/:targetType/:targetId', auth, (req, res) => {
  const t = req.params.targetType, tid = +req.params.targetId;
  res.json(store.all('playlist', p => p.user_id === req.user.id && p.target_type === t && p.target_id === tid)
    .sort((a, b) => a.position - b.position));
});
app.put('/api/playlist/:targetType/:targetId', auth, (req, res) => {
  const t = req.params.targetType, tid = +req.params.targetId;
  const items = (req.body && req.body.items) || [];
  store.remove('playlist', p => p.user_id === req.user.id && p.target_type === t && p.target_id === tid);
  items.forEach((it, i) => store.insert('playlist', {
    user_id: req.user.id, target_type: t, target_id: tid,
    item_type: it.item_type, item_id: it.item_id, position: i
  }));
  res.json({ ok: true, count: items.length });
});

// ================= PLAYER API =================
app.post('/api/player/register', (req, res) => {
  const device_id = (req.body && req.body.device_id) || crypto.randomUUID();
  let screen = store.find('screens', s => s.device_id === device_id);
  if (!screen) {
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    screen = store.insert('screens', { device_id, pair_code: code, paired: 0, user_id: null, group_id: null, name: null });
  }
  res.json({ device_id, paired: !!screen.paired, pair_code: screen.pair_code });
});

function baseUrl(req) {
  const host = req.get('host') || '';
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? req.protocol : 'https';
  return `${proto}://${host}`;
}
function mapRows(rows, req) {
  rows.sort((a, b) => a.position - b.position);
  const base = baseUrl(req);
  return rows.map(r => {
    if (r.item_type === 'content') {
      const c = store.find('content', x => x.id === r.item_id);
      if (!c) return null;
      return { kind: 'content', type: c.type, filename: c.filename, url: `${base}/uploads/${c.filename}`, duration: c.type === 'video' ? (c.duration || 0) : (c.duration || 10), title: c.title };
    } else {
      const w = store.find('websites', x => x.id === r.item_id);
      if (!w) return null;
      return { kind: 'website', type: 'website', url: w.url, duration: w.duration || 20, title: w.title };
    }
  }).filter(Boolean);
}
function resolvePlaylist(screen, req) {
  let rows = store.all('playlist', p => p.target_type === 'screen' && p.target_id === screen.id);
  if (rows.length === 0 && screen.group_id)
    rows = store.all('playlist', p => p.target_type === 'group' && p.target_id === screen.group_id);
  return mapRows(rows, req);
}
function resolveGroupPlaylist(groupId, req) {
  return mapRows(store.all('playlist', p => p.target_type === 'group' && p.target_id === groupId), req);
}

app.get('/api/player/state', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const device_id = req.query.device_id;
  const screen = store.find('screens', s => s.device_id === device_id);
  if (!screen) return res.status(404).json({ error: 'unknown device' });
  store.update('screens', screen.id, { last_seen: store.nowISO() });
  if (!screen.paired) return res.json({ paired: false, pair_code: screen.pair_code });
  const owner = store.find('users', u => u.id === screen.user_id);
  if (!screen.approved) return res.json({ paired: true, name: screen.name, blocked: 'Waiting for admin approval', playlist: [] });
  if (!subActive(owner)) return res.json({ paired: true, name: screen.name, blocked: 'Subscription expired — contact admin', playlist: [] });
  if (!screenActive(screen)) return res.json({ paired: true, name: screen.name, blocked: 'This screen has expired — contact admin', playlist: [] });
  if (screen.paused) return res.json({ paired: true, name: screen.name, paused: true, playlist: [] });
  // sync mode: if this screen's group has sync on, tell the player the shared start time + audio role
  let sync = null;
  if (screen.group_id) {
    const g = store.find('groups', x => x.id === screen.group_id);
    if (g && g.sync) sync = { on: true, epoch: g.sync_epoch || 0, audio: (g.audio_screen_id === screen.id) };
  }
  res.json({ paired: true, name: screen.name, paused: false,
    volume: (screen.volume == null ? null : screen.volume),
    cmd: screen.cmd || null,
    sync: sync,
    now: Date.now(),
    playlist: resolvePlaylist(screen, req) });
});

// Admin/user preview: what a given screen is currently playing
// Group remote control → all screens in the group (keeps a synced hall together)
app.post('/api/groups/:id/control', auth, (req, res) => {
  const id = +req.params.id;
  const g = store.find('groups', x => x.id === id && x.user_id === req.user.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  const screens = store.all('screens', s => s.group_id === id && s.user_id === req.user.id);
  screens.forEach(s => {
    const patch = {};
    if (req.body.volume !== undefined) patch.volume = Math.max(0, Math.min(1, Number(req.body.volume)));
    if (req.body.action !== undefined || req.body.seek !== undefined) {
      const seq = ((s.cmd && s.cmd.seq) || 0) + 1;
      patch.cmd = { seq, action: req.body.action || null, seek: (req.body.seek !== undefined ? Number(req.body.seek) : null), ts: Date.now() };
    }
    store.update('screens', s.id, patch);
  });
  res.json({ ok: true, screens: screens.length });
});

// Operator remote control → TV (volume persists; action/seek are one-shot commands)
app.post('/api/screens/:id/control', auth, (req, res) => {
  const id = +req.params.id;
  const s = store.find('screens', x => x.id === id && x.user_id === req.user.id);
  if (!s) return res.status(404).json({ error: 'Screen not found' });
  const patch = {};
  if (req.body.volume !== undefined) patch.volume = Math.max(0, Math.min(1, Number(req.body.volume)));
  if (req.body.action !== undefined || req.body.seek !== undefined) {
    const seq = ((s.cmd && s.cmd.seq) || 0) + 1;
    patch.cmd = { seq, action: req.body.action || null, seek: (req.body.seek !== undefined ? Number(req.body.seek) : null), ts: Date.now() };
  }
  store.update('screens', id, patch);
  res.json({ ok: true, cmd: patch.cmd || s.cmd || null, volume: patch.volume });
});

app.get('/api/screens/:id/nowplaying', auth, (req, res) => {
  const id = +req.params.id;
  const screen = store.find('screens', s => s.id === id && s.user_id === req.user.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  const online = screen.last_seen && (Date.now() - new Date(screen.last_seen + 'Z').getTime()) < 120000;
  res.json({
    id: screen.id, name: screen.name, device_id: screen.device_id, paused: !!screen.paused, online,
    last_seen: screen.last_seen || null, playlist: resolvePlaylist(screen, req)
  });
});

app.get('/api/groups/:id/nowplaying', auth, (req, res) => {
  const id = +req.params.id;
  const g = store.find('groups', x => x.id === id && x.user_id === req.user.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  res.json({ id: g.id, name: g.name, playlist: resolveGroupPlaylist(g.id, req) });
});

app.get('/health', (req, res) => res.json({ ok: true, app: 'INFO TV APP' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`INFO TV APP platform running on http://localhost:${PORT}`));
