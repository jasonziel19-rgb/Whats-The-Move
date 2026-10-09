// What's The Move — server
// Serves index.html and a small JSON API backed by Postgres (DATABASE_URL).
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable. Add it in Render > Environment.");
  process.exit(1);
}
// Render's *internal* database hostnames have no dots and don't need SSL; anything else (Neon, external URLs) does.
const dbHost = new URL(DATABASE_URL).hostname;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: dbHost.includes(".") ? { rejectUnauthorized: false } : false,
  max: 5,
});

const CATEGORIES = ["social", "party", "activity", "food", "campus", "clubs", "study"];
const PALETTE_SIZE = 12;
const DAY = 24 * 60 * 60 * 1000;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moves (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      frat BOOLEAN NOT NULL DEFAULT false,
      time TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      going_base INT NOT NULL DEFAULT 0,
      names JSONB NOT NULL DEFAULT '[]',
      author TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS updates (
      id SERIAL PRIMARY KEY,
      move_id TEXT NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      color INT NOT NULL,
      at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      move_id TEXT NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      name TEXT NOT NULL,
      color INT NOT NULL,
      at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS upvotes (
      move_id TEXT NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      device TEXT NOT NULL,
      PRIMARY KEY (move_id, device)
    );
    CREATE TABLE IF NOT EXISTS going (
      move_id TEXT NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      device TEXT NOT NULL,
      PRIMARY KEY (move_id, device)
    );
    -- All-time tracking (never cleared by the weekly cleanup)
    CREATE TABLE IF NOT EXISTS visitors (
      device TEXT PRIMARY KEY,
      first_seen BIGINT NOT NULL,
      last_seen BIGINT NOT NULL,
      visits INT NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value BIGINT NOT NULL DEFAULT 0
    );
    INSERT INTO stats (key, value) VALUES ('total_posts', (SELECT COUNT(*) FROM moves)) ON CONFLICT (key) DO NOTHING;
    INSERT INTO stats (key, value) VALUES ('total_visits', 0) ON CONFLICT (key) DO NOTHING;
    CREATE INDEX IF NOT EXISTS moves_updated_idx ON moves (updated_at DESC);
    CREATE INDEX IF NOT EXISTS updates_move_idx ON updates (move_id);
    CREATE INDEX IF NOT EXISTS comments_move_idx ON comments (move_id);
  `);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

// ---- helpers ----
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function deviceOf(req) {
  const d = req.get("X-Device") || "";
  return /^[A-Za-z0-9_-]{16,64}$/.test(d) ? d : null;
}
function needDevice(req, res) {
  const d = deviceOf(req);
  if (!d) res.status(400).json({ error: "Missing device id. Reload the page." });
  return d;
}
function pickColor(prev) {
  let i;
  do { i = Math.floor(Math.random() * PALETTE_SIZE); } while (i === prev);
  return i;
}

// Simple per-IP write limit: 40 writes per minute
const hits = new Map();
function limitWrites(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const list = (hits.get(key) || []).filter(t => now - t < 60000);
  if (list.length >= 40) return res.status(429).json({ error: "Slow down a little and try again in a minute." });
  list.push(now);
  hits.set(key, list);
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000);

async function moveExists(id) {
  const r = await pool.query("SELECT author FROM moves WHERE id = $1", [id]);
  return r.rows[0] || null;
}

// ---- API ----
app.get("/api/moves", async (req, res) => {
  try {
    const device = deviceOf(req) || "";
    const since = Date.now() - DAY;
    const { rows: moves } = await pool.query(
      "SELECT * FROM moves WHERE updated_at >= $1 ORDER BY updated_at DESC LIMIT 200", [since]);
    const ids = moves.map(m => m.id);
    if (!ids.length) return res.json({ moves: [] });

    const [ups, cms, votes, myVotes, goingCounts, myGoing] = await Promise.all([
      pool.query("SELECT move_id, text, color, at FROM updates WHERE move_id = ANY($1) ORDER BY at ASC", [ids]),
      pool.query("SELECT move_id, text, name, color, at FROM comments WHERE move_id = ANY($1) ORDER BY at ASC", [ids]),
      pool.query("SELECT move_id, COUNT(*)::int AS n FROM upvotes WHERE move_id = ANY($1) GROUP BY move_id", [ids]),
      pool.query("SELECT move_id FROM upvotes WHERE move_id = ANY($1) AND device = $2", [ids, device]),
      pool.query("SELECT move_id, COUNT(*)::int AS n FROM going WHERE move_id = ANY($1) GROUP BY move_id", [ids]),
      pool.query("SELECT move_id FROM going WHERE move_id = ANY($1) AND device = $2", [ids, device]),
    ]);
    const group = (rows) => rows.reduce((a, r) => ((a[r.move_id] ||= []).push(r), a), {});
    const upd = group(ups.rows), cmt = group(cms.rows);
    const count = (rows) => Object.fromEntries(rows.map(r => [r.move_id, r.n]));
    const vCount = count(votes.rows), gCount = count(goingCounts.rows);
    const mineV = new Set(myVotes.rows.map(r => r.move_id));
    const mineG = new Set(myGoing.rows.map(r => r.move_id));

    res.json({
      moves: moves.map(m => ({
        id: m.id,
        title: m.title,
        category: m.category,
        frat: m.frat,
        time: m.time,
        location: m.location,
        names: m.names,
        going: m.going_base + (gCount[m.id] || 0),
        goingMine: mineG.has(m.id),
        upvotes: vCount[m.id] || 0,
        upvoted: mineV.has(m.id),
        mine: !!device && m.author === device, // never send the author's device id
        createdAt: Number(m.created_at),
        updatedAt: Number(m.updated_at),
        updates: (upd[m.id] || []).map(u => ({ text: u.text, c: u.color, at: Number(u.at) })),
        comments: (cmt[m.id] || []).map(c => ({ text: c.text, name: c.name, c: c.color, at: Number(c.at) })),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't load moves." });
  }
});

app.post("/api/moves", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  const b = req.body || {};
  const title = str(b.title, 80);
  if (!title) return res.status(400).json({ error: "Add a short title." });
  const category = CATEGORIES.includes(b.category) ? b.category : "";
  const time = b.time === "now" ? "now" : (/^\d{2}:\d{2}$/.test(b.time || "") ? b.time : "");
  const going = Math.max(0, Math.min(9999, parseInt(b.going, 10) || 0));
  const names = Array.isArray(b.names) ? b.names.map(n => str(n, 40)).filter(Boolean).slice(0, 30) : [];
  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO moves (id, title, category, frat, time, location, going_base, names, author, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, title, category, !!b.frat, time, str(b.location, 80), going, JSON.stringify(names), device, now]);
    await pool.query("UPDATE stats SET value = value + 1 WHERE key = 'total_posts'");
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't post." }); }
});

app.post("/api/moves/:id/updates", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  const text = str((req.body || {}).text, 140);
  if (!text) return res.status(400).json({ error: "Write something first." });
  try {
    const m = await moveExists(req.params.id);
    if (!m) return res.status(404).json({ error: "That move was deleted." });
    if (m.author !== device) return res.status(403).json({ error: "Only the person who posted this move can add updates." });
    const last = await pool.query("SELECT color FROM updates WHERE move_id = $1 ORDER BY at DESC LIMIT 1", [req.params.id]);
    const now = Date.now();
    await pool.query("INSERT INTO updates (move_id, text, color, at) VALUES ($1,$2,$3,$4)",
      [req.params.id, text, pickColor(last.rows[0]?.color), now]);
    await pool.query("UPDATE moves SET updated_at = $2 WHERE id = $1", [req.params.id, now]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't post the update." }); }
});

app.post("/api/moves/:id/comments", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  const text = str((req.body || {}).text, 280);
  const name = str((req.body || {}).name, 30) || "Someone";
  if (!text) return res.status(400).json({ error: "Write something first." });
  try {
    if (!(await moveExists(req.params.id))) return res.status(404).json({ error: "That move was deleted." });
    const last = await pool.query("SELECT color FROM comments WHERE move_id = $1 ORDER BY at DESC LIMIT 1", [req.params.id]);
    await pool.query("INSERT INTO comments (move_id, text, name, color, at) VALUES ($1,$2,$3,$4,$5)",
      [req.params.id, text, name, pickColor(last.rows[0]?.color), Date.now()]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't post the comment." }); }
});

app.post("/api/moves/:id/upvote", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  try {
    if (!(await moveExists(req.params.id))) return res.status(404).json({ error: "That move was deleted." });
    await pool.query("INSERT INTO upvotes (move_id, device) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.id, device]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't upvote." }); }
});

app.post("/api/moves/:id/going", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  try {
    if (!(await moveExists(req.params.id))) return res.status(404).json({ error: "That move was deleted." });
    if ((req.body || {}).going) {
      await pool.query("INSERT INTO going (move_id, device) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.id, device]);
    } else {
      await pool.query("DELETE FROM going WHERE move_id = $1 AND device = $2", [req.params.id, device]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't update." }); }
});

app.delete("/api/moves/:id", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  try {
    const m = await moveExists(req.params.id);
    if (!m) return res.json({ ok: true });
    if (m.author !== device) return res.status(403).json({ error: "Only the person who posted this move can delete it." });
    await pool.query("DELETE FROM moves WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't delete." }); }
});

// Count a visit (called once per page load)
app.post("/api/visit", limitWrites, async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  const now = Date.now();
  try {
    await pool.query(
      `INSERT INTO visitors (device, first_seen, last_seen, visits) VALUES ($1, $2, $2, 1)
       ON CONFLICT (device) DO UPDATE SET last_seen = $2, visits = visitors.visits + 1`, [device, now]);
    await pool.query("UPDATE stats SET value = value + 1 WHERE key = 'total_visits'");
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't record visit." }); }
});

// Private stats page: /stats?key=YOUR_STATS_KEY  (set STATS_KEY in Render > Environment)
app.get("/stats", async (req, res) => {
  const want = process.env.STATS_KEY || "";
  const got = String(req.query.key || "");
  const ok = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(404).send("Not found");
  try {
    const now = Date.now();
    const [st, v, today, week, live] = await Promise.all([
      pool.query("SELECT key, value FROM stats"),
      pool.query("SELECT COUNT(*)::int AS n FROM visitors"),
      pool.query("SELECT COUNT(*)::int AS n FROM visitors WHERE last_seen >= $1", [now - DAY]),
      pool.query("SELECT COUNT(*)::int AS n FROM visitors WHERE last_seen >= $1", [now - 7 * DAY]),
      pool.query("SELECT COUNT(*)::int AS n FROM moves WHERE updated_at >= $1", [now - DAY]),
    ]);
    const s = Object.fromEntries(st.rows.map(r => [r.key, Number(r.value)]));
    res.json({
      uniqueVisitorsAllTime: v.rows[0].n,
      totalVisitsAllTime: s.total_visits || 0,
      postsAllTime: s.total_posts || 0,
      visitorsLast24h: today.rows[0].n,
      visitorsLast7Days: week.rows[0].n,
      movesShowingNow: live.rows[0].n,
    });
  } catch (e) { console.error(e); res.status(500).send("Couldn't load stats."); }
});

app.get("/healthz", (req, res) => res.send("ok"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Clear out moves older than a week, once an hour
setInterval(() => {
  pool.query("DELETE FROM moves WHERE updated_at < $1", [Date.now() - 7 * DAY]).catch(e => console.error(e));
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`What's The Move running on port ${PORT}`)))
  .catch(e => { console.error("Database setup failed:", e.message); process.exit(1); });
