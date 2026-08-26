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
    damaged     INTEGER NOT NULL DEFAULT 0 CHECK(damaged >= 0),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    notes       TEXT,
    image       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    image       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS project_components (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
    component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    qty          INTEGER NOT NULL DEFAULT 1 CHECK(qty >= 1),
    UNIQUE(project_id, component_id)
  );

  CREATE TABLE IF NOT EXISTS tools (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    image       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    image       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS set_components (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id       INTEGER NOT NULL REFERENCES sets(id)       ON DELETE CASCADE,
    component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    qty          INTEGER NOT NULL DEFAULT 1 CHECK(qty >= 1),
    UNIQUE(set_id, component_id)
  );

  CREATE TABLE IF NOT EXISTS tool_components (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id      INTEGER NOT NULL REFERENCES tools(id)      ON DELETE CASCADE,
    component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    qty          INTEGER NOT NULL DEFAULT 1 CHECK(qty >= 1),
    UNIQUE(tool_id, component_id)
  );

  CREATE TABLE IF NOT EXISTS tool_sets (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    set_id  INTEGER NOT NULL REFERENCES sets(id)  ON DELETE CASCADE,
    UNIQUE(tool_id, set_id)
  );

  CREATE TABLE IF NOT EXISTS set_tools (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id  INTEGER NOT NULL REFERENCES sets(id)  ON DELETE CASCADE,
    tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    UNIQUE(set_id, tool_id)
  );

  CREATE TABLE IF NOT EXISTS set_sets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    child_set_id  INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    UNIQUE(parent_set_id, child_set_id)
  );

  CREATE TABLE IF NOT EXISTS chargers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    image       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS set_chargers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id     INTEGER NOT NULL REFERENCES sets(id)     ON DELETE CASCADE,
    charger_id INTEGER NOT NULL REFERENCES chargers(id) ON DELETE CASCADE,
    UNIQUE(set_id, charger_id)
  );
  CREATE TABLE IF NOT EXISTS tool_chargers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id    INTEGER NOT NULL REFERENCES tools(id)    ON DELETE CASCADE,
    charger_id INTEGER NOT NULL REFERENCES chargers(id) ON DELETE CASCADE,
    UNIQUE(tool_id, charger_id)
  );
  CREATE TABLE IF NOT EXISTS project_chargers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    charger_id INTEGER NOT NULL REFERENCES chargers(id) ON DELETE CASCADE,
    UNIQUE(project_id, charger_id)
  );

  CREATE TABLE IF NOT EXISTS schematics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    html        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
`);

// Migrate existing DB: add in_use if missing
try { db.exec('ALTER TABLE components ADD COLUMN in_use INTEGER NOT NULL DEFAULT 0'); } catch {}
// Migrate existing DB: add parent_id (subcategories) if missing
try { db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE'); } catch {}
// Migrate existing DB: add favorite flag if missing
try { db.exec('ALTER TABLE components ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0'); } catch {}
// Migrate existing DB: add damaged count if missing
try { db.exec('ALTER TABLE components ADD COLUMN damaged INTEGER NOT NULL DEFAULT 0'); } catch {}
// Migrate existing DB: add carton (box) label if missing
try { db.exec('ALTER TABLE components ADD COLUMN carton TEXT'); } catch {}
// Migrate existing DB: add free-text "used in" note if missing
try { db.exec('ALTER TABLE components ADD COLUMN used_in TEXT'); } catch {}

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

// One-time: seed the initial schematic (radar WiFi wiring) from the bundled file.
if (!db.prepare("SELECT value FROM meta WHERE key='schem_seeded'").get()) {
  try {
    const html = fs.readFileSync('./seed/schematics/radar-wifi.html', 'utf8');
    db.prepare('INSERT INTO schematics(name,description,html) VALUES(?,?,?)').run(
      'Okablowanie radaru WiFi',
      'Połączenia pin-po-pinie: ESP32-C3 SuperMini + 28BYJ-48/ULN2003 + enkoder AS5600. Tabele, schemat wiązki i pomiary multimetrem.',
      html
    );
    console.log('Dodano schemat „Okablowanie radaru WiFi".');
  } catch (e) {
    console.warn('Nie udało się wczytać pliku seed schematu:', e.message);
  }
  db.prepare("INSERT INTO meta(key,value) VALUES('schem_seeded','1')").run();
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
app.use(express.json({ limit: '8mb' }));
app.use(express.static('public', {
  // Always revalidate the app shell so code changes are picked up on reload
  // (uploaded images keep normal caching — they have unique filenames).
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Adjust a component's in_use by delta, clamped to [0, qty - damaged].
function bumpInUse(componentId, delta) {
  const row = db.prepare('SELECT qty, in_use, damaged FROM components WHERE id=?').get(componentId);
  if (!row) return;
  const next = Math.max(0, Math.min(row.qty - row.damaged, row.in_use + delta));
  if (next !== row.in_use) db.prepare('UPDATE components SET in_use=? WHERE id=?').run(next, componentId);
}

// helper – remove uploaded file safely
function removeFile(imgPath) {
  if (!imgPath) return;
  const full = path.join('./public', imgPath);
  try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch {}
}

// Max category nesting: 1 = main, 2 = sub, 3 = sub-sub, 4 = sub-sub-sub
const MAX_DEPTH = 4;
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
    SELECT comp.*, cat.name AS cat_name,
      (SELECT GROUP_CONCAT(p.name, ', ')
         FROM project_components pc JOIN projects p ON p.id = pc.project_id
         WHERE pc.component_id = comp.id) AS project_names,
      (SELECT GROUP_CONCAT(s.name, ', ')
         FROM set_components sc JOIN sets s ON s.id = sc.set_id
         WHERE sc.component_id = comp.id) AS set_names,
      (SELECT GROUP_CONCAT(name, ', ') FROM (
         SELECT DISTINCT t.name FROM (
           SELECT tc.tool_id AS tid FROM tool_components tc WHERE tc.component_id = comp.id
           UNION
           SELECT ts.tool_id AS tid FROM set_components sc JOIN tool_sets ts ON ts.set_id = sc.set_id WHERE sc.component_id = comp.id
         ) x JOIN tools t ON t.id = x.tid ORDER BY t.name COLLATE NOCASE
       )) AS tool_names
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
  if (req.query.project === '__none__')     { sql += ' AND comp.id NOT IN (SELECT component_id FROM project_components)'; }
  else if (req.query.project === '__any__') { sql += ' AND comp.id IN (SELECT component_id FROM project_components)'; }
  else if (req.query.project)               { sql += ' AND comp.id IN (SELECT component_id FROM project_components WHERE project_id=?)'; params.push(req.query.project); }
  if (req.query.set === '__none__')         { sql += ' AND comp.id NOT IN (SELECT component_id FROM set_components)'; }
  else if (req.query.set === '__any__')     { sql += ' AND comp.id IN (SELECT component_id FROM set_components)'; }
  else if (req.query.set)                   { sql += ' AND comp.id IN (SELECT component_id FROM set_components WHERE set_id=?)'; params.push(req.query.set); }
  // a component belongs to a tool directly OR via a set attached to that tool
  const TOOL_ANY = '(SELECT component_id FROM tool_components UNION SELECT sc.component_id FROM set_components sc JOIN tool_sets ts ON ts.set_id=sc.set_id)';
  if (req.query.tool === '__none__')        { sql += ` AND comp.id NOT IN ${TOOL_ANY}`; }
  else if (req.query.tool === '__any__')    { sql += ` AND comp.id IN ${TOOL_ANY}`; }
  else if (req.query.tool)                  {
    sql += ` AND comp.id IN (
      SELECT component_id FROM tool_components WHERE tool_id=?
      UNION
      SELECT sc.component_id FROM set_components sc JOIN tool_sets ts ON ts.set_id=sc.set_id WHERE ts.tool_id=?
    )`;
    params.push(req.query.tool, req.query.tool);
  }
  switch (req.query.status) {
    case 'in_stock':  sql += ' AND comp.qty > 0'; break;
    case 'in_use':    sql += ' AND comp.in_use > 0'; break;
    case 'damaged':   sql += ' AND comp.damaged > 0'; break;
    case 'available': sql += ' AND (comp.qty - comp.in_use - comp.damaged) > 0'; break;
    case 'low':       sql += ' AND (comp.qty - comp.in_use - comp.damaged) BETWEEN 1 AND 5'; break;
    case 'out':       sql += ' AND (comp.qty - comp.in_use - comp.damaged) <= 0'; break;
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
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  // projects that use this component (for cross-linking)
  row.projects = db.prepare(`
    SELECT p.id, p.name, pc.qty
    FROM project_components pc JOIN projects p ON p.id = pc.project_id
    WHERE pc.component_id = ? ORDER BY p.name COLLATE NOCASE
  `).all(req.params.id);
  // sets that contain this component
  row.sets = db.prepare(`
    SELECT s.id, s.name, sc.qty
    FROM set_components sc JOIN sets s ON s.id = sc.set_id
    WHERE sc.component_id = ? ORDER BY s.name COLLATE NOCASE
  `).all(req.params.id);
  // tools this component is attached to — directly, and indirectly via attached sets
  const directTools = db.prepare(`
    SELECT t.id, t.name, tc.qty FROM tool_components tc JOIN tools t ON t.id = tc.tool_id
    WHERE tc.component_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(req.params.id);
  const directIds = new Set(directTools.map(t => t.id));
  const viaRows = db.prepare(`
    SELECT t.id, t.name, s.name AS via
    FROM set_components sc
    JOIN tool_sets ts ON ts.set_id = sc.set_id
    JOIN tools t ON t.id = ts.tool_id
    JOIN sets  s ON s.id = ts.set_id
    WHERE sc.component_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(req.params.id);
  const viaMap = {};
  for (const r of viaRows) {
    if (directIds.has(r.id)) continue;              // already assigned directly
    (viaMap[r.id] ||= { id: r.id, name: r.name, vias: [] }).vias.push(r.via);
  }
  row.tools = [
    ...directTools.map(t => ({ id: t.id, name: t.name, qty: t.qty, via: null })),
    ...Object.values(viaMap).map(t => ({ id: t.id, name: t.name, via: [...new Set(t.vias)].join(', ') })),
  ];
  res.json(row);
});

app.post('/api/components', upload.single('image'), (req, res) => {
  const { name, qty, in_use, damaged, category_id, notes, carton } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nazwa wymagana' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const safeQty     = Number(qty)    || 0;
  const safeInUse   = Math.min(Number(in_use) || 0, safeQty);
  const safeDamaged = Math.min(Number(damaged) || 0, safeQty - safeInUse);
  const r = db.prepare(
    'INSERT INTO components(name,qty,in_use,damaged,category_id,notes,image,carton) VALUES(?,?,?,?,?,?,?,?)'
  ).run(name.trim(), safeQty, safeInUse, safeDamaged, category_id||null, notes?.trim()||null, image, carton?.trim()||null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/components/:id', upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM components WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });

  const { name, qty, in_use, damaged, category_id, notes, remove_image, carton } = req.body;
  let image = existing.image;

  if (remove_image === '1') { removeFile(image); image = null; }
  if (req.file) { removeFile(image); image = `/uploads/${req.file.filename}`; }

  const safeQty   = qty !== undefined ? Number(qty)    : existing.qty;
  const safeInUse = in_use !== undefined
    ? Math.min(Math.max(0, Number(in_use)), safeQty)
    : Math.min(existing.in_use, safeQty);
  const safeDamaged = damaged !== undefined
    ? Math.min(Math.max(0, Number(damaged)), safeQty - safeInUse)
    : Math.min(existing.damaged, safeQty - safeInUse);
  const safeCarton = carton !== undefined ? (carton.trim() || null) : existing.carton;

  db.prepare(
    'UPDATE components SET name=?,qty=?,in_use=?,damaged=?,category_id=?,notes=?,image=?,carton=? WHERE id=?'
  ).run(
    (name||'').trim() || existing.name,
    safeQty,
    safeInUse,
    safeDamaged,
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
  const row = db.prepare('SELECT qty, in_use, damaged FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const newQty = Math.max(row.in_use + row.damaged, row.qty + (Number(delta)||0)); // can't go below in_use+damaged
  db.prepare('UPDATE components SET qty=? WHERE id=?').run(newQty, req.params.id);
  res.json({ qty: newQty, in_use: row.in_use, damaged: row.damaged, available: newQty - row.in_use - row.damaged });
});

// Toggle favorite (or set explicitly via { favorite: 0|1 })
app.patch('/api/components/:id/favorite', (req, res) => {
  const row = db.prepare('SELECT favorite FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const fav = req.body.favorite !== undefined ? (req.body.favorite ? 1 : 0) : (row.favorite ? 0 : 1);
  db.prepare('UPDATE components SET favorite=? WHERE id=?').run(fav, req.params.id);
  res.json({ favorite: fav });
});

// Free-text "used in" note (pure info, not shown on cards / not filterable)
app.patch('/api/components/:id/used_in', (req, res) => {
  const row = db.prepare('SELECT id FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const used_in = (req.body.used_in || '').trim() || null;
  // mutually exclusive with project assignment
  if (used_in && db.prepare('SELECT 1 FROM project_components WHERE component_id=?').get(req.params.id))
    return res.status(409).json({ error: 'Element jest przypisany do projektu — najpierw usuń przypisanie.' });
  db.prepare('UPDATE components SET used_in=? WHERE id=?').run(used_in, req.params.id);
  res.json({ used_in });
});

// Quick in_use bump (+/-)
app.patch('/api/components/:id/in_use', (req, res) => {
  const { delta } = req.body;
  const row = db.prepare('SELECT qty, in_use, damaged FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const newInUse = Math.max(0, Math.min(row.qty - row.damaged, row.in_use + (Number(delta)||0)));
  db.prepare('UPDATE components SET in_use=? WHERE id=?').run(newInUse, req.params.id);
  res.json({ qty: row.qty, in_use: newInUse, damaged: row.damaged, available: row.qty - newInUse - row.damaged });
});

// Quick damaged bump (+/-)
app.patch('/api/components/:id/damaged', (req, res) => {
  const { delta } = req.body;
  const row = db.prepare('SELECT qty, in_use, damaged FROM components WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono' });
  const newDamaged = Math.max(0, Math.min(row.qty - row.in_use, row.damaged + (Number(delta)||0)));
  db.prepare('UPDATE components SET damaged=? WHERE id=?').run(newDamaged, req.params.id);
  res.json({ qty: row.qty, in_use: row.in_use, damaged: newDamaged, available: row.qty - row.in_use - newDamaged });
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

// ── PROJECTS ─────────────────────────────────────────────────────────────────
app.get('/api/projects', (_req, res) => {
  res.json(db.prepare(`
    SELECT p.*, COUNT(pc.id) AS comp_count
    FROM projects p LEFT JOIN project_components pc ON pc.project_id = p.id
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all());
});

app.get('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Nie znaleziono' });
  p.components = db.prepare(`
    SELECT pc.qty, c.id, c.name, c.qty AS stock, c.in_use, c.damaged, c.image, cat.name AS cat_name
    FROM project_components pc
    JOIN components c ON c.id = pc.component_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE pc.project_id = ? ORDER BY c.name COLLATE NOCASE
  `).all(req.params.id);
  p.chargers = db.prepare(`
    SELECT ch.id, ch.name, ch.image FROM project_chargers pch JOIN chargers ch ON ch.id = pch.charger_id
    WHERE pch.project_id = ? ORDER BY ch.name COLLATE NOCASE
  `).all(req.params.id);
  res.json(p);
});

app.post('/api/projects', upload.single('image'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const r = db.prepare('INSERT INTO projects(name,description,image) VALUES(?,?,?)')
    .run(name, req.body.description?.trim() || null, image);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/projects/:id', upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });
  let image = existing.image;
  if (req.body.remove_image === '1') { removeFile(image); image = null; }
  if (req.file) { removeFile(image); image = `/uploads/${req.file.filename}`; }
  db.prepare('UPDATE projects SET name=?,description=?,image=? WHERE id=?').run(
    (req.body.name || '').trim() || existing.name,
    (req.body.description || '').trim() || null,
    image,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT image FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Nie znaleziono' });
  removeFile(p.image);
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id); // cascades project_components
  res.json({ ok: true });
});

// ── SCHEMATICS ────────────────────────────────────────────────────────────
// Self-contained HTML documents (wiring guides, pinouts) shown under Projekty.
app.get('/api/schematics', (_req, res) => {
  res.json(db.prepare(
    'SELECT id, name, description, created_at FROM schematics ORDER BY created_at DESC'
  ).all());
});

app.get('/api/schematics/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM schematics WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Nie znaleziono' });
  res.json(s);
});

app.post('/api/schematics', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
  const r = db.prepare('INSERT INTO schematics(name,description,html) VALUES(?,?,?)').run(
    name,
    req.body.description?.trim() || null,
    typeof req.body.html === 'string' ? req.body.html : ''
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/schematics/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM schematics WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });
  db.prepare('UPDATE schematics SET name=?,description=?,html=? WHERE id=?').run(
    (req.body.name || '').trim() || existing.name,
    (req.body.description || '').trim() || null,
    typeof req.body.html === 'string' ? req.body.html : existing.html,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/schematics/:id', (req, res) => {
  const s = db.prepare('SELECT id FROM schematics WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Nie znaleziono' });
  db.prepare('DELETE FROM schematics WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Add / update a component in a project's BOM (qty). Does NOT touch component.in_use.
app.post('/api/projects/:id/components', (req, res) => {
  const pid = Number(req.params.id);
  const cid = Number(req.body.component_id);
  const qty = Math.max(1, Number(req.body.qty) || 1);
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(pid)) return res.status(404).json({ error: 'Projekt nie istnieje' });
  const comp = db.prepare('SELECT used_in FROM components WHERE id=?').get(cid);
  if (!comp) return res.status(400).json({ error: 'Komponent nie istnieje' });
  // mutually exclusive with the free-text "used in" note
  if (comp.used_in) return res.status(409).json({ error: 'Element ma notatkę użycia — najpierw ją usuń.' });
  db.prepare(`
    INSERT INTO project_components(project_id,component_id,qty) VALUES(?,?,?)
    ON CONFLICT(project_id,component_id) DO UPDATE SET qty=excluded.qty
  `).run(pid, cid, qty);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/components/:cid', (req, res) => {
  db.prepare('DELETE FROM project_components WHERE project_id=? AND component_id=?')
    .run(req.params.id, req.params.cid);
  res.json({ ok: true });
});

// ── SETS (Zestawy) ───────────────────────────────────────────────────────────
app.get('/api/sets', (_req, res) => {
  res.json(db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM set_components sc WHERE sc.set_id=s.id) AS comp_count,
      (SELECT COUNT(*) FROM set_tools      st WHERE st.set_id=s.id) AS tool_count,
      (SELECT COUNT(*) FROM set_sets       ss WHERE ss.parent_set_id=s.id) AS set_count
    FROM sets s ORDER BY s.created_at DESC
  `).all());
});

app.get('/api/sets/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM sets WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Nie znaleziono' });
  s.components = db.prepare(`
    SELECT sc.qty, c.id, c.name, c.qty AS stock, c.in_use, c.damaged, c.image, cat.name AS cat_name
    FROM set_components sc
    JOIN components c ON c.id = sc.component_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE sc.set_id = ? ORDER BY c.name COLLATE NOCASE
  `).all(req.params.id);
  // tools that are MEMBERS of this set (the set consists of these tools)
  s.tools = db.prepare(`
    SELECT t.id, t.name, t.image FROM set_tools st JOIN tools t ON t.id = st.tool_id
    WHERE st.set_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(req.params.id);
  // tools this set is attached to (backlink — a tool that includes this set)
  s.usedInTools = db.prepare(`
    SELECT t.id, t.name FROM tool_sets ts JOIN tools t ON t.id = ts.tool_id
    WHERE ts.set_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(req.params.id);
  s.chargers = db.prepare(`
    SELECT ch.id, ch.name, ch.image FROM set_chargers sch JOIN chargers ch ON ch.id = sch.charger_id
    WHERE sch.set_id = ? ORDER BY ch.name COLLATE NOCASE
  `).all(req.params.id);
  // sub-sets: sets that are members of this set
  s.subsets = db.prepare(`
    SELECT s2.id, s2.name, s2.image,
      (SELECT COUNT(*) FROM set_components sc WHERE sc.set_id=s2.id) AS comp_count
    FROM set_sets ss JOIN sets s2 ON s2.id = ss.child_set_id
    WHERE ss.parent_set_id = ? ORDER BY s2.name COLLATE NOCASE
  `).all(req.params.id);
  // parent sets that contain this set (backlink)
  s.inSets = db.prepare(`
    SELECT s2.id, s2.name FROM set_sets ss JOIN sets s2 ON s2.id = ss.parent_set_id
    WHERE ss.child_set_id = ? ORDER BY s2.name COLLATE NOCASE
  `).all(req.params.id);
  res.json(s);
});

app.post('/api/sets', upload.single('image'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const r = db.prepare('INSERT INTO sets(name,description,image) VALUES(?,?,?)')
    .run(name, req.body.description?.trim() || null, image);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/sets/:id', upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM sets WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });
  let image = existing.image;
  if (req.body.remove_image === '1') { removeFile(image); image = null; }
  if (req.file) { removeFile(image); image = `/uploads/${req.file.filename}`; }
  db.prepare('UPDATE sets SET name=?,description=?,image=? WHERE id=?').run(
    (req.body.name || '').trim() || existing.name,
    (req.body.description || '').trim() || null,
    image,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/sets/:id', (req, res) => {
  const s = db.prepare('SELECT image FROM sets WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Nie znaleziono' });
  removeFile(s.image);
  db.prepare('DELETE FROM sets WHERE id=?').run(req.params.id); // cascades set_components
  res.json({ ok: true });
});

// Add / update a component in a set's list (qty). Independent of in_use / projects / note.
app.post('/api/sets/:id/components', (req, res) => {
  const sid = Number(req.params.id);
  const cid = Number(req.body.component_id);
  const qty = Math.max(1, Number(req.body.qty) || 1);
  if (!db.prepare('SELECT 1 FROM sets WHERE id=?').get(sid)) return res.status(404).json({ error: 'Zestaw nie istnieje' });
  const comp = db.prepare('SELECT qty, in_use, damaged FROM components WHERE id=?').get(cid);
  if (!comp) return res.status(400).json({ error: 'Komponent nie istnieje' });
  // can add anything to a set — unless the item is unavailable (0 available).
  // (edits to an already-added component are always allowed)
  const already = db.prepare('SELECT 1 FROM set_components WHERE set_id=? AND component_id=?').get(sid, cid);
  if (!already && (comp.qty - comp.in_use - comp.damaged) <= 0)
    return res.status(409).json({ error: 'Element niedostępny (0 dostępnych) — nie można dodać do zestawu.' });
  db.prepare(`
    INSERT INTO set_components(set_id,component_id,qty) VALUES(?,?,?)
    ON CONFLICT(set_id,component_id) DO UPDATE SET qty=excluded.qty
  `).run(sid, cid, qty);
  // on a NEW assignment, bump the component's in_use by 1 (capped by qty - damaged)
  if (!already) bumpInUse(cid, +1);
  res.json({ ok: true });
});

app.delete('/api/sets/:id/components/:cid', (req, res) => {
  const existed = db.prepare('SELECT 1 FROM set_components WHERE set_id=? AND component_id=?').get(req.params.id, req.params.cid);
  db.prepare('DELETE FROM set_components WHERE set_id=? AND component_id=?')
    .run(req.params.id, req.params.cid);
  if (existed) bumpInUse(req.params.cid, -1);   // release one from "in use"
  res.json({ ok: true });
});

// A set can also contain tools (e.g. „Alfa adapter + antena")
app.post('/api/sets/:id/tools', (req, res) => {
  const sid = Number(req.params.id);
  const toolId = Number(req.body.tool_id);
  if (!db.prepare('SELECT 1 FROM sets WHERE id=?').get(sid))   return res.status(404).json({ error: 'Zestaw nie istnieje' });
  if (!db.prepare('SELECT 1 FROM tools WHERE id=?').get(toolId)) return res.status(400).json({ error: 'Narzędzie nie istnieje' });
  db.prepare('INSERT OR IGNORE INTO set_tools(set_id,tool_id) VALUES(?,?)').run(sid, toolId);
  res.json({ ok: true });
});

app.delete('/api/sets/:id/tools/:toolId', (req, res) => {
  db.prepare('DELETE FROM set_tools WHERE set_id=? AND tool_id=?').run(req.params.id, req.params.toolId);
  res.json({ ok: true });
});

// A set can contain other sets (sub-sets). Guard against cycles.
function setSubtree(id) {              // id + all its descendant sets (via set_sets)
  return db.prepare(`
    WITH RECURSIVE d(id) AS (
      SELECT CAST(? AS INTEGER)
      UNION
      SELECT ss.child_set_id FROM set_sets ss JOIN d ON ss.parent_set_id = d.id
    ) SELECT id FROM d
  `).all(id).map(r => r.id);
}
app.post('/api/sets/:id/sets', (req, res) => {
  const parent = Number(req.params.id);
  const child  = Number(req.body.child_id);
  if (!db.prepare('SELECT 1 FROM sets WHERE id=?').get(parent)) return res.status(404).json({ error: 'Zestaw nie istnieje' });
  if (!db.prepare('SELECT 1 FROM sets WHERE id=?').get(child))  return res.status(400).json({ error: 'Zestaw nie istnieje' });
  if (setSubtree(child).includes(parent))
    return res.status(409).json({ error: 'Nie można — zestaw nie może zawierać samego siebie ani swojego nadzbioru (cykl).' });
  db.prepare('INSERT OR IGNORE INTO set_sets(parent_set_id,child_set_id) VALUES(?,?)').run(parent, child);
  res.json({ ok: true });
});
app.delete('/api/sets/:id/sets/:childId', (req, res) => {
  db.prepare('DELETE FROM set_sets WHERE parent_set_id=? AND child_set_id=?').run(req.params.id, req.params.childId);
  res.json({ ok: true });
});

// ── TOOLS ────────────────────────────────────────────────────────────────────
app.get('/api/tools', (_req, res) => {
  res.json(db.prepare('SELECT * FROM tools ORDER BY created_at DESC').all());
});

app.get('/api/tools/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Nie znaleziono' });
  t.components = db.prepare(`
    SELECT tc.qty, c.id, c.name, c.qty AS stock, c.in_use, c.damaged, c.image, cat.name AS cat_name
    FROM tool_components tc
    JOIN components c ON c.id = tc.component_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE tc.tool_id = ? ORDER BY c.name COLLATE NOCASE
  `).all(req.params.id);
  t.sets = db.prepare(`
    SELECT s.id, s.name, s.image, (SELECT COUNT(*) FROM set_components sc WHERE sc.set_id=s.id) AS comp_count
    FROM tool_sets ts JOIN sets s ON s.id = ts.set_id
    WHERE ts.tool_id = ? ORDER BY s.name COLLATE NOCASE
  `).all(req.params.id);
  // sets that this tool is a member of (backlink)
  t.in_sets = db.prepare(`
    SELECT s.id, s.name FROM set_tools st JOIN sets s ON s.id = st.set_id
    WHERE st.tool_id = ? ORDER BY s.name COLLATE NOCASE
  `).all(req.params.id);
  t.chargers = db.prepare(`
    SELECT ch.id, ch.name, ch.image FROM tool_chargers tch JOIN chargers ch ON ch.id = tch.charger_id
    WHERE tch.tool_id = ? ORDER BY ch.name COLLATE NOCASE
  `).all(req.params.id);
  // components pulled in via attached sets (excluding ones already directly attached)
  t.set_derived = db.prepare(`
    SELECT c.id, c.name, c.image, cat.name AS cat_name,
           GROUP_CONCAT(DISTINCT s.name) AS via
    FROM tool_sets ts
    JOIN set_components sc ON sc.set_id = ts.set_id
    JOIN sets s ON s.id = ts.set_id
    JOIN components c ON c.id = sc.component_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE ts.tool_id = ?
      AND c.id NOT IN (SELECT component_id FROM tool_components WHERE tool_id = ?)
    GROUP BY c.id ORDER BY c.name COLLATE NOCASE
  `).all(req.params.id, req.params.id);
  res.json(t);
});

app.post('/api/tools', upload.single('image'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const r = db.prepare('INSERT INTO tools(name,description,image) VALUES(?,?,?)')
    .run(name, req.body.description?.trim() || null, image);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/tools/:id', upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });
  let image = existing.image;
  if (req.body.remove_image === '1') { removeFile(image); image = null; }
  if (req.file) { removeFile(image); image = `/uploads/${req.file.filename}`; }
  db.prepare('UPDATE tools SET name=?,description=?,image=? WHERE id=?').run(
    (req.body.name || '').trim() || existing.name,
    (req.body.description || '').trim() || null,
    image,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/tools/:id', (req, res) => {
  const t = db.prepare('SELECT image FROM tools WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Nie znaleziono' });
  removeFile(t.image);
  db.prepare('DELETE FROM tools WHERE id=?').run(req.params.id); // cascades tool_components / tool_sets
  res.json({ ok: true });
});

// Attach / update a component on a tool (qty). Unavailable items can't be added (like sets).
app.post('/api/tools/:id/components', (req, res) => {
  const tid = Number(req.params.id);
  const cid = Number(req.body.component_id);
  const qty = Math.max(1, Number(req.body.qty) || 1);
  if (!db.prepare('SELECT 1 FROM tools WHERE id=?').get(tid)) return res.status(404).json({ error: 'Narzędzie nie istnieje' });
  const comp = db.prepare('SELECT qty, in_use, damaged FROM components WHERE id=?').get(cid);
  if (!comp) return res.status(400).json({ error: 'Komponent nie istnieje' });
  const already = db.prepare('SELECT 1 FROM tool_components WHERE tool_id=? AND component_id=?').get(tid, cid);
  if (!already && (comp.qty - comp.in_use - comp.damaged) <= 0)
    return res.status(409).json({ error: 'Element niedostępny (0 dostępnych) — nie można dodać do narzędzia.' });
  db.prepare(`
    INSERT INTO tool_components(tool_id,component_id,qty) VALUES(?,?,?)
    ON CONFLICT(tool_id,component_id) DO UPDATE SET qty=excluded.qty
  `).run(tid, cid, qty);
  if (!already) bumpInUse(cid, +1);
  res.json({ ok: true });
});

app.delete('/api/tools/:id/components/:cid', (req, res) => {
  const existed = db.prepare('SELECT 1 FROM tool_components WHERE tool_id=? AND component_id=?').get(req.params.id, req.params.cid);
  db.prepare('DELETE FROM tool_components WHERE tool_id=? AND component_id=?').run(req.params.id, req.params.cid);
  if (existed) bumpInUse(req.params.cid, -1);
  res.json({ ok: true });
});

// Attach / detach a set on a tool
app.post('/api/tools/:id/sets', (req, res) => {
  const tid = Number(req.params.id);
  const setId = Number(req.body.set_id);
  if (!db.prepare('SELECT 1 FROM tools WHERE id=?').get(tid)) return res.status(404).json({ error: 'Narzędzie nie istnieje' });
  if (!db.prepare('SELECT 1 FROM sets WHERE id=?').get(setId)) return res.status(400).json({ error: 'Zestaw nie istnieje' });
  db.prepare('INSERT OR IGNORE INTO tool_sets(tool_id,set_id) VALUES(?,?)').run(tid, setId);
  res.json({ ok: true });
});

app.delete('/api/tools/:id/sets/:setId', (req, res) => {
  db.prepare('DELETE FROM tool_sets WHERE tool_id=? AND set_id=?').run(req.params.id, req.params.setId);
  res.json({ ok: true });
});

// ── CHARGERS (Ładowarki) ──────────────────────────────────────────────────────
app.get('/api/chargers', (_req, res) => {
  res.json(db.prepare(`
    SELECT ch.*,
      ((SELECT COUNT(*) FROM set_chargers x WHERE x.charger_id=ch.id)
      +(SELECT COUNT(*) FROM tool_chargers x WHERE x.charger_id=ch.id)
      +(SELECT COUNT(*) FROM project_chargers x WHERE x.charger_id=ch.id)) AS link_count
    FROM chargers ch ORDER BY ch.created_at DESC
  `).all());
});

app.get('/api/chargers/:id', (req, res) => {
  const ch = db.prepare('SELECT * FROM chargers WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Nie znaleziono' });
  ch.sets = db.prepare(`SELECT s.id, s.name FROM set_chargers x JOIN sets s ON s.id=x.set_id WHERE x.charger_id=? ORDER BY s.name COLLATE NOCASE`).all(req.params.id);
  ch.tools = db.prepare(`SELECT t.id, t.name FROM tool_chargers x JOIN tools t ON t.id=x.tool_id WHERE x.charger_id=? ORDER BY t.name COLLATE NOCASE`).all(req.params.id);
  ch.projects = db.prepare(`SELECT p.id, p.name FROM project_chargers x JOIN projects p ON p.id=x.project_id WHERE x.charger_id=? ORDER BY p.name COLLATE NOCASE`).all(req.params.id);
  res.json(ch);
});

app.post('/api/chargers', upload.single('image'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const r = db.prepare('INSERT INTO chargers(name,description,image) VALUES(?,?,?)')
    .run(name, req.body.description?.trim() || null, image);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/chargers/:id', upload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM chargers WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Nie znaleziono' });
  let image = existing.image;
  if (req.body.remove_image === '1') { removeFile(image); image = null; }
  if (req.file) { removeFile(image); image = `/uploads/${req.file.filename}`; }
  db.prepare('UPDATE chargers SET name=?,description=?,image=? WHERE id=?').run(
    (req.body.name || '').trim() || existing.name,
    (req.body.description || '').trim() || null,
    image, req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/chargers/:id', (req, res) => {
  const ch = db.prepare('SELECT image FROM chargers WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Nie znaleziono' });
  removeFile(ch.image);
  db.prepare('DELETE FROM chargers WHERE id=?').run(req.params.id); // cascades link tables
  res.json({ ok: true });
});

// Attach / detach a charger to a set / tool / project (generic helper)
function chargerLink(table, parentCol, parentTable) {
  return {
    add: (req, res) => {
      const pid = Number(req.params.id);
      const chId = Number(req.body.charger_id);
      if (!db.prepare(`SELECT 1 FROM ${parentTable} WHERE id=?`).get(pid))  return res.status(404).json({ error: 'Nie znaleziono' });
      if (!db.prepare('SELECT 1 FROM chargers WHERE id=?').get(chId))       return res.status(400).json({ error: 'Ładowarka nie istnieje' });
      db.prepare(`INSERT OR IGNORE INTO ${table}(${parentCol},charger_id) VALUES(?,?)`).run(pid, chId);
      res.json({ ok: true });
    },
    del: (req, res) => {
      db.prepare(`DELETE FROM ${table} WHERE ${parentCol}=? AND charger_id=?`).run(req.params.id, req.params.chId);
      res.json({ ok: true });
    }
  };
}
const setCh = chargerLink('set_chargers', 'set_id', 'sets');
const toolCh = chargerLink('tool_chargers', 'tool_id', 'tools');
const projCh = chargerLink('project_chargers', 'project_id', 'projects');
app.post('/api/sets/:id/chargers', setCh.add);       app.delete('/api/sets/:id/chargers/:chId', setCh.del);
app.post('/api/tools/:id/chargers', toolCh.add);     app.delete('/api/tools/:id/chargers/:chId', toolCh.del);
app.post('/api/projects/:id/chargers', projCh.add);  app.delete('/api/projects/:id/chargers/:chId', projCh.del);

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
  const { total }     = g(`SELECT COUNT(*) AS total FROM components${where}`);
  const { sumQty }    = g(`SELECT COALESCE(SUM(qty),0) AS sumQty FROM components${where}`);
  const { sumInUse }  = g(`SELECT COALESCE(SUM(in_use),0) AS sumInUse FROM components${where}`);
  const { sumDamaged }= g(`SELECT COALESCE(SUM(damaged),0) AS sumDamaged FROM components${where}`);
  const and = where ? ' AND' : ' WHERE';
  const { lowStock } = g(`SELECT COUNT(*) AS lowStock FROM components${where}${and} (qty-in_use-damaged)<=5 AND (qty-in_use-damaged)>0`);
  const { outStock } = g(`SELECT COUNT(*) AS outStock FROM components${where}${and} (qty-in_use-damaged)<=0`);
  const { favorites }= g(`SELECT COUNT(*) AS favorites FROM components${where}${and} favorite=1`);
  res.json({ total, sumQty, sumInUse, sumDamaged, sumAvailable: sumQty - sumInUse - sumDamaged, lowStock, outStock, favorites });
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
