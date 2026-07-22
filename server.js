'use strict';
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { DatabaseSync } = require('node:sqlite');

// ── DB ──────────────────────────────────────────────────────────────────────
const db = new DatabaseSync('./store.db');
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS components (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0),
    in_use      INTEGER NOT NULL DEFAULT 0 CHECK(in_use >= 0),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    notes       TEXT,
    image       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
`);

// Migrate existing DB: add in_use if missing
try { db.exec('ALTER TABLE components ADD COLUMN in_use INTEGER NOT NULL DEFAULT 0'); } catch {}
// Migrate existing DB: add parent_id (subcategories) if missing
try { db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE'); } catch {}
// Migrate existing DB: add favorite flag if missing
try { db.exec('ALTER TABLE components ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0'); } catch {}
// Migrate existing DB: add carton (box) label if missing
try { db.exec('ALTER TABLE components ADD COLUMN carton TEXT'); } catch {}

// Key/value metadata — used to mark one-time actions like initial seeding
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);

// One-time: assign every currently-favorite component to carton "botland"
if (!db.prepare("SELECT value FROM meta WHERE key='carton_botland'").get()) {
  const r = db.prepare("UPDATE components SET carton='botland' WHERE favorite=1 AND (carton IS NULL OR carton='')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('carton_botland','1')").run();
  if (r.changes) console.log(`Przypisano ${r.changes} ulubionych do kartonu „botland".`);
}

// Seed default categories ONLY on the first-ever launch of this database.
// After that, whatever the user has (including deletions) is preserved across restarts.
const alreadySeeded = db.prepare("SELECT value FROM meta WHERE key='seeded'").get();
if (!alreadySeeded) {
  // Top-level categories
  const CATS = ['Rezystory','Kondensatory','Tranzystory','Układy scalone (IC)',
                'Diody','Mikrokontrolery','Czujniki','Moduły RF','Złącza','Inne'];
  const ins = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
  CATS.forEach(c => ins.run(c));

  // Subcategories (grouped under their parent)
  const SUBCATS = {
    'Rezystory':            ['Rezystory THT','Rezystory SMD','Potencjometry'],
    'Kondensatory':         ['Kondensatory ceramiczne','Kondensatory elektrolityczne','Kondensatory foliowe','Kondensatory tantalowe'],
    'Tranzystory':          ['Tranzystory BJT','Tranzystory MOSFET','Tranzystory IGBT'],
    'Układy scalone (IC)':  ['Wzmacniacze operacyjne','Bramki logiczne','Timery / zegary','Pamięci'],
    'Diody':                ['Diody prostownicze','Diody Zenera','Diody LED','Diody Schottky'],
    'Mikrokontrolery':      ['AVR / Arduino','STM32','ESP32 / ESP8266'],
    'Czujniki':             ['Czujniki temperatury','Czujniki ruchu','Czujniki światła','Czujniki gazu'],
    'Moduły RF':            ['Bluetooth','WiFi','LoRa','NRF24'],
    'Złącza':               ['Goldpiny','Listwy zaciskowe','Złącza USB','Gniazda zasilania'],
  };
  const findParent = db.prepare('SELECT id FROM categories WHERE name=? AND parent_id IS NULL');
  const insSub     = db.prepare('INSERT OR IGNORE INTO categories(name,parent_id) VALUES(?,?)');
  for (const [parent, subs] of Object.entries(SUBCATS)) {
    const row = findParent.get(parent);
    if (row) subs.forEach(s => insSub.run(s, row.id));
  }

  db.prepare("INSERT INTO meta(key,value) VALUES('seeded','1')").run();
}

// ── MULTER ──────────────────────────────────────────────────────────────────
const UPLOAD_DIR = './public/uploads/';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });   // ensure upload folder exists
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req,  file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/')
      ? cb(null, true)
      : cb(new Error('Tylko pliki graficzne (jpg/png/webp)'))
});

// ── APP ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static('public'));

// helper – remove uploaded file safely
function removeFile(imgPath) {
  if (!imgPath) return;
  const full = path.join('./public', imgPath);
  try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch {}
}

// Max category nesting: 1 = main, 2 = subcategory, 3 = sub-subcategory
const MAX_DEPTH = 3;
// Depth of a category counted from the top (top-level = 1)
function categoryDepth(id) {
  let depth = 0, cur = id;
  while (cur != null) {
    const row = db.prepare('SELECT parent_id FROM categories WHERE id=?').get(cur);
    if (!row) break;
    depth++;
    cur = row.parent_id;
  }
  return depth;
}

// A category id + ids of all its descendants (any depth)
function descendantIds(id) {
  return db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
    )
    SELECT id FROM tree
  `).all(id).map(r => r.id);
}

// Height of a subtree rooted at id (a leaf category = 1)
function subtreeHeight(id) {
  const kids = db.prepare('SELECT id FROM categories WHERE parent_id=?').all(id);
  return kids.length ? 1 + Math.max(...kids.map(k => subtreeHeight(k.id))) : 1;
}

// ── CATEGORIES ───────────────────────────────────────────────────────────────
app.get('/api/categories', (_req, res) => {
  res.json(db.prepare(`
    SELECT c.id, c.name, c.parent_id, COUNT(comp.id) AS count
    FROM categories c
    LEFT JOIN components comp ON comp.category_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all());
});

app.post('/api/categories', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
  let parent_id = req.body.parent_id != null && req.body.parent_id !== ''
    ? Number(req.body.parent_id) : null;
  if (parent_id != null) {
    const parent = db.prepare('SELECT id FROM categories WHERE id=?').get(parent_id);
    if (!parent) return res.status(400).json({ error: 'Kategoria nadrzędna nie istnieje' });
    if (categoryDepth(parent_id) >= MAX_DEPTH)
      return res.status(400).json({ error: `Maksymalny poziom zagnieżdżenia to ${MAX_DEPTH}` });
  }
  try {
    const r = db.prepare('INSERT INTO categories(name,parent_id) VALUES(?,?)').run(name, parent_id);
    res.status(201).json({ id: Number(r.lastInsertRowid), name, parent_id, count: 0 });
  } catch {
    res.status(409).json({ error: 'Kategoria już istnieje' });
  }
});

app.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Re-parent a category (drag & drop). parent_id = null → make it top-level.
app.patch('/api/categories/:id/parent', (req, res) => {
  const id = Number(req.params.id);
  const cat = db.prepare('SELECT id FROM categories WHERE id=?').get(id);
  if (!cat) return res.status(404).json({ error: 'Nie znaleziono' });

  const parent_id = req.body.parent_id != null && req.body.parent_id !== ''
    ? Number(req.body.parent_id) : null;

  if (parent_id != null) {
    const parent = db.prepare('SELECT id FROM categories WHERE id=?').get(parent_id);
    if (!parent) return res.status(400).json({ error: 'Kategoria docelowa nie istnieje' });
    // no cycles: target can't be the category itself nor one of its descendants
    if (descendantIds(id).includes(parent_id))
      return res.status(400).json({ error: 'Nie można zagnieździć kategorii w niej samej ani w jej podkategorii' });
    // resulting depth of the deepest node in the moved subtree must fit the limit
    const deepest = categoryDepth(parent_id) + subtreeHeight(id);
    if (deepest > MAX_DEPTH)
      return res.status(400).json({ error: `Przekroczony maksymalny poziom zagnieżdżenia (${MAX_DEPTH})` });
  }

  db.prepare('UPDATE categories SET parent_id=? WHERE id=?').run(parent_id, id);
  res.json({ ok: true });
});

// ── COMPONENTS ───────────────────────────────────────────────────────────────
app.get('/api/components', (req, res) => {
  const { cat, q, sort } = req.query;
  const sorts = {
    name_az:  'comp.name ASC',
    name_za:  'comp.name DESC',
    qty_asc:  'comp.qty ASC',
    qty_desc: 'comp.qty DESC',
    newest:   'comp.created_at DESC',
    oldest:   'comp.created_at ASC',
  };
  let sql = `
    SELECT comp.*, cat.name AS cat_name
    FROM components comp
    LEFT JOIN categories cat ON cat.id = comp.category_id
    WHERE 1=1
  `;
  const params = [];
  if (cat && cat !== 'all') {
    // include the category itself + all of its descendants (any depth)
    const ids = descendantIds(cat);
    sql += ` AND comp.category_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  if (q)                    { sql += ' AND (comp.name LIKE ? OR comp.notes LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (req.query.fav === '1') { sql += ' AND comp.favorite = 1'; }
  if (req.query.carton === '__none__')      { sql += " AND (comp.carton IS NULL OR comp.carton='')"; }
  else if (req.query.carton)                { sql += ' AND comp.carton = ?'; params.push(req.query.carton); }
  switch (req.query.status) {
    case 'in_stock':  sql += ' AND comp.qty > 0'; break;
    case 'in_use':    sql += ' AND comp.in_use > 0'; break;
    case 'available': sql += ' AND (comp.qty - comp.in_use) > 0'; break;
    case 'low':       sql += ' AND (comp.qty - comp.in_use) BETWEEN 1 AND 5'; break;
    case 'out':       sql += ' AND (comp.qty - comp.in_use) <= 0'; break;
  }
  sql += ` ORDER BY ${sorts[sort] || sorts.newest}`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/components/:id', (req, res) => {
  const row = db.prepare(`
    SELECT comp.*, cat.name AS cat_name
    FROM components comp LEFT JOIN categories cat ON cat.id=comp.category_id
    WHERE comp.id=?
  `).get(req.params.id);
  row ? res.json(row) : res.status(404).json({ error: 'Nie znaleziono' });
});

app.post('/api/components', upload.single('image'), (req, res) => {
  const { name, qty, in_use, category_id, notes, carton } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nazwa wymagana' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const safeQty    = Number(qty)    || 0;
  const safeInUse  = Math.min(Number(in_use) || 0, safeQty);
  const r = db.prepare(
    'INSERT INTO components(name,qty,in_use,category_id,notes,image,carton) VALUES(?,?,?,?,?,?,?)'
  ).run(name.trim(), safeQty, safeInUse, category_id||null, notes?.trim()||null, image, carton?.trim()||null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/components/:id', upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM components WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });

  const { name, qty, in_use, category_id, notes, remove_image, carton } = req.body;
  let image = existing.image;

  if (remove_image === '1') { removeFile(image); image = null; }
  if (req.file) { removeFile(image); image = `/uploads/${req.file.filename}`; }

  const safeQty   = qty !== undefined ? Number(qty)    : existing.qty;
  const safeInUse = in_use !== undefined
    ? Math.min(Math.max(0, Number(in_use)), safeQty)
    : Math.min(existing.in_use, safeQty);
  const safeCarton = carton !== undefined ? (carton.trim() || null) : existing.carton;

  db.prepare(
    'UPDATE components SET name=?,qty=?,in_use=?,category_id=?,notes=?,image=?,carton=? WHERE id=?'
  ).run(
    (name||'').trim() || existing.name,
    safeQty,
    safeInUse,
    category_id || null,
    (notes||'').trim() || null,
    image,
    safeCarton,
    req.params.id
  );
  res.json({ ok: true });
});

// Quick quantity bump (+/-) for stock qty
app.patch('/api/components/:id/qty', (req, res) => {
  const { delta } = req.body;
  const row = db.prepare('SELECT qty, in_use FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const newQty   = Math.max(row.in_use, row.qty + (Number(delta)||0)); // can't go below in_use
  db.prepare('UPDATE components SET qty=? WHERE id=?').run(newQty, req.params.id);
  res.json({ qty: newQty, in_use: row.in_use, available: newQty - row.in_use });
});

// Toggle favorite (or set explicitly via { favorite: 0|1 })
app.patch('/api/components/:id/favorite', (req, res) => {
  const row = db.prepare('SELECT favorite FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const fav = req.body.favorite !== undefined ? (req.body.favorite ? 1 : 0) : (row.favorite ? 0 : 1);
  db.prepare('UPDATE components SET favorite=? WHERE id=?').run(fav, req.params.id);
  res.json({ favorite: fav });
});

// Quick in_use bump (+/-)
app.patch('/api/components/:id/in_use', (req, res) => {
  const { delta } = req.body;
  const row = db.prepare('SELECT qty, in_use FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const newInUse = Math.max(0, Math.min(row.qty, row.in_use + (Number(delta)||0)));
  db.prepare('UPDATE components SET in_use=? WHERE id=?').run(newInUse, req.params.id);
  res.json({ qty: row.qty, in_use: newInUse, available: row.qty - newInUse });
});

app.delete('/api/components/:id', (req, res) => {
  const row = db.prepare('SELECT image FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  removeFile(row.image);
  db.prepare('DELETE FROM components WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Distinct carton labels with counts (for the filter dropdown)
app.get('/api/cartons', (_req, res) => {
  res.json(db.prepare(`
    SELECT carton, COUNT(*) AS count
    FROM components
    WHERE carton IS NOT NULL AND carton <> ''
    GROUP BY carton ORDER BY carton COLLATE NOCASE
  `).all());
});

// Stats — global, or scoped to a category (+ all its descendants) via ?cat=
app.get('/api/stats', (req, res) => {
  const { cat } = req.query;
  let where = '', params = [];
  if (cat && cat !== 'all') {
    const ids = descendantIds(cat);
    where = ` WHERE category_id IN (${ids.map(() => '?').join(',')})`;
    params = ids;
  }
  const g = sql => db.prepare(sql).get(...params);
  const { total }    = g(`SELECT COUNT(*) AS total FROM components${where}`);
  const { sumQty }   = g(`SELECT COALESCE(SUM(qty),0) AS sumQty FROM components${where}`);
  const { sumInUse } = g(`SELECT COALESCE(SUM(in_use),0) AS sumInUse FROM components${where}`);
  const and = where ? ' AND' : ' WHERE';
  const { lowStock } = g(`SELECT COUNT(*) AS lowStock FROM components${where}${and} (qty-in_use)<=5 AND (qty-in_use)>0`);
  const { outStock } = g(`SELECT COUNT(*) AS outStock FROM components${where}${and} (qty-in_use)<=0`);
  const { favorites }= g(`SELECT COUNT(*) AS favorites FROM components${where}${and} favorite=1`);
  res.json({ total, sumQty, sumInUse, sumAvailable: sumQty - sumInUse, lowStock, outStock, favorites });
});

// Upload / multer error handler → clean JSON instead of a 500 HTML page
app.use((err, _req, res, _next) => {
  console.error('Błąd:', err.message);
  res.status(400).json({ error: err.message || 'Błąd przesyłania pliku' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`\n⚡  Magazyn Elektroniki  →  http://localhost:${PORT}\n`)
);
