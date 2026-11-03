import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import { postgresConnectionOptions } from '../data/postgres-connection.js';

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const invalidCaFile = process.env.INVALID_TEST_CA_FILE;

if (!databaseUrl || !invalidCaFile) {
  if (process.env.CI === 'true') throw new Error('CI must provide disposable TLS PostgreSQL test settings.');
  console.log('Skipped PostgreSQL TLS integration checks: disposable TEST_DATABASE_URL is not configured.');
  process.exit(0);
}

const parsed = new URL(databaseUrl);
const fixtureName = process.env.PG_TLS_TEST_FIXTURE || 'staging';
const fixtures = {
  staging: { host: 'localhost', wrongHost: '127.0.0.1', database: 'shweta_studio_test', user: 'postgres' },
  'docker-native': { host: '127.0.0.1', wrongHost: '127.0.0.2', database: 'shweta_native_app_test', user: 'shweta_native_app' }
};
const fixture = Object.hasOwn(fixtures, fixtureName) ? fixtures[fixtureName] : undefined;
if (process.env.CI !== 'true' || !fixture || !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== fixture.host || parsed.port !== '5433' ||
    parsed.pathname !== `/${fixture.database}` || parsed.username !== fixture.user ||
    parsed.search || parsed.hash) {
  throw new Error('Refusing TLS integration: use only the configured disposable loopback CI fixture.');
}

const baseOptions = postgresConnectionOptions(databaseUrl, { sslMode: 'require', production: true });
assert.equal(baseOptions.ssl.rejectUnauthorized, true, 'the valid connection must verify its certificate chain');
const tlsDisabledPool = new Pool({
  connectionString: databaseUrl,
  ssl: false,
  max: 1,
  connectionTimeoutMillis: 5000
});
try {
  await assert.rejects(tlsDisabledPool.query('SELECT 1'), /(?:no pg_hba\.conf entry|pg_hba\.conf rejects connection).*no encryption/i,
    'the disposable PostgreSQL host rejects a TLS-disabled connection');
} finally {
  await tlsDisabledPool.end();
}

const pool = new Pool({ ...baseOptions, max: 1, connectionTimeoutMillis: 5000 });
let trustedFingerprint;
try {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT current_database() AS database_name');
    assert.equal(result.rows[0].database_name, fixture.database);
    const tlsState = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    assert.equal(tlsState.rows[0].ssl, true, 'the accepted test connection negotiated TLS');
    const socket = client.connection.stream;
    assert.equal(socket.authorized, true, 'the accepted connection has a trusted certificate chain');
    const certificate = socket.getPeerCertificate();
    trustedFingerprint = certificate.fingerprint256;
    assert.ok(trustedFingerprint, 'the accepted connection must present a certificate');
    assert.equal(checkServerIdentity(fixture.host, certificate), undefined,
      'the trusted certificate must match the successful loopback identity');
    assert.equal(checkServerIdentity(fixture.wrongHost, certificate)?.code, 'ERR_TLS_CERT_ALTNAME_INVALID',
      'the trusted certificate must not match the deliberately incorrect loopback identity');
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

const wrongCa = await readFile(invalidCaFile, 'utf8');
const invalidCertificatePool = new Pool({
  ...baseOptions,
  ssl: { ...baseOptions.ssl, ca: wrongCa },
  max: 1,
  connectionTimeoutMillis: 5000
});
try {
  await assert.rejects(invalidCertificatePool.query('SELECT 1'), /certificate|issuer|self.signed|unable to verify/i,
    'a certificate signed by an untrusted CA must be rejected');
} finally {
  await invalidCertificatePool.end();
}

const wrongHostUrl = new URL(databaseUrl);
wrongHostUrl.hostname = fixture.wrongHost;
assert.notEqual(wrongHostUrl.hostname, parsed.hostname,
  'the mismatch test changes the actual TCP connection hostname');

// Prove the alternate loopback address reaches the same TLS peer and database.
// The chain is still verified, and identity is checked against the known-good
// fixture identity; the following rejection test uses the actual address.
const controlOptions = postgresConnectionOptions(wrongHostUrl.toString(), { sslMode: 'require', production: true });
const reachableWrongHostPool = new Pool({
  ...controlOptions,
  ssl: { ...controlOptions.ssl, checkServerIdentity: (_host, certificate) => checkServerIdentity(fixture.host, certificate) },
  max: 1,
  connectionTimeoutMillis: 5000
});
try {
  const client = await reachableWrongHostPool.connect();
  try {
    const result = await client.query(`SELECT current_database() AS database_name,
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`);
    assert.equal(result.rows[0].database_name, fixture.database);
    assert.equal(result.rows[0].ssl, true, 'alternate loopback address must negotiate TLS');
    assert.equal(client.connection.stream.authorized, true, 'alternate address must present a trusted chain');
    assert.equal(client.connection.stream.getPeerCertificate().fingerprint256, trustedFingerprint,
      'alternate loopback address must reach the same certificate');
  } finally {
    client.release();
  }
} finally {
  await reachableWrongHostPool.end();
}

const wrongHostPool = new Pool({
  ...postgresConnectionOptions(wrongHostUrl.toString(), { sslMode: 'require', production: true }),
  max: 1,
  connectionTimeoutMillis: 5000
});
try {
  await assert.rejects(wrongHostPool.query('SELECT 1'), error => {
    assert.equal(error.code, 'ERR_TLS_CERT_ALTNAME_INVALID', 'rejection must be caused by server identity mismatch');
    assert.equal(error.host, fixture.wrongHost, 'rejection must identify the deliberately incorrect loopback address');
    return true;
  });
} finally {
  await wrongHostPool.end();
}

console.log(`Disposable PostgreSQL TLS checks passed (${fixtureName}): trusted chain and identity accepted; alternate loopback reached the same TLS certificate; invalid CA, identity mismatch and plaintext rejected.`);
