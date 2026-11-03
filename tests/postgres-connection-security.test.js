import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { postgresConnectionOptions } from '../data/postgres-connection.js';

const require = createRequire(import.meta.url);
const installedPgVersion = require('pg/package.json').version;
const { startSession } = require('pg/lib/crypto/sasl');

assert.equal(installedPgVersion, '8.23.1', 'review connection policy when the locked pg driver changes');

const external = postgresConnectionOptions(
  'postgres://test:synthetic@db.example.test/app?sslmode=disable&channel_binding=disable',
  { sslMode: 'require', production: true }
);
assert.deepEqual(external.ssl, { rejectUnauthorized: true }, 'external connections retain certificate-chain and hostname verification');
assert.equal(new URL(external.connectionString).searchParams.has('sslmode'), false, 'URL TLS parameters cannot override the explicit TLS policy');
assert.equal(new URL(external.connectionString).searchParams.has('channel_binding'), false, 'driver-unsupported URL policy is never passed through');

const renderInternal = postgresConnectionOptions('postgres://test:synthetic@dpg-test-a:5432/app', {
  sslMode: 'require', production: true
});
assert.notEqual(renderInternal.ssl, false, 'Render private connections remain encrypted');
assert.equal(renderInternal.ssl.rejectUnauthorized, false, 'Render private self-signed certificate behavior remains scoped to internal hosts');

const renderExternal = postgresConnectionOptions('postgres://test:synthetic@dpg-test-a.singapore-postgres.render.com/app', {
  sslMode: 'require', production: true
});
assert.equal(renderExternal.ssl.rejectUnauthorized, true, 'Render external connections verify certificates and hostnames');

assert.throws(() => postgresConnectionOptions('postgres://test:synthetic@localhost/app', {
  sslMode: 'disable', production: true
}), /cannot be disabled in production/i, 'production connections reject TLS-disabled configuration');
assert.throws(() => postgresConnectionOptions('postgres://test:synthetic@db.example.test/app?channel_binding=require', {
  sslMode: 'require', production: true
}), /channel_binding=require cannot be enforced/i, 'mandatory channel binding fails closed before connecting');
assert.throws(() => postgresConnectionOptions('postgres://test:synthetic@db.example.test/app?channel_binding=unknown', {
  sslMode: 'require', production: true
}), /unsupported or ambiguous PostgreSQL channel_binding/i, 'unknown channel binding policy is rejected');
assert.throws(() => postgresConnectionOptions('postgres://test:synthetic@db.example.test/app?channel_binding=disable&channel_binding=require', {
  sslMode: 'require', production: true
}), /unsupported or ambiguous PostgreSQL channel_binding/i, 'duplicate policies cannot hide a mandatory requirement');
assert.throws(() => postgresConnectionOptions('postgres://test:synthetic@db.example.test/app?channel_binding=', {
  sslMode: 'require', production: true
}), /unsupported or ambiguous PostgreSQL channel_binding/i, 'empty channel binding policy is rejected');

const preferred = postgresConnectionOptions('postgres://test:synthetic@db.example.test/app?channel_binding=prefer', {
  sslMode: 'require', production: true
});
assert.equal(preferred.enableChannelBinding, true, 'prefer enables PLUS when offered but is not represented as mandatory');

// Verify the installed implementation rather than inferring behavior from the
// enableChannelBinding flag. It prefers PLUS, but selects plain SCRAM if that
// is the only mechanism the server advertises.
const tlsStream = { getPeerCertificate: () => ({ raw: Buffer.from('synthetic certificate') }) };
assert.equal(startSession(['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256'], tlsStream).mechanism,
  'SCRAM-SHA-256-PLUS', 'the client prefers channel-bound SCRAM when the server offers it');
assert.equal(startSession(['SCRAM-SHA-256'], tlsStream).mechanism,
  'SCRAM-SHA-256', 'the installed client silently falls back when the server omits PLUS');

console.log(`PostgreSQL connection security checks passed (pg ${installedPgVersion}; mandatory channel binding unsupported).`);
