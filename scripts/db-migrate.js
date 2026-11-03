import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../data/postgres-pool.js';
import {
  assertStagingTestDatabaseIsEmpty,
  resolveStagingTestFixtureConfig,
  verifyStagingTestDatabaseIdentity
} from '../data/staging-test-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../db/migrations');

const fixtureConfig = resolveStagingTestFixtureConfig(process.env, { purpose: 'migration' });
const migrationUrl = fixtureConfig.enabled
  ? fixtureConfig.databaseUrl
  : (process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL);
if (!migrationUrl) {
  console.error('MIGRATION_DATABASE_URL or DATABASE_URL is required to run database migrations.');
  process.exit(1);
}

const pool = createPostgresPool(migrationUrl, {
  max: 2,
  connectionTimeoutMillis: 10000
});

try {
  if (fixtureConfig.enabled) {
    await verifyStagingTestDatabaseIdentity(pool.query.bind(pool), fixtureConfig);
  }
  const files = (await fs.readdir(migrationsDir))
    .filter(file => /^\d+_[a-z0-9_-]+\.sql$/.test(file))
    .sort();

  const migrationTable = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
  const hasMigrationTable = Boolean(migrationTable.rows[0]?.name);
  let appliedVersions = [];
  if (hasMigrationTable) {
    const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    appliedVersions = applied.rows.map(row => row.version);
  }

  if (fixtureConfig.enabled) {
    // A fresh fixture database may contain only its identity marker. A prior
    // migration run must be complete; newer migrations require a separate
    // review rather than silently changing a disposable payment database.
    if (appliedVersions.some(version => !files.includes(version))) {
      throw new Error('Fixture database has migrations unknown to this build; refusing to continue.');
    }
    const fullyMigrated = files.length > 0 && files.every(file => appliedVersions.includes(file));
    if (appliedVersions.length && !fullyMigrated) {
      throw new Error('Fixture database has pending migrations; refusing automatic schema changes.');
    }
    if (fullyMigrated) {
      await verifyStagingTestDatabaseIdentity(pool.query.bind(pool), fixtureConfig, {
        requireFixtureOnlyData: true
      });
    } else {
      await assertStagingTestDatabaseIsEmpty(pool.query.bind(pool), {
        allowEmptyMigrationTable: hasMigrationTable
      });
    }
  }

  if (!hasMigrationTable) {
    await pool.query(`
      CREATE TABLE ${fixtureConfig.enabled ? '' : 'IF NOT EXISTS '}schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  if (fixtureConfig.twoRole) {
    const app = '"' + fixtureConfig.applicationUser.replaceAll('"', '""') + '"';
    await pool.query(`REVOKE ALL ON schema_migrations FROM ${app}; GRANT SELECT ON schema_migrations TO ${app}`);
  }

  for (const file of files) {
    const alreadyApplied = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1', [file]
    );
    if (alreadyApplied.rowCount) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} catch (error) {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
