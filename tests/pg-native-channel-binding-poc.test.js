import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';
import postgres from 'postgres';

const suite = process.env.PG_NATIVE_POC_SUITE || 'all';
if (!['all', 'pg-native', 'postgres-js'].includes(suite)) {
  throw new Error(`Unsupported PG_NATIVE_POC_SUITE: ${suite}`);
}
const databaseUrl = process.env.PG_NATIVE_POC_DATABASE_URL;
const caFile = process.env.PG_NATIVE_POC_CA_FILE;
const wrongCaFile = process.env.PG_NATIVE_POC_WRONG_CA_FILE;
const testPassword = process.env.PG_NATIVE_POC_PASSWORD;
if (process.env.CI !== 'true' || !databaseUrl || !caFile || !wrongCaFile || !testPassword) {
  throw new Error('This disposable CI-only proof of concept requires CI=true and test-only TLS settings.');
}

function assertDisposableUrl(value) {
  const url = new URL(value);
  const loopbackIpv4 = net.isIPv4(url.hostname) && url.hostname.split('.')[0] === '127';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !loopbackIpv4 || url.searchParams.has('hostaddr') ||
      !url.pathname.slice(1).endsWith('_test')) {
    throw new Error('Refusing to connect outside a loopback _test database.');
  }
  return url;
}
const baseUrl = assertDisposableUrl(databaseUrl);
assert.throws(
  () => assertDisposableUrl('postgres://user:password@db.example.com/shweta_test'),
  /loopback _test database/,
  'non-loopback database URLs must be rejected before connecting'
);
assert.throws(
  () => assertDisposableUrl('postgres://user:password@127.0.0.1/staging'),
  /loopback _test database/,
  'loopback URLs to non-test databases must be rejected before connecting'
);
assert.throws(
  () => assertDisposableUrl('postgres://user:password@127.0.0.1/shweta_test?hostaddr=192.0.2.10'),
  /loopback _test database/,
  'hostaddr overrides are forbidden in this test harness'
);
assert.equal(baseUrl.hostname, '127.0.0.1', 'test connections must use the published IPv4 loopback address');
assert.equal(baseUrl.port, '5433', 'test connections must use the disposable published port');
assert.equal(baseUrl.searchParams.get('sslmode'), 'verify-full', 'test connections must verify TLS identity');
assert.equal(baseUrl.searchParams.get('channel_binding'), 'require',
  'test connections must require SCRAM channel binding');
assert.equal(baseUrl.searchParams.has('hostaddr'), false,
  'the adapter must not override the explicit IPv4 loopback host');
assert.equal(assertDisposableUrl('postgres://user:password@127.0.0.2/shweta_test').hostname, '127.0.0.2',
  'the alternate wrong-identity test endpoint must also be loopback-only');

// Never silently fall back to the pure-JS pg driver in the native suite.
const Native = suite === 'postgres-js' ? null : pg.native;
if (suite !== 'postgres-js' && (!Native?.Client || !Native?.Pool)) {
  throw new Error('pg-native is required for this test; refusing a JavaScript-driver fallback.');
}
const { Client, Pool } = Native || {};

function connectionUrl({ host, password, sslmode = 'verify-full', rootCert = caFile } = {}) {
  const url = new URL(baseUrl);
  if (host) url.hostname = host;
  if (password) url.password = password;
  url.searchParams.set('sslmode', sslmode);
  url.searchParams.set('channel_binding', 'require');
  url.searchParams.set('connect_timeout', '5');
  if (rootCert) url.searchParams.set('sslrootcert', rootCert);
  else url.searchParams.delete('sslrootcert');
  return assertDisposableUrl(url.toString()).toString();
}

function postgresJsConnectionUrl({ host, password, sslmode = 'verify-full' } = {}) {
  const url = new URL(baseUrl);
  if (host) url.hostname = host;
  if (password) url.password = password;
  url.searchParams.set('sslmode', sslmode);
  url.searchParams.set('channel_binding', 'require');
  // postgres.js v4 does not load libpq's sslrootcert URL parameter. Its
  // supported API accepts Node tls.connect options through the ssl option.
  url.searchParams.delete('sslrootcert');
  return assertDisposableUrl(url.toString()).toString();
}

function postgresJsOptions({ rootCert = caFile, tlsEnabled = true, max = 2 } = {}) {
  return {
    max,
    connect_timeout: 5,
    ssl: tlsEnabled ? { ca: readFileSync(rootCert), rejectUnauthorized: true } : false
  };
}

function nativeClientConfig(url, overrides = {}) {
  // pg's native adapter reconstructs a libpq connection string from selected
  // fields; nativeConnectionString preserves channel_binding=require verbatim.
  return { connectionString: url, nativeConnectionString: url, ...overrides };
}

async function assertTcpLoopbackReachable(host, port, label) {
  const socket = net.createConnection({ host, port });
  try {
    await new Promise((resolve, reject) => {
      socket.setTimeout(3000, () => reject(new Error(`${label}: TCP probe timed out`)));
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  } finally {
    socket.destroy();
  }
}

async function expectConnectionFailure(url, pattern, label) {
  const client = new Client(nativeClientConfig(url, { connectionTimeoutMillis: 5000 }));
  let rejection;
  try {
    await assert.rejects(client.connect(), error => {
      rejection = error;
      return pattern.test(error.message);
    }, label);
  } finally {
    await client.end().catch(() => {});
  }
  return rejection;
}

async function expectPostgresJsFailure(url, pattern, label, options = postgresJsOptions({ max: 1 })) {
  const client = postgres(url, options);
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
  let advertisedMechanisms = [];
  let negotiatedTlsProtocol = null;
  let negotiatedTlsCipher = null;

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
            negotiatedTlsProtocol = secure.getProtocol();
            negotiatedTlsCipher = secure.getCipher()?.name;
            // Deliberately do not advertise SCRAM-SHA-256-PLUS.
            advertisedMechanisms = ['SCRAM-SHA-256'];
            const saslBody = Buffer.concat([
              int32(10), Buffer.from(`${advertisedMechanisms[0]}\0\0`, 'ascii')
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
      url.hostname = '127.0.0.1';
      url.port = String(port ?? server.address().port);
      url.pathname = '/shweta_native_poc_test';
      url.username = 'poc_scram_user';
      url.password = testPassword;
      url.search = '';
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.set('sslrootcert', caFile);
      url.searchParams.set('channel_binding', 'require');
      url.searchParams.set('connect_timeout', '5');
      return assertDisposableUrl(url.toString()).toString();
    },
    port,
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
    get gotStartupOverTls() { return gotStartupOverTls; },
    get offeredPlainScramOnly() { return offeredPlainScramOnly; },
    get gotScramInitialResponse() { return gotScramInitialResponse; },
    get advertisedMechanisms() { return advertisedMechanisms; },
    get negotiatedTlsProtocol() { return negotiatedTlsProtocol; },
    get negotiatedTlsCipher() { return negotiatedTlsCipher; }
  };
}

if (suite !== 'postgres-js') {
// Strict success against disposable PostgreSQL: a TLS+SCRAM connection can
// succeed under channel_binding=require only if libpq completed PLUS.
const pool = new Pool(nativeClientConfig(connectionUrl(), { max: 2, connectionTimeoutMillis: 5000 }));
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
await assertTcpLoopbackReachable('127.0.0.2', Number(baseUrl.port),
  'native wrong-identity endpoint must be listening before TLS verification');
await expectConnectionFailure(
  connectionUrl({ host: '127.0.0.2' }),
  /certificate verify failed|does not match host name|hostname mismatch/i,
  'incorrect IP identity must fail certificate verification'
);
await expectConnectionFailure(
  connectionUrl({ sslmode: 'disable', rootCert: null }),
  /channel binding.*required.*SSL|SSL.*channel binding|no encryption|no pg_hba\.conf entry/i,
  'TLS-disabled connection must fail under channel_binding=require'
);
console.log('pg-native wrong-credential, invalid-CA, hostname-mismatch and TLS-disabled rejection checks passed.');

// Mandatory downgrade rejection runs before the optional pure-JavaScript
// compatibility suite. TLS and reachability are proven independently.
const plainOnly = await startPlainScramOnlyServer({
  key: process.env.PG_NATIVE_POC_SERVER_KEY,
  cert: process.env.PG_NATIVE_POC_SERVER_CERT
});
try {
  await assertTcpLoopbackReachable('127.0.0.1', plainOnly.port,
    'pg-native plain-SCRAM downgrade server must be reachable before TLS');
  const downgradeUrl = plainOnly.url(plainOnly.port);
  assert.equal(new URL(downgradeUrl).searchParams.get('channel_binding'), 'require',
    'pg-native downgrade client must explicitly require channel binding');
  const error = await expectConnectionFailure(
    downgradeUrl,
    /channel.?binding.*(required|require|not available|not offered|support)|SCRAM-SHA-256-PLUS.*(not offered|not supported|unavailable)|(?:no|not).*SCRAM-SHA-256-PLUS/i,
    'plain-SCRAM-only server must be rejected specifically for missing channel binding'
  );
  assert.equal(plainOnly.gotStartupOverTls, true,
    'plain-SCRAM test must complete TLS and receive PostgreSQL StartupMessage before authentication');
  assert.equal(plainOnly.offeredPlainScramOnly, true, 'test peer must advertise ordinary SCRAM');
  assert.deepEqual(plainOnly.advertisedMechanisms, ['SCRAM-SHA-256'],
    'test peer must advertise ordinary SCRAM without SCRAM-SHA-256-PLUS');
  assert.ok(plainOnly.negotiatedTlsProtocol?.startsWith('TLSv'),
    'test peer must record a successfully negotiated TLS protocol');
  assert.ok(plainOnly.negotiatedTlsCipher,
    'test peer must record a successfully negotiated TLS cipher');
  assert.match(error.message, /channel.?binding|SCRAM-SHA-256-PLUS/i,
    'failure must identify unavailable channel binding rather than DNS, TLS, TCP or timeout');
  assert.equal(plainOnly.gotScramInitialResponse, false,
    'libpq must refuse before sending a plain SCRAM response');
  console.log(`pg-native channel_binding=require rejected plain SCRAM after ${plainOnly.negotiatedTlsProtocol} negotiation (${plainOnly.negotiatedTlsCipher}); no plain-SCRAM proof was sent.`);
} finally {
  await plainOnly.close();
}
}

if (suite !== 'pg-native') {
// Compare the newly released pure-JavaScript Postgres.js v4 driver. It has a
// different API from pg, but its documented channel_binding=require policy
// avoids native libpq dependencies.
// Postgres.js is tested independently with its own URL and TLS/IP identity.
assert.equal(new URL(postgresJsConnectionUrl()).hostname, '127.0.0.1',
  'Postgres.js must connect directly to the disposable IPv4 loopback listener');
const jsDriver = postgres(postgresJsConnectionUrl(), postgresJsOptions());
try {
  assert.equal(jsDriver.options.channel_binding, 'require',
    'Postgres.js must retain channel_binding=require from the connection URL');
  assert.equal(jsDriver.options.ssl.rejectUnauthorized, true,
    'Postgres.js must require trusted certificates');
  assert.deepEqual(jsDriver.options.ssl.ca, readFileSync(caFile),
    'Postgres.js must receive the disposable CA as a Node TLS ca buffer');
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
  postgresJsConnectionUrl(),
  /SELF_SIGNED_CERT_IN_CHAIN|CERT_UNTRUSTED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate verify failed/i,
  'Postgres.js untrusted certificate authority must fail',
  postgresJsOptions({ rootCert: wrongCaFile, max: 1 })
);
await assertTcpLoopbackReachable('127.0.0.2', Number(baseUrl.port),
  'Postgres.js wrong-identity endpoint must be listening before TLS verification');
await expectPostgresJsFailure(
  postgresJsConnectionUrl({ host: '127.0.0.2' }),
  /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate|hostname mismatch/i,
  'Postgres.js incorrect IP identity must fail certificate verification'
);
await expectPostgresJsFailure(
  postgresJsConnectionUrl({ sslmode: 'disable' }),
  /CHANNEL_BINDING_REQUIRED|channel.?binding.*require|no pg_hba\.conf entry|no encryption/i,
  'Postgres.js TLS-disabled connection must fail under channel_binding=require',
  postgresJsOptions({ tlsEnabled: false, max: 1 })
);
console.log('Postgres.js v4 wrong-credential, invalid-CA, hostname-mismatch and TLS-disabled rejection checks passed.');

// Optional compatibility comparison against the same TLS-protected downgrade peer.
const plainOnly = await startPlainScramOnlyServer({
  key: process.env.PG_NATIVE_POC_SERVER_KEY,
  cert: process.env.PG_NATIVE_POC_SERVER_CERT
});
try {
  await assertTcpLoopbackReachable('127.0.0.1', plainOnly.port,
    'Postgres.js plain-SCRAM downgrade server must be reachable before TLS');
  const downgradeUrl = plainOnly.url(plainOnly.port);
  assert.equal(new URL(downgradeUrl).searchParams.get('channel_binding'), 'require',
    'Postgres.js downgrade client must explicitly require channel binding');
  const jsDriver = postgres(downgradeUrl, postgresJsOptions({ max: 1 }));
  try {
    await assert.rejects(
      jsDriver.unsafe('SELECT 1'),
      error => /CHANNEL_BINDING_REQUIRED|channel.?binding.*require/i.test(error.message),
      'Postgres.js must reject a TLS peer offering only plain SCRAM'
    );
    assert.equal(plainOnly.gotStartupOverTls, true,
      'Postgres.js downgrade test must complete TLS before authentication');
    assert.deepEqual(plainOnly.advertisedMechanisms, ['SCRAM-SHA-256'],
      'Postgres.js downgrade peer must advertise only ordinary SCRAM');
    assert.ok(plainOnly.negotiatedTlsProtocol?.startsWith('TLSv'),
      'Postgres.js downgrade peer must record negotiated TLS');
    assert.ok(plainOnly.negotiatedTlsCipher,
      'Postgres.js downgrade peer must record the negotiated TLS cipher');
    assert.equal(plainOnly.gotScramInitialResponse, false,
      'Postgres.js must refuse before sending a plain SCRAM response');
    console.log('Postgres.js v4 rejected the plain-SCRAM-only server without sending authentication proof.');
  } finally {
    await jsDriver.end({ timeout: 5 });
  }
} finally {
  await plainOnly.close();
}
}
