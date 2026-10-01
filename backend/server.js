const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Load environment variables
dotenv.config();

const app = express();
app.use(cors());
// `verify` stashes the raw request body bytes on req.rawBody, alongside
// the normal parsed req.body — needed by routes/social.js's WhatsApp
// webhook handler to check Meta's X-Hub-Signature-256 header, which is
// computed over the exact raw bytes Meta sent, not a re-serialization of
// the parsed JSON (whitespace/key-order differences would break it).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Import database adapters
const db1 = require('./adapters/db1');
const db2 = require('./adapters/db2');
const db3 = require('./adapters/db3');
const db4 = require('./adapters/db4');
const db5 = require('./adapters/db5');
const db6 = require('./adapters/db6');
const ga4 = require('./lib/ga4');

// Social module (Phase 1: YouTube + Google Business Profile) — kept in
// its own backend/social/ + backend/routes/social.js, same "own folder,
// wired into the same server.js" shape as everything else here, not a
// second app.
const socialRoutes = require('./routes/social');
const socialScheduler = require('./social/scheduler');
const socialPollers = require('./social/pollers');

// Leads module — Meta Lead Ads capture, its own routes/leads.js +
// backend/leads/poller.js, but reusing the social module's Supabase
// project and Facebook Page connection (see backend/migrations/004_leads.sql).
const leadsRoutes = require('./routes/leads');
const leadsPoller = require('./leads/poller');

const ADAPTERS = { db1, db2, db3, db4, db5, db6 };

// Database configurations (can be overwritten via config API or .env)
let dbConfig = {
  db1: { url: process.env.SUPABASE_URL_1 || '', key: process.env.SUPABASE_KEY_1 || '' },
  db2: { url: process.env.SUPABASE_URL_2 || '', key: process.env.SUPABASE_KEY_2 || '' },
  db3: { url: process.env.SUPABASE_URL_3 || '', key: process.env.SUPABASE_KEY_3 || '' },
  db4: { url: process.env.SUPABASE_URL_4 || '', key: process.env.SUPABASE_KEY_4 || '' },
  db5: { url: process.env.SUPABASE_URL_5 || '', key: process.env.SUPABASE_KEY_5 || '' },
  db6: { url: process.env.SUPABASE_URL_6 || '', key: process.env.SUPABASE_KEY_6 || '' }
};

// Cached Supabase clients
const clients = {};

function getSupabaseClient(dbId) {
  const cfg = dbConfig[dbId];
  if (!cfg || !cfg.url || !cfg.key) {
    return null; // Fall back to mock mode
  }

  const cacheKey = `${dbId}-${cfg.url}`;
  if (!clients[cacheKey]) {
    try {
      clients[cacheKey] = createClient(cfg.url, cfg.key);
    } catch (e) {
      console.error(`Failed to create client for ${dbId}:`, e.message);
      return null;
    }
  }
  return clients[cacheKey];
}

const JWT_SECRET = process.env.JWT_SECRET || 'aegis-portal-super-secret-key-12345';
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// Ensure users.json exists
if (!fs.existsSync(USERS_FILE)) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

function readUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading users file:', err);
    return [];
  }
}

function writeUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing users file:', err);
  }
}

// -------------------------------------------------------------
// Report generation log (Phase 1: Report Monitoring)
// Every PDF request (success or failure) gets appended here, since the
// Supabase projects don't track this themselves — it's the admin
// panel's own record of what it has generated.
// -------------------------------------------------------------
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
if (!fs.existsSync(REPORTS_FILE)) {
  fs.writeFileSync(REPORTS_FILE, '[]', 'utf8');
}

function readReports() {
  try {
    return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading reports file:', err);
    return [];
  }
}

function logReportEvent(entry) {
  try {
    const reports = readReports();
    reports.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry
    });
    // Keep the log bounded so it doesn't grow forever.
    const trimmed = reports.slice(-2000);
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing reports file:', err);
  }
}

// -------------------------------------------------------------
// Adapter health tracking (Phase 1: System / Health Monitoring)
// Persisted to disk (data/health-stats.json) so a backend restart/deploy
// doesn't erase the error-rate/latency history — same read/write-a-JSON-
// file pattern already used for data/reports.json. Still not a real time
// series (no per-day history, just running counters + a capped sample
// window), just no longer wiped by every restart.
// -------------------------------------------------------------
const HEALTH_STATS_FILE = path.join(__dirname, 'data', 'health-stats.json');
const MAX_LATENCY_SAMPLES = 200;

function defaultHealthStat() {
  return { calls: 0, errors: 0, totalLatencyMs: 0, latencies: [], lastError: null, lastErrorAt: null, lastSuccessAt: null };
}

function loadHealthStats() {
  const stats = {};
  let persisted = {};
  if (fs.existsSync(HEALTH_STATS_FILE)) {
    try {
      persisted = JSON.parse(fs.readFileSync(HEALTH_STATS_FILE, 'utf8'));
    } catch (err) {
      console.warn('Could not read health-stats.json, starting fresh:', err.message);
    }
  }
  for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
    stats[dbId] = { ...defaultHealthStat(), ...persisted[dbId] };
  }
  return stats;
}

const healthStats = loadHealthStats();

function saveHealthStats() {
  try {
    fs.writeFileSync(HEALTH_STATS_FILE, JSON.stringify(healthStats, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing health-stats.json:', err);
  }
}

function recordHealth(dbId, { ok, latencyMs, error }) {
  const stat = healthStats[dbId];
  if (!stat) return;
  stat.calls++;
  stat.totalLatencyMs += latencyMs;
  stat.latencies.push(latencyMs);
  if (stat.latencies.length > MAX_LATENCY_SAMPLES) stat.latencies.shift();
  if (ok) {
    stat.lastSuccessAt = new Date().toISOString();
  } else {
    stat.errors++;
    stat.lastError = error;
    stat.lastErrorAt = new Date().toISOString();
  }
  saveHealthStats();
}


// Nearest-rank percentile over a sample array (not interpolated — simple
// and good enough for a health dashboard, not a stats package).
function percentile(samples, p) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}

// -------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------

// Auth Routes (unprotected)
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const users = readUsers();
  const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ error: 'User with this email already exists.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = {
    id: Date.now().toString(),
    email: email.toLowerCase(),
    password: hashedPassword,
    role: 'admin',
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  writeUsers(users);

  const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({ success: true, token, email: newUser.email, role: newUser.role });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const users = readUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role || 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, token, email: user.email, role: user.role || 'admin' });
});

// Social OAuth callback (unprotected) — the OAuth provider redirects the
// user's browser here directly, so it can't carry a Bearer token; CSRF
// protection is the signed `state` param instead (see routes/social.js).
// Must be registered before the global authenticateToken gate below.
app.use('/api', socialRoutes.publicRouter);

// Protect all subsequent endpoints
app.use(authenticateToken);

// Current role for the logged-in user, read fresh from users.json on every
// request rather than trusted from the JWT — so changing someone's role
// (scripts/set-user-role.js) takes effect immediately instead of after their
// 24h token expires. Accounts created before roles existed have no `role`
// field and count as 'admin'.
function currentUserRole(req) {
  const user = req.user && readUsers().find(u => u.id === req.user.id);
  return user ? (user.role || 'admin') : null;
}

// Role gate. Responds 403 with code FORBIDDEN_ROLE (not a bare 403) so the
// frontend can tell "not allowed here" apart from "token invalid", which
// authenticateToken also answers with 403 and which does mean log out.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(currentUserRole(req))) {
      return res.status(403).json({ error: 'You do not have permission to access this resource.', code: 'FORBIDDEN_ROLE' });
    }
    next();
  };
}

// Finance is a Sales-only role: it can reach the leads endpoints and the
// /auth/me role check, and nothing else — no Overview/Analytics/Social/
// Settings/candidate data. Mounted on '/api' (before the social router,
// before leads, before every other endpoint below) so it's the first
// thing every request hits after authentication. Admin is unaffected by
// this gate and can reach both Sales and everything else.
function restrictFinanceToSalesOnly(req, res, next) {
  if (currentUserRole(req) === 'finance' && req.path !== '/auth/me' && !req.path.startsWith('/leads')) {
    return res.status(403).json({ error: 'Finance accounts can only access the Sales module.', code: 'FORBIDDEN_ROLE' });
  }
  next();
}
app.use('/api', restrictFinanceToSalesOnly);

app.get('/api/auth/me', (req, res) => {
  const role = currentUserRole(req);
  if (!role) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({ email: req.user.email, role });
});

// Social module routes (protected) — accounts, connect, posts, mentions,
// inbox, analytics. See routes/social.js.
app.use('/api', socialRoutes.protectedRouter);

// Leads routes (protected) — see routes/leads.js. The Sales module is
// open to finance and admin. The gate is mounted on /api/leads
// specifically: mounting it on /api alongside the router would run it
// for every /api request that reaches this point and lock out roles
// that aren't finance/admin from all the routes below.
app.use('/api/leads', requireRole('finance', 'admin'));
app.use('/api', leadsRoutes);

// Get dashboard configuration and connection status
app.get('/api/status', (req, res) => {
  const status = {};
  for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
    const cfg = dbConfig[dbId];
    const hasConfig = !!(cfg && cfg.url && cfg.key);
    const client = getSupabaseClient(dbId);
    status[dbId] = {
      name: ADAPTERS[dbId].metadata.name,
      description: ADAPTERS[dbId].metadata.description,
      configured: hasConfig,
      connectionOk: hasConfig && client !== null,
      mode: hasConfig && client !== null ? 'live' : 'mock'
    };
  }
  res.json(status);
});

// Update configurations at runtime
app.post('/api/config', (req, res) => {
  const { dbId, url, key } = req.body;
  if (!dbConfig[dbId]) {
    return res.status(400).json({ error: 'Invalid database identifier. Must be db1 - db5.' });
  }
  dbConfig[dbId] = { url, key };
  res.json({ success: true, message: `Updated configuration for ${dbId}.` });
});

// Reset configurations
app.post('/api/config/reset', (req, res) => {
  dbConfig = {
    db1: { url: process.env.SUPABASE_URL_1 || '', key: process.env.SUPABASE_KEY_1 || '' },
    db2: { url: process.env.SUPABASE_URL_2 || '', key: process.env.SUPABASE_KEY_2 || '' },
    db3: { url: process.env.SUPABASE_URL_3 || '', key: process.env.SUPABASE_KEY_3 || '' },
    db4: { url: process.env.SUPABASE_URL_4 || '', key: process.env.SUPABASE_KEY_4 || '' },
    db5: { url: process.env.SUPABASE_URL_5 || '', key: process.env.SUPABASE_KEY_5 || '' },
    db6: { url: process.env.SUPABASE_URL_6 || '', key: process.env.SUPABASE_KEY_6 || '' }
  };
  res.json({ success: true, message: 'Reset configurations to environment variables.' });
});

// -------------------------------------------------------------
// Aggregation helpers (Phase 1: Master KPIs + Phase 2: Score distribution)
// -------------------------------------------------------------

// Bucket a candidate's percentage score into low/medium/high.
// Thresholds match the frontend's getScoreClass() so badges agree everywhere.
function scoreBucket(pct) {
  if (pct >= 85) return 'high';
  if (pct >= 60) return 'medium';
  return 'low';
}

// Given a list of standardized candidates ({ score, maxScore, testDate }),
// compute the aggregate stats a single tool card/row needs.
function computeToolStats(candidates) {
  const totalCount = candidates.length;

  if (totalCount === 0) {
    return {
      totalTestTakers: 0,
      averageScorePercentage: 0,
      medianScorePercentage: 0,
      minScorePercentage: 0,
      maxScorePercentage: 0,
      scoreDistribution: { low: 0, medium: 0, high: 0 },
      lastActivity: null
    };
  }

  const pcts = candidates.map(c => (c.maxScore > 0 ? (c.score / c.maxScore) * 100 : 0));

  const avgScore = Math.round(pcts.reduce((sum, p) => sum + p, 0) / totalCount);

  const sortedPcts = [...pcts].sort((a, b) => a - b);
  const mid = Math.floor(sortedPcts.length / 2);
  const medianScore = Math.round(
    sortedPcts.length % 2 !== 0
      ? sortedPcts[mid]
      : (sortedPcts[mid - 1] + sortedPcts[mid]) / 2
  );

  const buckets = { low: 0, medium: 0, high: 0 };
  pcts.forEach(p => { buckets[scoreBucket(p)]++; });
  const scoreDistribution = {
    low: Math.round((buckets.low / totalCount) * 100),
    medium: Math.round((buckets.medium / totalCount) * 100),
    high: Math.round((buckets.high / totalCount) * 100)
  };

  // Most recent testDate across candidates, if present/parseable.
  const validDates = candidates
    .map(c => c.testDate ? new Date(c.testDate) : null)
    .filter(d => d && !isNaN(d.getTime()));
  const lastActivity = validDates.length > 0
    ? new Date(Math.max(...validDates.map(d => d.getTime()))).toISOString()
    : null;

  return {
    totalTestTakers: totalCount,
    averageScorePercentage: avgScore,
    medianScorePercentage: medianScore,
    minScorePercentage: Math.round(Math.min(...pcts)),
    maxScorePercentage: Math.round(Math.max(...pcts)),
    scoreDistribution,
    lastActivity
  };
}

// Compare candidate volume in the last 7 days vs the 7 days before that,
// per tool. Used for the ↑/↓ trend indicator on the tool-wise table.
function computeTrend(candidates) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const last7Start = now - 7 * day;
  const prior7Start = now - 14 * day;

  let last7 = 0;
  let prior7 = 0;
  for (const c of candidates) {
    if (!c.testDate) continue;
    const t = new Date(c.testDate).getTime();
    if (isNaN(t)) continue;
    if (t >= last7Start && t <= now) last7++;
    else if (t >= prior7Start && t < last7Start) prior7++;
  }

  if (prior7 === 0) {
    return { direction: last7 > 0 ? 'up' : 'flat', changePercent: last7 > 0 ? 100 : 0 };
  }
  const changePercent = Math.round(((last7 - prior7) / prior7) * 100);
  return { direction: changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'flat', changePercent };
}

// Payment conversion for one tool, live-mode only — mirrors the same
// >=5-submissions gate used by the alerts panel so a single paid/unpaid
// submission doesn't produce a misleading 0%/100% rate. Returns null when
// the adapter has no payment concept or there isn't enough live data yet.
const MIN_PAYMENT_SAMPLE = 5;
async function getToolPaymentRate(dbId, adapter) {
  if (typeof adapter.getPaymentSummary !== 'function') return null;
  const client = getSupabaseClient(dbId);
  if (!client) return null;
  try {
    const payment = await adapter.getPaymentSummary(client);
    const total = payment.paidCount + payment.unpaidCount;
    return total >= MIN_PAYMENT_SAMPLE ? payment.paymentRate : null;
  } catch (err) {
    console.warn(`Payment summary failed for ${dbId} during tool scoring:`, err.message);
    return null;
  }
}

// Tool scoring/ranking (Star/Growth/Maintain/Review) — an honest, narrow
// composite: performance = average of score quality and payment
// conversion (only where the tool actually tracks payment), momentum =
// the real 7-day-vs-prior-7-day volume trend already computed above.
// Deliberately NOT revenue-weighted or satisfaction-weighted — we don't
// have revenue or NPS data for most tools, so those never entered the
// score in the first place, rather than being estimated.
const MIN_SCORING_SAMPLE = 5;
const PERFORMANCE_THRESHOLD = 55;

function computeToolTier({ stats, trend, paymentRate }) {
  if (stats.totalTestTakers < MIN_SCORING_SAMPLE) {
    return { tier: 'review', performanceScore: null, reason: `Not enough data yet (${stats.totalTestTakers} assessment${stats.totalTestTakers === 1 ? '' : 's'} — need ${MIN_SCORING_SAMPLE}+)` };
  }

  const metrics = [stats.averageScorePercentage];
  if (paymentRate !== null) metrics.push(paymentRate);
  const performanceScore = Math.round(metrics.reduce((a, b) => a + b, 0) / metrics.length);
  const strongPerformance = performanceScore >= PERFORMANCE_THRESHOLD;
  const positiveMomentum = trend.direction === 'up';

  let tier;
  let reason;
  if (strongPerformance && positiveMomentum) {
    tier = 'star';
    reason = `Strong performance (${performanceScore}/100) and growing (${trend.changePercent > 0 ? '+' : ''}${trend.changePercent}% vs prior week)`;
  } else if (strongPerformance) {
    tier = 'maintain';
    reason = `Strong performance (${performanceScore}/100), volume ${trend.direction === 'down' ? 'declining' : 'steady'}`;
  } else if (positiveMomentum) {
    tier = 'growth';
    reason = `Growing volume (${trend.changePercent > 0 ? '+' : ''}${trend.changePercent}%) but performance still building (${performanceScore}/100)`;
  } else {
    tier = 'review';
    reason = `Performance (${performanceScore}/100) and volume both need a look`;
  }

  return { tier, performanceScore, reason };
}

// Fetch (live-or-mock) candidates for one adapter, same fallback logic
// used everywhere else in this file. Live attempts are timed and
// recorded into healthStats regardless of outcome.
async function fetchCandidatesForTool(dbId) {
  const adapter = ADAPTERS[dbId];
  const client = getSupabaseClient(dbId);
  let isMock = false;
  let candidates = [];

  if (client) {
    const start = Date.now();
    try {
      candidates = await adapter.getCandidates(client);
      recordHealth(dbId, { ok: true, latencyMs: Date.now() - start });
    } catch (err) {
      console.warn(`Query failed for ${dbId}, falling back to mock data. Error:`, err.message);
      candidates = adapter.getMockCandidates();
      isMock = true;
      recordHealth(dbId, { ok: false, latencyMs: Date.now() - start, error: err.message });
    }
  } else {
    candidates = adapter.getMockCandidates();
    isMock = true;
  }

  return { adapter, candidates, isMock };
}

// Tool-wise monitoring table data (doc section 2), enriched with score
// distribution (section 9). NOTE: totalAttempts/completed are currently
// equal because adapters only expose completed records today — in
// progress/abandoned counts need session-status data from each Supabase
// project (see schema audit) before those columns can be real.
app.get('/api/overview', async (req, res) => {
  try {
    const overview = [];
    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const { adapter, candidates, isMock } = await fetchCandidatesForTool(dbId);
      const stats = computeToolStats(candidates);
      const trend = computeTrend(candidates);

      overview.push({
        id: dbId,
        name: adapter.metadata.name,
        category: adapter.metadata.category || 'Uncategorized',
        description: adapter.metadata.description,
        mode: isMock ? 'mock' : 'live',
        ...stats,
        trend
      });
    }

    res.json(overview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Master KPI cards (doc section 1) — aggregated across ALL tools.
// Only includes numbers we can honestly compute from completed-candidate
// data today. Fields the doc asks for that need new instrumentation
// (In Progress, Abandoned, Active Users, Active Organizations, Reports
// Pending) are intentionally omitted rather than faked — see
// /docs/schema-audit for what's needed to add them.
app.get('/api/overview/summary', async (req, res) => {
  try {
    let totalAssessments = 0;
    let weightedScoreSum = 0;
    let liveToolsCount = 0;
    let mockToolsCount = 0;
    let mostRecentActivity = null;

    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const { candidates, isMock } = await fetchCandidatesForTool(dbId);
      const stats = computeToolStats(candidates);

      totalAssessments += stats.totalTestTakers;
      weightedScoreSum += stats.averageScorePercentage * stats.totalTestTakers;
      isMock ? mockToolsCount++ : liveToolsCount++;

      if (stats.lastActivity) {
        const d = new Date(stats.lastActivity);
        if (!mostRecentActivity || d > new Date(mostRecentActivity)) {
          mostRecentActivity = stats.lastActivity;
        }
      }
    }

    const averageScorePercentage = totalAssessments > 0
      ? Math.round(weightedScoreSum / totalAssessments)
      : 0;

    res.json({
      totalAssessments,          // sum of completed records across all tools
      averageScorePercentage,    // weighted average score across all tools
      totalTools: liveToolsCount + mockToolsCount,
      liveToolsCount,
      mockToolsCount,
      lastActivity: mostRecentActivity
      // NOT included yet (needs schema audit / new instrumentation):
      // inProgress, abandoned, completionRate, avgCompletionTime,
      // activeUsers, activeOrganizations, reportsGenerated, reportsPending
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cross-tool Organizations/Users/Reports summary (doc section 16's
// bottom row). Not deduplicated across tools — each source database
// is a separate system, so the same org/user name appearing in two
// tools isn't necessarily the same real-world entity. Only counts
// live tools; mock-mode org/user breakdowns are empty anyway.
//
// Also reports activeUsers30d/activeOrgs30d (last-activity within 30
// days, from the same breakdowns above — no new instrumentation) and a
// blended repeat-assessment retention cohort (D1/D7/D30) from every tool
// whose adapter exposes getRetentionCohort (db1, db5 today). Retention
// here means "came back for another completed assessment," not
// login/session retention — no adapter schema has session data.
app.get('/api/overview/entities', async (req, res) => {
  try {
    let totalOrganizations = 0;
    let totalUsers = 0;
    let activeOrgs30d = 0;
    let activeUsers30d = 0;
    let cohortTotal = 0, d1Weighted = 0, d7Weighted = 0, d30Weighted = 0;

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const isActive = lastActivity => lastActivity && (now - new Date(lastActivity).getTime()) <= THIRTY_DAYS;

    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const adapter = ADAPTERS[dbId];
      const client = getSupabaseClient(dbId);
      if (!client) continue;

      if (typeof adapter.getOrgBreakdown === 'function') {
        try {
          const orgs = await adapter.getOrgBreakdown(client);
          totalOrganizations += orgs.length;
          activeOrgs30d += orgs.filter(o => isActive(o.lastActivity)).length;
        } catch (err) {
          console.warn(`getOrgBreakdown failed for ${dbId} during entities summary:`, err.message);
        }
      }

      if (typeof adapter.getUserBreakdown === 'function') {
        try {
          const result = await adapter.getUserBreakdown(client);
          totalUsers += result.totalUniqueUsers;
          activeUsers30d += result.users.filter(u => isActive(u.lastActivity)).length;
        } catch (err) {
          console.warn(`getUserBreakdown failed for ${dbId} during entities summary:`, err.message);
        }
      }

      if (typeof adapter.getRetentionCohort === 'function') {
        try {
          const r = await adapter.getRetentionCohort(client);
          cohortTotal += r.totalUsers;
          d1Weighted += (r.d1Pct / 100) * r.totalUsers;
          d7Weighted += (r.d7Pct / 100) * r.totalUsers;
          d30Weighted += (r.d30Pct / 100) * r.totalUsers;
        } catch (err) {
          console.warn(`getRetentionCohort failed for ${dbId} during entities summary:`, err.message);
        }
      }
    }

    const totalReports = readReports().filter(r => r.status === 'success').length;

    res.json({
      totalOrganizations,
      totalUsers,
      totalReports,
      activeOrgs30d,
      activeUsers30d,
      retention: cohortTotal > 0 ? {
        cohortSize: cohortTotal,
        d1Pct: Math.round((d1Weighted / cohortTotal) * 100),
        d7Pct: Math.round((d7Weighted / cohortTotal) * 100),
        d30Pct: Math.round((d30Weighted / cohortTotal) * 100)
      } : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tool scoring/ranking — Star/Growth/Maintain/Review tiers. See
// computeToolTier() above for exactly what does and doesn't feed the
// composite (no revenue or satisfaction data — most tools don't have it).
app.get('/api/tool-scoring', async (req, res) => {
  try {
    const tools = [];
    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const { adapter, candidates, isMock } = await fetchCandidatesForTool(dbId);
      const stats = computeToolStats(candidates);
      const trend = computeTrend(candidates);
      const paymentRate = isMock ? null : await getToolPaymentRate(dbId, adapter);
      const { tier, performanceScore, reason } = computeToolTier({ stats, trend, paymentRate });

      tools.push({
        id: dbId,
        name: adapter.metadata.name,
        category: adapter.metadata.category || 'Uncategorized',
        mode: isMock ? 'mock' : 'live',
        usage: stats.totalTestTakers,
        avgScorePercentage: stats.averageScorePercentage,
        paymentRate,
        hasPaymentData: paymentRate !== null,
        trend,
        performanceScore,
        tier,
        reason
      });
    }
    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tool Performance — the org-head-grade single source of truth for "how
// is each tool doing and what should I do about it." One row per tool
// merging every signal this panel can honestly compute: usage + 7-day
// trend, score quality, payment conversion (only where a tool actually
// tracks it), org/user reach (only where a stable id exists), live
// health, and the same composite tier /api/tool-scoring already
// computes (reused via computeToolTier, not recomputed differently so
// the two views never disagree). A metric a tool's adapter doesn't
// support comes back null — same "don't fake it" rule as every other
// endpoint here, not a zero or a fabricated placeholder.
app.get('/api/tool-performance', async (req, res) => {
  try {
    const tools = [];
    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const adapter = ADAPTERS[dbId];
      const { candidates, isMock } = await fetchCandidatesForTool(dbId);
      const stats = computeToolStats(candidates);
      const trend = computeTrend(candidates);
      const client = isMock ? null : getSupabaseClient(dbId);

      const paymentRate = isMock ? null : await getToolPaymentRate(dbId, adapter);
      const { tier, performanceScore, reason } = computeToolTier({ stats, trend, paymentRate });

      let orgCount = null;
      if (client && typeof adapter.getOrgBreakdown === 'function') {
        try {
          orgCount = (await adapter.getOrgBreakdown(client)).length;
        } catch (err) {
          console.warn(`getOrgBreakdown failed for ${dbId} during tool-performance:`, err.message);
        }
      }

      let uniqueUsers = null;
      let avgAttemptsPerUser = null;
      if (client && typeof adapter.getUserBreakdown === 'function') {
        try {
          const ub = await adapter.getUserBreakdown(client);
          uniqueUsers = ub.totalUniqueUsers;
          avgAttemptsPerUser = ub.averageAttemptsPerUser;
        } catch (err) {
          console.warn(`getUserBreakdown failed for ${dbId} during tool-performance:`, err.message);
        }
      }

      const health = await buildHealthEntry(dbId);

      tools.push({
        id: dbId,
        name: adapter.metadata.name,
        category: adapter.metadata.category || 'Uncategorized',
        mode: isMock ? 'mock' : 'live',
        usage: stats.totalTestTakers,
        avgScorePercentage: stats.averageScorePercentage,
        medianScorePercentage: stats.medianScorePercentage,
        scoreDistribution: stats.scoreDistribution,
        lastActivity: stats.lastActivity,
        trend,
        hasPaymentData: paymentRate !== null,
        paymentRate,
        orgCount,
        uniqueUsers,
        avgAttemptsPerUser,
        health: {
          status: health.status,
          errorRate: health.errorRate,
          avgLatencyMs: health.avgLatencyMs,
          p95LatencyMs: health.p95LatencyMs,
          availability: health.availability
        },
        performanceScore,
        tier,
        reason
      });
    }
    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Org tool-usage breadth ("N% of orgs use only 1-2 tools") — aggregates
// the per-tool org breakdowns already fetched for Organization Monitoring
// into a cross-tool view. Matches organizations by name across the 5
// separate Supabase projects, which is the best available signal, not a
// verified identity match — the same caveat /api/overview/entities notes.
app.get('/api/org-breadth', async (req, res) => {
  try {
    const orgDetail = {}; // org name -> { tools: Set<dbId>, totalAssessments, lastActivity }

    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const adapter = ADAPTERS[dbId];
      const client = getSupabaseClient(dbId);
      if (!client || typeof adapter.getOrgBreakdown !== 'function') continue;

      try {
        const orgs = await adapter.getOrgBreakdown(client);
        for (const org of orgs) {
          const key = (org.organization || '').trim();
          if (!key || key.toLowerCase() === 'unassigned') continue;
          if (!orgDetail[key]) orgDetail[key] = { tools: new Set(), totalAssessments: 0, lastActivity: null };
          orgDetail[key].tools.add(dbId);
          orgDetail[key].totalAssessments += org.totalAssessments || 0;
          if (org.lastActivity) {
            const d = new Date(org.lastActivity);
            if (!orgDetail[key].lastActivity || d > new Date(orgDetail[key].lastActivity)) {
              orgDetail[key].lastActivity = org.lastActivity;
            }
          }
        }
      } catch (err) {
        console.warn(`getOrgBreakdown failed for ${dbId} during org-breadth check:`, err.message);
      }
    }

    const entries = Object.entries(orgDetail);
    const counts = entries.map(([, v]) => v.tools.size);
    const totalOrgs = counts.length;
    const distribution = [1, 2, 3, 4, 5, 6].map(n => {
      const orgCount = counts.filter(c => c === n).length;
      return { toolCount: n, orgCount, percentage: totalOrgs > 0 ? Math.round((orgCount / totalOrgs) * 100) : 0 };
    });

    const lowUsageOrgCount = counts.filter(c => c <= 2).length;
    const lowUsagePercentage = totalOrgs > 0 ? Math.round((lowUsageOrgCount / totalOrgs) * 100) : 0;

    // Top organizations by tool adoption depth (ties broken by volume) —
    // the concrete "who" behind the aggregate distribution above, capped
    // so the panel doesn't turn into an unbounded list.
    const topOrgs = entries
      .map(([organization, v]) => ({
        organization,
        toolsUsed: v.tools.size,
        totalAssessments: v.totalAssessments,
        lastActivity: v.lastActivity
      }))
      .sort((a, b) => b.toolsUsed - a.toolsUsed || b.totalAssessments - a.totalAssessments)
      .slice(0, 15);

    res.json({ totalOrgs, distribution, lowUsagePercentage, topOrgs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch candidate list for a specific database
app.get('/api/assessments/:dbId/candidates', async (req, res) => {
  const { dbId } = req.params;
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }

  const client = getSupabaseClient(dbId);
  try {
    let candidates = [];
    let isMock = false;

    if (client) {
      try {
        candidates = await adapter.getCandidates(client);
      } catch (err) {
        console.warn(`Query failed for ${dbId}, falling back to mock.`, err.message);
        candidates = adapter.getMockCandidates();
        isMock = true;
      }
    } else {
      candidates = adapter.getMockCandidates();
      isMock = true;
    }

    res.json({
      assessmentName: adapter.metadata.name,
      mode: isMock ? 'mock' : 'live',
      candidates
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch detailed answers for a specific candidate in a database
app.get('/api/assessments/:dbId/candidates/:candidateId', async (req, res) => {
  const { dbId, candidateId } = req.params;
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }

  const client = getSupabaseClient(dbId);
  try {
    let details;
    if (client && !candidateId.startsWith('db')) { // Mock candidate IDs start with 'db'
      try {
        details = await adapter.getCandidateDetails(client, candidateId);
      } catch (err) {
        console.warn(`Query failed for details of ${candidateId} in ${dbId}, falling back to mock.`, err.message);
        details = adapter.getMockCandidateDetails(candidateId);
      }
    } else {
      details = adapter.getMockCandidateDetails(candidateId);
    }
    res.json(details);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate PDF Report for a Candidate
app.get('/api/assessments/:dbId/candidates/:candidateId/pdf', async (req, res) => {
  const { dbId, candidateId } = req.params;
  const pdfStartTime = Date.now();
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }

  const client = getSupabaseClient(dbId);
  let details;
  try {
    if (client && !candidateId.startsWith('db')) {
      try {
        details = await adapter.getCandidateDetails(client, candidateId);
      } catch (err) {
        details = adapter.getMockCandidateDetails(candidateId);
      }
    } else {
      details = adapter.getMockCandidateDetails(candidateId);
    }

    const { personalInfo, results } = details;

    // A. Check if there is a pre-generated PDF URL in the candidate details (e.g. Founder Compatibility database)
    if (personalInfo.pdfUrl) {
      try {
        console.log(`Downloading pre-generated PDF from URL: ${personalInfo.pdfUrl}`);
        const pdfRes = await fetch(personalInfo.pdfUrl);
        if (pdfRes.ok) {
          const arrayBuffer = await pdfRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename=${personalInfo.name.replace(/\s+/g, '_')}_Result.pdf`);
          res.send(buffer);
          logReportEvent({ dbId, toolName: adapter.metadata.name, candidateId, candidateName: personalInfo.name, status: 'success', source: 'pregenerated', durationMs: Date.now() - pdfStartTime });
          return;
        } else {
          console.warn(`Failed to download PDF from URL: ${personalInfo.pdfUrl}, status: ${pdfRes.status}`);
        }
      } catch (err) {
        console.error(`Error downloading pre-generated PDF:`, err.message);
      }
    }

    // 1. Try to fetch existing dashboard export image from cii_dashboard_exports
    let dashboardImageBuffer = null;
    if (client && personalInfo.sessionId) {
      try {
        const { data: exports, error: expError } = await client
          .from('cii_dashboard_exports')
          .select('file_url')
          .eq('session_id', personalInfo.sessionId)
          .limit(1);

        if (!expError && exports && exports.length > 0) {
          const imageUrl = exports[0].file_url;
          console.log(`Fetching dashboard export image: ${imageUrl}`);
          const imgRes = await fetch(imageUrl);
          if (imgRes.ok) {
            const arrayBuffer = await imgRes.arrayBuffer();
            dashboardImageBuffer = Buffer.from(arrayBuffer);
          } else {
            console.warn(`Failed to fetch image from URL: ${imageUrl}, status: ${imgRes.status}`);
          }
        }
      } catch (err) {
        console.warn(`Error trying to get dashboard image export:`, err.message);
      }
    }

    // 2. Or check if the candidate details returned a direct screenshot URL (e.g. DB4 submissions screenshot)
    if (!dashboardImageBuffer && personalInfo.screenshotUrl) {
      try {
        console.log(`Fetching direct screenshot URL: ${personalInfo.screenshotUrl}`);
        const imgRes = await fetch(personalInfo.screenshotUrl);
        if (imgRes.ok) {
          const arrayBuffer = await imgRes.arrayBuffer();
          dashboardImageBuffer = Buffer.from(arrayBuffer);
        } else {
          console.warn(`Failed to fetch direct screenshot from URL: ${personalInfo.screenshotUrl}, status: ${imgRes.status}`);
        }
      } catch (err) {
        console.warn(`Error trying to get direct screenshot URL:`, err.message);
      }
    }

    // Stream PDF to the client
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${personalInfo.name.replace(/\s+/g, '_')}_Result.pdf`);

    if (dashboardImageBuffer) {
      // Create a PDF with zero margins to fit the PNG dashboard export
      const doc = new PDFDocument({ margin: 0, bufferPages: true });
      doc.pipe(res);

      // Embed the image centered or full-width (width of letter page is 612 pt)
      doc.image(dashboardImageBuffer, 0, 0, { width: 612 });
      doc.end();
      logReportEvent({ dbId, toolName: adapter.metadata.name, candidateId, candidateName: personalInfo.name, status: 'success', source: 'dashboard-image', durationMs: Date.now() - pdfStartTime });
      return;
    }

    // --- FALLBACK: Text PDF Generation ---
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    doc.pipe(res);

    // Title / Header Banner
    doc.rect(0, 0, 612, 100).fill('#1f2937');
    doc.fillColor('#ffffff')
      .fontSize(22)
      .font('Helvetica-Bold')
      .text('ASSESSMENT REPORT', 50, 35);

    doc.fontSize(12)
      .font('Helvetica')
      .text(adapter.metadata.name.toUpperCase(), 50, 65);

    // Personal Info Panel
    doc.fillColor('#111827')
      .fontSize(16)
      .font('Helvetica-Bold')
      .text('Candidate Profile', 50, 130);

    doc.rect(50, 155, 512, 85).fill('#f3f4f6');

    doc.fillColor('#374151')
      .fontSize(10)
      .font('Helvetica-Bold')
      .text('Name:', 70, 170)
      .font('Helvetica')
      .text(personalInfo.name, 140, 170);

    doc.font('Helvetica-Bold')
      .text('Email:', 70, 190)
      .font('Helvetica')
      .text(personalInfo.email, 140, 190);

    doc.font('Helvetica-Bold')
      .text('Test Date:', 70, 210)
      .font('Helvetica')
      .text(new Date(personalInfo.testDate).toLocaleString(), 140, 210);

    // Score Summary
    const pct = Math.round((personalInfo.score / personalInfo.maxScore) * 100);
    doc.rect(400, 170, 140, 55).stroke('#d1d5db');
    doc.font('Helvetica-Bold')
      .fontSize(9)
      .text('FINAL SCORE', 410, 178, { width: 120, align: 'center' });

    doc.fontSize(18)
      .fillColor('#10b981')
      .text(`${personalInfo.score} / ${personalInfo.maxScore} (${pct}%)`, 410, 195, { width: 120, align: 'center' });

    // Question & Answers Section
    doc.fillColor('#111827')
      .fontSize(16)
      .font('Helvetica-Bold')
      .text('Detailed Responses', 50, 265);

    let currentY = 295;

    results.forEach((item, index) => {
      // Check if we need a new page
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
      }

      // Question header
      doc.fillColor('#374151')
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(`Question ${index + 1}: ${item.question}`, 50, currentY, { width: 512 });

      currentY += doc.heightOfString(`Question ${index + 1}: ${item.question}`, { width: 512 }) + 5;

      // Answer block
      doc.rect(50, currentY, 512, doc.heightOfString(item.answer, { width: 492 }) + 16).fill('#f9fafb');

      doc.fillColor('#1f2937')
        .fontSize(10)
        .font('Helvetica')
        .text(item.answer, 60, currentY + 8, { width: 492 });

      currentY += doc.heightOfString(item.answer, { width: 492 }) + 18;

      // Question Score
      doc.fillColor('#6b7280')
        .fontSize(9)
        .font('Helvetica-Bold')
        .text(`Points: ${item.score} / ${item.maxScore}`, 50, currentY, { align: 'right', width: 512 });

      currentY += 25;

      // Draw horizontal line separator
      doc.moveTo(50, currentY - 10).lineTo(562, currentY - 10).strokeColor('#e5e7eb').stroke();
    });

    // Add footer
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.rect(0, 770, 612, 22).fill('#f3f4f6');
      doc.fillColor('#9ca3af')
        .fontSize(8)
        .text(`Page ${i + 1} of ${pages.count}  |  Assessment Dashboard PDF Service`, 50, 777, { align: 'center', width: 512 });
    }

    doc.end();
    logReportEvent({ dbId, toolName: adapter.metadata.name, candidateId, candidateName: personalInfo.name, status: 'success', source: 'generated', durationMs: Date.now() - pdfStartTime });
  } catch (error) {
    console.error(error);
    logReportEvent({ dbId, toolName: adapter.metadata.name, candidateId, candidateName: details?.personalInfo?.name || null, status: 'failed', error: error.message, durationMs: Date.now() - pdfStartTime });
    res.status(500).json({ error: error.message });
  }
});

// Payment Monitoring — user-requested addition, outside the original
// DASHBOARD.docx scope. Paid/unpaid counts + conversion rate for every
// supported tool; revenue is included only where a dollar amount
// column exists (db1). db2/db5's payment columns are unverified guesses
// (see the comment above getPaymentSummary in each adapter) — they were
// added for schema-extend parity with db4/db6, not confirmed live.
app.get('/api/assessments/:dbId/payments', async (req, res) => {
  const { dbId } = req.params;
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }

  const client = getSupabaseClient(dbId);

  if (typeof adapter.getPaymentSummary === 'function') {
    if (!client) {
      return res.json({ supported: true, mode: 'mock', ...adapter.getMockPaymentSummary() });
    }
    try {
      const summary = await adapter.getPaymentSummary(client);
      return res.json({ supported: true, mode: 'live', ...summary });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(200).json({ supported: false });
});

// Acquisition monitoring (visitors, bounce rate, landing conversion) —
// see lib/ga4.js for why this can't come from Supabase: none of the 6
// adapters see a visitor who didn't complete an assessment. Sourced from
// the GA4 Data API once GA4_SERVICE_ACCOUNT_KEY + a per-tool
// GA4_PROPERTY_ID_<n> are configured; until then every tool reports
// supported: true, mode: 'mock' with all-zero/null values rather than a
// fabricated traffic number that could be mistaken for a real signal.
app.get('/api/assessments/:dbId/acquisition', async (req, res) => {
  const { dbId } = req.params;
  if (!ADAPTERS[dbId]) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }

  if (!ga4.isConfigured(dbId)) {
    return res.json({ supported: true, mode: 'mock', ...ga4.getMockAcquisitionSummary() });
  }

  try {
    const summary = await ga4.getAcquisitionSummary(dbId, Number(req.query.days) || 7);
    res.json({ supported: true, mode: 'live', ...summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cross-tool acquisition summary — same "not configured yet" fallback
// per tool, just merged into one call for the Analytics overview panel.
app.get('/api/acquisition', async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const tools = [];
    for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
      const adapter = ADAPTERS[dbId];
      const configured = ga4.isConfigured(dbId);
      let summary;
      let mode;
      if (!configured) {
        summary = ga4.getMockAcquisitionSummary();
        mode = 'mock';
      } else {
        try {
          summary = await ga4.getAcquisitionSummary(dbId, days);
          mode = 'live';
        } catch (err) {
          console.warn(`GA4 acquisition summary failed for ${dbId}:`, err.message);
          summary = ga4.getMockAcquisitionSummary();
          mode = 'error';
        }
      }
      tools.push({ id: dbId, name: adapter.metadata.name, mode, ...summary });
    }

    res.json({
      configuredCount: tools.filter(t => t.mode === 'live').length,
      totalTools: tools.length,
      tools
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tool-Specific Dimensions (doc section 10) — only implemented where the
// schema audit confirmed real per-dimension score columns (currently db1).
app.get('/api/assessments/:dbId/dimensions', async (req, res) => {
  const { dbId } = req.params;
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }
  if (typeof adapter.getDimensionAverages !== 'function') {
    return res.status(200).json({ supported: false, dimensions: [] });
  }

  const client = getSupabaseClient(dbId);
  if (!client) {
    return res.status(200).json({ supported: true, mode: 'mock', dimensions: adapter.getMockDimensionAverages() });
  }

  try {
    const dimensions = await adapter.getDimensionAverages(client);
    res.json({ supported: true, mode: 'live', dimensions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Organization monitoring (Phase 5) — only implemented for tools where
// the schema audit confirmed a real org column (db1, db3, db4, db5).
app.get('/api/assessments/:dbId/organizations', async (req, res) => {
  const { dbId } = req.params;
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }
  if (typeof adapter.getOrgBreakdown !== 'function') {
    return res.status(200).json({
      supported: false,
      reason: 'This tool has no organization column in its schema yet — see schema audit.',
      organizations: []
    });
  }

  const client = getSupabaseClient(dbId);
  if (!client) {
    return res.status(200).json({ supported: true, mode: 'mock', organizations: [] });
  }

  try {
    const organizations = await adapter.getOrgBreakdown(client);
    res.json({ supported: true, mode: 'live', organizations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User monitoring (Phase 5) — only implemented for tools where the
// schema audit confirmed a stable user/candidate id (db1, db5).
app.get('/api/assessments/:dbId/users', async (req, res) => {
  const { dbId } = req.params;
  const adapter = ADAPTERS[dbId];
  if (!adapter) {
    return res.status(400).json({ error: 'Invalid database identifier.' });
  }
  if (typeof adapter.getUserBreakdown !== 'function') {
    return res.status(200).json({
      supported: false,
      reason: 'This tool has no stable user/candidate id column in its schema yet — see schema audit.',
      users: []
    });
  }

  const client = getSupabaseClient(dbId);
  if (!client) {
    return res.status(200).json({ supported: true, mode: 'mock', totalUniqueUsers: 0, averageAttemptsPerUser: 0, users: [] });
  }

  try {
    const result = await adapter.getUserBreakdown(client);
    res.json({ supported: true, mode: 'live', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// Phase 1 additions: System health, report monitoring, usage trend,
// alerts and live activity — all built from data the admin panel
// already has (candidates + its own report log), no new source-schema
// columns required.
// -------------------------------------------------------------

// Tool Availability — pings each tool's actual public-facing website.
// This is deliberately separate from the Supabase query health below:
// a database can be perfectly reachable while the real candidate-
// facing site is suspended (confirmed case: mpa.infopaceindia.co.in
// returned "This service has been suspended by its owner" while its
// Supabase queries kept succeeding). Cached per tool so /api/health
// doesn't do a live network round-trip on every request.
const availabilityCache = {};
const AVAILABILITY_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function checkToolAvailability(dbId) {
  const url = ADAPTERS[dbId].metadata.siteUrl;
  if (!url) return null;

  const cached = availabilityCache[dbId];
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let result;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const bodyText = (await res.text()).slice(0, 2000);
    // Some suspended-hosting pages return HTTP 200 with a short plain-
    // text "suspended" message instead of an error status.
    const suspended = /suspended/i.test(bodyText) && bodyText.trim().length < 500;
    result = {
      url,
      status: !res.ok ? 'down' : suspended ? 'suspended' : 'up',
      statusCode: res.status,
      checkedAt: Date.now()
    };
  } catch (err) {
    result = { url, status: 'down', statusCode: null, error: err.message, checkedAt: Date.now() };
  } finally {
    clearTimeout(timeout);
  }

  availabilityCache[dbId] = result;
  return result;
}

// System / Health Monitoring (doc section 14) — per-adapter query
// health since the backend started, plus real Tool Availability.
async function buildHealthEntry(dbId) {
  const stat = healthStats[dbId];
  const cfg = dbConfig[dbId];
  const hasConfig = !!(cfg && cfg.url && cfg.key);
  const errorRate = stat.calls > 0 ? Math.round((stat.errors / stat.calls) * 100) : 0;
  const avgLatencyMs = stat.calls > 0 ? Math.round(stat.totalLatencyMs / stat.calls) : null;
  // A P95 from fewer than 5 samples is just the max — not a meaningful
  // percentile, so hide it rather than show a misleadingly precise number.
  const p95LatencyMs = stat.latencies.length >= 5 ? percentile(stat.latencies, 95) : null;

  let status = 'unknown';
  if (!hasConfig) status = 'mock';
  else if (errorRate > 20) status = 'critical';
  else if (errorRate > 0) status = 'warning';
  else if (stat.calls > 0) status = 'healthy';

  const availability = await checkToolAvailability(dbId);

  return {
    name: ADAPTERS[dbId].metadata.name,
    status,
    calls: stat.calls,
    errors: stat.errors,
    errorRate,
    avgLatencyMs,
    p95LatencyMs,
    lastError: stat.lastError,
    lastErrorAt: stat.lastErrorAt,
    lastSuccessAt: stat.lastSuccessAt,
    availability
  };
}

app.get('/api/health', async (req, res) => {
  const health = {};
  for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
    health[dbId] = await buildHealthEntry(dbId);
  }
  res.json(health);
});

// Report Monitoring (doc section 13) — generated/failed counts and a
// recent log, sourced from this backend's own PDF request history.
app.get('/api/reports/summary', (req, res) => {
  const reports = readReports();
  const byTool = {};
  let totalGenerated = 0;
  let totalFailed = 0;
  let durationSum = 0;
  let durationCount = 0;
  const generatedCandidateCounts = {};

  for (const r of reports) {
    if (!byTool[r.dbId]) byTool[r.dbId] = { generated: 0, failed: 0 };
    if (r.status === 'success') {
      totalGenerated++;
      byTool[r.dbId].generated++;
      if (typeof r.durationMs === 'number') {
        durationSum += r.durationMs;
        durationCount++;
      }
      // Same candidate + tool generated more than once = a regeneration.
      const key = `${r.dbId}:${r.candidateId}`;
      generatedCandidateCounts[key] = (generatedCandidateCounts[key] || 0) + 1;
    } else {
      totalFailed++;
      byTool[r.dbId].failed++;
    }
  }

  const totalRegenerated = Object.values(generatedCandidateCounts)
    .reduce((sum, count) => sum + Math.max(count - 1, 0), 0);

  const total = totalGenerated + totalFailed;
  res.json({
    totalGenerated,
    totalFailed,
    totalRegenerated,
    avgGenerationTimeMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    successRate: total > 0 ? Math.round((totalGenerated / total) * 100) : 100,
    byTool,
    recent: reports.slice(-20).reverse()
  });
});

// Usage trend (doc section 3) — completed-assessment counts bucketed
// by day. Only "Completed" is real; Started/Abandoned need session
// status data this dashboard doesn't have yet (see schema audit).
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

const MAX_CUSTOM_RANGE_DAYS = 366;

app.get('/api/overview/trend', async (req, res) => {
  try {
    const { startDate: startParam, endDate: endParam } = req.query;
    let dayKeys = [];
    let range;

    if (startParam || endParam) {
      const start = new Date(`${startParam}T00:00:00Z`);
      const end = new Date(`${endParam}T00:00:00Z`);
      if (!startParam || !endParam || isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
        return res.status(400).json({ error: 'Invalid custom date range — provide both startDate and endDate as YYYY-MM-DD, with startDate <= endDate.' });
      }
      const spanDays = Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
      if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
        return res.status(400).json({ error: `Custom range too large — max ${MAX_CUSTOM_RANGE_DAYS} days.` });
      }
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        dayKeys.push(new Date(d).toISOString().slice(0, 10));
      }
      range = 'custom';
    } else {
      range = RANGE_DAYS[req.query.range] ? req.query.range : '7d';
      const days = RANGE_DAYS[range];
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        dayKeys.push(d.toISOString().slice(0, 10));
      }
    }

    const dbIdFilter = req.query.dbId;
    const dbIds = dbIdFilter && ADAPTERS[dbIdFilter] ? [dbIdFilter] : ['db1', 'db2', 'db3', 'db4', 'db5', 'db6'];

    const buckets = {};
    dayKeys.forEach(key => { buckets[key] = { total: 0, byTool: {} }; });

    for (const dbId of dbIds) {
      const { candidates } = await fetchCandidatesForTool(dbId);
      for (const c of candidates) {
        if (!c.testDate) continue;
        const key = new Date(c.testDate).toISOString().slice(0, 10);
        if (key in buckets) {
          buckets[key].total++;
          buckets[key].byTool[dbId] = (buckets[key].byTool[dbId] || 0) + 1;
        }
      }
    }

    res.json({
      range,
      series: dayKeys.map(key => ({ date: key, completed: buckets[key].total, byTool: buckets[key].byTool }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Alerts / Attention Required (doc section 15) — derived signals from
// data already on hand: volume drop, low-score concentration, PDF
// failure rate, and elevated query error rate. Not the full doc list
// (that needs status/history data this dashboard doesn't have), but
// real anomalies rather than nothing. Each alert carries a `category`
// tag so the same signals can be re-grouped elsewhere (see the Weekly
// Review endpoint below) without recomputing anything.
async function buildAlerts() {
  const alerts = [];
  const reports = readReports();

  for (const dbId of ['db1', 'db2', 'db3', 'db4', 'db5', 'db6']) {
    const { adapter, candidates, isMock } = await fetchCandidatesForTool(dbId);
    const stats = computeToolStats(candidates);
    const trend = computeTrend(candidates);
    const name = adapter.metadata.name;

    // Site availability is independent of DB mock/live status — the
    // public site can be down even while mock data is showing fine.
    const availability = await checkToolAvailability(dbId);
    if (availability && availability.status !== 'up') {
      const reason = availability.status === 'suspended'
        ? 'the hosting service reports it as suspended'
        : `it returned ${availability.statusCode || 'no response'}`;
      alerts.push({ tool: name, dbId, severity: 'critical', category: 'availability', message: `Tool website is unreachable — ${reason} (${availability.url})` });
    }

    if (isMock) {
      alerts.push({ tool: name, dbId, severity: 'info', category: 'dataSource', message: 'Running on mock data — live Supabase connection not configured' });
    } else {
      if (trend.direction === 'down' && Math.abs(trend.changePercent) >= 20) {
        alerts.push({ tool: name, dbId, severity: 'warning', category: 'volume', message: `Completed assessments dropped ${Math.abs(trend.changePercent)}% vs the prior 7 days` });
      }
      if (stats.totalTestTakers > 0 && stats.scoreDistribution.low >= 40) {
        alerts.push({ tool: name, dbId, severity: 'warning', category: 'scores', message: `${stats.scoreDistribution.low}% of recent scores are in the Low band` });
      }
      const health = healthStats[dbId];
      if (health && health.calls > 0) {
        const errorRate = Math.round((health.errors / health.calls) * 100);
        if (errorRate > 20) {
          alerts.push({ tool: name, dbId, severity: 'critical', category: 'errors', message: `Elevated query error rate (${errorRate}%)` });
        }
        if (health.calls >= 5) {
          const p95 = percentile(health.latencies, 95);
          if (p95 !== null && p95 > 3000) {
            alerts.push({ tool: name, dbId, severity: 'warning', category: 'latency', message: `P95 query latency elevated — ${p95}ms (last ${health.latencies.length} calls)` });
          }
        }
      }

      let paymentRateForTier = null;
      if (typeof adapter.getPaymentSummary === 'function') {
        try {
          const client = getSupabaseClient(dbId);
          if (client) {
            const payment = await adapter.getPaymentSummary(client);
            const paymentTotal = payment.paidCount + payment.unpaidCount;
            if (paymentTotal >= MIN_PAYMENT_SAMPLE) {
              paymentRateForTier = payment.paymentRate;
              if (payment.paymentRate < 20) {
                alerts.push({ tool: name, dbId, severity: 'warning', category: 'payments', message: `Low payment conversion — only ${payment.paymentRate}% of submissions convert (${payment.paidCount}/${paymentTotal})` });
              }
            }
          }
        } catch (err) {
          console.warn(`Payment summary failed for ${dbId} during alerts check:`, err.message);
        }
      }

      // Only flag the Review tier when it reflects a real, low performance
      // score — not the "not enough data yet" case every new/low-volume
      // tool starts in, which isn't something to escalate weekly.
      const tierResult = computeToolTier({ stats, trend, paymentRate: paymentRateForTier });
      if (tierResult.performanceScore !== null && tierResult.tier === 'review') {
        alerts.push({ tool: name, dbId, severity: 'warning', category: 'performance', message: `Tool tier: Review — ${tierResult.reason}` });
      }
    }

    const toolReports = reports.filter(r => r.dbId === dbId);
    if (toolReports.length >= 5) {
      const failed = toolReports.filter(r => r.status === 'failed').length;
      const failRate = Math.round((failed / toolReports.length) * 100);
      if (failRate >= 10) {
        alerts.push({ tool: name, dbId, severity: 'critical', category: 'reports', message: `PDF report generation failing ${failRate}% of the time` });
      }

      const timedReports = toolReports.filter(r => r.status === 'success' && typeof r.durationMs === 'number');
      if (timedReports.length >= 5) {
        const avgMs = Math.round(timedReports.reduce((sum, r) => sum + r.durationMs, 0) / timedReports.length);
        if (avgMs > 3000) {
          alerts.push({ tool: name, dbId, severity: 'warning', category: 'reports', message: `Report generation delay — averaging ${(avgMs / 1000).toFixed(1)}s` });
        }
      }
    }
  }

  return alerts;
}

app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await buildAlerts();
    if (alerts.length === 0) {
      alerts.push({ tool: null, dbId: null, severity: 'ok', category: 'overall', message: 'All tools operating normally' });
    }
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Weekly PM Review (doc-inspired, not in the original spec) — the exact
// same alert signals above, just re-grouped into a fixed weekly checklist
// instead of a flat per-tool list, so a PM can scan one status per topic
// instead of hunting through Overview/Analytics for red flags. No new
// data source: this is a presentation of buildAlerts(), nothing else.
const WEEKLY_REVIEW_ROWS = [
  { category: 'volume', label: 'Assessment Volume', description: 'Week-over-week completed assessment counts, per tool.' },
  { category: 'scores', label: 'Score Quality', description: 'Share of recent scores landing in the Low band.' },
  { category: 'errors', label: 'System Errors', description: 'Supabase query error rate across all 5 tools.' },
  { category: 'payments', label: 'Payment Conversion', description: 'Paid vs. unpaid submission rate for tools that track payment.' },
  { category: 'reports', label: 'Report Generation', description: 'PDF report failure rate and generation time.' },
  { category: 'performance', label: 'Tool Performance Tier', description: 'Tools that dropped into the Review tier on real usage/score/payment data (not just low sample size).' },
  { category: 'latency', label: 'Query Latency (P95)', description: 'Worst-case Supabase query latency, not just the average.' },
  { category: 'availability', label: 'Site Availability', description: 'Whether each tool\'s public site is reachable.' },
  { category: 'dataSource', label: 'Live Data Connections', description: 'Tools still running on mock data instead of a connected Supabase project.' }
];

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1, ok: 0 };
const SEVERITY_TO_STATUS = { critical: 'escalate', warning: 'attention', info: 'attention', ok: 'on_track' };

app.get('/api/weekly-review', async (req, res) => {
  try {
    const alerts = await buildAlerts();

    const rows = WEEKLY_REVIEW_ROWS.map(row => {
      const matches = alerts.filter(a => a.category === row.category);
      if (matches.length === 0) {
        return { category: row.category, label: row.label, description: row.description, status: 'on_track', items: [] };
      }
      const worst = matches.reduce((acc, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[acc.severity] ? a : acc), matches[0]);
      return {
        category: row.category,
        label: row.label,
        description: row.description,
        status: SEVERITY_TO_STATUS[worst.severity] || 'attention',
        items: matches.map(a => ({ tool: a.tool, severity: a.severity, message: a.message }))
      };
    });

    const escalateCount = rows.filter(r => r.status === 'escalate').length;
    const attentionCount = rows.filter(r => r.status === 'attention').length;
    const onTrackCount = rows.filter(r => r.status === 'on_track').length;

    const now = new Date();
    const day = now.getUTCDay();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const weekLabel = `${fmt(monday)} – ${fmt(sunday)}, ${sunday.getUTCFullYear()}`;

    res.json({ weekLabel, generatedAt: now.toISOString(), summary: { escalateCount, attentionCount, onTrackCount }, rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Live Activity (doc section 6) — approximated by polling: merges the
// most recent completed candidates across tools with this backend's
// report log, sorted newest first. Not push-based, but no schema
// change needed. Optional ?dbId= scopes it to one tool, for the
// Analytics per-tool drill-down.
app.get('/api/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const dbIdFilter = req.query.dbId;
    const dbIds = dbIdFilter && ADAPTERS[dbIdFilter] ? [dbIdFilter] : ['db1', 'db2', 'db3', 'db4', 'db5', 'db6'];
    const events = [];

    for (const dbId of dbIds) {
      const { adapter, candidates } = await fetchCandidatesForTool(dbId);
      for (const c of candidates) {
        if (!c.testDate) continue;
        events.push({ type: 'assessment_completed', tool: adapter.metadata.name, dbId, candidateName: c.name, timestamp: c.testDate });
      }
    }

    const reports = dbIdFilter ? readReports().filter(r => r.dbId === dbIdFilter) : readReports();
    for (const r of reports) {
      events.push({
        type: r.status === 'success' ? 'report_generated' : 'report_failed',
        tool: r.toolName,
        dbId: r.dbId,
        candidateName: r.candidateName,
        timestamp: r.timestamp
      });
    }

    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    res.json({ events: events.slice(0, limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  socialScheduler.start();
  socialPollers.start();
  leadsPoller.start();
});
