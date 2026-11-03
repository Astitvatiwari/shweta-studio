import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith('_test') || process.env.CI !== 'true') {
  throw new Error('Refusing TLS integration: use only a loopback _test database in CI.');
}

const baseOptions = postgresConnectionOptions(databaseUrl, { sslMode: 'require', production: true });
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
try {
  const result = await pool.query('SELECT current_database() AS database_name');
  assert.equal(result.rows[0].database_name, parsed.pathname.slice(1));
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
  await assert.rejects(invalidCertificatePool.query('SELECT 1'), undefined,
    'a certificate signed by an untrusted CA must be rejected');
} finally {
  await invalidCertificatePool.end();
}

const wrongHostUrl = new URL(databaseUrl);
wrongHostUrl.hostname = parsed.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const wrongHostPool = new Pool({
  ...postgresConnectionOptions(wrongHostUrl.toString(), { sslMode: 'require', production: true }),
  max: 1,
  connectionTimeoutMillis: 5000
});
try {
  await assert.rejects(wrongHostPool.query('SELECT 1'), undefined,
    'a valid chain with a hostname mismatch must be rejected');
} finally {
  await wrongHostPool.end();
}

console.log('Disposable PostgreSQL TLS checks passed: trusted chain/hostname accepted; invalid CA and hostname rejected.');
