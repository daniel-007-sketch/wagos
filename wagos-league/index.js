import express from 'express';
import session from 'express-session';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import dayjs from 'dayjs';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'wagos-league-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
  })
);

// Database setup
const db = new Database('data.sqlite');
db.pragma('journal_mode = WAL');

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_lower TEXT NOT NULL UNIQUE,
      skill INTEGER NOT NULL,
      team TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function seedInitialData() {
  const playerCount = db.prepare('SELECT COUNT(1) as c FROM players').get().c;
  if (playerCount === 0) {
    const insert = db.prepare(
      'INSERT INTO players (name, name_lower, skill, team, created_at) VALUES (?, ?, ?, NULL, ?)'
    );
    const now = dayjs().toISOString();
    const names = [];
    for (let i = 1; i <= 50; i++) {
      names.push(`Player ${i}`);
    }
    const insertMany = db.transaction((list) => {
      for (const name of list) {
        const skill = Math.floor(Math.random() * 100) + 1; // 1..100
        insert.run(name, name.toLowerCase(), skill, now);
      }
    });
    insertMany(names);
  }

  const adminExists = db
    .prepare('SELECT COUNT(1) as c FROM users WHERE username = ?')
    .get('admin').c;
  if (adminExists === 0) {
    const passwordHash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run('admin', passwordHash, 'admin');
  }

  const lastReset = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_reset_at');
  if (!lastReset) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('last_reset_at', dayjs().toISOString());
  }
}

function getTeams() {
  return ['A', 'B', 'C'];
}

function computeNextWednesday(fromDate = dayjs()) {
  // Next Wednesday at 00:00 local time
  const WEDNESDAY = 3; // dayjs: 0 Sunday, 3 Wednesday
  let d = fromDate.startOf('day');
  const dayOfWeek = d.day();
  let daysToAdd = (WEDNESDAY - dayOfWeek + 7) % 7;
  if (daysToAdd === 0) {
    // If today is Wednesday, move to next week
    daysToAdd = 7;
  }
  d = d.add(daysToAdd, 'day');
  return d.toISOString();
}

function randomizeTeams() {
  const teams = getTeams();
  const players = db
    .prepare('SELECT id, skill FROM players ORDER BY skill DESC, id ASC')
    .all();

  const teamTotals = new Map();
  for (const t of teams) {
    teamTotals.set(t, { totalSkill: 0, count: 0 });
  }

  const assignments = [];
  for (const p of players) {
    let bestTeam = teams[0];
    for (const t of teams) {
      const a = teamTotals.get(t);
      const b = teamTotals.get(bestTeam);
      if (a.totalSkill < b.totalSkill) {
        bestTeam = t;
      } else if (a.totalSkill === b.totalSkill && a.count < b.count) {
        bestTeam = t;
      }
    }
    assignments.push({ id: p.id, team: bestTeam });
    const agg = teamTotals.get(bestTeam);
    agg.totalSkill += p.skill;
    agg.count += 1;
  }

  const update = db.prepare('UPDATE players SET team = ? WHERE id = ?');
  db.transaction(() => {
    for (const a of assignments) {
      update.run(a.team, a.id);
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('last_reset_at', dayjs().toISOString());
  })();
}

function assignNewPlayerToTeam(playerId) {
  // Choose team with minimum total skill, tie-break by count
  const teams = getTeams();
  const rows = db
    .prepare('SELECT team, SUM(skill) as totalSkill, COUNT(1) as cnt FROM players WHERE team IS NOT NULL GROUP BY team')
    .all();
  const teamTotals = new Map();
  for (const t of teams) {
    teamTotals.set(t, { totalSkill: 0, count: 0 });
  }
  for (const r of rows) {
    if (teamTotals.has(r.team)) {
      teamTotals.set(r.team, { totalSkill: r.totalSkill || 0, count: r.cnt || 0 });
    }
  }
  let bestTeam = teams[0];
  for (const t of teams) {
    const a = teamTotals.get(t);
    const b = teamTotals.get(bestTeam);
    if (a.totalSkill < b.totalSkill) {
      bestTeam = t;
    } else if (a.totalSkill === b.totalSkill && a.count < b.count) {
      bestTeam = t;
    }
  }
  db.prepare('UPDATE players SET team = ? WHERE id = ?').run(bestTeam, playerId);
  return bestTeam;
}

// Run DB setup
runMigrations();
seedInitialData();
// Ensure initial team randomization if teams are empty
const anyAssigned = db.prepare('SELECT COUNT(1) as c FROM players WHERE team IS NOT NULL').get().c;
if (anyAssigned === 0) {
  randomizeTeams();
}

// Schedule weekly randomization: Every Wednesday at 00:00
cron.schedule('0 0 * * 3', () => {
  try {
    randomizeTeams();
    // eslint-disable-next-line no-console
    console.log(`[${new Date().toISOString()}] Teams randomized by scheduler.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Scheduler randomization error:', err);
  }
});

// Expose countdown target to all templates
app.use((req, res, next) => {
  res.locals.nextResetAtISO = computeNextWednesday();
  res.locals.appName = 'Wagos League';
  res.locals.isAdmin = Boolean(req.session.user && req.session.user.role === 'admin');
  next();
});

// Routes
app.get('/', (req, res) => {
  res.render('index', { signupResult: null, teamInfo: null, error: null });
});

app.post('/signup', (req, res) => {
  const rawName = (req.body.name || '').trim();
  if (!rawName) {
    return res.render('index', { signupResult: null, teamInfo: null, error: 'Please enter your name.' });
  }
  const name = rawName.replace(/\s+/g, ' ');
  const nameLower = name.toLowerCase();
  try {
    const existing = db.prepare('SELECT id, team FROM players WHERE name_lower = ?').get(nameLower);
    if (existing) {
      const team = existing.team || '(unassigned)';
      return res.render('index', {
        signupResult: { name, team, already: true },
        teamInfo: null,
        error: null
      });
    }

    const skill = Math.floor(Math.random() * 100) + 1;
    const now = dayjs().toISOString();
    const info = db
      .prepare('INSERT INTO players (name, name_lower, skill, team, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(name, nameLower, skill, now);
    const team = assignNewPlayerToTeam(info.lastInsertRowid);

    return res.render('index', {
      signupResult: { name, team, already: false },
      teamInfo: null,
      error: null
    });
  } catch (err) {
    return res.render('index', { signupResult: null, teamInfo: null, error: 'Signup failed. Try a different name.' });
  }
});

app.post('/my-team', (req, res) => {
  const rawName = (req.body.name || '').trim();
  if (!rawName) {
    return res.render('index', { signupResult: null, teamInfo: null, error: 'Enter your name to view your team.' });
  }
  const nameLower = rawName.replace(/\s+/g, ' ').toLowerCase();
  const player = db.prepare('SELECT id, name, team FROM players WHERE name_lower = ?').get(nameLower);
  if (!player) {
    return res.render('index', { signupResult: null, teamInfo: null, error: 'Name not found. Please sign up first.' });
  }
  if (!player.team) {
    return res.render('index', { signupResult: null, teamInfo: null, error: 'Your team is not assigned yet. Please try later.' });
  }
  const teammates = db
    .prepare('SELECT name, skill FROM players WHERE team = ? ORDER BY name ASC')
    .all(player.team);
  return res.render('index', {
    signupResult: null,
    teamInfo: { you: player.name, team: player.team, teammates },
    error: null
  });
});

// Admin routes
app.get('/admin/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get((username || '').trim());
  if (!user) return res.render('admin-login', { error: 'Invalid credentials.' });
  const ok = bcrypt.compareSync(password || '', user.password_hash);
  if (!ok) return res.render('admin-login', { error: 'Invalid credentials.' });
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/admin');
});

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/admin/login');
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  const totals = db
    .prepare('SELECT team, COUNT(1) as cnt, SUM(skill) as totalSkill FROM players WHERE team IS NOT NULL GROUP BY team')
    .all();
  const playersCount = db.prepare('SELECT COUNT(1) as c FROM players').get().c;
  const lastReset = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_reset_at');
  res.render('admin', {
    stats: { totals, playersCount, lastResetAt: lastReset ? lastReset.value : null },
    message: null,
    error: null
  });
});

app.post('/admin/reset', requireAdmin, (req, res) => {
  try {
    randomizeTeams();
    const totals = db
      .prepare('SELECT team, COUNT(1) as cnt, SUM(skill) as totalSkill FROM players WHERE team IS NOT NULL GROUP BY team')
      .all();
    const playersCount = db.prepare('SELECT COUNT(1) as c FROM players').get().c;
    const lastReset = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_reset_at');
    return res.render('admin', {
      stats: { totals, playersCount, lastResetAt: lastReset ? lastReset.value : null },
      message: 'Teams have been randomized successfully.',
      error: null
    });
  } catch (err) {
    const totals = db
      .prepare('SELECT team, COUNT(1) as cnt, SUM(skill) as totalSkill FROM players WHERE team IS NOT NULL GROUP BY team')
      .all();
    const playersCount = db.prepare('SELECT COUNT(1) as c FROM players').get().c;
    const lastReset = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_reset_at');
    return res.render('admin', {
      stats: { totals, playersCount, lastResetAt: lastReset ? lastReset.value : null },
      message: null,
      error: 'Failed to randomize teams.'
    });
  }
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// Start server
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Wagos League server running on http://localhost:${PORT}`);
});

