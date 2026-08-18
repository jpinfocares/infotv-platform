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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- file uploads ----------
const UPLOAD_DIR = path.join(process.env.DATA_ROOT || __dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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

// ================= ADMIN: USER MANAGEMENT =================
app.get('/api/admin/users', auth, admin, (req, res) => {
  res.json(store.all('users').map(u => ({
    id: u.id, email: u.email, name: u.name, role: u.role || 'user',
    approved: u.approved ? 1 : 0, created_at: u.created_at
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
    duration: 10,
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
  if (req.body.duration !== undefined) patch.duration = +req.body.duration || 10;
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
  res.json(store.insert('websites', { user_id: req.user.id, title: title || url, url: finalUrl, duration: duration || 20 }));
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
  if (req.body.duration !== undefined) patch.duration = +req.body.duration || 20;
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
  res.json(store.update('groups', id, patch));
});

// ================= SCREENS =================
app.get('/api/screens', auth, (req, res) => {
  res.json(store.all('screens', s => s.user_id === req.user.id).reverse());
});
app.post('/api/screens/pair', auth, (req, res) => {
  const { code, name, group_id } = req.body || {};
  const screen = store.find('screens', s => s.pair_code === (code || '').toUpperCase() && !s.paired);
  if (!screen) return res.status(404).json({ error: 'No screen is showing that pairing code' });
  store.update('screens', screen.id, {
    user_id: req.user.id, name: name || 'Screen', group_id: group_id || null, paired: 1, pair_code: null
  });
  res.json(store.find('screens', s => s.id === screen.id));
});
app.patch('/api/screens/:id', auth, (req, res) => {
  const id = +req.params.id;
  const s = store.find('screens', x => x.id === id && x.user_id === req.user.id);
  if (!s) return res.status(404).json({ error: 'Screen not found' });
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.group_id !== undefined) patch.group_id = req.body.group_id;
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
function resolvePlaylist(screen, req) {
  let rows = store.all('playlist', p => p.target_type === 'screen' && p.target_id === screen.id);
  if (rows.length === 0 && screen.group_id)
    rows = store.all('playlist', p => p.target_type === 'group' && p.target_id === screen.group_id);
  rows.sort((a, b) => a.position - b.position);
  const base = baseUrl(req);
  return rows.map(r => {
    if (r.item_type === 'content') {
      const c = store.find('content', x => x.id === r.item_id);
      if (!c) return null;
      return { kind: 'content', type: c.type, filename: c.filename, url: `${base}/uploads/${c.filename}`, duration: c.duration || 10, title: c.title };
    } else {
      const w = store.find('websites', x => x.id === r.item_id);
      if (!w) return null;
      return { kind: 'website', type: 'website', url: w.url, duration: w.duration || 20, title: w.title };
    }
  }).filter(Boolean);
}

app.get('/api/player/state', (req, res) => {
  const device_id = req.query.device_id;
  const screen = store.find('screens', s => s.device_id === device_id);
  if (!screen) return res.status(404).json({ error: 'unknown device' });
  store.update('screens', screen.id, { last_seen: store.nowISO() });
  if (!screen.paired) return res.json({ paired: false, pair_code: screen.pair_code });
  if (screen.paused) return res.json({ paired: true, name: screen.name, paused: true, playlist: [] });
  res.json({ paired: true, name: screen.name, paused: false, playlist: resolvePlaylist(screen, req) });
});

// Admin/user preview: what a given screen is currently playing
app.get('/api/screens/:id/nowplaying', auth, (req, res) => {
  const id = +req.params.id;
  const screen = store.find('screens', s => s.id === id && s.user_id === req.user.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  const online = screen.last_seen && (Date.now() - new Date(screen.last_seen + 'Z').getTime()) < 120000;
  res.json({
    id: screen.id, name: screen.name, paused: !!screen.paused, online,
    last_seen: screen.last_seen || null, playlist: resolvePlaylist(screen, req)
  });
});

app.get('/health', (req, res) => res.json({ ok: true, app: 'INFO TV APP' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`INFO TV APP platform running on http://localhost:${PORT}`));
