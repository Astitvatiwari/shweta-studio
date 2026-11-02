/**
 * Synthetic checkout data for a separately configured staging test backend.
 * This module is server-only and is intentionally not imported by artworks.js
 * or the static-site compiler.
 */
export const STAGING_TEST_FIXTURE = Object.freeze({
  id: 'staging-checkout-fixture',
  inventoryCode: 'SS-STAGE-TEST-001',
  slug: 'staging-checkout-fixture',
  title: 'Synthetic Staging Checkout Fixture',
  category: 'Staging Test Fixture',
  medium: 'Synthetic test data',
  price: '₹100',
  availability: 'Available',
  images: [],
  cardImage: null,
  isStagingTestFixture: true,
  preparationTime: {
    duration: 'Test fixture',
    fullNotice: 'Synthetic staging data. Not an artwork and not for sale.',
    displayText: 'Staging test fixture',
    categoryPolicy: 'Test only'
  }
});

export const STAGING_TEST_DATABASE_NAME = 'shweta_studio_checkout_test';
export const STAGING_TEST_DATABASE_IDENTITY_SCHEMA = 'shweta_fixture_meta';
export const STAGING_TEST_DATABASE_IDENTITY_TABLE = 'database_identity';
export const STAGING_TEST_DATABASE_IDENTITY_KEY = 'checkout_fixture_database';

const fail = message => { throw new Error(`Staging checkout fixture configuration rejected: ${message}`); };

function parseDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('dedicated database URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    fail('dedicated database URL must use PostgreSQL.');
  }
  return {
    url,
    databaseName: decodeURIComponent(url.pathname.replace(/^\//, '')),
    databaseUser: decodeURIComponent(url.username)
  };
}

export function resolveStagingTestFixtureConfig(env = process.env) {
  const modeRequested = env.SHWETA_RUNTIME_MODE === 'staging-fixture';
  const fixtureRequested = env.SHWETA_STAGING_TEST_FIXTURE === 'enabled';
  if (!modeRequested && !fixtureRequested) return Object.freeze({ enabled: false });

  if (!modeRequested || !fixtureRequested) fail('both explicit staging-fixture gates are required.');
  if (env.NODE_ENV !== 'production') fail('the fixture backend must use the production server runtime.');
  if (env.STORAGE_BACKEND !== 'postgres') fail('the fixture backend must use PostgreSQL.');
  if (!/^rzp_test_[A-Za-z0-9]+$/.test(env.RAZORPAY_KEY_ID || '')) {
    fail('a Razorpay Test Mode key ID is required.');
  }
  if (!env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET) {
    fail('Razorpay Test Mode API and webhook secrets must be configured.');
  }
  if (!env.STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET ||
      env.STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET.length < 32 ||
      env.NETLIFY_PROXY_SIGNING_SECRET || env.NETLIFY_SITE_URL || env.STOREFRONT_ORIGINS) {
    fail('a separate test-site proxy secret is required; normal Netlify proxy settings must be absent.');
  }
  let testSiteUrl;
  try {
    testSiteUrl = new URL(env.STAGING_TEST_NETLIFY_SITE_URL);
  } catch {
    fail('a dedicated staging test-site URL is required.');
  }
  if (testSiteUrl.protocol !== 'https:' || !testSiteUrl.hostname.endsWith('.netlify.app') ||
      testSiteUrl.pathname !== '/' || testSiteUrl.search || testSiteUrl.hash) {
    fail('the fixture backend must be bound to a dedicated HTTPS Netlify staging test site.');
  }

  // Fixture mode must have its own URL. Normal staging/production URLs are
  // rejected instead of serving as fallbacks for this isolated backend.
  if (!env.STAGING_TEST_DATABASE_URL) fail('STAGING_TEST_DATABASE_URL is required; no fallback is allowed.');
  if (env.DATABASE_URL || env.MIGRATION_DATABASE_URL) {
    fail('DATABASE_URL and MIGRATION_DATABASE_URL must be absent from the fixture backend.');
  }
  const { url, databaseName, databaseUser } = parseDatabaseUrl(env.STAGING_TEST_DATABASE_URL);
  const expectedHost = String(env.STAGING_TEST_DATABASE_HOST || '').trim().toLowerCase();
  if (!expectedHost || !/^[a-z0-9.-]+$/.test(expectedHost) || url.hostname.toLowerCase() !== expectedHost) {
    fail('the dedicated database URL host does not match STAGING_TEST_DATABASE_HOST.');
  }
  if (databaseName !== STAGING_TEST_DATABASE_NAME) {
    fail('the PostgreSQL database name does not match the dedicated disposable fixture database.');
  }
  if (env.STAGING_TEST_DATABASE_NAME !== STAGING_TEST_DATABASE_NAME) {
    fail('STAGING_TEST_DATABASE_NAME must match the dedicated fixture database.');
  }
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(env.STAGING_TEST_DATABASE_USER || '') ||
      databaseUser !== env.STAGING_TEST_DATABASE_USER) {
    fail('the dedicated fixture database URL must use the configured fixture-only database user.');
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.STAGING_TEST_DATABASE_IDENTITY || '')) {
    fail('a dedicated database identity marker is required.');
  }

  return Object.freeze({
    enabled: true,
    databaseUrl: env.STAGING_TEST_DATABASE_URL,
    databaseName,
    databaseUser,
    expectedHost,
    identity: env.STAGING_TEST_DATABASE_IDENTITY,
    databaseHost: url.hostname,
    proxySecret: env.STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET,
    siteUrl: testSiteUrl.origin
  });
}

export function getRuntimeCatalog(artworks, fixtureConfig = resolveStagingTestFixtureConfig()) {
  return fixtureConfig.enabled ? [STAGING_TEST_FIXTURE] : artworks;
}

export function isStagingTestFixtureCode(code) {
  return String(code || '').trim().toUpperCase() === STAGING_TEST_FIXTURE.inventoryCode;
}

export function validateStagingTestFixtureCart(items, fixtureEnabled) {
  if (!Array.isArray(items)) return null;
  const fixtureItems = items.filter(item => isStagingTestFixtureCode(item?.inventoryCode));
  if (fixtureItems.length === 0) return null;
  if (!fixtureEnabled || items.length !== 1 || fixtureItems.length !== 1 ||
      fixtureItems[0].purchaseType !== 'original' || Number(fixtureItems[0].quantity ?? 1) !== 1) {
    return 'The synthetic staging item is available only as a single original in the isolated test checkout.';
  }
  return null;
}

/** Remove synthetic records from every normal public inventory listing. */
export function filterPublicInventory(inventory) {
  return Object.fromEntries(Object.entries(inventory || {}).filter(([code, item]) =>
    !isStagingTestFixtureCode(code) && item?.isStagingTestFixture !== true));
}

export async function verifyStagingTestDatabaseRole(query, expectedUser) {
  const role = await query(
    `SELECT current_user AS role_name, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
            r.rolreplication, r.rolbypassrls, r.rolinherit,
            EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_role_memberships
     FROM pg_roles r WHERE r.rolname = current_user`
  );
  const roleState = role.rows?.[0];
  if (roleState?.role_name !== expectedUser || !roleState.rolcanlogin || roleState.rolsuper ||
      roleState.rolcreatedb || roleState.rolcreaterole || roleState.rolreplication ||
      roleState.rolbypassrls || roleState.rolinherit || roleState.has_role_memberships) {
    fail('connected PostgreSQL role is missing or has privileges outside the fixture role policy.');
  }
  return true;
}

/**
 * Verify the server-selected database independently of the connection URL.
 * The identity row is created once by initialize-staging-test-db.js and is
 * never overwritten by application startup or migrations.
 */
export async function verifyStagingTestDatabaseIdentity(query, fixtureConfig, { requireFixtureOnlyData = false } = {}) {
  if (!fixtureConfig?.enabled) return true;
  try {
    const actual = await query('SELECT current_database() AS database_name, current_user AS database_user');
    if (actual.rows?.[0]?.database_name !== STAGING_TEST_DATABASE_NAME ||
        actual.rows?.[0]?.database_user !== fixtureConfig.databaseUser) {
      fail('connected PostgreSQL database identity does not match the dedicated fixture database.');
    }
    await verifyStagingTestDatabaseRole(query, fixtureConfig.databaseUser);
    const marker = await query(
      `SELECT identity_value FROM ${STAGING_TEST_DATABASE_IDENTITY_SCHEMA}.${STAGING_TEST_DATABASE_IDENTITY_TABLE}
       WHERE identity_key = $1`,
      [STAGING_TEST_DATABASE_IDENTITY_KEY]
    );
    if (marker.rowCount !== 1 || marker.rows[0].identity_value !== fixtureConfig.identity) {
      fail('connected PostgreSQL database does not contain the expected fixture identity marker.');
    }
    if (requireFixtureOnlyData) {
      const otherInventory = await query(
        'SELECT count(*)::int AS count FROM inventory WHERE inventory_code <> $1',
        [STAGING_TEST_FIXTURE.inventoryCode]
      );
      const otherItems = await query(
        'SELECT count(*)::int AS count FROM order_items WHERE inventory_code <> $1',
        [STAGING_TEST_FIXTURE.inventoryCode]
      );
      const otherOrders = await query(
        `SELECT count(*)::int AS count FROM orders o
         WHERE NOT EXISTS (
           SELECT 1 FROM order_items oi
           WHERE oi.order_id = o.order_id AND oi.inventory_code = $1
         )`,
        [STAGING_TEST_FIXTURE.inventoryCode]
      );
      const otherPaymentEvents = await query(
        `SELECT count(*)::int AS count FROM payment_events pe
         WHERE pe.order_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM order_items oi
           WHERE oi.order_id = pe.order_id AND oi.inventory_code = $1
         )`,
        [STAGING_TEST_FIXTURE.inventoryCode]
      );
      if (otherInventory.rows?.[0]?.count !== 0 || otherItems.rows?.[0]?.count !== 0 ||
          otherOrders.rows?.[0]?.count !== 0 || otherPaymentEvents.rows?.[0]?.count !== 0) {
        fail('dedicated fixture database contains non-fixture inventory, orders, or payment events.');
      }
    }
    return true;
  } catch (error) {
    if (error?.message?.startsWith('Staging checkout fixture configuration rejected:')) throw error;
    fail('database identity could not be independently verified.');
  }
}

/**
 * Refuse to establish a fixture identity on a database that already contains
 * application objects. The only allowed non-system object is our exact marker
 * table from a prior successful initialization.
 */
export async function assertStagingTestDatabaseIsEmpty(query, { allowEmptyMigrationTable = false } = {}) {
  const schemas = await query(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('public', 'information_schema', $1)
       AND left(nspname, 3) <> 'pg_'
     LIMIT 1`,
    [STAGING_TEST_DATABASE_IDENTITY_SCHEMA]
  );
  if (schemas.rowCount) fail('database contains an unexpected non-system schema.');

  const unexpectedRelations = await query(
    `SELECT n.nspname, c.relname, c.relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('information_schema', $1)
       AND left(n.nspname, 3) <> 'pg_'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT (n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r')
       AND NOT ($3::boolean AND n.nspname = 'public' AND c.relname = 'schema_migrations' AND c.relkind = 'r')
     LIMIT 1`,
    [STAGING_TEST_DATABASE_IDENTITY_SCHEMA, STAGING_TEST_DATABASE_IDENTITY_TABLE, allowEmptyMigrationTable]
  );
  if (unexpectedRelations.rowCount) fail('database already contains application tables or other relations.');

  const markerSchema = await query(
    'SELECT to_regclass($1) AS marker_table',
    [`${STAGING_TEST_DATABASE_IDENTITY_SCHEMA}.${STAGING_TEST_DATABASE_IDENTITY_TABLE}`]
  );
  const schemaExists = await query(
    'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists',
    [STAGING_TEST_DATABASE_IDENTITY_SCHEMA]
  );
  if (schemaExists.rows?.[0]?.schema_exists && !markerSchema.rows?.[0]?.marker_table) {
    fail('database contains an incomplete fixture identity schema.');
  }
  return Boolean(markerSchema.rows?.[0]?.marker_table);
}
