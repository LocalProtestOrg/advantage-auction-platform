// Isolated database for the full-stack environment: PGlite (in memory) with the full migration chain, served over the
// Postgres wire protocol so the real app connects with its normal `pg` driver. Prints `READY <port>` when listening.
//   node tests/fullstack/dbServer.mjs [port]
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { applyAll } from './schema.mjs';

const port = Number(process.argv[2] || 0) || 54329;
const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm } });
const applied = await applyAll(db);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
process.stdout.write(`READY ${port} ${applied.length}\n`);
const stop = async () => { try { await server.stop(); await db.close(); } catch (_) {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('disconnect', stop);
