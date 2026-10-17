// Starts a throwaway local PostgreSQL server for development/testing (no install needed).
// Requires: npm install --no-save embedded-postgres
// Connection: postgres://postgres:postgres@localhost:5433/npacct
import path from 'node:path';
import fs from 'node:fs';

const { default: EmbeddedPostgres } = await import('embedded-postgres').catch(() => {
  console.error('embedded-postgres is not installed. Run: npm install --no-save embedded-postgres');
  process.exit(1);
});

const dataDir = path.resolve('.dev-pgdata');
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 5433, persistent: true });
if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try { await pg.createDatabase('npacct'); } catch { /* already exists */ }
console.log('Dev PostgreSQL running at postgres://postgres:postgres@localhost:5433/npacct (Ctrl+C to stop)');
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
