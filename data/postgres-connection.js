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
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
  return {
    connectionString: parsed.toString(),
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true }
  };
}
