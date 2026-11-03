// Image entrypoint: no migrations and no credential output.
import pg from 'pg';
if (!pg.native?.Pool || !pg.native?.Client) throw new Error('Required native PostgreSQL dependencies are unavailable.');
let server;
let closeStore;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  try {
    if (server) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await closeStore?.();
    process.exitCode = code;
  } catch { process.exitCode = 1; }
  clearTimeout(deadline);
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
try {
  ({ closeStore } = await import('../data/inventory-store.js'));
  const { startServer } = await import('../server.js');
  server = await startServer();
  console.log('API startup verification complete.');
} catch {
  console.error('API startup verification failed.');
  await stop(1);
}
