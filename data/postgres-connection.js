// Render URLs can include sslmode=require. node-postgres parses that query
// parameter after the explicit ssl option, which can silently disable
// certificate verification. Strip URL-level TLS options and apply policy here.
export function postgresConnectionOptions(connectionString, {
  sslMode = process.env.PGSSLMODE || 'require',
  production = process.env.NODE_ENV === 'production'
} = {}) {
  if (!connectionString) throw new Error('A PostgreSQL connection URL is required.');
  if (production && sslMode === 'disable') {
    throw new Error('PostgreSQL TLS cannot be disabled in production.');
  }
  const parsed = new URL(connectionString);
  const channelBindingValues = parsed.searchParams.getAll('channel_binding').map(value => value.toLowerCase());
  if (channelBindingValues.length > 1 || channelBindingValues.some(value => !['require', 'prefer', 'disable'].includes(value))) {
    throw new Error('Unsupported or ambiguous PostgreSQL channel_binding connection parameter.');
  }
  const requestedChannelBinding = channelBindingValues[0];
  if (requestedChannelBinding === 'require') {
    // pg 8.23.1 prefers SCRAM-SHA-256-PLUS when enableChannelBinding is true,
    // but falls back to SCRAM-SHA-256 if the server does not offer PLUS. The
    // Neon URL parameter is mandatory policy, so do not silently downgrade.
    throw new Error('PostgreSQL channel_binding=require cannot be enforced by the installed node-postgres driver.');
  }
  parsed.searchParams.delete('channel_binding');
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
  // Render's private Postgres hostname is a bare `dpg-…` name. Its TLS
  // certificate is self-signed, so keep TLS encryption but skip chain
  // validation only for that private-network hostname. Public/external hosts
  // continue to require normal certificate verification.
  const isRenderInternalPostgres = /^dpg-[a-z0-9-]+$/i.test(parsed.hostname);
  return {
    connectionString: parsed.toString(),
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: !isRenderInternalPostgres },
    ...(requestedChannelBinding === 'prefer' ? { enableChannelBinding: true } : {})
  };
}
