import assert from 'node:assert/strict';
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';
import postgres from 'postgres';

const databaseUrl = process.env.PG_NATIVE_POC_DATABASE_URL;
const caFile = process.env.PG_NATIVE_POC_CA_FILE;
const wrongCaFile = process.env.PG_NATIVE_POC_WRONG_CA_FILE;
const testPassword = process.env.PG_NATIVE_POC_PASSWORD;
if (process.env.CI !== 'true' || !databaseUrl || !caFile || !wrongCaFile || !testPassword) {
  throw new Error('This disposable CI-only proof of concept requires CI=true and test-only TLS settings.');
}

function assertDisposableUrl(value) {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      (url.searchParams.has('hostaddr') && url.searchParams.get('hostaddr') !== '127.0.0.1') ||
      !url.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to connect outside a loopback _test database.');
  }
  return url;
}
const baseUrl = assertDisposableUrl(databaseUrl);
assert.throws(
  () => assertDisposableUrl('postgres://user:password@db.example.com/staging'),
  /loopback _test database/,
  'non-loopback non-test database URLs must be rejected before connecting'
);
assert.throws(
  () => assertDisposableUrl('postgres://user:password@localhost/staging'),
  /loopback _test database/,
  'loopback URLs to non-test databases must be rejected before connecting'
);
assert.throws(
  () => assertDisposableUrl('postgres://user:password@localhost/shweta_test?hostaddr=192.0.2.10'),
  /loopback _test database/,
  'hostaddr must not redirect a test connection away from loopback'
);
assert.equal(baseUrl.hostname, 'localhost', 'TLS identity must remain the DNS hostname');
baseUrl.searchParams.set('hostaddr', '127.0.0.1');

// Never silently fall back to the pure-JS pg driver in this proof of concept.
const Native = pg.native;
if (!Native?.Client || !Native?.Pool) {
  throw new Error('pg-native is required for this test; refusing a JavaScript-driver fallback.');
}
const { Client, Pool } = Native;

function connectionUrl({ host, password, sslmode = 'verify-full', rootCert = caFile } = {}) {
  const url = new URL(baseUrl);
  if (host) url.hostname = host;
  if (password) url.password = password;
  url.searchParams.set('sslmode', sslmode);
  url.searchParams.set('channel_binding', 'require');
  if (rootCert) url.searchParams.set('sslrootcert', rootCert);
  else url.searchParams.delete('sslrootcert');
  return url.toString();
}

function postgresJsConnectionUrl({ host, password, sslmode = 'verify-full', rootCert = caFile } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.delete('hostaddr');
  if (host) url.hostname = host;
  if (password) url.password = password;
  url.searchParams.set('sslmode', sslmode);
  url.searchParams.set('channel_binding', 'require');
  if (rootCert) url.searchParams.set('sslrootcert', rootCert);
  else url.searchParams.delete('sslrootcert');
  return url.toString();
}

async function expectConnectionFailure(url, pattern, label) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await assert.rejects(client.connect(), pattern, label);
  } finally {
    await client.end().catch(() => {});
  }
}

async function expectPostgresJsFailure(url, pattern, label) {
  const client = postgres(url, { max: 1, connect_timeout: 5 });
  try {
    await assert.rejects(client.unsafe('SELECT 1'), pattern, label);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function int32(value) {
  const result = Buffer.alloc(4);
  result.writeInt32BE(value);
  return result;
}

function protocolMessage(type, body) {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

async function startPlainScramOnlyServer({ key, cert }) {
  const tlsOptions = { key: await readFile(key), cert: await readFile(cert) };
  const secureContext = tls.createSecureContext(tlsOptions);
  let gotStartupOverTls = false;
  let offeredPlainScramOnly = false;
  let gotScramInitialResponse = false;

  const server = net.createServer(raw => {
    let initial = Buffer.alloc(0);
    const handleSslRequest = chunk => {
      initial = Buffer.concat([initial, chunk]);
      if (initial.length < 8) return;
      const sslRequestCode = initial.readInt32BE(4);
      raw.removeListener('data', handleSslRequest);
      if (sslRequestCode !== 80877103) {
        raw.destroy(new Error('Expected PostgreSQL SSLRequest.'));
        return;
      }

      raw.write('S');
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext });
      let buffer = Buffer.alloc(0);
      let awaitingStartup = true;
      let respondedWithPlainOnlySasl = false;
      secure.on('error', () => {});
      secure.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          if (awaitingStartup) {
            const length = buffer.readInt32BE(0);
            if (buffer.length < length) return;
            buffer = buffer.subarray(length);
            awaitingStartup = false;
            gotStartupOverTls = true;
            // Deliberately do not advertise SCRAM-SHA-256-PLUS.
            const saslBody = Buffer.concat([
              int32(10), Buffer.from('SCRAM-SHA-256\0\0', 'ascii')
            ]);
            secure.write(protocolMessage('R', saslBody));
            offeredPlainScramOnly = true;
            respondedWithPlainOnlySasl = true;
            continue;
          }

          if (buffer.length < 5) return;
          const messageLength = buffer.readInt32BE(1);
          if (buffer.length < messageLength + 1) return;
          const type = String.fromCharCode(buffer[0]);
          buffer = buffer.subarray(messageLength + 1);
          if (respondedWithPlainOnlySasl && type === 'p') {
            gotScramInitialResponse = true;
            const fields = Buffer.from('SERROR\0C08004\0Mplain SCRAM only in disposable POC\0\0', 'ascii');
            secure.write(protocolMessage('E', fields));
            return;
          }
        }
      });
    };
    raw.on('data', handleSslRequest);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: port => {
      const url = new URL(baseUrl);
      url.hostname = 'localhost';
      url.port = String(port ?? server.address().port);
      url.pathname = '/shweta_native_poc_test';
      url.username = 'poc_scram_user';
      url.password = testPassword;
      url.search = '';
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.set('sslrootcert', caFile);
      url.searchParams.set('channel_binding', 'require');
      return url.toString();
    },
    port,
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
    get gotStartupOverTls() { return gotStartupOverTls; },
    get offeredPlainScramOnly() { return offeredPlainScramOnly; },
    get gotScramInitialResponse() { return gotScramInitialResponse; }
  };
}

// Strict success against disposable PostgreSQL: a TLS+SCRAM connection can
// succeed under channel_binding=require only if libpq completed PLUS.
const pool = new Pool({ connectionString: connectionUrl(), max: 2, connectionTimeoutMillis: 5000 });
try {
  const checked = await pool.query(`SELECT current_database() AS database_name,
    (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls_enabled`);
  assert.equal(checked.rows[0].database_name, baseUrl.pathname.slice(1));
  assert.equal(checked.rows[0].tls_enabled, true, 'strict SCRAM connection must use TLS');

  // Exercise the Pool/Client operations used by the project store and migrator.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migrationSql = await readFile(new URL('../db/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
    await client.query(migrationSql);
    await client.query(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_initial_schema.sql']);
    await client.query(`INSERT INTO inventory (inventory_code, status, original_quantity, data)
      VALUES ($1, $2, $3, $4::jsonb)`, ['SS-NATIVE-POC-001', 'Available', 1, JSON.stringify({ synthetic: true })]);
    const selected = await client.query(
      'SELECT data FROM inventory WHERE inventory_code=$1 FOR UPDATE', ['SS-NATIVE-POC-001']
    );
    const rowData = typeof selected.rows[0].data === 'string'
      ? JSON.parse(selected.rows[0].data)
      : selected.rows[0].data;
    assert.deepEqual(rowData, { synthetic: true });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  console.log('pg-native strict PLUS pool, real migration SQL, parameterized query, row lock, rollback and TLS checks passed.');
} finally {
  await pool.end();
}

await expectConnectionFailure(
  connectionUrl({ password: 'wrong_synthetic_password' }),
  /password authentication failed/i,
  'incorrect credentials must fail'
);
await expectConnectionFailure(
  connectionUrl({ rootCert: wrongCaFile }),
  /certificate verify failed|self-signed certificate/i,
  'untrusted certificate authority must fail'
);
await expectConnectionFailure(
  connectionUrl({ host: '127.0.0.1' }),
  /certificate verify failed|does not match host name|hostname mismatch/i,
  'hostname mismatch must fail'
);
await expectConnectionFailure(
  connectionUrl({ sslmode: 'disable', rootCert: null }),
  /channel binding.*required.*SSL|SSL.*channel binding|no encryption|no pg_hba\.conf entry/i,
  'TLS-disabled connection must fail under channel_binding=require'
);
console.log('pg-native wrong-credential, invalid-CA, hostname-mismatch and TLS-disabled rejection checks passed.');

// Compare the newly released pure-JavaScript Postgres.js v4 driver. It has a
// different API from pg, but its documented channel_binding=require policy
// avoids native libpq dependencies.
// Unlike libpq, this driver uses Node's resolver. Keep the DNS hostname for TLS,
// but resolve localhost to the runner's IPv4-only loopback publication.
dns.setDefaultResultOrder('ipv4first');
const localhostAddresses = await dns.promises.lookup('localhost', { all: true });
assert.equal(localhostAddresses[0].address, '127.0.0.1',
  'Postgres.js localhost must resolve to the disposable IPv4 loopback listener');
const jsDriver = postgres(postgresJsConnectionUrl(), { max: 2, connect_timeout: 5 });
try {
  const [checked] = await jsDriver`SELECT current_database() AS database_name,
    (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls_enabled`;
  assert.equal(checked.database_name, baseUrl.pathname.slice(1));
  assert.equal(checked.tls_enabled, true, 'Postgres.js strict connection must use validated TLS');

  await jsDriver.begin(async tx => {
    await tx`CREATE TEMP TABLE pg_js_poc (id integer PRIMARY KEY, value text)`;
    await tx`INSERT INTO pg_js_poc VALUES (${1}, ${'synthetic'})`;
    const [row] = await tx`SELECT value FROM pg_js_poc WHERE id=${1} FOR UPDATE`;
    assert.equal(row.value, 'synthetic');
  });
  console.log('Postgres.js v4 strict PLUS pool, parameterized query, transaction and row-lock checks passed.');
} finally {
  await jsDriver.end({ timeout: 5 });
}
await expectPostgresJsFailure(
  postgresJsConnectionUrl({ password: 'wrong_synthetic_password' }),
  /password authentication failed/i,
  'Postgres.js incorrect credentials must fail'
);
await expectPostgresJsFailure(
  postgresJsConnectionUrl({ rootCert: wrongCaFile }),
  /SELF_SIGNED_CERT_IN_CHAIN|CERT_UNTRUSTED|certificate verify failed/i,
  'Postgres.js untrusted certificate authority must fail'
);
await expectPostgresJsFailure(
  postgresJsConnectionUrl({ host: '127.0.0.1' }),
  /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate|hostname mismatch/i,
  'Postgres.js hostname mismatch must fail'
);
await expectPostgresJsFailure(
  postgresJsConnectionUrl({ sslmode: 'disable', rootCert: null }),
  /CHANNEL_BINDING_REQUIRED|channel.?binding.*require/i,
  'Postgres.js TLS-disabled connection must fail under channel_binding=require'
);
console.log('Postgres.js v4 wrong-credential, invalid-CA, hostname-mismatch and TLS-disabled rejection checks passed.');

// Simulate a TLS-capable server that advertises plain SCRAM only. This is the
// downgrade test: strict libpq must reject before sending any SASL response.
const plainOnly = await startPlainScramOnlyServer({
  key: process.env.PG_NATIVE_POC_SERVER_KEY,
  cert: process.env.PG_NATIVE_POC_SERVER_CERT
});
try {
  await expectConnectionFailure(
    plainOnly.url(plainOnly.port),
    /channel.?binding.*(required|require|offer|support)|SCRAM-SHA-256-PLUS.*(offer|support)|(?:no|not).*SCRAM-SHA-256-PLUS/i,
    'plain-SCRAM-only server must be rejected'
  );
  assert.equal(plainOnly.gotStartupOverTls, true, 'plain-SCRAM test must reach authentication over validated TLS');
  assert.equal(plainOnly.offeredPlainScramOnly, true, 'test peer must advertise only ordinary SCRAM');
  assert.equal(plainOnly.gotScramInitialResponse, false,
    'libpq must refuse before sending a plain SCRAM response');
  console.log('pg-native rejected a TLS peer offering only plain SCRAM before sending authentication proof.');

  const jsDriver = postgres(plainOnly.url(plainOnly.port), { max: 1, connect_timeout: 5 });
  try {
    await assert.rejects(
      jsDriver.unsafe('SELECT 1'),
      error => /CHANNEL_BINDING_REQUIRED|channel.?binding.*require/i.test(error.message),
      'Postgres.js must reject a TLS peer offering only plain SCRAM'
    );
    assert.equal(plainOnly.gotScramInitialResponse, false,
      'Postgres.js must refuse before sending a plain SCRAM response');
    console.log('Postgres.js v4 rejected the plain-SCRAM-only server without sending authentication proof.');
  } finally {
    await jsDriver.end({ timeout: 5 });
  }
} finally {
  await plainOnly.close();
}
