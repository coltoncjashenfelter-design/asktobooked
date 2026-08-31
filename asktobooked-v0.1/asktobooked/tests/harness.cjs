/**
 * Shared test harness.
 *
 * Runs the real Pages Function handler against an in-memory SQLite database
 * built from the migrations, through a small D1-shaped shim, and gives each
 * simulated browser its own cookie jar so sessions behave as they would in a
 * real client.
 *
 * Requires node:sqlite (Node 24+, or Node 22.5+ with --experimental-sqlite).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = ['0001_home_graph.sql', '0002_auth.sql'];
const ORIGIN = 'http://localhost';

function requireSqlite() {
  try { return require('node:sqlite').DatabaseSync; }
  catch { return null; }
}

const normalizeParam = value => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  return String(value);
};

class D1Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new D1Statement(this.db, this.sql, params.map(normalizeParam)); }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (row === undefined || row === null) return null;
    return column === undefined ? row : row[column];
  }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
  }
}

class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function loadCore() {
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
  return sandbox.module.exports;
}

function readSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * Builds a test environment. Each client() is an independent browser: it keeps
 * its own cookies, so cross-tenant and signed-out cases are exercised the same
 * way a second browser session would.
 */
async function createHarness(env = {}) {
  const DatabaseSync = requireSqlite();
  if (!DatabaseSync) return null;
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) sqlite.exec(fs.readFileSync(path.join(ROOT, 'migrations', migration), 'utf8'));
  const DB = new D1Database(sqlite);
  const worker = await import(pathToFileURL(path.join(ROOT, 'functions', 'api', '[[path]].js')).href);
  const baseEnv = { DB, ALLOW_DEMO_SEED: 'true', ALLOW_SIGNUP: 'true', ...env };

  function client(initialCookies = {}) {
    const jar = { ...initialCookies };
    async function call(method, route, body, overrides = {}) {
      const init = { method, headers: {} };
      if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
      const cookies = Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookies) init.headers.cookie = cookies;
      Object.assign(init.headers, overrides.headers || {});
      const response = await worker.onRequest({
        request: new Request(`${ORIGIN}/api/${route}`, init),
        env: { ...baseEnv, ...(overrides.env || {}) }
      });
      for (const cookie of readSetCookies(response)) {
        const [pair, ...attributes] = cookie.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        const expired = attributes.some(a => /^\s*max-age\s*=\s*0\s*$/i.test(a));
        if (!value || expired) delete jar[name]; else jar[name] = value;
      }
      return { status: response.status, payload: await response.json(), headers: response.headers };
    }
    return {
      jar,
      call,
      async ok(method, route, body, overrides) {
        const result = await call(method, route, body, overrides);
        if (result.payload.ok !== true) {
          throw new Error(`${method} /api/${route} failed (${result.status}): ${JSON.stringify(result.payload)}`);
        }
        return result.payload.data;
      },
      async login(email, password) {
        const result = await call('POST', 'auth/login', { email, password });
        if (result.payload.ok !== true) throw new Error(`login failed: ${JSON.stringify(result.payload)}`);
        return result.payload.data;
      },
      async register(input) {
        const result = await call('POST', 'auth/register', input);
        if (result.payload.ok !== true) throw new Error(`register failed: ${JSON.stringify(result.payload)}`);
        return result.payload.data;
      }
    };
  }

  return { sqlite, DB, worker, core: loadCore(), client, close: () => sqlite.close(), ORIGIN };
}

module.exports = { createHarness, loadCore, D1Database, D1Statement, ORIGIN };
