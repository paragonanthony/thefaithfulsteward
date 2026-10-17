// Shared setup for integration tests. Each test file uses its own throwaway database.
import pg from 'pg';

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/postgres';

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || res.statusText); e.status = res.status; throw e; }
    return data;
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}

/** Create a fresh database, run migrations, add an "admin" system user and start the app. */
export async function startTestServer(dbName) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  process.env.DATABASE_URL = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const db = await import('../server/db.js');
  const { createApp } = await import('../server/index.js');
  const { hashPassword } = await import('../server/auth.js');
  await db.query(`INSERT INTO users (username, password_hash, display_name, is_system_admin) VALUES ('admin', $1, 'Admin', true)`, [await hashPassword('admin-password')]);
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  return {
    base,
    db,
    client: () => new Client(base),
    stop: async () => { server.close(); await db.pool.end(); },
  };
}
