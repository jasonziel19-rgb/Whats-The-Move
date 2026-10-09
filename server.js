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
    ALTER TABLE moves ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'move';
    ALTER TABLE moves ADD COLUMN IF NOT EXISTS all_welcome BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT '';
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

// ---------------- Anti-spam ----------------
// Limits are counted per device (one phone/browser) AND per network address (IP).
// Per-IP limits are looser than per-device ones because everyone on campus Wi-Fi
// can share the same IP. Counters live in memory and reset when the server restarts.
const MIN = 60 * 1000, HOUR = 60 * MIN;
const LIMITS = {
  post:    { device: [[1, MIN], [20, DAY]], ip: [[6, MIN], [200, DAY]] },  // moves + interests
  comment: { device: [[1, 10000], [8, MIN], [150, DAY]], ip: [[40, MIN]] },
  update:  { device: [[1, 10000], [8, MIN]], ip: [[30, MIN]] },
  react:   { device: [[30, MIN]], ip: [[150, MIN]] },                       // upvotes, going
  remove:  { device: [[10, MIN]], ip: [[40, MIN]] },
  visit:   { device: [[10, MIN]], ip: [[200, MIN]] },
};
const NEW_DEVICES_PER_IP_PER_HOUR = 150; // stops a bot from minting fake visitors/upvotes

const buckets = new Map();
// Checks every rule first and only records the hit if all pass.
// Returns { wait } (seconds, 0 = allowed) and refund() to undo the hit if the request fails.
function rateHit(rules) {
  const now = Date.now();
  let wait = 0;
  const lists = rules.map(([key, limit, win]) => {
    const list = (buckets.get(key) || []).filter(t => now - t < win);
    buckets.set(key, list);
    if (list.length >= limit) wait = Math.max(wait, Math.ceil((win - (now - list[list.length - limit])) / 1000));
    return list;
  });
  if (wait) return { wait, refund() {} };
  const stamp = now + Math.random() / 1000; // unique marker for this hit
  lists.forEach(l => l.push(stamp));
  return { wait: 0, refund() { lists.forEach(l => { const i = l.indexOf(stamp); if (i >= 0) l.splice(i, 1); }); } };
}
const rate = rules => rateHit(rules).wait;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.some(t => now - t < DAY)) buckets.delete(k);
}, 10 * MIN);

function waitText(sec) {
  if (sec < 60) return `${sec} second${sec === 1 ? "" : "s"}`;
  if (sec < 3600) { const m = Math.ceil(sec / 60); return `${m} minute${m === 1 ? "" : "s"}`; }
  const h = Math.ceil(sec / 3600); return `${h} hour${h === 1 ? "" : "s"}`;
}
const LIMIT_MSG = {
  post: s => `You can post again in ${waitText(s)}.`,
  comment: s => `Slow down. You can comment again in ${waitText(s)}.`,
  update: s => `You can post another update in ${waitText(s)}.`,
  react: s => `Too many taps. Try again in ${waitText(s)}.`,
  remove: s => `Try again in ${waitText(s)}.`,
  visit: s => `Try again in ${waitText(s)}.`,
};
function limit(kind) {
  return (req, res, next) => {
    const device = deviceOf(req) || "none";
    const L = LIMITS[kind];
    const rules = [
      ...L.device.map(([n, w], i) => [`${kind}:d${i}:${device}`, n, w]),
      ...L.ip.map(([n, w], i) => [`${kind}:i${i}:${req.ip}`, n, w]),
    ];
    const hit = rateHit(rules);
    if (hit.wait) return res.status(429).json({ error: LIMIT_MSG[kind](hit.wait) });
    // Rejected requests (bad input, duplicates, unregistered device) don't use up the allowance.
    res.on("finish", () => { if (res.statusCode >= 400) hit.refund(); });
    next();
  };
}

// Writes only come from devices that have opened the site (registered through /api/visit).
async function requireKnown(req, res) {
  const device = needDevice(req, res); if (!device) return null;
  const r = await pool.query("SELECT 1 FROM visitors WHERE device = $1", [device]);
  if (!r.rowCount) { res.status(403).json({ error: "Reload the page and try again.", code: "register" }); return null; }
  return device;
}

async function moveExists(id) {
  const r = await pool.query("SELECT author FROM moves WHERE id = $1", [id]);
  return r.rows[0] || null;
}

// ---- API ----
app.get("/api/moves", async (req, res) => {
  try {
    const device = deviceOf(req) || "";
    const now = Date.now();
    const { rows: moves } = await pool.query(
      `SELECT * FROM moves
       WHERE (kind = 'interest' AND updated_at >= $2) OR (kind <> 'interest' AND updated_at >= $1)
       ORDER BY updated_at DESC LIMIT 300`, [now - DAY, now - 7 * DAY]);
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
        kind: m.kind,
        allWelcome: m.all_welcome,
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

app.post("/api/moves", limit("post"), async (req, res) => {
  const b = req.body || {};
  // Honeypot: a hidden field real people never fill in. Bots that fill every field get a fake success.
  if (str(b.website, 200)) return res.json({ id: "ok" });
  try {
    const device = await requireKnown(req, res); if (!device) return;
    const isInterest = b.kind === "interest";
    const title = str(b.title, isInterest ? 300 : 80);
    if (!title) return res.status(400).json({ error: isInterest ? "Describe what you're into." : "Add a short title." });
    const now = Date.now();
    const dup = await pool.query(
      "SELECT 1 FROM moves WHERE author = $1 AND lower(title) = lower($2) AND created_at >= $3 LIMIT 1",
      [device, title, now - 30 * MIN]);
    if (dup.rowCount) return res.status(409).json({ error: "You already posted that." });

    const category = !isInterest && CATEGORIES.includes(b.category) ? b.category : "";
    const time = isInterest ? str(b.time, 40)
      : b.time === "now" ? "now" : (/^\d{2}:\d{2}$/.test(b.time || "") ? b.time : "");
    const names = !isInterest && Array.isArray(b.names) ? b.names.map(n => str(n, 40)).filter(Boolean).slice(0, 30) : [];
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO moves (id, kind, title, category, frat, all_welcome, time, location, going_base, names, author, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$11)`,
      [id, isInterest ? "interest" : "move", title, category, !isInterest && !!b.frat, !isInterest && !!b.allWelcome,
       time, str(b.location, 80), JSON.stringify(names), device, now]);
    await pool.query("UPDATE stats SET value = value + 1 WHERE key = 'total_posts'");
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't post." }); }
});

app.post("/api/moves/:id/updates", limit("update"), async (req, res) => {
  const text = str((req.body || {}).text, 140);
  if (!text) return res.status(400).json({ error: "Write something first." });
  try {
    const device = await requireKnown(req, res); if (!device) return;
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

app.post("/api/moves/:id/comments", limit("comment"), async (req, res) => {
  const text = str((req.body || {}).text, 280);
  const name = str((req.body || {}).name, 30) || "Someone";
  if (!text) return res.status(400).json({ error: "Write something first." });
  try {
    const device = await requireKnown(req, res); if (!device) return;
    if (!(await moveExists(req.params.id))) return res.status(404).json({ error: "That move was deleted." });
    const now = Date.now();
    const dup = await pool.query(
      "SELECT 1 FROM comments WHERE move_id = $1 AND device = $2 AND lower(text) = lower($3) AND at >= $4 LIMIT 1",
      [req.params.id, device, text, now - 10 * MIN]);
    if (dup.rowCount) return res.status(409).json({ error: "You already posted that comment." });
    const last = await pool.query("SELECT color FROM comments WHERE move_id = $1 ORDER BY at DESC LIMIT 1", [req.params.id]);
    await pool.query("INSERT INTO comments (move_id, text, name, color, at, device) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.params.id, text, name, pickColor(last.rows[0]?.color), now, device]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't post the comment." }); }
});

app.post("/api/moves/:id/upvote", limit("react"), async (req, res) => {
  try {
    const device = await requireKnown(req, res); if (!device) return;
    if (!(await moveExists(req.params.id))) return res.status(404).json({ error: "That move was deleted." });
    await pool.query("INSERT INTO upvotes (move_id, device) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.id, device]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't upvote." }); }
});

app.post("/api/moves/:id/going", limit("react"), async (req, res) => {
  try {
    const device = await requireKnown(req, res); if (!device) return;
    if (!(await moveExists(req.params.id))) return res.status(404).json({ error: "That move was deleted." });
    if ((req.body || {}).going) {
      await pool.query("INSERT INTO going (move_id, device) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.id, device]);
    } else {
      await pool.query("DELETE FROM going WHERE move_id = $1 AND device = $2", [req.params.id, device]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Couldn't update." }); }
});

app.delete("/api/moves/:id", limit("remove"), async (req, res) => {
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
app.post("/api/visit", limit("visit"), async (req, res) => {
  const device = needDevice(req, res); if (!device) return;
  const now = Date.now();
  try {
    const prev = await pool.query("SELECT last_seen FROM visitors WHERE device = $1", [device]);
    if (!prev.rowCount) {
      const wait = rate([[`newdev:${req.ip}`, NEW_DEVICES_PER_IP_PER_HOUR, HOUR]]);
      if (wait) return res.status(429).json({ error: `Too many new visitors from this network. Try again in ${waitText(wait)}.` });
      await pool.query("INSERT INTO visitors (device, first_seen, last_seen, visits) VALUES ($1,$2,$2,1) ON CONFLICT DO NOTHING", [device, now]);
      await pool.query("UPDATE stats SET value = value + 1 WHERE key = 'total_visits'");
    } else if (now - Number(prev.rows[0].last_seen) > 30 * MIN) {
      await pool.query("UPDATE visitors SET last_seen = $2, visits = visits + 1 WHERE device = $1", [device, now]);
      await pool.query("UPDATE stats SET value = value + 1 WHERE key = 'total_visits'");
    } else {
      await pool.query("UPDATE visitors SET last_seen = $2 WHERE device = $1", [device, now]);
    }
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
      pool.query("SELECT COUNT(*)::int AS n FROM moves WHERE kind <> 'interest' AND updated_at >= $1", [now - DAY]),
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
// Homepage, with the site's own address filled into the link-preview tags
// (iMessage, Instagram, Snapchat, etc. need a full https:// link to the preview image).
const fs = require("fs");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
app.get("/", (req, res) => {
  const origin = process.env.SITE_URL || `${req.protocol}://${req.get("host")}`;
  res.type("html").send(INDEX_HTML.replaceAll("__ORIGIN__", origin.replace(/\/$/, "")));
});
// Link-preview image and home-screen icon
const sendImg = name => (req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(__dirname, name));
};
app.get("/og.png", sendImg("og.png"));
app.get("/icon.png", sendImg("icon.png"));

// Clear out moves older than a week, once an hour
setInterval(() => {
  pool.query("DELETE FROM moves WHERE updated_at < $1", [Date.now() - 8 * DAY]).catch(e => console.error(e));
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`What's The Move running on port ${PORT}`)))
  .catch(e => { console.error("Database setup failed:", e.message); process.exit(1); });
