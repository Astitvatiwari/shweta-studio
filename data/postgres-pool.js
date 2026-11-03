import pg from 'pg';
import { postgresConnectionOptions } from './postgres-connection.js';

const NEON_HOST_SUFFIX = '.neon.tech';

function nativeNeonConnectionString(connectionString) {
  if (!connectionString) throw new Error('A PostgreSQL connection URL is required.');

  let url;
  try {
    url = new URL(connectionString);
  } catch (cause) {
    throw new Error('The explicitly configured Neon PostgreSQL URL is invalid.', { cause });
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname.toLowerCase().endsWith(NEON_HOST_SUFFIX)) {
    throw new Error('pg-native is restricted to PostgreSQL URLs whose hostname ends in .neon.tech.');
  }
  const parameters = [...url.searchParams.entries()];
  if (parameters.some(([key]) => ['host', 'hostaddr'].includes(key.toLowerCase()))) {
    throw new Error('Neon native connections cannot override the URL host or host address.');
  }

  const channelBinding = parameters
    .filter(([key]) => key.toLowerCase() === 'channel_binding')
    .map(([, value]) => value);
  if (channelBinding.length !== 1 || channelBinding[0].toLowerCase() !== 'require') {
    throw new Error('Neon native connections require exactly one channel_binding=require parameter.');
  }

  const sslModes = parameters
    .filter(([key]) => key.toLowerCase() === 'sslmode')
    .map(([, value]) => value.toLowerCase());
  if (sslModes.length > 1 || sslModes.some(value =>
    !['require', 'verify-ca', 'verify-full'].includes(value))) {
    throw new Error('Neon native connections reject disabled, weak, duplicate, or unknown sslmode settings.');
  }

  // libpq 16+ supports sslrootcert=system. PostgreSQL documents that this
  // selects the platform trust store and forces verify-full.
  for (const key of [...url.searchParams.keys()]) {
    if (['sslmode', 'sslrootcert', 'channel_binding'].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', 'system');
  url.searchParams.set('channel_binding', 'require');
  // libpq URI query values use percent-encoding (space is %20). URLSearchParams
  // emits '+' for spaces, which is form encoding and is not portable in libpq.
  url.search = url.searchParams.toString().replace(/\+/g, '%20');
  return url.toString();
}

function nodePostgresNativeAdapterConnectionString(nativeConnectionString) {
  const url = new URL(nativeConnectionString);
  // pg-native still initializes node-postgres ConnectionParameters before
  // replacing this URL with nativeConnectionString. pg-connection-string
  // interprets sslrootcert as a local file and cannot parse libpq's special
  // sslrootcert=system value. Keep verification strict for that JS-side parse;
  // libpq receives the full URL separately below.
  url.searchParams.delete('sslrootcert');
  return url.toString();
}

function requestedDriver(env) {
  const provider = String(env.DATABASE_PROVIDER || '').trim().toLowerCase();
  const driver = String(env.DATABASE_DRIVER || '').trim().toLowerCase();

  if (!provider && !driver) return 'node-postgres';
  if (provider === 'render' && (!driver || driver === 'node-postgres' || driver === 'pg')) {
    return 'node-postgres';
  }
  if (provider === 'neon' && driver === 'pg-native') return 'pg-native';
  if (provider === 'neon' || driver === 'pg-native') {
    throw new Error('Neon requires DATABASE_PROVIDER=neon and DATABASE_DRIVER=pg-native together.');
  }
  throw new Error('Unsupported DATABASE_PROVIDER or DATABASE_DRIVER configuration.');
}

/**
 * Construct the shared node-postgres Pool API for the application.
 * pg-native is loaded only for an explicitly configured, strictly validated
 * Neon URL. Every other connection keeps the existing pg Pool policy.
 */
export function createPostgresPool(connectionString, poolOptions = {}, {
  env = process.env,
  pgModule = pg
} = {}) {
  const driver = requestedDriver(env);
  if (driver === 'node-postgres') {
    return new pgModule.Pool({
      ...poolOptions,
      ...postgresConnectionOptions(connectionString, {
        sslMode: env.PGSSLMODE || 'require',
        production: env.NODE_ENV === 'production' ||
          (env.NODE_ENV === undefined && process.env.NODE_ENV === 'production')
      })
    });
  }

  const nativeUrl = nativeNeonConnectionString(connectionString);
  let native;
  try {
    native = pgModule.native;
  } catch (cause) {
    throw new Error(
      'pg-native was explicitly requested for Neon but could not be loaded; refusing a JavaScript-driver fallback.',
      { cause }
    );
  }
  if (!native?.Pool) {
    throw new Error(
      'pg-native was explicitly requested for Neon but its Pool API is unavailable; refusing a JavaScript-driver fallback.'
    );
  }

  return new native.Pool({
    ...poolOptions,
    connectionString: nodePostgresNativeAdapterConnectionString(nativeUrl),
    nativeConnectionString: nativeUrl
  });
}
