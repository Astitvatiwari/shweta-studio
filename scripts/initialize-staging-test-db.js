import pg from 'pg';
import { postgresConnectionOptions } from '../data/postgres-connection.js';
import {
  resolveStagingTestFixtureConfig,
  assertStagingTestDatabaseIsEmpty,
  STAGING_TEST_DATABASE_IDENTITY_KEY,
  STAGING_TEST_DATABASE_IDENTITY_SCHEMA,
  STAGING_TEST_DATABASE_IDENTITY_TABLE,
  STAGING_TEST_DATABASE_NAME,
  verifyStagingTestDatabaseRole
} from '../data/staging-test-fixture.js';

const { Pool } = pg;
const config = resolveStagingTestFixtureConfig();
if (!config.enabled) {
  throw new Error('Refusing to initialize a database without explicit staging-fixture gates.');
}

const pool = new Pool({
  ...postgresConnectionOptions(config.databaseUrl),
  max: 1,
  connectionTimeoutMillis: 10000
});

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT current_database() AS database_name, current_user AS database_user');
    if (rows[0]?.database_name !== STAGING_TEST_DATABASE_NAME || rows[0]?.database_user !== config.databaseUser) {
      throw new Error('Refusing to initialize: connected database identity does not match the dedicated fixture database.');
    }
    await verifyStagingTestDatabaseRole(client.query.bind(client), config.databaseUser);

    const markerAlreadyExists = await assertStagingTestDatabaseIsEmpty(client.query.bind(client));
    if (markerAlreadyExists) {
      const existingMarker = await client.query(
        `SELECT identity_value FROM ${STAGING_TEST_DATABASE_IDENTITY_SCHEMA}.${STAGING_TEST_DATABASE_IDENTITY_TABLE}
         WHERE identity_key = $1`,
        [STAGING_TEST_DATABASE_IDENTITY_KEY]
      );
      if (existingMarker.rowCount !== 1 || existingMarker.rows[0].identity_value !== config.identity) {
        throw new Error('Refusing to initialize: existing fixture identity marker is invalid or mismatched.');
      }
      await client.query('COMMIT');
      console.log('Dedicated staging test database identity is already initialized and verified.');
    } else {
      await client.query(`CREATE SCHEMA ${STAGING_TEST_DATABASE_IDENTITY_SCHEMA}`);
      await client.query(`CREATE TABLE ${STAGING_TEST_DATABASE_IDENTITY_SCHEMA}.${STAGING_TEST_DATABASE_IDENTITY_TABLE} (
        identity_key text PRIMARY KEY,
        identity_value text NOT NULL,
        initialized_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(
        `INSERT INTO ${STAGING_TEST_DATABASE_IDENTITY_SCHEMA}.${STAGING_TEST_DATABASE_IDENTITY_TABLE}
          (identity_key, identity_value) VALUES ($1, $2)`,
        [STAGING_TEST_DATABASE_IDENTITY_KEY, config.identity]
      );
      await client.query('COMMIT');
      console.log('Dedicated staging test database identity initialized and verified.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
