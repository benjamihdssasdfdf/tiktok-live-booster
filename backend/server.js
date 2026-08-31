const http = require('http');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');
const { runMigrations } = require('./migrations');
const GitHubClient = require('./github_client');
const FleetWorker = require('./fleet_worker');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3005;
const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'tiktok_live_booster_secret_key_2026';
const RUNNER_SECRET = process.env.RUNNER_SECRET || 'runner_token';
const PYTHON_PATH = process.env.PYTHON_PATH || 'python3';
const ENCRYPTION_KEY = crypto.scryptSync(process.env.ENCRYPTION_SECRET || JWT_SECRET, 'salt_fgos_tiktok_2026', 32);

// AES-256-GCM Secret Encryption & Decryption Helpers
function encryptSecret(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || plaintext.trim() === '') return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptSecret(encryptedStr) {
  if (!encryptedStr || typeof encryptedStr !== 'string' || !encryptedStr.includes(':')) return null;
  try {
    const [ivHex, authTagHex, cipherHex] = encryptedStr.split(':');
    if (!ivHex || !authTagHex || !cipherHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

// PostgreSQL Pool
const pool = new Pool({
  user: process.env.PGUSER || process.env.DB_USER || 'fgos_admin',
  host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
  database: process.env.PGDATABASE || process.env.DB_NAME || 'tiktok_live_booster',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'fgos_secure_2026',
  port: parseInt(process.env.PGPORT || process.env.DB_PORT || '5432'),
  max: 30,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Telemetry & Control maps
const runnerTelemetryMap = {};
const runnerControlQueueMap = {};
const runnerHeaderCache = new Map(); // Caches SPS/PPS NAL headers per runner
const dashboardClients = new Set();
let telemetryBroadcastTimer = null;

// Authoritative State Transition Logger
async function recordStateTransition(runnerKey, sessionUuid, fromState, toState, reason = '', metadata = {}) {
  const ts = new Date().toISOString();
  console.log(`[STATE_TRANSITION] runner=${runnerKey} session=${sessionUuid || 'none'} from=${fromState || 'UNKNOWN'} to=${toState} reason="${reason || 'N/A'}" ts=${ts}`);
  try {
    await pool.query(`
      INSERT INTO runner_state_transitions (runner_key, session_uuid, from_state, to_state, reason, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
    `, [runnerKey, sessionUuid || null, fromState || null, toState, reason || null, JSON.stringify(metadata)]);
  } catch (err) {
    console.debug('Postgres transition log notice:', err.message);
  }
}

// Automatic Stale-Heartbeat Sweeper (Checks every 5s; marks runners >35s without check-in as OFFLINE)
setInterval(async () => {
  const now = Date.now();
  for (const [key, t] of Object.entries(runnerTelemetryMap)) {
    const lastUpdated = t.last_updated ? new Date(t.last_updated).getTime() : 0;
    if (t.state !== 'OFFLINE' && t.state !== 'STOPPED' && (now - lastUpdated) > 35000) {
      const fromState = t.state;
      const staleSecs = Math.round((now - lastUpdated) / 1000);
      t.state = 'OFFLINE';
      t.status = 'OFFLINE';
      t.screen_state = 'OFFLINE';
      t.log_snippet = `Runner offline: No heartbeat received for >35s (Last check-in: ${staleSecs}s ago)`;
      t.last_updated = new Date().toISOString();

      console.warn(`[Runner Sweeper] Runner ${key} marked OFFLINE (No heartbeat for ${staleSecs}s)`);

      recordStateTransition(key, t.session_uuid, fromState, 'OFFLINE', 'Stale heartbeat timeout (>35s without check-in)', {
        stale_seconds: staleSecs
      });

      if (t.session_uuid) {
        pool.query(`
          UPDATE runner_sessions SET state = 'OFFLINE', screen_state = 'OFFLINE'
          WHERE session_uuid = $1
        `, [t.session_uuid]).catch(() => {});
      }
      broadcastTelemetryUpdate('RUNNER_OFFLINE', { runner_key: key, state: 'OFFLINE' });
    }
  }
}, 5000);

function broadcastTelemetryUpdate(eventType = 'TELEMETRY_UPDATE', extraPayload = {}) {
  if (dashboardClients.size === 0) return;

  // Immediate events are broadcast instantly
  if (eventType !== 'TELEMETRY_UPDATE') {
    const now = Date.now();
    const activeList = Object.values(runnerTelemetryMap)
      .filter(t => (now - new Date(t.last_updated).getTime()) < 30000 && t.state !== 'STOPPED' && t.state !== 'DISCONNECTED')
      .sort((a, b) => a.runner_id - b.runner_id);

    const payload = JSON.stringify({
      type: eventType,
      timestamp: new Date().toISOString(),
      telemetry: activeList,
      ...extraPayload
    });

    for (const client of dashboardClients) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch (_) {}
      }
    }
    return;
  }

  // Continuous heartbeat updates are debounced to a 75ms window to support 100-500 runners
  if (telemetryBroadcastTimer) return;
  telemetryBroadcastTimer = setTimeout(() => {
    telemetryBroadcastTimer = null;
    if (dashboardClients.size === 0) return;

    const now = Date.now();
    const activeList = Object.values(runnerTelemetryMap)
      .filter(t => (now - new Date(t.last_updated).getTime()) < 30000 && t.state !== 'STOPPED' && t.state !== 'DISCONNECTED')
      .sort((a, b) => a.runner_id - b.runner_id);

    const payload = JSON.stringify({
      type: 'TELEMETRY_UPDATE',
      timestamp: new Date().toISOString(),
      telemetry: activeList,
      ...extraPayload
    });

    for (const client of dashboardClients) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch (_) {}
      }
    }
  }, 75);
}

// Instantiate Production Fleet Concurrency Worker (Concurrency: 3)
const fleetWorker = new FleetWorker(pool, broadcastTelemetryUpdate, 3);

// Run DB Migrations & Startup Recovery
runMigrations(pool)
  .then(() => fleetWorker.recoverOrphanedJobs())
  .catch(err => console.debug('Migration startup note:', err.message));

// In-Memory fleet configuration
let inMemoryFleet = [
  {
    id: 1,
    label: 'Public Cluster #1',
    owner: process.env.GITHUB_USER || 'kashifjutt7456-art',
    repo: 'tiktok-live-booster',
    token: process.env.GITHUB_TOKEN || '',
    max_runners: 5,
    is_active: true
  },
  {
    id: 2,
    label: 'Public Cluster #2',
    owner: process.env.GITHUB_USER || 'kashifjutt7456-art',
    repo: 'tiktok-live-booster-cluster-2',
    token: process.env.GITHUB_TOKEN || '',
    max_runners: 5,
    is_active: true
  }
];

// Helper: Get active fleet accounts
async function getFleetAccounts() {
  try {
    const res = await pool.query('SELECT * FROM github_accounts ORDER BY id ASC');
    if (res.rows.length > 0) return res.rows;
  } catch (err) {
    console.debug('Postgres query fallback:', err.message);
  }
  return inMemoryFleet;
}

// Middleware: Verify JWT Auth
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authorization token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Middleware: RBAC Guard
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Insufficient privileges' });
    }
    next();
  };
}

function getNormalizedRunnerKey(repo, runnerId) {
  const shortRepo = (repo || 'tiktok-live-booster').split('/').pop().trim();
  return `${shortRepo}_runner_${parseInt(runnerId) || 0}`;
}

const cancelledRunIds = new Set();

// Define Main API Router
const apiRouter = express.Router();

// 1. Health
apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'tiktok-booster-backend',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// 2. Auth: Login
apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }

  const role = email.includes('admin') || email.includes('nadeem') ? 'admin' : 'operator';
  const name = email.split('@')[0];

  const token = jwt.sign(
    { email, role, name: name.charAt(0).toUpperCase() + name.slice(1) },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    success: true,
    token,
    user: {
      email,
      role,
      name: name.charAt(0).toUpperCase() + name.slice(1)
    }
  });
});

// Helper: Parallel Cancel Workflows with Controlled Concurrency
async function cancelAllActiveRunsInParallel(repos, concurrency = 15) {
  let totalCancelled = 0;
  if (!Array.isArray(repos) || repos.length === 0) return 0;

  const queue = [...repos];
  let index = 0;

  const worker = async () => {
    while (index < queue.length) {
      const r = queue[index++];
      if (!r || !r.token) continue;

      try {
        const ghClient = new GitHubClient(r.token);
        const activeRuns = await ghClient.listActiveRuns(r.owner, r.repo);
        for (const run of activeRuns) {
          cancelledRunIds.add(run.id);
          const cancelRes = await ghClient.cancelRun(r.owner, r.repo, run.id);
          if (cancelRes && cancelRes.success) {
            totalCancelled++;
          }
        }
      } catch (_) {}
    }
  };

  const workers = [];
  const workerCount = Math.min(concurrency, queue.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return totalCancelled;
}

// 3. Fleet Accounts
apiRouter.get('/fleet/accounts', authenticateToken, async (req, res) => {
  try {
    const accounts = await getFleetAccounts();
    const sanitized = accounts.map(acc => {
      const { token, ...safeData } = acc;
      return {
        ...safeData,
        token_preview: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : 'N/A'
      };
    });
    res.json({ success: true, accounts: sanitized });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/fleet/accounts', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  let { label, owner, repo, token, max_runners = 5 } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: 'GitHub Personal Access Token is required' });
  }

  try {
    // Validate token and auto-resolve real username
    const ghClient = new GitHubClient(token);
    const val = await ghClient.validateToken();
    if (!val.valid) {
      return res.status(400).json({ success: false, error: `Invalid GitHub token: ${val.error}` });
    }

    const realOwner = val.user?.login || owner;
    if (!owner || owner === 'Tester' || owner === 'user') {
      owner = realOwner;
    }
    if (!repo) {
      repo = 'tiktok-live-booster';
    }

    const finalLabel = label || `Cluster [${realOwner}]`;

    const query = `
      INSERT INTO github_accounts (label, owner, repo, token, max_runners, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING *
    `;
    const result = await pool.query(query, [finalLabel, owner, repo, token, max_runners]);
    const { token: rawTok, ...safeAcc } = result.rows[0];
    res.json({
      success: true,
      account: {
        ...safeAcc,
        token_preview: rawTok ? `${rawTok.slice(0, 4)}...${rawTok.slice(-4)}` : 'N/A'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.delete('/fleet/accounts/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM github_accounts WHERE id = $1', [id]);
    inMemoryFleet = inMemoryFleet.filter(a => a.id !== parseInt(id));
    res.json({ success: true, message: 'Account removed from fleet' });
  } catch (err) {
    inMemoryFleet = inMemoryFleet.filter(a => a.id !== parseInt(id));
    res.json({ success: true, message: 'Account removed' });
  }
});

apiRouter.put('/fleet/accounts/:id/toggle', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE github_accounts SET is_active = NOT is_active WHERE id = $1 RETURNING *',
      [id]
    );
    const { token, ...safeAcc } = result.rows[0];
    res.json({
      success: true,
      account: {
        ...safeAcc,
        token_preview: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : 'N/A'
      }
    });
  } catch (err) {
    const acc = inMemoryFleet.find(a => a.id === parseInt(id));
    if (acc) acc.is_active = !acc.is_active;
    res.json({ success: true, account: acc });
  }
});

apiRouter.put('/fleet/accounts/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  const { label, owner, repo, token, max_runners, is_active } = req.body;
  try {
    let finalOwner = owner;
    if (token) {
      const ghClient = new GitHubClient(token);
      const val = await ghClient.validateToken();
      if (val.valid && val.user?.login) {
        finalOwner = val.user.login;
      }
    }

    const result = await pool.query(
      `UPDATE github_accounts SET
        label = COALESCE($1, label),
        owner = COALESCE($2, owner),
        repo = COALESCE($3, repo),
        token = COALESCE($4, token),
        max_runners = COALESCE($5, max_runners),
        is_active = COALESCE($6, is_active)
      WHERE id = $7 RETURNING *`,
      [label || null, finalOwner || null, repo || null, token || null, max_runners ? parseInt(max_runners) : null, typeof is_active === 'boolean' ? is_active : null, id]
    );
    const { token: rawTok, ...safeAcc } = result.rows[0];
    res.json({
      success: true,
      account: {
        ...safeAcc,
        token_preview: rawTok ? `${rawTok.slice(0, 4)}...${rawTok.slice(-4)}` : 'N/A'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PRODUCTION GITHUB FLEET MANAGEMENT (100-500 Repos)
// ==========================================

// 3.1 Validate GitHub Token & Scopes
apiRouter.post('/fleet/validate-token', authenticateToken, async (req, res) => {
  const { token: ghToken } = req.body;
  if (!ghToken || ghToken.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'GitHub Personal Access Token is required' });
  }

  const ghClient = new GitHubClient(ghToken.trim());
  const validation = await ghClient.validateToken();

  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  res.json({
    success: true,
    user: validation.user,
    scopes: validation.scopes,
    hasRepoScope: validation.hasRepoScope,
    hasWorkflowScope: validation.hasWorkflowScope,
    token_preview: GitHubClient.maskToken(ghToken)
  });
});

// 3.2 Simple "Add GitHub Fleet" (Create & Start with Controlled Concurrency)
apiRouter.post('/fleet/create', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const {
    token: ghToken,
    repository = '',
    repo_count = 1,
    runners_per_repo = 1,
    stream_url = 'https://www.tiktok.com/@tiktok/live',
    duration_minutes = 60,
    likes_per_minute = 180,
    vpn_provider = 'none'
  } = req.body;

  if (!ghToken || ghToken.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Valid GitHub Personal Access Token is required' });
  }

  const sanitizedToken = ghToken.trim();

  // 1. Validate Token against GitHub
  const ghClient = new GitHubClient(sanitizedToken);
  const validation = await ghClient.validateToken();

  if (!validation.valid) {
    return res.status(400).json({ success: false, error: `GitHub Authentication Failed: ${validation.error}` });
  }

  const ghUser = validation.user;
  const owner = ghUser.login;

  try {
    // 2. Register or update GitHub Account in PostgreSQL
    const accQuery = `
      INSERT INTO github_accounts (label, owner, repo, token, max_runners, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id
    `;
    const accRes = await pool.query(accQuery, [
      `Account [${owner}]`,
      owner,
      repository.trim() || 'tiktok-live-booster-fleet',
      sanitizedToken,
      parseInt(runners_per_repo) || 1
    ]);
    const accountId = accRes.rows[0]?.id;

    // 3. Determine repository configurations
    let repoConfigs = [];
    const targetRepo = repository.trim();

    if (targetRepo) {
      // User provided specific repository (e.g. "owner/repo" or "repo")
      const repoName = targetRepo.includes('/') ? targetRepo.split('/')[1] : targetRepo;
      const repoOwner = targetRepo.includes('/') ? targetRepo.split('/')[0] : owner;
      repoConfigs.push({
        owner: repoOwner,
        repo: repoName,
        runner_count: parseInt(runners_per_repo) || 1
      });
    } else {
      // Automatically create repository sequence: tiktok-live-booster-fleet-001, ...
      const targetCount = Math.max(1, Math.min(parseInt(repo_count) || 1, 500));
      
      // Query existing repos for this owner in database to avoid name collisions
      const existingRes = await pool.query('SELECT repo FROM repositories WHERE owner = $1', [owner]);
      const existingSet = new Set(existingRes.rows.map(r => r.repo.toLowerCase()));

      let seq = 1;
      while (repoConfigs.length < targetCount) {
        const candidate = `tiktok-live-booster-fleet-${String(seq).padStart(3, '0')}`;
        if (!existingSet.has(candidate.toLowerCase())) {
          repoConfigs.push({
            owner,
            repo: candidate,
            runner_count: parseInt(runners_per_repo) || 1
          });
          existingSet.add(candidate.toLowerCase());
        }
        seq++;
      }
    }

    // 4. Create Fleet Record in PostgreSQL
    const fleetRes = await pool.query(`
      INSERT INTO fleets (name, account_id, status, target_url, duration_minutes, likes_per_minute, runners_per_repo, total_repos)
      VALUES ($1, $2, 'INITIALIZING', $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      `Fleet (${owner}) - ${repoConfigs.length} Repos`,
      accountId,
      stream_url.trim(),
      parseInt(duration_minutes) || 60,
      parseInt(likes_per_minute) || 180,
      parseInt(runners_per_repo) || 1,
      repoConfigs.length
    ]);
    const fleet = fleetRes.rows[0];

    // 5. Create Background Fleet Job & Job Items
    const jobRes = await pool.query(`
      INSERT INTO fleet_jobs (fleet_id, type, status, total_items, completed_items, failed_items)
      VALUES ($1, 'CREATE_AND_START', 'PENDING', $2, 0, 0)
      RETURNING *
    `, [fleet.id, repoConfigs.length]);
    const job = jobRes.rows[0];

    for (const cfg of repoConfigs) {
      await pool.query(`
        INSERT INTO fleet_job_items (job_id, repo_name, step, status)
        VALUES ($1, $2, 'PENDING', 'PENDING')
      `, [job.id, cfg.repo]);
    }

    // 6. Start Background Worker Queue (Controlled Concurrency: 3)
    const dispatchParams = {
      stream_url: stream_url.trim(),
      duration_minutes: parseInt(duration_minutes) || 60,
      likes_per_minute: parseInt(likes_per_minute) || 180,
      runner_count: parseInt(runners_per_repo) || 1,
      vpn_provider
    };

    fleetWorker.startJob(job.id, fleet.id, { id: accountId, owner, token: sanitizedToken }, repoConfigs, dispatchParams);

    res.json({
      success: true,
      message: `🚀 Fleet initialized! Background queue is creating & starting ${repoConfigs.length} repository runner(s)...`,
      job_id: job.id,
      fleet_id: fleet.id,
      total_items: repoConfigs.length,
      owner,
      repositories: repoConfigs.map(r => `${r.owner}/${r.repo}`)
    });
  } catch (err) {
    console.error('[Fleet Create Error]', err);
    res.status(500).json({ success: false, error: `Failed to create fleet: ${err.message}` });
  }
});

// 3.3 Get Fleet Job Progress
apiRouter.get('/fleet/jobs/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const jobRes = await pool.query('SELECT * FROM fleet_jobs WHERE id = $1', [id]);
    if (jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    const itemsRes = await pool.query('SELECT * FROM fleet_job_items WHERE job_id = $1 ORDER BY id ASC', [id]);
    res.json({
      success: true,
      job: jobRes.rows[0],
      items: itemsRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.4 List All Fleets
apiRouter.get('/fleet', authenticateToken, async (req, res) => {
  try {
    const fleetsRes = await pool.query(`
      SELECT f.*, a.owner as account_owner, a.label as account_label,
        (SELECT COUNT(*) FROM repositories r WHERE r.fleet_id = f.id) as repo_count,
        (SELECT COUNT(*) FROM repositories r WHERE r.fleet_id = f.id AND r.status = 'RUNNING') as running_count,
        (SELECT COUNT(*) FROM repositories r WHERE r.fleet_id = f.id AND r.status = 'FAILED') as failed_count
      FROM fleets f
      LEFT JOIN github_accounts a ON f.account_id = a.id
      ORDER BY f.id DESC
    `);
    res.json({ success: true, fleets: fleetsRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.5 Paginated & Searchable Repositories List (Supports 100-500 Repositories)
apiRouter.get('/fleet/repositories', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim().toLowerCase();
    const status = (req.query.status || 'ALL').trim().toUpperCase();
    const fleetId = req.query.fleet_id ? parseInt(req.query.fleet_id) : null;

    let whereClauses = [];
    let params = [];
    let paramIdx = 1;

    if (search) {
      whereClauses.push(`(LOWER(r.owner) LIKE $${paramIdx} OR LOWER(r.repo) LIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    if (status && status !== 'ALL') {
      whereClauses.push(`r.status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    if (fleetId) {
      whereClauses.push(`r.fleet_id = $${paramIdx}`);
      params.push(fleetId);
      paramIdx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM repositories r ${whereSql}`, params);
    const total = parseInt(countRes.rows[0]?.total || 0);

    const dataQuery = `
      SELECT r.*, f.name as fleet_name, f.target_url, a.token as has_token
      FROM repositories r
      LEFT JOIN fleets f ON r.fleet_id = f.id
      LEFT JOIN github_accounts a ON r.account_id = a.id
      ${whereSql}
      ORDER BY r.id DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const dataRes = await pool.query(dataQuery, params);

    res.json({
      success: true,
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      repositories: dataRes.rows.map(r => ({
        ...r,
        has_token: !!r.has_token
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.6 Start Fleet (Dispatch All Active Repositories in a Fleet)
apiRouter.post('/fleet/:id/start', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    const fleetRes = await pool.query('SELECT * FROM fleets WHERE id = $1', [id]);
    const fleet = fleetRes.rows[0];
    if (!fleet) return res.status(404).json({ success: false, error: 'Fleet not found' });

    const accRes = await pool.query('SELECT * FROM github_accounts WHERE id = $1', [fleet.account_id]);
    const account = accRes.rows[0];
    if (!account) return res.status(404).json({ success: false, error: 'Fleet GitHub account not found' });

    const reposRes = await pool.query('SELECT * FROM repositories WHERE fleet_id = $1', [id]);
    const repos = reposRes.rows;

    const ghClient = new GitHubClient(account.token);
    let dispatchedCount = 0;

    for (const r of repos) {
      try {
        const dRes = await ghClient.dispatchWorkflow(r.owner, r.repo, 'tiktok-app-booster.yml', {
          stream_url: fleet.target_url,
          duration_minutes: fleet.duration_minutes,
          likes_per_minute: fleet.likes_per_minute,
          runner_count: r.runner_count || fleet.runners_per_repo || 1
        });
        if (dRes.success) {
          dispatchedCount++;
          await pool.query("UPDATE repositories SET status = 'RUNNING', dispatch_status = 'DISPATCHED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [r.id]);
        }
      } catch (err) {
        console.debug(`Dispatch error for ${r.owner}/${r.repo}:`, err.message);
      }
    }

    await pool.query("UPDATE fleets SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
    broadcastTelemetryUpdate('FLEET_STARTED', { fleet_id: id, dispatched_count: dispatchedCount });

    res.json({ success: true, message: `Dispatched ${dispatchedCount} of ${repos.length} repositories in fleet.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.7 Stop Fleet (Cancel Workflows in a Fleet)
apiRouter.post('/fleet/:id/stop', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    const fleetRes = await pool.query('SELECT * FROM fleets WHERE id = $1', [id]);
    const fleet = fleetRes.rows[0];
    if (!fleet) return res.status(404).json({ success: false, error: 'Fleet not found' });

    const accRes = await pool.query('SELECT * FROM github_accounts WHERE id = $1', [fleet.account_id]);
    const account = accRes.rows[0];
    const reposRes = await pool.query('SELECT * FROM repositories WHERE fleet_id = $1', [id]);
    const repos = reposRes.rows;

    let cancelledCount = 0;
    if (account) {
      const ghClient = new GitHubClient(account.token);
      for (const r of repos) {
        try {
          const activeRuns = await ghClient.listActiveRuns(r.owner, r.repo);
          for (const run of activeRuns) {
            cancelledRunIds.add(run.id);
            await ghClient.cancelRun(r.owner, r.repo, run.id);
            cancelledCount++;
          }
        } catch (_) {}
      }
    }

    await pool.query("UPDATE repositories SET status = 'STOPPED', dispatch_status = 'STOPPED', updated_at = CURRENT_TIMESTAMP WHERE fleet_id = $1", [id]);
    await pool.query("UPDATE fleets SET status = 'STOPPED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
    broadcastTelemetryUpdate('FLEET_STOPPED', { fleet_id: id, cancelled_count: cancelledCount });

    res.json({ success: true, message: `Stopped fleet and cancelled ${cancelledCount} active workflow run(s).` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.8 Retry Failed Repositories in Fleet
apiRouter.post('/fleet/:id/retry-failed', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    const jobRes = await pool.query('SELECT id FROM fleet_jobs WHERE fleet_id = $1 ORDER BY id DESC LIMIT 1', [id]);
    const jobId = jobRes.rows[0]?.id;
    if (!jobId) return res.status(404).json({ success: false, error: 'No previous fleet job found' });

    const retryRes = await fleetWorker.retryJob(jobId);
    res.json(retryRes);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.9 Delete Fleet
apiRouter.delete('/fleet/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM fleets WHERE id = $1', [id]);
    res.json({ success: true, message: 'Fleet deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.10 Batch Controls: Start Selected / Stop Selected
apiRouter.post('/fleet/repos/start-selected', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { repo_ids = [] } = req.body;
  if (!Array.isArray(repo_ids) || repo_ids.length === 0) {
    return res.status(400).json({ success: false, error: 'Array of repo_ids required' });
  }

  try {
    const reposRes = await pool.query(
      'SELECT r.*, a.token, f.target_url, f.duration_minutes, f.likes_per_minute, f.runners_per_repo FROM repositories r JOIN github_accounts a ON r.account_id = a.id LEFT JOIN fleets f ON r.fleet_id = f.id WHERE r.id = ANY($1::int[])',
      [repo_ids]
    );

    let count = 0;
    for (const r of reposRes.rows) {
      try {
        const ghClient = new GitHubClient(r.token);
        const dRes = await ghClient.dispatchWorkflow(r.owner, r.repo, 'tiktok-app-booster.yml', {
          stream_url: r.target_url || 'https://www.tiktok.com/@tiktok/live',
          duration_minutes: r.duration_minutes || 60,
          likes_per_minute: r.likes_per_minute || 180,
          runner_count: r.runner_count || 1
        });
        if (dRes.success) {
          count++;
          await pool.query("UPDATE repositories SET status = 'RUNNING', dispatch_status = 'DISPATCHED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [r.id]);
        }
      } catch (_) {}
    }

    broadcastTelemetryUpdate('REPOS_STARTED', { count });
    res.json({ success: true, message: `Started ${count} of ${reposRes.rows.length} selected repository runners.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/fleet/repos/stop-selected', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { repo_ids = [] } = req.body;
  if (!Array.isArray(repo_ids) || repo_ids.length === 0) {
    return res.status(400).json({ success: false, error: 'Array of repo_ids required' });
  }

  try {
    const reposRes = await pool.query(
      'SELECT r.*, a.token FROM repositories r JOIN github_accounts a ON r.account_id = a.id WHERE r.id = ANY($1::int[])',
      [repo_ids]
    );

    let cancelledCount = 0;
    for (const r of reposRes.rows) {
      try {
        const ghClient = new GitHubClient(r.token);
        const activeRuns = await ghClient.listActiveRuns(r.owner, r.repo);
        for (const run of activeRuns) {
          cancelledRunIds.add(run.id);
          await ghClient.cancelRun(r.owner, r.repo, run.id);
          cancelledCount++;
        }
        await pool.query("UPDATE repositories SET status = 'STOPPED', dispatch_status = 'STOPPED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [r.id]);
      } catch (_) {}
    }

    broadcastTelemetryUpdate('REPOS_STOPPED', { cancelledCount });
    res.json({ success: true, message: `Stopped ${reposRes.rows.length} repositories and cancelled ${cancelledCount} workflow run(s).` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.11 Global Stop All (Authoritative Across All Accounts, Fleets, and Repositories)
apiRouter.post('/fleet/stop-all', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  try {
    // 1. Fetch all repositories and legacy accounts
    const reposRes = await pool.query('SELECT r.*, a.token FROM repositories r JOIN github_accounts a ON r.account_id = a.id');
    const legacyAccounts = await getFleetAccounts();
    const legacyRepos = legacyAccounts.map(acc => ({
      owner: acc.owner,
      repo: acc.repo,
      token: (acc.token && acc.token.trim().length > 10) ? acc.token.trim() : (process.env.GITHUB_TOKEN || '')
    }));

    const allReposToCancel = [...reposRes.rows, ...legacyRepos];

    // 2. Parallel cancellation across all repositories with concurrency of 15 workers
    const totalCancelled = await cancelAllActiveRunsInParallel(allReposToCancel, 15);

    // 3. Terminate all PostgreSQL runner sessions & clear state in single batch queries
    await pool.query("UPDATE runner_sessions SET state = 'STOPPED', ended_at = CURRENT_TIMESTAMP WHERE state NOT IN ('STOPPED', 'COMPLETED', 'DISCONNECTED')").catch(() => {});
    await pool.query("UPDATE repositories SET status = 'STOPPED', dispatch_status = 'STOPPED', updated_at = CURRENT_TIMESTAMP").catch(() => {});
    await pool.query("UPDATE fleets SET status = 'STOPPED', updated_at = CURRENT_TIMESTAMP").catch(() => {});

    Object.keys(runnerTelemetryMap).forEach(k => delete runnerTelemetryMap[k]);
    Object.keys(runnerControlQueueMap).forEach(k => delete runnerControlQueueMap[k]);
    broadcastTelemetryUpdate('RUNNERS_CANCELLED');

    res.json({ success: true, message: `Global Stop All: Cancelled ${totalCancelled} running workflow(s) across all fleets and repositories.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Sanitize audit log details and record action
async function logAccountAudit(accountId, action, performedBy, details = {}) {
  try {
    const sanitizedDetails = { ...details };
    const sensitiveKeys = ['password', 'secret', 'token', 'app_password', 'cookies_raw'];
    for (const k of Object.keys(sanitizedDetails)) {
      if (sensitiveKeys.some(sk => k.toLowerCase().includes(sk))) {
        sanitizedDetails[k] = '[REDACTED]';
      }
    }
    await pool.query(`
      INSERT INTO account_audit_logs (account_id, action, performed_by, details)
      VALUES ($1, $2, $3, $4)
    `, [accountId || null, action, performedBy || 'system', JSON.stringify(sanitizedDetails)]);
  } catch (err) {
    console.debug('Account audit logging fallback:', err.message);
  }
}

// Helper: Email syntax validation
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

// 4. TikTok Accounts Management System (PostgreSQL + AES-256-GCM Encrypted Secret Store)

// 4.1 List All TikTok Accounts (Public metadata only - Credentials NEVER returned)
apiRouter.get('/accounts', authenticateToken, async (req, res) => {
  try {
    const dbRes = await pool.query(`
      SELECT id, display_name, label, username, email, gmail_address, is_enabled,
             status, login_status, last_login_attempt, last_successful_login,
             assigned_runner_id, assigned_runner_key, device_id, proxy, created_at, updated_at,
             ((tiktok_password_encrypted IS NOT NULL AND LENGTH(tiktok_password_encrypted) > 0) OR (password_encrypted IS NOT NULL AND LENGTH(password_encrypted) > 0)) AS has_tiktok_password,
             (gmail_app_password_encrypted IS NOT NULL AND LENGTH(gmail_app_password_encrypted) > 0) AS has_gmail_app_password,
             (email_password_encrypted IS NOT NULL AND LENGTH(email_password_encrypted) > 0) AS has_email_password,
             (email_2fa_secret_encrypted IS NOT NULL AND LENGTH(email_2fa_secret_encrypted) > 0) AS has_email_2fa_secret
      FROM accounts
      ORDER BY id ASC
    `);

    let accList = dbRes.rows;

    res.json({
      success: true,
      accounts: accList.map(a => ({
        id: a.id,
        email: a.email || a.username,
        display_name: a.display_name || a.label || (a.email || a.username).split('@')[0],
        status: a.status || 'IDLE',
        login_status: a.login_status || 'IDLE',
        is_enabled: !!a.is_enabled,
        assigned_runner_key: a.assigned_runner_key || null,
        device_id: a.device_id || null,
        proxy: a.proxy || null,
        gmail_address: a.gmail_address || null,
        last_login_attempt: a.last_login_attempt,
        last_successful_login: a.last_successful_login,
        created_at: a.created_at,
        updated_at: a.updated_at,
        has_tiktok_password: !!a.has_tiktok_password,
        has_gmail_app_password: !!a.has_gmail_app_password,
        has_email_password: !!a.has_email_password,
        has_email_2fa_secret: !!a.has_email_2fa_secret
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.2 Create New TikTok Account (Secrets Encrypted with AES-256-GCM Before DB Storage)
apiRouter.post('/accounts', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const {
    email,
    display_name,
    label,
    username,
    tiktok_password,
    password,
    gmail_address,
    gmail_app_password,
    email_password,
    email_2fa_secret,
    assigned_runner_key,
    device_id,
    proxy
  } = req.body;

  const rawEmail = (email || username || '').trim();
  if (!rawEmail || !isValidEmail(rawEmail)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required' });
  }

  const cleanEmail = rawEmail.toLowerCase();
  const cleanDisplayName = (display_name || label || cleanEmail.split('@')[0] || 'TikTok Account').trim();
  const rawTiktokPassword = tiktok_password || password;

  const encTiktokPassword = encryptSecret(rawTiktokPassword);
  const encGmailAppPassword = encryptSecret(gmail_app_password);
  const encEmailPassword = encryptSecret(email_password);
  const encEmail2faSecret = encryptSecret(email_2fa_secret);

  try {
    if (assigned_runner_key) {
      await pool.query('UPDATE accounts SET assigned_runner_key = NULL WHERE assigned_runner_key = $1', [assigned_runner_key]);
    }
    const insRes = await pool.query(`
      INSERT INTO accounts (
        email, username, display_name, label,
        tiktok_password_encrypted, password_encrypted,
        gmail_address, gmail_app_password_encrypted,
        email_password_encrypted, email_2fa_secret_encrypted,
        assigned_runner_key, device_id, proxy,
        is_enabled, status, login_status
      )
      VALUES ($1, $1, $2, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, true, 'IDLE', 'IDLE')
      RETURNING id, email, display_name, gmail_address, is_enabled, status, login_status, assigned_runner_key, device_id, created_at, updated_at
    `, [
      cleanEmail,
      cleanDisplayName,
      encTiktokPassword,
      gmail_address ? gmail_address.trim() : (cleanEmail.includes('gmail.com') ? cleanEmail : null),
      encGmailAppPassword,
      encEmailPassword,
      encEmail2faSecret,
      assigned_runner_key || null,
      device_id || null,
      proxy || null
    ]);

    const createdAcc = insRes.rows[0];
    await logAccountAudit(createdAcc.id, 'CREATE', req.user?.email || 'admin', {
      email: cleanEmail,
      display_name: cleanDisplayName,
      has_tiktok_password: !!encTiktokPassword,
      has_gmail_app_password: !!encGmailAppPassword,
      has_email_password: !!encEmailPassword,
      has_email_2fa_secret: !!encEmail2faSecret
    });

    res.json({
      success: true,
      message: `Account "${cleanEmail}" created with encrypted credentials`,
      account: {
        ...createdAcc,
        has_tiktok_password: !!encTiktokPassword,
        has_gmail_app_password: !!encGmailAppPassword,
        has_email_password: !!encEmailPassword,
        has_email_2fa_secret: !!encEmail2faSecret
      }
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: `Account with email "${cleanEmail}" already exists` });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.3 Update TikTok Account (Re-encrypts secrets only if modified)
apiRouter.put('/accounts/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  const {
    email,
    display_name,
    label,
    tiktok_password,
    password,
    gmail_address,
    gmail_app_password,
    email_password,
    email_2fa_secret,
    assigned_runner_key,
    is_enabled,
    device_id,
    proxy
  } = req.body;

  try {
    const curRes = await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
    if (curRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Account not found' });
    }
    const current = curRes.rows[0];

    let cleanEmail = current.email || current.username;
    if (email && email.trim()) {
      if (!isValidEmail(email.trim())) {
        return res.status(400).json({ success: false, error: 'Invalid email address format' });
      }
      cleanEmail = email.trim().toLowerCase();
    }

    const rawTiktokPassword = tiktok_password !== undefined ? tiktok_password : password;
    const encTiktokPassword = (rawTiktokPassword && rawTiktokPassword.trim().length > 0 && rawTiktokPassword !== '••••••••')
      ? encryptSecret(rawTiktokPassword.trim())
      : (current.tiktok_password_encrypted || current.password_encrypted);

    const encGmailAppPassword = (gmail_app_password && gmail_app_password.trim().length > 0 && gmail_app_password !== '••••••••')
      ? encryptSecret(gmail_app_password.trim())
      : current.gmail_app_password_encrypted;

    const encEmailPassword = (email_password && email_password.trim().length > 0 && email_password !== '••••••••')
      ? encryptSecret(email_password.trim())
      : current.email_password_encrypted;

    const encEmail2faSecret = (email_2fa_secret && email_2fa_secret.trim().length > 0 && email_2fa_secret !== '••••••••')
      ? encryptSecret(email_2fa_secret.trim())
      : current.email_2fa_secret_encrypted;

    if (assigned_runner_key) {
      await pool.query('UPDATE accounts SET assigned_runner_key = NULL WHERE assigned_runner_key = $1 AND id != $2', [assigned_runner_key, id]);
    }

    const updatedRes = await pool.query(`
      UPDATE accounts SET
        email = $1,
        username = $1,
        display_name = COALESCE($2, display_name),
        label = COALESCE($2, label),
        tiktok_password_encrypted = $3,
        password_encrypted = $3,
        gmail_address = $4,
        gmail_app_password_encrypted = $5,
        email_password_encrypted = $6,
        email_2fa_secret_encrypted = $7,
        assigned_runner_key = $8,
        is_enabled = COALESCE($9, is_enabled),
        device_id = COALESCE($10, device_id),
        proxy = COALESCE($11, proxy),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING id, email, display_name, gmail_address, is_enabled, status, login_status, last_login_attempt, last_successful_login, assigned_runner_key, device_id, proxy, created_at, updated_at
    `, [
      cleanEmail,
      display_name ? display_name.trim() : (label ? label.trim() : null),
      encTiktokPassword,
      gmail_address !== undefined ? (gmail_address ? gmail_address.trim() : null) : current.gmail_address,
      encGmailAppPassword,
      encEmailPassword,
      encEmail2faSecret,
      assigned_runner_key !== undefined ? (assigned_runner_key || null) : current.assigned_runner_key,
      is_enabled !== undefined ? is_enabled : current.is_enabled,
      device_id !== undefined ? (device_id || null) : current.device_id,
      proxy !== undefined ? (proxy || null) : current.proxy,
      id
    ]);

    await logAccountAudit(id, 'UPDATE', req.user?.email || 'admin', {
      email: cleanEmail,
      is_enabled: is_enabled !== undefined ? is_enabled : current.is_enabled,
      assigned_runner_key: assigned_runner_key !== undefined ? assigned_runner_key : current.assigned_runner_key
    });

    res.json({
      success: true,
      message: 'Account updated successfully with encrypted credentials',
      account: {
        ...updatedRes.rows[0],
        has_tiktok_password: !!encTiktokPassword,
        has_gmail_app_password: !!encGmailAppPassword,
        has_email_password: !!encEmailPassword,
        has_email_2fa_secret: !!encEmail2faSecret
      }
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: 'An account with this email already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.4 Delete TikTok Account
apiRouter.delete('/accounts/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    const curRes = await pool.query('SELECT email, username FROM accounts WHERE id = $1', [id]);
    const email = curRes.rows[0]?.email || curRes.rows[0]?.username || `#${id}`;

    await pool.query('DELETE FROM accounts WHERE id = $1', [id]);

    await logAccountAudit(id, 'DELETE', req.user?.email || 'admin', { email });

    res.json({ success: true, message: `Account "${email}" deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.5 Toggle Account Enabled Status
apiRouter.post('/accounts/:id/toggle', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await pool.query(`
      UPDATE accounts SET is_enabled = NOT is_enabled, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, email, username, display_name, is_enabled
    `, [id]);
    if (updated.rows.length === 0) return res.status(404).json({ success: false, error: 'Account not found' });
    
    const acc = updated.rows[0];
    await logAccountAudit(id, 'TOGGLE', req.user?.email || 'admin', {
      email: acc.email || acc.username,
      is_enabled: acc.is_enabled
    });

    res.json({ success: true, account: acc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.6 Bulk Import Accounts (CSV/TSV with in-memory encryption and atomic upsert)
apiRouter.post('/accounts/bulk-import', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { csv_data, raw_text } = req.body;
  const content = (csv_data || raw_text || '').trim();

  if (!content) {
    return res.status(400).json({ success: false, error: 'No CSV/TSV data provided for import' });
  }

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  let importedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  let duplicateCount = 0;
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines or header row
    if (line.startsWith('#') || line.toLowerCase().startsWith('email,') || line.toLowerCase().startsWith('gmail\t') || line.toLowerCase().startsWith('email\t') || line.toLowerCase().startsWith('email address')) {
      continue;
    }

    // Determine delimiter (Tab or Comma)
    let parts = [];
    if (line.includes('\t')) {
      parts = line.split('\t').map(p => p.trim());
    } else {
      parts = line.split(',').map(p => p.trim());
    }

    const email = (parts[0] || '').trim();
    const gmailAppPassword = (parts[1] || '').trim();
    const tiktokPassword = (parts[2] || '').trim();
    const emailPassword = (parts[3] || '').trim();
    const email2faSecret = (parts[4] || '').trim();

    if (!email || !isValidEmail(email)) {
      failedCount++;
      errors.push({ row: i + 1, reason: `Invalid email format at row ${i + 1}` });
      continue;
    }

    const cleanEmail = email.toLowerCase();
    const displayName = cleanEmail.split('@')[0];

    const encTiktokPassword = encryptSecret(tiktokPassword);
    const encGmailAppPassword = encryptSecret(gmailAppPassword);
    const encEmailPassword = encryptSecret(emailPassword);
    const encEmail2faSecret = encryptSecret(email2faSecret);

    try {
      const existing = await pool.query('SELECT id FROM accounts WHERE LOWER(email) = $1 OR LOWER(username) = $1', [cleanEmail]);
      if (existing.rows.length > 0) {
        const accId = existing.rows[0].id;
        await pool.query(`
          UPDATE accounts SET
            display_name = COALESCE($1, display_name),
            label = COALESCE($1, label),
            tiktok_password_encrypted = COALESCE($2, tiktok_password_encrypted),
            password_encrypted = COALESCE($2, password_encrypted),
            gmail_address = COALESCE($3, gmail_address),
            gmail_app_password_encrypted = COALESCE($4, gmail_app_password_encrypted),
            email_password_encrypted = COALESCE($5, email_password_encrypted),
            email_2fa_secret_encrypted = COALESCE($6, email_2fa_secret_encrypted),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $7
        `, [
          displayName,
          encTiktokPassword,
          cleanEmail.includes('gmail.com') ? cleanEmail : null,
          encGmailAppPassword,
          encEmailPassword,
          encEmail2faSecret,
          accId
        ]);
        updatedCount++;
        duplicateCount++;
      } else {
        await pool.query(`
          INSERT INTO accounts (
            email, username, display_name, label,
            tiktok_password_encrypted, password_encrypted,
            gmail_address, gmail_app_password_encrypted,
            email_password_encrypted, email_2fa_secret_encrypted,
            is_enabled, status, login_status
          )
          VALUES ($1, $1, $2, $2, $3, $3, $4, $5, $6, $7, true, 'IDLE', 'IDLE')
        `, [
          cleanEmail,
          displayName,
          encTiktokPassword,
          cleanEmail.includes('gmail.com') ? cleanEmail : null,
          encGmailAppPassword,
          encEmailPassword,
          encEmail2faSecret
        ]);
        importedCount++;
      }
    } catch (err) {
      failedCount++;
      errors.push({ row: i + 1, reason: `Database error at row ${i + 1}` });
    }
  }

  await logAccountAudit(null, 'BULK_IMPORT', req.user?.email || 'admin', {
    imported: importedCount,
    updated: updatedCount,
    failed: failedCount,
    duplicates: duplicateCount
  });

  res.json({
    success: true,
    message: `Bulk import completed: ${importedCount} created, ${updatedCount} updated, ${failedCount} failed`,
    imported: importedCount,
    updated: updatedCount,
    failed: failedCount,
    duplicates: duplicateCount,
    errors: errors.length > 0 ? errors : undefined
  });
});

// 4.7 Fetch Assigned Account for Runner (Called securely by runner worker upon boot)
apiRouter.get('/accounts/runner-assignment/:runnerKey', async (req, res) => {
  const { runnerKey } = req.params;
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : (req.query.token || null);

  // Authenticate via RUNNER_SECRET or JWT
  if (token && token !== RUNNER_SECRET && token !== 'runner_token') {
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (_) {
      return res.status(401).json({ success: false, error: 'Unauthorized runner credentials' });
    }
  }

  try {
    let activeTargetUrl = 'https://www.tiktok.com/@touqeernasir000?_r=1&_t=ZS-99JIaSBiNev';
    try {
      const targetRes = await pool.query('SELECT url FROM live_targets WHERE is_active_target = true AND is_enabled = true ORDER BY id DESC LIMIT 1');
      if (targetRes.rows.length > 0 && targetRes.rows[0].url) {
        activeTargetUrl = targetRes.rows[0].url;
      }
    } catch (_) {}

    // Fetch accounts strictly assigned to this runner or unassigned (prevents cross-runner collisions)
    const allEnabledRes = await pool.query(`
      SELECT * FROM accounts
      WHERE is_enabled = true
        AND (assigned_runner_key = $1 OR assigned_runner_key IS NULL OR assigned_runner_key = '')
      ORDER BY 
        CASE WHEN assigned_runner_key = $1 THEN 0 ELSE 1 END,
        id ASC
    `, [runnerKey]);

    if (allEnabledRes.rows.length === 0) {
      return res.json({
        success: true,
        has_account: false,
        account: null,
        accounts_pool: [],
        target_live_url: activeTargetUrl,
        message: 'No enabled TikTok account available. Running in Guest Viewer mode.'
      });
    }

    const formatAccountRow = (row) => ({
      id: row.id,
      email: row.email || row.username,
      display_name: row.display_name || row.label || row.username,
      username: row.username,
      tiktok_password: decryptSecret(row.tiktok_password_encrypted) || decryptSecret(row.password_encrypted) || row.password || '',
      password: decryptSecret(row.tiktok_password_encrypted) || decryptSecret(row.password_encrypted) || row.password || '',
      gmail_address: row.gmail_address || null,
      gmail_app_password: decryptSecret(row.gmail_app_password_encrypted) || '',
      email_password: decryptSecret(row.email_password_encrypted) || '',
      email_2fa_secret: decryptSecret(row.email_2fa_secret_encrypted) || '',
      device_id: row.device_id || null,
      proxy: row.proxy || null,
      cookies_raw: row.cookies_raw || null
    });

    const accountsPool = allEnabledRes.rows.map(formatAccountRow);
    const primaryAccount = accountsPool[0];

    // Mark last login attempt on primary account
    await pool.query('UPDATE accounts SET last_login_attempt = CURRENT_TIMESTAMP WHERE id = $1', [primaryAccount.id]).catch(() => {});

    res.json({
      success: true,
      has_account: true,
      target_live_url: activeTargetUrl,
      account: primaryAccount,
      accounts_pool: accountsPool
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.7 Update Account Login Status (Called by runner upon login success/challenge/failure)
apiRouter.post('/accounts/:id/login-status', async (req, res) => {
  const { id } = req.params;
  const { login_status, error_message = null } = req.body;
  try {
    const isSuccess = login_status === 'LOGGED_IN' || login_status === 'AUTHENTICATED' || login_status === 'TIKTOK_AUTHENTICATED' || login_status === 'READY';
    await pool.query(`
      UPDATE accounts SET
        login_status = $1,
        last_successful_login = CASE WHEN $2 = true THEN CURRENT_TIMESTAMP ELSE last_successful_login END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [login_status, isSuccess, id]);

    res.json({ success: true, message: `Account status updated to ${login_status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.8 Configurable Live Targets Management System (PostgreSQL + Dashboard CRUD)
apiRouter.get('/live-targets', authenticateToken, async (req, res) => {
  try {
    const targetsRes = await pool.query(`
      SELECT id, url, creator, is_enabled, status, is_active_target, created_at, updated_at
      FROM live_targets
      ORDER BY id ASC
    `);

    // Calculate active viewer / runner count per target URL
    const activeTelemetry = Object.values(runnerTelemetryMap).filter(t => 
      t.state !== 'OFFLINE' && t.state !== 'STOPPED' && t.state !== 'DISCONNECTED'
    );

    const targetsWithStats = targetsRes.rows.map(target => {
      const viewerCount = activeTelemetry.filter(t => 
        (t.target_live_url && t.target_live_url === target.url) ||
        (t.stream_url && t.stream_url === target.url) ||
        (target.is_active_target && (t.state === 'WATCHING' || t.state === 'LIVE_OPEN' || t.state === 'OPENING_LIVE'))
      ).length;

      return {
        ...target,
        viewer_count: viewerCount
      };
    });

    res.json({
      success: true,
      targets: targetsWithStats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.get('/live-targets/active', async (req, res) => {
  try {
    const targetRes = await pool.query('SELECT * FROM live_targets WHERE is_active_target = true AND is_enabled = true ORDER BY id DESC LIMIT 1');
    if (targetRes.rows.length > 0) {
      return res.json({ success: true, target: targetRes.rows[0] });
    }
    // Fallback default
    res.json({
      success: true,
      target: {
        id: 0,
        url: 'https://www.tiktok.com/@touqeernasir000?_r=1&_t=ZS-99JIaSBiNev',
        creator: '@touqeernasir000',
        status: 'ACTIVE',
        is_active_target: true
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/live-targets', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { url, creator, is_enabled = true, set_active = false } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ success: false, error: 'Live stream URL is required' });
  }

  const rawUrl = url.trim();
  let extractedCreator = creator ? creator.trim() : '';
  if (!extractedCreator) {
    const match = rawUrl.match(/@([a-zA-Z0-9_.-]+)/);
    if (match) {
      extractedCreator = `@${match[1]}`;
    }
  }

  try {
    if (set_active) {
      await pool.query('UPDATE live_targets SET is_active_target = false');
    }

    const insRes = await pool.query(`
      INSERT INTO live_targets (url, creator, is_enabled, status, is_active_target)
      VALUES ($1, $2, $3, 'ACTIVE', $4)
      RETURNING *
    `, [rawUrl, extractedCreator || null, is_enabled, set_active]);

    broadcastTelemetryUpdate('LIVE_TARGETS_UPDATED');
    res.json({
      success: true,
      message: 'Live stream target added successfully',
      target: insRes.rows[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.put('/live-targets/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  const { url, creator, is_enabled, status, is_active_target } = req.body;

  try {
    let rawUrl = url ? url.trim() : null;
    let extractedCreator = creator ? creator.trim() : null;
    if (rawUrl && !extractedCreator) {
      const match = rawUrl.match(/@([a-zA-Z0-9_.-]+)/);
      if (match) extractedCreator = `@${match[1]}`;
    }

    if (is_active_target === true) {
      await pool.query('UPDATE live_targets SET is_active_target = false');
    }

    const updRes = await pool.query(`
      UPDATE live_targets SET
        url = COALESCE($1, url),
        creator = COALESCE($2, creator),
        is_enabled = COALESCE($3, is_enabled),
        status = COALESCE($4, status),
        is_active_target = COALESCE($5, is_active_target),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `, [rawUrl, extractedCreator, is_enabled, status, is_active_target, id]);

    if (updRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Live target not found' });
    }

    broadcastTelemetryUpdate('LIVE_TARGETS_UPDATED');
    res.json({
      success: true,
      message: 'Live target updated successfully',
      target: updRes.rows[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/live-targets/:id/select', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE live_targets SET is_active_target = false');
    const updRes = await pool.query(`
      UPDATE live_targets SET is_active_target = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (updRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Live target not found' });
    }

    broadcastTelemetryUpdate('LIVE_TARGETS_UPDATED', { active_target: updRes.rows[0] });
    res.json({
      success: true,
      message: `Active live target set to ${updRes.rows[0].creator || updRes.rows[0].url}`,
      target: updRes.rows[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.delete('/live-targets/:id', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM live_targets WHERE id = $1', [id]);
    broadcastTelemetryUpdate('LIVE_TARGETS_UPDATED');
    res.json({ success: true, message: 'Live target deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Runners Status
apiRouter.get('/runners/status', authenticateToken, async (req, res) => {
  try {
    const accounts = await getFleetAccounts();
    const activeAccounts = accounts.filter(a => a.is_active);

    const runPromises = activeAccounts.map(async (acc) => {
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${acc.owner}/${acc.repo}/actions/runs?per_page=5`, {
          headers: {
            Authorization: `Bearer ${acc.token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'TikTok-Live-Booster-Fleet'
          }
        });
        if (ghRes.ok) {
          const data = await ghRes.json();
          return (data.workflow_runs || []).map(r => ({
            id: r.id,
            account_label: acc.label,
            repo: `${acc.owner}/${acc.repo}`,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            created_at: r.created_at,
            html_url: r.html_url,
            run_number: r.run_number
          }));
        }
      } catch (err) {
        console.debug(`Error fetching runs for ${acc.owner}/${acc.repo}:`, err.message);
      }
      return [];
    });

    const results = await Promise.all(runPromises);
    const allRuns = results.flat()
      .map(r => {
        if (cancelledRunIds.has(r.id)) {
          return { ...r, status: 'completed', conclusion: 'cancelled' };
        }
        return r;
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const totalCapacity = activeAccounts.reduce((sum, a) => sum + (a.max_runners || 5), 0);
    const runningGithubJobs = allRuns.filter(r => (r.status === 'in_progress' || r.status === 'queued') && !cancelledRunIds.has(r.id)).length;

    const now = Date.now();
    const activeTelemetryList = Object.values(runnerTelemetryMap).filter(t => {
      const ageMs = t.last_updated ? (now - new Date(t.last_updated).getTime()) : Infinity;
      return ageMs < 15000 && t.state !== 'OFFLINE' && t.state !== 'STOPPED' && t.state !== 'DISCONNECTED';
    });

    const onlineRunnersCount = activeTelemetryList.length;
    const readyAvdsCount = activeTelemetryList.filter(t => t.adb_state === 'OK' || t.state === 'ANDROID_READY' || t.state === 'RUNNING' || t.state === 'APP_STARTED').length;
    const activelyStreamingCount = activeTelemetryList.filter(t => t.screen_state === 'STREAMING').length;
    const totalLikesSent = activeTelemetryList.reduce((sum, t) => sum + (t.likes_sent || 0), 0);

    res.json({
      success: true,
      fleet_summary: {
        total_accounts: accounts.length,
        active_accounts: activeAccounts.length,
        total_capacity_runners: totalCapacity,
        dispatched_jobs_count: allRuns.length,
        running_github_jobs_count: runningGithubJobs,
        online_runners_count: onlineRunnersCount,
        ready_avds_count: readyAvdsCount,
        actively_streaming_count: activelyStreamingCount,
        total_likes_sent: totalLikesSent
      },
      runs: allRuns,
      active_runners: activeTelemetryList
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Dispatch
apiRouter.post('/runners/dispatch', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  let { 
    stream_url, 
    duration_minutes = 60, 
    likes_per_minute = 180, 
    runner_count = 5,
    vpn_provider = 'none',
    emulator_provider = 'avd',
    target_accounts = 'all'
  } = req.body;

  // Auto-resolve active Live URL from database if not explicitly passed
  let targetUrl = stream_url ? String(stream_url).trim() : '';
  if (!targetUrl || targetUrl === 'https://www.tiktok.com/@tiktok/live') {
    try {
      const liveTargetRes = await pool.query('SELECT url FROM live_targets WHERE is_active_target = true AND is_enabled = true ORDER BY id DESC LIMIT 1');
      if (liveTargetRes.rows.length > 0 && liveTargetRes.rows[0].url) {
        targetUrl = liveTargetRes.rows[0].url;
      }
    } catch (_) {}
  }
  if (!targetUrl) {
    targetUrl = 'https://www.tiktok.com/@touqeernasir000?_r=1&_t=ZS-99JIaSBiNev';
  }

  try {
    const accounts = await getFleetAccounts();
    let dispatchTargets = accounts.filter(a => a.is_active);

    if (Array.isArray(target_accounts) && target_accounts.length > 0) {
      dispatchTargets = dispatchTargets.filter(a => target_accounts.includes(a.id));
    }

    if (dispatchTargets.length === 0) {
      return res.status(400).json({ success: false, error: 'No active GitHub fleet accounts available' });
    }

    // Immediately purge all stale in-memory screenshots and telemetry for the new boost session
    Object.keys(runnerTelemetryMap).forEach(key => delete runnerTelemetryMap[key]);
    Object.keys(runnerControlQueueMap).forEach(key => delete runnerControlQueueMap[key]);
    broadcastTelemetryUpdate('RUNNERS_CANCELLED');

    const dispatchPromises = dispatchTargets.map(async (acc) => {
      const targetRunnerCount = acc.max_runners || runner_count || 5;
      const tokenToUse = (acc.token && acc.token.trim().length > 10) ? acc.token.trim() : (process.env.GITHUB_TOKEN || '');
      
      try {
        const ghClient = new GitHubClient(tokenToUse);
        const val = await ghClient.validateToken();

        let targetOwner = acc.owner;
        let targetRepo = acc.repo || 'tiktok-live-booster';

        // Auto-fix owner if token user is valid and owner is placeholder/incorrect
        if (val.valid && val.user?.login) {
          if (!targetOwner || targetOwner === 'Tester' || targetOwner === 'user' || targetOwner.toLowerCase() !== val.user.login.toLowerCase()) {
            const checkOwner = await ghClient.checkRepoExists(targetOwner, targetRepo);
            if (!checkOwner.exists) {
              targetOwner = val.user.login;
              await pool.query('UPDATE github_accounts SET owner = $1 WHERE id = $2', [targetOwner, acc.id]).catch(() => {});
            }
          }
        }

        // Auto-initialize repository if not found on GitHub
        const repoCheck = await ghClient.checkRepoExists(targetOwner, targetRepo);
        if (!repoCheck.exists) {
          console.log(`[Auto-Init] Repository ${targetOwner}/${targetRepo} not found on GitHub. Auto-creating and pushing runner files...`);
          await ghClient.createRepository(targetRepo, false, 'TikTok Live Booster Cloud Runner Fleet');
          await ghClient.pushRunnerFiles(targetOwner, targetRepo);
          await ghClient.verifyWorkflow(targetOwner, targetRepo, 'tiktok-app-booster.yml', 4);
        } else {
          // Check if workflow exists; if not, push runner files
          const wfCheck = await ghClient.verifyWorkflow(targetOwner, targetRepo, 'tiktok-app-booster.yml', 2);
          if (!wfCheck.recognized) {
            console.log(`[Auto-Init] Workflow missing in ${targetOwner}/${targetRepo}. Pushing runner files...`);
            await ghClient.pushRunnerFiles(targetOwner, targetRepo);
            await ghClient.verifyWorkflow(targetOwner, targetRepo, 'tiktok-app-booster.yml', 4);
          }
        }

        // Dispatch workflow
        const dRes = await ghClient.dispatchWorkflow(targetOwner, targetRepo, 'tiktok-app-booster.yml', {
          stream_url: String(targetUrl).trim(),
          duration_minutes: String(duration_minutes),
          likes_per_minute: String(likes_per_minute),
          runner_count: String(targetRunnerCount),
          vpn_provider: String(vpn_provider || 'none'),
          emulator_provider: String(emulator_provider || 'avd')
        });

        return {
          account: acc.label,
          repo: `${targetOwner}/${targetRepo}`,
          dispatched: dRes.success,
          statusCode: dRes.statusCode || (dRes.success ? 204 : 400),
          error: dRes.error || null
        };
      } catch (dispatchErr) {
        return {
          account: acc.label,
          repo: `${acc.owner}/${acc.repo}`,
          dispatched: false,
          statusCode: 500,
          error: dispatchErr.message
        };
      }
    });

    const dispatchResults = await Promise.all(dispatchPromises);
    const successCount = dispatchResults.filter(r => r.dispatched).length;

    cancelledRunIds.clear();

    try {
      await pool.query(
        'INSERT INTO dispatches (stream_url, duration_minutes, likes_per_minute, dispatched_by, status) VALUES ($1, $2, $3, $4, $5)',
        [stream_url, duration_minutes, likes_per_minute, req.user.email, `${successCount} accounts triggered`]
      );
    } catch (dbErr) {
      console.debug('Postgres log dispatch:', dbErr.message);
    }

    if (successCount === 0) {
      const errorSummary = dispatchResults.map(r => `${r.account} (${r.error || `HTTP ${r.statusCode}`})`).join(', ');
      return res.status(400).json({
        success: false,
        error: `GitHub dispatch failed: ${errorSummary}`,
        results: dispatchResults
      });
    }

    res.json({
      success: true,
      message: `Successfully dispatched Live Boost to ${successCount} GitHub fleet account(s)!`,
      results: dispatchResults
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Cancel Workflows
apiRouter.post('/runners/cancel', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  try {
    const reposRes = await pool.query('SELECT r.*, a.token FROM repositories r JOIN github_accounts a ON r.account_id = a.id');
    const legacyAccounts = await getFleetAccounts();
    const legacyRepos = legacyAccounts.map(acc => ({
      owner: acc.owner,
      repo: acc.repo,
      token: (acc.token && acc.token.trim().length > 10) ? acc.token.trim() : (process.env.GITHUB_TOKEN || '')
    }));

    const allReposToCancel = [...reposRes.rows, ...legacyRepos];
    const cancelledCount = await cancelAllActiveRunsInParallel(allReposToCancel, 15);

    await pool.query("UPDATE repositories SET status = 'STOPPED', dispatch_status = 'STOPPED', updated_at = CURRENT_TIMESTAMP").catch(() => {});
    await pool.query("UPDATE fleets SET status = 'STOPPED', updated_at = CURRENT_TIMESTAMP").catch(() => {});

    // Also cancel all active PostgreSQL sessions
    try {
      await pool.query(`
        UPDATE runner_sessions SET state = 'STOPPED', ended_at = CURRENT_TIMESTAMP
        WHERE state NOT IN ('STOPPED', 'COMPLETED', 'DISCONNECTED')
      `);
    } catch (_) {}

    Object.keys(runnerTelemetryMap).forEach(key => delete runnerTelemetryMap[key]);
    Object.keys(runnerControlQueueMap).forEach(key => delete runnerControlQueueMap[key]);
    broadcastTelemetryUpdate('RUNNERS_CANCELLED');

    res.json({ success: true, message: `Cancelled ${cancelledCount} running workflow run(s) and cleared active fleet.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/runners/cancel-all', authenticateToken, requireRole(['admin', 'operator']), async (req, res) => {
  Object.keys(runnerTelemetryMap).forEach(key => delete runnerTelemetryMap[key]);
  Object.keys(runnerControlQueueMap).forEach(key => delete runnerControlQueueMap[key]);
  broadcastTelemetryUpdate('RUNNERS_CANCELLED');
  res.json({ success: true, message: 'All runner feeds stopped & telemetry reset.' });
});

// 8. Runner Registration (POST /runners/register)
apiRouter.post('/runners/register', async (req, res) => {
  const {
    runner_key,
    cluster_repo = 'tiktok-live-booster',
    runner_index = 0,
    session_uuid,
    android_version = '14',
    sdk_level = 34,
    display_width = 1080,
    display_height = 2400,
    display_density = 420,
    target_stream_url = '',
    workflow_run_id = null
  } = req.body;

  const key = runner_key || getNormalizedRunnerKey(cluster_repo, runner_index);
  const sessionUuid = session_uuid || `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  try {
    const runnerRes = await pool.query(`
      INSERT INTO runners (runner_key, cluster_repo, runner_index, android_version, sdk_level, display_width, display_height, display_density, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REGISTERED', CURRENT_TIMESTAMP)
      ON CONFLICT (runner_key) DO UPDATE SET
        cluster_repo = EXCLUDED.cluster_repo,
        android_version = EXCLUDED.android_version,
        sdk_level = EXCLUDED.sdk_level,
        display_width = EXCLUDED.display_width,
        display_height = EXCLUDED.display_height,
        display_density = EXCLUDED.display_density,
        status = 'REGISTERED',
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [key, cluster_repo, runner_index, android_version, sdk_level, display_width, display_height, display_density]);

    const runnerId = runnerRes.rows[0]?.id;

    await pool.query(`
      INSERT INTO runner_sessions (session_uuid, runner_id, workflow_run_id, target_stream_url, state, started_at)
      VALUES ($1, $2, $3, $4, 'INITIALIZING', CURRENT_TIMESTAMP)
      ON CONFLICT (session_uuid) DO UPDATE SET
        state = 'INITIALIZING',
        started_at = CURRENT_TIMESTAMP
    `, [sessionUuid, runnerId, workflow_run_id, target_stream_url]);

    console.log(`[Runner Registration] Runner registered: ${key} (Session: ${sessionUuid}, SDK: ${sdk_level}, Display: ${display_width}x${display_height})`);
    
    // Record state transition
    recordStateTransition(key, sessionUuid, 'UNREGISTERED', 'REGISTERED', 'Runner process registered in central backend', {
      sdk_level, display_width, display_height, cluster_repo
    });
  } catch (err) {
    console.debug('Postgres runner register fallback:', err.message);
  }

  runnerTelemetryMap[key] = {
    runner_id: parseInt(runner_index),
    runner_key: key,
    session_uuid: sessionUuid,
    repo: cluster_repo,
    status: 'INITIALIZING',
    state: 'INITIALIZING',
    android_version,
    sdk_level: parseInt(sdk_level),
    display_width: parseInt(display_width),
    display_height: parseInt(display_height),
    likes_sent: 0,
    elapsed_seconds: 0,
    screenshot: null,
    last_updated: new Date().toISOString()
  };

  broadcastTelemetryUpdate('RUNNER_REGISTERED');

  res.json({
    success: true,
    message: `Runner ${key} successfully registered in PostgreSQL`,
    session_uuid: sessionUuid,
    registered_at: new Date().toISOString()
  });
});

// 9. Telemetry Heartbeat (POST /telemetry/heartbeat)
apiRouter.post('/telemetry/heartbeat', async (req, res) => {
  const {
    runner_id = 0,
    runner_key,
    session_uuid,
    workflow_run_id,
    repo = 'kashifjutt7456-art/tiktok-live-booster',
    account = 'Active Session',
    status = 'RUNNING',
    state,
    likes_sent = 0,
    elapsed_seconds = 0,
    screenshot,
    screenshot_b64,
    foreground_activity,
    package_name,
    adb_state = 'OK',
    app_state = 'RUNNING',
    screen_state = 'STREAMING',
    control_state = 'CONNECTED',
    error_code,
    error_message,
    log_snippet,
    reason,
    target_live_url,
    creator,
    login_verified,
    live_verified,
    last_verified_login,
    last_verified_live,
    device_timestamp
  } = req.body;

  const key = runner_key || getNormalizedRunnerKey(repo, runner_id);
  const runnerState = state || status || 'RUNNING';
  const screenImg = screenshot_b64 || screenshot || null;

  // Derive verified indicators
  let derivedLoginVerified = login_verified;
  if (!derivedLoginVerified) {
    if (['LOGGED_IN', 'AUTHENTICATED', 'OPENING_LIVE', 'LIVE_OPEN', 'WATCHING', 'RUNNING'].includes(runnerState)) {
      derivedLoginVerified = 'VERIFIED';
    } else if (['LOGIN_FAILED'].includes(runnerState)) {
      derivedLoginVerified = 'FAILED';
    } else if (['LOGIN_RATE_LIMITED'].includes(runnerState)) {
      derivedLoginVerified = 'RATE_LIMITED';
    } else if (['LOGIN_CHALLENGE', 'LOGIN_BLOCKED', '2FA_REQUIRED'].includes(runnerState)) {
      derivedLoginVerified = 'CHALLENGE';
    } else {
      derivedLoginVerified = 'UNVERIFIED';
    }
  }

  let derivedLiveVerified = live_verified;
  if (!derivedLiveVerified) {
    if (['WATCHING', 'RUNNING'].includes(runnerState)) {
      derivedLiveVerified = 'PLAYING';
    } else if (['LIVE_OFFLINE', 'LIVE_NOT_FOUND'].includes(runnerState)) {
      derivedLiveVerified = 'OFFLINE';
    } else if (['OPENING_LIVE', 'LIVE_OPEN', 'TARGET_OPENING', 'TARGET_VERIFIED'].includes(runnerState)) {
      derivedLiveVerified = 'BUFFERING';
    } else {
      derivedLiveVerified = 'INACTIVE';
    }
  }

  const STATE_RANKS = {
    'OFFLINE': 0,
    'WAITING_FOR_RUNNER': 1,
    'REGISTERED': 2,
    'ACCOUNT_ASSIGNED': 3,
    'INITIALIZING': 3,
    'BOOTING': 3,
    'ADB_CONNECTING': 4,
    'ADB_CONNECTED': 5,
    'ANDROID_BOOTING': 6,
    'ANDROID_READY': 7,
    'STARTING': 8,
    'APP_STARTING': 8,
    'APP_STARTED': 9,
    'LOGIN_STARTED': 10,
    'LOGIN_REQUIRED': 10,
    'LOGIN_SUBMITTED': 11,
    'LOGIN_VERIFYING': 12,
    'LOGIN_SUBMITTING': 12,
    '2FA_REQUIRED': 13,
    'LOGGED_IN': 14,
    'AUTHENTICATED': 14,
    'OPENING_LIVE': 15,
    'TARGET_OPENING': 15,
    'LIVE_OPEN': 16,
    'TARGET_VERIFIED': 16,
    'WATCHING': 17,
    'RUNNING': 17,
    'RECOVERING': 17,
    'STOPPING': 18,
    'STOPPED': 19,
    'LOGIN_FAILED': 20,
    'LOGIN_RATE_LIMITED': 20,
    'LOGIN_CHALLENGE': 20,
    'LOGIN_BLOCKED': 20,
    'LIVE_OFFLINE': 20,
    'LIVE_NOT_FOUND': 20,
    'WATCH_FAILED': 20,
    'FAILED': 20,
    'ERROR': 20
  };

  const currentRecord = runnerTelemetryMap[key];

  // 1. Session Correlation & Stale Session Protection
  if (currentRecord && currentRecord.session_uuid && session_uuid && currentRecord.session_uuid !== session_uuid) {
    const activeAgeMs = currentRecord.last_updated ? (Date.now() - new Date(currentRecord.last_updated).getTime()) : Infinity;
    if (activeAgeMs < 15000 && currentRecord.state !== 'OFFLINE' && currentRecord.state !== 'STOPPED') {
      console.warn(`[Heartbeat Ignored] Stale heartbeat from old session ${session_uuid} ignored for runner ${key} (active: ${currentRecord.session_uuid})`);
      return res.json({ success: false, error: 'Stale session heartbeat rejected', active_session: currentRecord.session_uuid });
    }
  }

  // 2. Monotonic State Progression (Prevent backward regression due to lagging packet, allow error/failure states)
  let finalState = runnerState;
  const prevState = currentRecord?.state || 'UNREGISTERED';
  const isFailureState = ['LOGIN_FAILED', 'LOGIN_CHALLENGE', 'LOGIN_BLOCKED', 'LIVE_OFFLINE', 'LIVE_NOT_FOUND', 'WATCH_FAILED', 'ERROR', 'FAILED', 'STOPPED', 'STOPPING', 'OFFLINE'].includes(runnerState);
  
  if (currentRecord && prevState !== 'OFFLINE' && prevState !== 'STOPPED' && !isFailureState) {
    const prevRank = STATE_RANKS[prevState] || 0;
    const incomingRank = STATE_RANKS[runnerState] || 0;
    if (incomingRank < prevRank && incomingRank > 0) {
      finalState = prevState; // Preserve higher authoritative verified state
    }
  }

  // Track state transition if changed
  if (prevState !== finalState) {
    recordStateTransition(key, session_uuid || currentRecord?.session_uuid, prevState, finalState, reason || log_snippet || 'Authoritative heartbeat state change', {
      adb_state, app_state, screen_state, likes_sent, workflow_run_id, device_timestamp, target_live_url, login_verified: derivedLoginVerified, live_verified: derivedLiveVerified
    });
  }

  let pendingCommands = [];
  try {
    if (session_uuid) {
      await pool.query(`
        UPDATE runner_sessions SET
          state = $1,
          likes_sent = $2,
          elapsed_seconds = $3,
          foreground_activity = COALESCE($4, foreground_activity),
          package_name = COALESCE($5, package_name),
          adb_state = $6,
          app_state = $7,
          screen_state = $8,
          control_state = $9,
          error_code = $10,
          error_message = $11,
          last_heartbeat = CURRENT_TIMESTAMP
        WHERE session_uuid = $12
      `, [finalState, parseInt(likes_sent), parseInt(elapsed_seconds), foreground_activity || null, package_name || null, adb_state, app_state, screen_state, control_state, error_code || null, error_message || null, session_uuid]);
    }

    const cmdRes = await pool.query(`
      UPDATE runner_commands
      SET status = 'DELIVERED', delivered_at = CURRENT_TIMESTAMP
      WHERE runner_key = $1 AND status = 'PENDING'
      RETURNING id, action, payload
    `, [key]);

    if (cmdRes.rows.length > 0) {
      pendingCommands = cmdRes.rows.map(r => ({
        id: r.id,
        action: r.action,
        ...r.payload
      }));
    }
  } catch (err) {
    console.debug('Postgres heartbeat notice:', err.message);
  }

  if (pendingCommands.length === 0 && runnerControlQueueMap[key]) {
    pendingCommands = runnerControlQueueMap[key];
    runnerControlQueueMap[key] = [];
  }

  const effectiveTargetUrl = target_live_url || currentRecord?.target_live_url || currentRecord?.stream_url || '';
  let effectiveCreator = creator || currentRecord?.creator || '';
  if (!effectiveCreator && effectiveTargetUrl) {
    const m = effectiveTargetUrl.match(/@([a-zA-Z0-9_.-]+)/);
    if (m) effectiveCreator = `@${m[1]}`;
  }

  runnerTelemetryMap[key] = {
    ...runnerTelemetryMap[key],
    runner_id: parseInt(runner_id),
    runner_key: key,
    session_uuid: session_uuid || runnerTelemetryMap[key]?.session_uuid,
    repo,
    account,
    status: finalState,
    state: finalState,
    target_live_url: effectiveTargetUrl,
    creator: effectiveCreator,
    login_verified: derivedLoginVerified,
    live_verified: derivedLiveVerified,
    last_verified_login: last_verified_login || currentRecord?.last_verified_login || (derivedLoginVerified === 'VERIFIED' ? new Date().toISOString() : null),
    last_verified_live: last_verified_live || currentRecord?.last_verified_live || (derivedLiveVerified === 'PLAYING' ? new Date().toISOString() : null),
    likes_sent: parseInt(likes_sent),
    elapsed_seconds: parseInt(elapsed_seconds),
    screenshot: screenImg,
    foreground_activity: foreground_activity || runnerTelemetryMap[key]?.foreground_activity,
    package_name: package_name || runnerTelemetryMap[key]?.package_name,
    adb_state,
    app_state,
    screen_state,
    control_state,
    error_code: error_code || null,
    error_message: error_message || null,
    log_snippet: log_snippet || runnerTelemetryMap[key]?.log_snippet || '',
    last_updated: new Date().toISOString()
  };

  broadcastTelemetryUpdate('TELEMETRY_UPDATE');

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    commands: pendingCommands
  });
});

// 10. State Transitions Audit API
apiRouter.get('/runners/:key/transitions', authenticateToken, async (req, res) => {
  const { key } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  try {
    const result = await pool.query(`
      SELECT id, runner_key, session_uuid, from_state, to_state, reason, metadata, created_at
      FROM runner_state_transitions
      WHERE runner_key = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [key, limit]);
    res.json({ success: true, runner_key: key, transitions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.get('/runners/transitions/all', authenticateToken, async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  try {
    const result = await pool.query(`
      SELECT id, runner_key, session_uuid, from_state, to_state, reason, metadata, created_at
      FROM runner_state_transitions
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ success: true, transitions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Remote Control Command Dispatch
apiRouter.post('/runners/:id/control', authenticateToken, async (req, res) => {
  const runnerId = parseInt(req.params.id);
  const { repo, session_uuid, action = 'tap', ...payload } = req.body;
  const key = getNormalizedRunnerKey(repo, runnerId);
  const sessionUuid = session_uuid || runnerTelemetryMap[key]?.session_uuid || 'active_session';

  const cmdPayload = {
    x: parseInt(payload.x) || 540,
    y: parseInt(payload.y) || 960,
    x1: parseInt(payload.x1) || 540,
    y1: parseInt(payload.y1) || 1600,
    x2: parseInt(payload.x2) || 540,
    y2: parseInt(payload.y2) || 400,
    keycode: parseInt(payload.keycode) || 4,
    text: payload.text || '',
    timestamp: new Date().toISOString()
  };

  try {
    const dbRes = await pool.query(`
      INSERT INTO runner_commands (session_uuid, runner_key, action, payload, status)
      VALUES ($1, $2, $3, $4, 'PENDING')
      RETURNING id
    `, [sessionUuid, key, action, JSON.stringify(cmdPayload)]);

    cmdPayload.id = dbRes.rows[0]?.id || Date.now();
  } catch (err) {
    cmdPayload.id = Date.now();
    if (!runnerControlQueueMap[key]) runnerControlQueueMap[key] = [];
    runnerControlQueueMap[key].push({ id: cmdPayload.id, action, ...cmdPayload });
  }

  res.json({
    success: true,
    message: `Dispatched remote ${action} command to Runner #${runnerId}`,
    command: { id: cmdPayload.id, action, ...cmdPayload }
  });
});

// 11. Command ACK
apiRouter.post('/runners/:id/command-ack', async (req, res) => {
  const { command_id, status = 'EXECUTED', error_message = null } = req.body;
  try {
    if (command_id) {
      await pool.query(`
        UPDATE runner_commands
        SET status = $1, executed_at = CURRENT_TIMESTAMP, error_message = $2
        WHERE id = $3
      `, [status, error_message, command_id]);
    }
  } catch (err) {
    console.debug('Postgres command ack notice:', err.message);
  }
  res.json({ success: true, command_id, status });
});

// 12. Stop Runner
apiRouter.post('/runners/:id/stop', async (req, res) => {
  const runnerId = parseInt(req.params.id);
  const { repo, session_uuid } = req.body;
  const key = getNormalizedRunnerKey(repo, runnerId);

  try {
    await pool.query(`
      UPDATE runner_sessions SET state = 'STOPPED', ended_at = CURRENT_TIMESTAMP
      WHERE runner_id = (SELECT id FROM runners WHERE runner_key = $1) OR session_uuid = $2
    `, [key, session_uuid]);

    await pool.query(`
      UPDATE runners SET status = 'STOPPED', updated_at = CURRENT_TIMESTAMP WHERE runner_key = $1
    `, [key]);
  } catch (err) {
    console.debug('Postgres stop runner notice:', err.message);
  }

  if (runnerTelemetryMap[key]) {
    runnerTelemetryMap[key].status = 'STOPPED';
    runnerTelemetryMap[key].state = 'STOPPED';
  }

  res.json({ success: true, message: `Runner ${key} marked as STOPPED in PostgreSQL` });
});

// 13. Diagnostics Endpoint
apiRouter.get('/runners/:id/diagnostics', async (req, res) => {
  const runnerId = parseInt(req.params.id);
  const { repo } = req.query;
  const key = getNormalizedRunnerKey(repo, runnerId);

  try {
    const dbRes = await pool.query(`
      SELECT r.runner_key, r.cluster_repo, r.runner_index, r.android_version, r.sdk_level,
             r.display_width, r.display_height, r.display_density, r.status AS runner_status,
             s.session_uuid, s.state AS session_state, s.likes_sent, s.elapsed_seconds,
             s.package_name, s.foreground_activity, s.adb_state, s.app_state, s.screen_state,
             s.control_state, s.last_heartbeat, s.error_code, s.error_message, s.started_at
      FROM runners r
      LEFT JOIN runner_sessions s ON s.runner_id = r.id
      WHERE r.runner_key = $1
      ORDER BY s.id DESC LIMIT 1
    `, [key]);

    if (dbRes.rows.length > 0) {
      const row = dbRes.rows[0];
      return res.json({
        success: true,
        diagnostics: {
          runner_id: row.runner_index,
          runner_key: row.runner_key,
          session_uuid: row.session_uuid,
          status: row.session_state || row.runner_status,
          android_version: row.android_version,
          sdk: row.sdk_level,
          adb_state: row.adb_state,
          boot_completed: row.adb_state === 'OK',
          display_size: `${row.display_width}x${row.display_height}`,
          display_density: row.display_density,
          package_name: row.package_name,
          foreground_activity: row.foreground_activity,
          app_state: row.app_state,
          screen_stream_state: row.screen_state,
          control_state: row.control_state,
          likes_sent: row.likes_sent,
          elapsed_seconds: row.elapsed_seconds,
          last_heartbeat: row.last_heartbeat,
          started_at: row.started_at,
          error_code: row.error_code,
          error_message: row.error_message
        }
      });
    }
  } catch (err) {
    console.debug('Postgres diagnostics fallback:', err.message);
  }

  const t = runnerTelemetryMap[key] || {};
  res.json({
    success: true,
    diagnostics: {
      runner_id: runnerId,
      runner_key: key,
      session_uuid: t.session_uuid || 'N/A',
      status: t.state || t.status || 'OFFLINE',
      android_version: t.android_version || '14',
      sdk: t.sdk_level || 34,
      adb_state: t.adb_state || 'OK',
      boot_completed: true,
      display_size: `${t.display_width || 1080}x${t.display_height || 2400}`,
      package_name: t.package_name || 'com.zhiliaoapp.musically',
      foreground_activity: t.foreground_activity || 'N/A',
      app_state: t.app_state || 'RUNNING',
      screen_stream_state: t.screen_state || 'STREAMING',
      control_state: t.control_state || 'CONNECTED',
      likes_sent: t.likes_sent || 0,
      elapsed_seconds: t.elapsed_seconds || 0,
      last_heartbeat: t.last_updated || 'N/A',
      error_code: t.error_code || null,
      error_message: t.error_message || null
    }
  });
});

// 14. Live Telemetry
apiRouter.get('/telemetry/live', authenticateToken, async (req, res) => {
  const now = Date.now();
  const activeList = Object.values(runnerTelemetryMap)
    .filter(t => (now - new Date(t.last_updated).getTime()) < 25000 && t.state !== 'STOPPED' && t.state !== 'DISCONNECTED')
    .sort((a, b) => a.runner_id - b.runner_id);

  res.json({
    success: true,
    telemetry: activeList
  });
});

// Mount router on both direct '/api' and reverse-proxied '/tiktok/api' and '/tiktok' prefixes
app.use('/api', apiRouter);
app.use('/tiktok/api', apiRouter);
app.use('/tiktok', apiRouter);

// Watchdog: Disconnect detection (every 5 seconds)
setInterval(async () => {
  try {
    await pool.query(`
      UPDATE runner_sessions SET state = 'DISCONNECTED', ended_at = CURRENT_TIMESTAMP
      WHERE state NOT IN ('STOPPED', 'COMPLETED', 'DISCONNECTED')
        AND last_heartbeat < (CURRENT_TIMESTAMP - INTERVAL '15 SECONDS')
    `);
  } catch (err) {}
}, 5000);

// WebSocket Server: Low-Latency Screen & Touch Relay
const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024, perMessageDeflate: false });
const runnerSockets = new Map();
const browserClients = new Map();
const httpStreamSubscribers = new Map();
const httpControlPollers = new Map();

// HTTP Chunked Stream Publisher (For Runners when WebSockets are proxied/blocked)
const handleStreamPublish = (req, res) => {
  const runnerKey = req.params.runnerKey || req.query.runner_key || 'tiktok-live-booster_runner_0';
  const token = req.query.token || (req.headers.authorization ? req.headers.authorization.split(' ')[1] : null);

  if (token && token !== RUNNER_SECRET && token !== 'runner_token') {
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized runner token' });
    }
  }

  console.log(`[HTTP-Stream] Runner H.264 publisher stream connected for ${runnerKey}`);
  pool.query(`
    UPDATE runner_sessions SET screen_state = 'STREAMING'
    WHERE runner_id = (SELECT id FROM runners WHERE runner_key = $1)
  `, [runnerKey]).catch(() => {});

  req.on('data', (chunk) => {
    if (Buffer.isBuffer(chunk)) {
      if (chunk.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67])) || chunk.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x27]))) {
        runnerHeaderCache.set(runnerKey, chunk);
      }
    }

    // Forward to WebSocket viewers
    const wsViewers = browserClients.get(runnerKey);
    if (wsViewers) {
      for (const client of wsViewers) {
        if (client.readyState === 1) {
          client.send(chunk, { binary: true });
        }
      }
    }

    // Forward to HTTP Chunked Stream subscribers
    const httpViewers = httpStreamSubscribers.get(runnerKey);
    if (httpViewers) {
      for (const sub of httpViewers) {
        try {
          sub.write(chunk);
        } catch (_) {}
      }
    }
  });

  req.on('end', () => {
    console.log(`[HTTP-Stream] Runner publisher stream ended for ${runnerKey}`);
    res.status(200).json({ success: true, message: 'Stream ended' });
  });

  req.on('error', (err) => {
    console.warn(`[HTTP-Stream] Runner publisher error for ${runnerKey}:`, err.message);
  });
};

// HTTP Live H.264 Stream Subscriber (For Browser Viewers via Fetch ReadableStream)
const handleStreamLive = (req, res) => {
  const runnerKey = req.params.runnerKey || req.query.runner_key || 'tiktok-live-booster_runner_0';
  const token = req.query.token || (req.headers.authorization ? req.headers.authorization.split(' ')[1] : null);

  if (!token) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  try {
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  console.log(`[HTTP-Stream] Browser viewer subscribed to live stream for ${runnerKey}`);

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  if (!httpStreamSubscribers.has(runnerKey)) {
    httpStreamSubscribers.set(runnerKey, new Set());
  }
  httpStreamSubscribers.get(runnerKey).add(res);

  // Send cached SPS/PPS header chunk immediately to bootstrap browser decoder
  const cachedHeader = runnerHeaderCache.get(runnerKey);
  if (cachedHeader) {
    try {
      res.write(cachedHeader);
    } catch (_) {}
  }

  req.on('close', () => {
    console.log(`[HTTP-Stream] Browser viewer disconnected from ${runnerKey}`);
    httpStreamSubscribers.get(runnerKey)?.delete(res);
  });
};

// Helper to parse Scrcpy binary packets (>BBQIIHHHII for touch, >BBIII for keycode)
function parseScrcpyPacket(buf) {
  if (!buf || buf.length < 14) return null;
  try {
    const type = buf.readUInt8(0);
    if (type === 0x02 && buf.length >= 32) {
      const action = buf.readUInt8(1); // 0=DOWN, 1=UP, 2=MOVE
      const x = buf.readUInt32BE(10);
      const y = buf.readUInt32BE(14);
      const w = buf.readUInt16BE(18);
      const h = buf.readUInt16BE(20);
      return { type: 'touch', action, x, y, w, h };
    } else if (type === 0x00 && buf.length >= 14) {
      const action = buf.readUInt8(1);
      const keycode = buf.readUInt32BE(2);
      return { type: 'key', action, keycode };
    }
  } catch (_) {}
  return null;
}

// HTTP Control Command Endpoint (Browser -> Runner)
const handleStreamControl = (req, res) => {
  const runnerKey = req.params.runnerKey || req.query.runner_key || 'tiktok-live-booster_runner_0';
  const token = req.query.token || (req.headers.authorization ? req.headers.authorization.split(' ')[1] : null);

  if (!token) {
    return res.status(401).json({ error: 'Authorization token required' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Support JSON command payloads (e.g. { action: 'text', text: '...' } or { action: 'tap', x, y })
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && req.body.action) {
    if (!runnerControlQueueMap[runnerKey]) runnerControlQueueMap[runnerKey] = [];
    runnerControlQueueMap[runnerKey].push({
      id: Date.now(),
      action: req.body.action,
      text: req.body.text,
      x: req.body.x,
      y: req.body.y,
      keycode: req.body.keycode,
      timestamp: new Date().toISOString()
    });
    console.log(`[COMMAND_QUEUED] runner=${runnerKey} action=${req.body.action} payload=`, req.body);
    return res.json({ success: true, queued: true });
  }

  const rawBody = req.body;
  let packetBuffer = null;

  if (Buffer.isBuffer(rawBody)) {
    packetBuffer = rawBody;
  } else if (typeof rawBody === 'string') {
    packetBuffer = Buffer.from(rawBody, 'base64');
  } else if (rawBody && rawBody.data) {
    packetBuffer = Buffer.from(rawBody.data);
  }

  if (packetBuffer) {
    const parsed = parseScrcpyPacket(packetBuffer);
    if (parsed) {
      if (parsed.type === 'touch' && parsed.action === 0) {
        console.log(`[TOUCH_DISPATCH] runner=${runnerKey} action=TAP android=(${parsed.x},${parsed.y}) resolution=${parsed.w}x${parsed.h}`);
      } else if (parsed.type === 'key' && parsed.action === 0) {
        console.log(`[KEY_DISPATCH] runner=${runnerKey} keycode=${parsed.keycode}`);
      }
    }

    // 1. Forward to WebSocket runner
    let deliveredWs = false;
    const runnerWs = runnerSockets.get(runnerKey);
    if (runnerWs && runnerWs.readyState === 1) {
      runnerWs.send(packetBuffer, { binary: true });
      deliveredWs = true;
    }

    // 2. Forward to HTTP polling runner
    const pollers = httpControlPollers.get(runnerKey);
    if (pollers && pollers.size > 0) {
      for (const poller of pollers) {
        try {
          poller.write(packetBuffer);
          deliveredWs = true;
        } catch (_) {}
      }
    }

    // 3. Fallback to ADB Command Queue if Scrcpy socket is not reachable and action is tap/key
    if (!deliveredWs && parsed) {
      if (!runnerControlQueueMap[runnerKey]) runnerControlQueueMap[runnerKey] = [];
      if (parsed.type === 'touch' && parsed.action === 0) {
        runnerControlQueueMap[runnerKey].push({
          id: Date.now(),
          action: 'tap',
          x: parsed.x,
          y: parsed.y,
          timestamp: new Date().toISOString()
        });
      } else if (parsed.type === 'key' && parsed.action === 0) {
        runnerControlQueueMap[runnerKey].push({
          id: Date.now(),
          action: 'key',
          keycode: parsed.keycode,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  res.json({ success: true });
};

// HTTP Control Long-Poll Endpoint (Runner receives commands over HTTP)
const handleControlPoll = (req, res) => {
  const runnerKey = req.params.runnerKey || req.query.runner_key || 'tiktok-live-booster_runner_0';
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  if (!httpControlPollers.has(runnerKey)) {
    httpControlPollers.set(runnerKey, new Set());
  }
  httpControlPollers.get(runnerKey).add(res);

  req.on('close', () => {
    httpControlPollers.get(runnerKey)?.delete(res);
  });
};

// Register Stream Endpoints on API Router
apiRouter.post('/stream/publish/:runnerKey', express.raw({ type: '*/*', limit: '10mb' }), handleStreamPublish);
apiRouter.get('/stream/live/:runnerKey', handleStreamLive);
apiRouter.post('/stream/control/:runnerKey', express.raw({ type: '*/*', limit: '1mb' }), handleStreamControl);
apiRouter.get('/stream/control-poll/:runnerKey', handleControlPoll);

// Also register directly on app for /api and /tiktok routes
app.post(['/api/stream/publish/:runnerKey', '/tiktok/api/stream/publish/:runnerKey', '/stream/publish/:runnerKey'], express.raw({ type: '*/*', limit: '10mb' }), handleStreamPublish);
app.get(['/api/stream/live/:runnerKey', '/tiktok/api/stream/live/:runnerKey', '/stream/live/:runnerKey'], handleStreamLive);
app.post(['/api/stream/control/:runnerKey', '/tiktok/api/stream/control/:runnerKey', '/stream/control/:runnerKey'], express.raw({ type: '*/*', limit: '1mb' }), handleStreamControl);
app.get(['/api/stream/control-poll/:runnerKey', '/tiktok/api/stream/control-poll/:runnerKey', '/stream/control-poll/:runnerKey'], handleControlPoll);

// Mount main API router for both direct port and /tiktok reverse proxy paths
app.use('/api', apiRouter);
app.use('/tiktok/api', apiRouter);
app.use('/', apiRouter);

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname.endsWith('/ws/stream') || pathname.includes('/ws/stream') || pathname.endsWith('/stream')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  if (ws._socket && ws._socket.setNoDelay) {
    ws._socket.setNoDelay(true);
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role'); // 'runner', 'browser', or 'dashboard'
  const runnerKey = url.searchParams.get('runner_key') || 'tiktok-live-booster_runner_0';
  const token = url.searchParams.get('token');

  // Real-Time Dashboard Client (Live Telemetry Push Channel)
  if (role === 'dashboard') {
    if (!token) {
      ws.close(4001, 'Authorization token required');
      return;
    }
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (err) {
      ws.close(4001, 'Invalid or expired token');
      return;
    }

    dashboardClients.add(ws);
    console.log(`[WebSocket] Dashboard Client connected. Total dashboard viewers: ${dashboardClients.size}`);

    // Send immediate sync snapshot of current fleet state
    const now = Date.now();
    const activeList = Object.values(runnerTelemetryMap)
      .filter(t => (now - new Date(t.last_updated).getTime()) < 30000 && t.state !== 'STOPPED' && t.state !== 'DISCONNECTED')
      .sort((a, b) => a.runner_id - b.runner_id);

    ws.send(JSON.stringify({
      type: 'TELEMETRY_SYNC',
      timestamp: new Date().toISOString(),
      telemetry: activeList
    }));

    ws.on('close', () => {
      dashboardClients.delete(ws);
      console.log(`[WebSocket] Dashboard Client disconnected. Remaining: ${dashboardClients.size}`);
    });
    return;
  }

  // Enforce Authentication for Browser Viewers
  if (role === 'browser') {
    if (!token) {
      console.warn(`[WebSocket] Rejected browser stream connection (missing token) for ${runnerKey}`);
      ws.close(4001, 'Authorization token required');
      return;
    }
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (err) {
      console.warn(`[WebSocket] Unauthorized browser stream attempt for ${runnerKey}`);
      ws.close(4001, 'Invalid or expired token');
      return;
    }
  }

  // Validate Runner Connection
  if (role === 'runner') {
    if (token && token !== RUNNER_SECRET && token !== 'runner_token') {
      try {
        jwt.verify(token, JWT_SECRET);
      } catch (err) {
        console.warn(`[WebSocket] Unauthorized runner stream attempt for ${runnerKey}`);
        ws.close(4001, 'Unauthorized runner');
        return;
      }
    }

    console.log(`[WebSocket] Scrcpy H.264 publisher connected for ${runnerKey}`);
    runnerSockets.set(runnerKey, ws);

    pool.query(`
      UPDATE runner_sessions SET screen_state = 'STREAMING'
      WHERE runner_id = (SELECT id FROM runners WHERE runner_key = $1)
    `, [runnerKey]).catch(() => {});

    ws.on('message', (data, isBinary) => {
      if (isBinary && Buffer.isBuffer(data)) {
        // Cache SPS/PPS header chunk if present (NAL unit type 7: 0x67 / 0x27)
        if (data.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67])) || data.includes(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x27]))) {
          runnerHeaderCache.set(runnerKey, data);
        }
      }

      // Forward binary H.264 chunks directly to connected WebSocket browser viewers
      const viewers = browserClients.get(runnerKey) || new Set();
      for (const client of viewers) {
        if (client.readyState === 1) { // OPEN
          // Drop frame if client buffer has accumulated backpressure (> 512KB) to prevent multi-second lag
          if (client.bufferedAmount < 512 * 1024) {
            client.send(data, { binary: isBinary });
          }
        }
      }

      // Forward to HTTP Chunked Stream subscribers
      const httpViewers = httpStreamSubscribers.get(runnerKey);
      if (httpViewers) {
        for (const sub of httpViewers) {
          try {
            sub.write(data);
          } catch (_) {}
        }
      }
    });

    ws.on('close', () => {
      console.log(`[WebSocket] Runner screen stream disconnected: ${runnerKey}`);
      runnerSockets.delete(runnerKey);
      pool.query(`
        UPDATE runner_sessions SET screen_state = 'FALLBACK'
        WHERE runner_id = (SELECT id FROM runners WHERE runner_key = $1)
      `, [runnerKey]).catch(() => {});
    });
  } else {
    // Browser Viewer Client
    console.log(`[WebSocket] Browser viewer client subscribed to ${runnerKey}`);
    if (!browserClients.has(runnerKey)) {
      browserClients.set(runnerKey, new Set());
    }
    browserClients.get(runnerKey).add(ws);

    // If we have cached SPS/PPS header chunk, send it immediately to bootstrap decoder
    const cachedHeader = runnerHeaderCache.get(runnerKey);
    if (cachedHeader && ws.readyState === 1) {
      ws.send(cachedHeader, { binary: true });
    }

    ws.on('message', (msg, isBinary) => {
      // Browser touch/key control event -> Forward directly to runner socket
      const runnerSocket = runnerSockets.get(runnerKey);
      if (runnerSocket && runnerSocket.readyState === 1) {
        runnerSocket.send(msg, { binary: isBinary });
      }
      // Also forward to HTTP control pollers
      const pollers = httpControlPollers.get(runnerKey);
      if (pollers) {
        for (const poller of pollers) {
          try {
            poller.write(msg);
          } catch (_) {}
        }
      }
    });

    ws.on('close', () => {
      browserClients.get(runnerKey)?.delete(ws);
    });
  }
});

// Serve production frontend assets if built
const fs = require('fs');
const distPath = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use('/tiktok', express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/tiktok/api') || req.path.startsWith('/ws') || req.path.startsWith('/stream')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TikTok Booster API] Engine listening on port ${PORT} with WebSocket support`);
});

module.exports = { app, server };
