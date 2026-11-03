import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPostgresPool } from '../data/postgres-pool.js';

const require = createRequire(import.meta.url);
const { parse: parsePgConnectionString } = require('pg-connection-string');

const neonUrl =
  'postgresql://neon_app:synthetic@ep-phase6.us-east-2.aws.neon.tech/shweta?sslmode=require&channel_binding=require';
const neonEnv = {
  DATABASE_PROVIDER: 'neon',
  DATABASE_DRIVER: 'pg-native',
  NODE_ENV: 'test',
  PGSSLMODE: 'disable'
};
let jsPoolCreations = 0;
let nativePoolCreations = 0;
let nativeLoads = 0;
let lastNativeConfig;

class FakeJsPool {
  constructor(config) {
    jsPoolCreations++;
    this.config = config;
  }
}

class FakeNativePool {
  constructor(config) {
    nativePoolCreations++;
    lastNativeConfig = config;
  }
}

const fakePg = {
  Pool: FakeJsPool,
  get native() {
    nativeLoads++;
    return { Pool: FakeNativePool };
  }
};

const renderInternal = createPostgresPool(
  'postgres://render_user:synthetic@dpg-test-a:5432/shweta_test',
  { max: 4 },
  { env: { NODE_ENV: 'production', PGSSLMODE: 'require' }, pgModule: fakePg }
);
assert.ok(renderInternal instanceof FakeJsPool);
assert.equal(renderInternal.config.max, 4);
assert.equal(renderInternal.config.ssl.rejectUnauthorized, false,
  'the existing Render private-host certificate exception remains scoped to Render URLs');
assert.equal(nativeLoads, 0, 'default/Render pools must not load pg-native');

const disposableCiPool = createPostgresPool(
  'postgres://postgres:synthetic@localhost:5432/shweta_studio_test',
  {},
  { env: { NODE_ENV: 'test', PGSSLMODE: 'disable' }, pgModule: fakePg }
);
assert.ok(disposableCiPool instanceof FakeJsPool);
assert.equal(disposableCiPool.config.ssl, false,
  'the disposable CI configuration explicitly disables TLS only for its unencrypted test service');
assert.equal(nativeLoads, 0, 'disposable CI configuration keeps the JavaScript driver');

const renderExternal = createPostgresPool(
  'postgres://render_user:synthetic@dpg-test-a.singapore-postgres.render.com/shweta_test',
  {},
  { env: { DATABASE_PROVIDER: 'render', DATABASE_DRIVER: 'pg' }, pgModule: fakePg }
);
assert.ok(renderExternal instanceof FakeJsPool);
assert.equal(renderExternal.config.ssl.rejectUnauthorized, true,
  'Render external hosts retain certificate and hostname validation');
assert.equal(nativeLoads, 0, 'Render connections must not load pg-native');

assert.throws(
  () => createPostgresPool(neonUrl, {}, { env: { DATABASE_PROVIDER: 'neon' }, pgModule: fakePg }),
  /DATABASE_PROVIDER=neon and DATABASE_DRIVER=pg-native together/i,
  'Neon cannot silently use the JavaScript driver'
);
assert.throws(
  () => createPostgresPool(neonUrl, {}, { env: { DATABASE_DRIVER: 'pg-native' }, pgModule: fakePg }),
  /DATABASE_PROVIDER=neon and DATABASE_DRIVER=pg-native together/i,
  'pg-native cannot be enabled without explicit Neon provider selection'
);
assert.throws(
  () => createPostgresPool('postgres://user:pass@dpg-test-a/app?channel_binding=require', {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /hostname ends in \.neon\.tech/i,
  'the native adapter rejects Render and arbitrary hosts'
);
assert.throws(
  () => createPostgresPool(neonUrl.replace('&channel_binding=require', ''), {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /exactly one channel_binding=require/i,
  'Neon native mode requires a strict channel-binding parameter'
);
assert.throws(
  () => createPostgresPool(neonUrl.replace('channel_binding=require', 'channel_binding=prefer'), {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /exactly one channel_binding=require/i,
  'preferred channel binding is not accepted for Neon native mode'
);
assert.throws(
  () => createPostgresPool(neonUrl + '&channel_binding=require', {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /exactly one channel_binding=require/i,
  'duplicate channel-binding parameters are rejected'
);
assert.throws(
  () => createPostgresPool(neonUrl.replace('sslmode=require', 'sslmode=disable'), {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /weak, duplicate, or unknown sslmode/i,
  'disabled TLS is rejected before constructing the native pool'
);
assert.throws(
  () => createPostgresPool(neonUrl + '&hostaddr=192.0.2.10', {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /cannot override the URL host/i,
  'host address overrides cannot divert a Neon connection'
);
assert.throws(
  () => createPostgresPool(neonUrl + '&HOSTADDR=192.0.2.10', {}, {
    env: neonEnv, pgModule: fakePg
  }),
  /cannot override the URL host/i,
  'case-variant host address overrides cannot divert a Neon connection'
);
assert.equal(nativeLoads, 0, 'invalid Neon configuration must fail before native module loading');
assert.equal(nativePoolCreations, 0, 'invalid Neon configuration must not construct either pool');

const neonPool = createPostgresPool(neonUrl, {
  max: 3,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 25000
}, { env: neonEnv, pgModule: fakePg });
assert.ok(neonPool instanceof FakeNativePool);
assert.equal(nativeLoads, 1);
assert.equal(nativePoolCreations, 1);
assert.equal(jsPoolCreations, 3, 'the Neon connection must not fall back to node-postgres');
assert.equal(lastNativeConfig.max, 3);
assert.equal(lastNativeConfig.connectionTimeoutMillis, 8000);
assert.equal(lastNativeConfig.idleTimeoutMillis, 25000);
assert.equal(lastNativeConfig.nativeConnectionString.includes('sslmode=verify-full'), true,
  'Neon native policy enforces verified TLS regardless of inherited PGSSLMODE');
assert.notEqual(lastNativeConfig.connectionString, lastNativeConfig.nativeConnectionString,
  'the JS compatibility parser must not receive libpq-only sslrootcert=system');
const adapterParsedUrl = parsePgConnectionString(lastNativeConfig.connectionString);
assert.equal(adapterParsedUrl.sslmode, 'verify-full');
assert.equal(adapterParsedUrl.sslrootcert, undefined);
assert.throws(
  () => parsePgConnectionString(lastNativeConfig.nativeConnectionString),
  /ENOENT.*system/i,
  'the installed node-postgres URL parser treats sslrootcert=system as a local CA path'
);
const strictNeonUrl = new URL(lastNativeConfig.nativeConnectionString);
assert.equal(strictNeonUrl.hostname, 'ep-phase6.us-east-2.aws.neon.tech');
assert.equal(strictNeonUrl.searchParams.get('sslmode'), 'verify-full');
assert.equal(strictNeonUrl.searchParams.get('sslrootcert'), 'system');
assert.equal(strictNeonUrl.searchParams.get('channel_binding'), 'require');

createPostgresPool(
  `${neonUrl}&options=-c+search_path%3Dnative_test`,
  {},
  { env: neonEnv, pgModule: fakePg }
);
const optionsUrl = lastNativeConfig.nativeConnectionString;
assert.match(optionsUrl, /options=-c%20search_path%3Dnative_test/,
  'native libpq URI encodes spaces using RFC percent encoding');

const missingNativePg = {
  Pool: FakeJsPool,
  get native() {
    throw new Error('synthetic missing pg-native module');
  }
};
assert.throws(
  () => createPostgresPool(neonUrl, {}, { env: neonEnv, pgModule: missingNativePg }),
  /could not be loaded; refusing a JavaScript-driver fallback/i,
  'missing pg-native is a startup failure, never a fallback'
);

const nativeWithoutPool = { Pool: FakeJsPool, native: {} };
assert.throws(
  () => createPostgresPool(neonUrl, {}, { env: neonEnv, pgModule: nativeWithoutPool }),
  /Pool API is unavailable; refusing a JavaScript-driver fallback/i,
  'an incomplete native binding is a startup failure'
);

console.log('PostgreSQL pool selection, strict Neon configuration, Render preservation, and no-fallback checks passed.');
