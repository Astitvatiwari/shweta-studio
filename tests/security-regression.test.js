import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function unusedPort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

const port = await unusedPort();
const signingSecret = 'isolated-test-netlify-secret';
const adminSecret = 'isolated-test-admin-secret-32-bytes-min';
const databaseUrl = 'postgres://testuser:testpassword@127.0.0.1:1/not-a-real-database';
const child = spawn(process.execPath, ['--input-type=module', '-e',
  "import { startServer } from './server.js'; await startServer(); console.log('SECURITY_TEST_READY');"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production', STORAGE_BACKEND: 'postgres', DATABASE_URL: databaseUrl,
    PGSSLMODE: 'require', PORT: String(port), NETLIFY_PROXY_SIGNING_SECRET: signingSecret,
    ADMIN_API_KEY: adminSecret, STOREFRONT_ORIGINS: 'https://shwetastudio.com'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

try {
  const deadline = Date.now() + 10000;
  while (!output.includes('SECURITY_TEST_READY') && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production test server exited early: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(output.includes('SECURITY_TEST_READY'), 'isolated production-mode server started');

  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('strict-transport-security') || '', /max-age=31536000/);

  const privateFile = await fetch(`${base}/data/orders.json`);
  assert.equal(privateFile.status, 404, 'production API must not expose project files or JSON stores');
  assert.doesNotMatch(await privateFile.text(), /customer|email|address/i);

  const unsigned = await fetch(`${base}/api/orders`);
  assert.equal(unsigned.status, 403, 'direct unsigned access to production API is denied');

  const token = makeProxyToken(signingSecret);
  const unauthorizedAdmin = await fetch(`${base}/api/orders`, {
    headers: { 'x-nf-sign': token }
  });
  assert.equal(unauthorizedAdmin.status, 403, 'Netlify signature does not replace admin authorization');

  const validAdmin = await fetch(`${base}/api/orders`, {
    headers: { 'x-nf-sign': token, Authorization: `Bearer ${adminSecret}` }
  });
  assert.equal(validAdmin.status, 500, 'unavailable database returns a safe server error');
  const failure = await validAdmin.text();
  assert.match(failure, /Unable to process the request/);
  assert.doesNotMatch(failure, /testpassword|127\.0\.0\.1:1|ECONNREFUSED|stack|sql/i);

  const foreignOrigin = await fetch(`${base}/api/orders`, {
    headers: { 'x-nf-sign': token, Origin: 'https://attacker.example' }
  });
  assert.equal(foreignOrigin.status, 403, 'unapproved browser origins are rejected');

  const wrongContentType = await fetch(`${base}/api/checkout/cancel-order`, {
    method: 'POST', headers: { 'x-nf-sign': token, 'content-type': 'text/plain' }, body: '{}'
  });
  assert.equal(wrongContentType.status, 415, 'state-changing API requires JSON content type');

  console.log('Production security regression checks passed.');
} finally {
  child.kill('SIGTERM');
}

function makeProxyToken(secret) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iss: 'netlify', exp: Math.floor(Date.now() / 1000) + 60, site_url: 'https://shwetastudio.com' });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
