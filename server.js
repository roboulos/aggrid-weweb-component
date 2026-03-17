const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Database connection (Neon via DATABASE_URL)
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[DB] Pool error:', err.message));
}

// Make libraries available to routes
app.locals.db = pool;
app.locals.jwt = jwt;
app.locals.bcrypt = bcrypt;
const JWT_SECRET = process.env.JWT_SECRET || 'hp-dev-secret-change-in-prod';

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Health endpoint
app.get('/health', async (req, res) => {
  const status = { server: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  if (pool) {
    try {
      const result = await pool.query('SELECT NOW()');
      status.database = 'connected';
      status.db_time = result.rows[0].now;
    } catch (err) {
      status.database = 'error';
      status.db_error = err.message;
    }
  } else {
    status.database = 'not configured';
  }
  res.json(status);
});

// SQL query endpoint (for AI agents and admin use)
app.post('/sql', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { query, params } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const result = await pool.query(query, params || []);
    res.json({ rows: result.rows, rowCount: result.rowCount, command: result.command });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Dynamic route loader — loads all .js files from /app/routes
const ROUTES_DIR = process.env.ROUTES_DIR || '/app/routes';
let dynamicRouter = express.Router();
app.use((req, res, next) => dynamicRouter(req, res, next));

function loadRoutes() {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.log(`[Routes] No routes directory at ${ROUTES_DIR}, skipping`);
    return;
  }
  Object.keys(require.cache).forEach(key => {
    if (key.startsWith(ROUTES_DIR)) delete require.cache[key];
  });
  const newRouter = express.Router();
  const files = fs.readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const route = require(path.join(ROUTES_DIR, file));
      if (typeof route === 'function') {
        route({ ...app, get: newRouter.get.bind(newRouter), post: newRouter.post.bind(newRouter), put: newRouter.put.bind(newRouter), patch: newRouter.patch.bind(newRouter), delete: newRouter.delete.bind(newRouter), locals: app.locals });
        console.log(`[Routes] Loaded: ${file}`);
      }
    } catch (err) {
      console.error(`[Routes] Failed to load ${file}:`, err.message);
    }
  }
  dynamicRouter = newRouter;
}
loadRoutes();

app.post('/_reload', (req, res) => {
  loadRoutes();
  res.json({ success: true, message: 'Routes reloaded', routes: deployedRoutes.size });
});

// === ROUTE PERSISTENCE ===
async function initRouteStore() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS _route_store (
      name TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      code TEXT NOT NULL,
      deployed_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await pool.query('SELECT * FROM _route_store');
    for (const row of result.rows) {
      deployRoute(row.name, row.method, row.path, row.code, false);
    }
    console.log(`[Routes] Restored ${result.rows.length} routes from database`);
  } catch (err) {
    console.error('[Routes] Failed to init route store:', err.message);
  }
}

function deployRoute(name, method, routePath, code, persist = true) {
  const verb = method.toLowerCase();
  const fileName = `${name}.js`;
  const filePath = path.join(ROUTES_DIR, fileName);
  const wrappedCode = `
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
module.exports = function(app) {
  app.${verb}('${routePath}', async (req, res) => {
    const db = app.locals.db;
    const JWT_SECRET = process.env.JWT_SECRET || 'hp-dev-secret-change-in-prod';
    const getUser = () => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) return null;
      try { return jwt.verify(auth.slice(7), JWT_SECRET); } catch { return null; }
    };
    const callFn = async (name, ...args) => app.locals.callFunction(name, ...args);
    try {
      ${code}
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};`;
  fs.writeFileSync(filePath, wrappedCode);
  loadRoutes();
  deployedRoutes.set(name, { method: verb.toUpperCase(), path: routePath, deployed_at: new Date().toISOString() });
  if (persist && pool) {
    pool.query(
      `INSERT INTO _route_store (name, method, path, code) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET method = $2, path = $3, code = $4, deployed_at = NOW()`,
      [name, verb.toUpperCase(), routePath, code]
    ).catch(err => console.error('[Routes] Failed to persist:', err.message));
  }
  console.log(`[Deploy] ${verb.toUpperCase()} ${routePath} -> ${fileName}`);
}

const deployedRoutes = new Map();

app.post('/_deploy', (req, res) => {
  const { name, method, path: routePath, code } = req.body;
  if (!name || !routePath || !code) {
    return res.status(400).json({ error: 'name, path, and code are required' });
  }
  const verb = (method || 'GET').toLowerCase();
  if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) {
    return res.status(400).json({ error: 'Invalid method. Use GET, POST, PUT, PATCH, or DELETE' });
  }
  try {
    deployRoute(name, verb.toUpperCase(), routePath, code, true);
    res.json({ success: true, route: { name, method: verb.toUpperCase(), path: routePath } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/_undeploy', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const filePath = path.join(ROUTES_DIR, `${name}.js`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    deployedRoutes.delete(name);
    loadRoutes();
    if (pool) pool.query('DELETE FROM _route_store WHERE name = $1', [name]).catch(() => {});
    res.json({ success: true, removed: name });
  } else {
    res.status(404).json({ error: 'Route not found' });
  }
});

app.get('/_routes', (req, res) => {
  const routes = [];
  deployedRoutes.forEach((val, key) => routes.push({ name: key, ...val }));
  const files = fs.existsSync(ROUTES_DIR)
    ? fs.readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))
    : [];
  res.json({ deployed: routes, files });
});

app.get('/_routes/:name', (req, res) => {
  const filePath = path.join(ROUTES_DIR, `${req.params.name}.js`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Route not found' });
  res.json({ name: req.params.name, source: fs.readFileSync(filePath, 'utf8') });
});

const daemons = new Map();

app.post('/_daemon/start', (req, res) => {
  const { name, interval_ms, code } = req.body;
  if (!name || !interval_ms) return res.status(400).json({ error: 'name and interval_ms required' });
  if (daemons.has(name)) {
    clearInterval(daemons.get(name).timer);
  }
  try {
    const fn = new Function('db', 'fetch', 'console', code);
    const timer = setInterval(() => {
      try { fn(pool, fetch, console); }
      catch (err) { console.error(`[Daemon:${name}]`, err.message); }
    }, interval_ms);
    daemons.set(name, { timer, interval_ms, started: new Date().toISOString() });
    res.json({ success: true, daemon: name, interval_ms });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/_daemon/stop', (req, res) => {
  const { name } = req.body;
  if (!name || !daemons.has(name)) return res.status(404).json({ error: 'Daemon not found' });
  clearInterval(daemons.get(name).timer);
  daemons.delete(name);
  res.json({ success: true, stopped: name });
});

app.get('/_daemon/list', (req, res) => {
  const list = [];
  daemons.forEach((val, key) => list.push({ name: key, interval_ms: val.interval_ms, started: val.started }));
  res.json({ daemons: list });
});

const storedFunctions = new Map();

async function initFunctionStore() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS _function_store (
      name TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await pool.query('SELECT * FROM _function_store');
    for (const row of result.rows) {
      storedFunctions.set(row.name, { code: row.code, description: row.description || '' });
    }
    console.log(`[Functions] Restored ${result.rows.length} functions from database`);
  } catch (err) {
    console.error('[Functions] Failed to init function store:', err.message);
  }
}

async function callFunction(name, ...args) {
  const fn = storedFunctions.get(name);
  if (!fn) throw new Error(`Function "${name}" not found`);
  const executor = new Function('db', 'fetch', 'console', 'args', `return (async () => { ${fn.code} })()`);
  return executor(pool, fetch, console, args);
}

app.locals.callFunction = callFunction;

app.post('/_functions', (req, res) => {
  const { name, code, description } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  storedFunctions.set(name, { code, description: description || '' });
  if (pool) {
    pool.query(
      `INSERT INTO _function_store (name, code, description) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET code = $2, description = $3, created_at = NOW()`,
      [name, code, description || '']
    ).catch(err => console.error('[Functions] Failed to persist:', err.message));
  }
  console.log(`[Functions] Stored: ${name}`);
  res.json({ success: true, function: { name, description: description || '' } });
});

app.get('/_functions', (req, res) => {
  const list = [];
  storedFunctions.forEach((val, key) => list.push({ name: key, description: val.description }));
  res.json({ functions: list });
});

app.get('/_functions/:name', (req, res) => {
  const fn = storedFunctions.get(req.params.name);
  if (!fn) return res.status(404).json({ error: 'Function not found' });
  res.json({ name: req.params.name, code: fn.code, description: fn.description });
});

app.delete('/_functions/:name', (req, res) => {
  if (!storedFunctions.has(req.params.name)) return res.status(404).json({ error: 'Function not found' });
  storedFunctions.delete(req.params.name);
  if (pool) pool.query('DELETE FROM _function_store WHERE name = $1', [req.params.name]).catch(() => {});
  console.log(`[Functions] Deleted: ${req.params.name}`);
  res.json({ success: true, deleted: req.params.name });
});

app.get('/', (req, res) => {
  const routes = [];
  deployedRoutes.forEach((val, key) => routes.push({ name: key, ...val }));
  res.json({
    name: process.env.INSTANCE_NAME || 'hp-instance',
    version: '3.4.0',
    database: pool ? 'configured' : 'none',
    routes: routes.length,
    functions: storedFunctions.size,
    daemons: daemons.size,
    uptime: process.uptime(),
    endpoints: {
      system: ['GET /', 'GET /health', 'POST /sql', 'POST /_deploy', 'POST /_undeploy', 'GET /_routes', 'GET /_routes/:name', 'POST /_reload', 'POST /_functions', 'GET /_functions', 'GET /_functions/:name', 'DELETE /_functions/:name', 'POST /_daemon/start', 'POST /_daemon/stop', 'GET /_daemon/list'],
      deployed: routes,
    },
  });
});

app.listen(PORT, async () => {
  console.log(`[HP] Server running on port ${PORT}`);
  if (pool) {
    console.log('[HP] Database configured via DATABASE_URL');
    await initRouteStore();
    await initFunctionStore();
  } else {
    console.log('[HP] No DATABASE_URL — running without database');
  }
});
