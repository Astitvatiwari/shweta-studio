import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { postgresConnectionOptions } from '../data/postgres-connection.js';
import { createPostgresPool } from '../data/postgres-pool.js';
import { resolveStagingTestFixtureConfig, verifyStagingTestDatabaseIdentity } from '../data/staging-test-fixture.js';
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) { if (process.env.CI) throw Error('Disposable database required'); console.log('SKIP two-role integration: no disposable database'); process.exit(0); }
const u = new URL(adminUrl);
assert.ok(['localhost','127.0.0.1'].includes(u.hostname) && u.pathname.endsWith('_test') && process.env.CI === 'true');
const db = 'shweta_studio_checkout_test', app = 'shweta_two_app', mig = 'shweta_two_migration';
const pw = randomBytes(24).toString('hex'), marker = randomBytes(24).toString('hex');
const admin = new pg.Pool({...postgresConnectionOptions(adminUrl,{production:true}),max:1});
let provision, appPool, migrationPool, createdDb=false;
const createdRoles=[];
const native = process.env.PG_NATIVE_ADAPTER_CI === 'true';
const roleUrl = role => { const url=new URL(u);url.pathname='/'+db;url.username=role;url.password=pw;if(native){url.hostname='phase6-main.neon.tech';url.searchParams.set('channel_binding','require');}return url.toString(); };
const env={...process.env,NODE_ENV:'production',STORAGE_BACKEND:'postgres',SHWETA_RUNTIME_MODE:'staging-fixture',SHWETA_STAGING_TEST_FIXTURE:'enabled',STAGING_TEST_ROLE_MODE:'separate',STAGING_TEST_DATABASE_URL:roleUrl(app),STAGING_TEST_DATABASE_HOST:native?'phase6-main.neon.tech':u.hostname,STAGING_TEST_DATABASE_NAME:db,STAGING_TEST_DATABASE_USER:app,STAGING_TEST_MIGRATION_USER:mig,STAGING_TEST_DATABASE_IDENTITY:marker,STAGING_TEST_NETLIFY_SITE_URL:'https://fixture-only.netlify.app',STAGING_TEST_NETLIFY_PROXY_SIGNING_SECRET:randomBytes(32).toString('hex'),RAZORPAY_KEY_ID:'rzp_test_fixture',RAZORPAY_KEY_SECRET:'synthetic-only',RAZORPAY_WEBHOOK_SECRET:'synthetic-only'};
for(const k of ['DATABASE_URL','MIGRATION_DATABASE_URL','STAGING_TEST_MIGRATION_URL','NETLIFY_SITE_URL','NETLIFY_PROXY_SIGNING_SECRET','STOREFRONT_ORIGINS']) delete env[k];
const migrationEnv={...env,STAGING_TEST_MIGRATION_URL:roleUrl(mig)};
const run = (script,e=env) => spawnSync(process.execPath,[script],{env:e,encoding:'utf8',timeout:30000});
try {
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[db])).rowCount,0);
  for(const role of [app,mig]) { await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);createdRoles.push(role); }
  await admin.query(`CREATE DATABASE ${db}`);createdDb=true;
  const target=new URL(u);target.pathname='/'+db;
  provision=new pg.Pool({...postgresConnectionOptions(target.toString(),{production:true}),max:1});
  await provision.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO ${app},${mig}; REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO ${mig}; GRANT USAGE ON SCHEMA public TO ${app}; CREATE SCHEMA shweta_fixture_meta; CREATE TABLE shweta_fixture_meta.database_identity(identity_key text PRIMARY KEY,identity_value text NOT NULL); GRANT USAGE ON SCHEMA shweta_fixture_meta TO ${app},${mig}; GRANT SELECT ON shweta_fixture_meta.database_identity TO ${app},${mig}; ALTER ROLE ${app} IN DATABASE ${db} SET search_path=public; ALTER ROLE ${mig} IN DATABASE ${db} SET search_path=public`);
  await provision.query('INSERT INTO shweta_fixture_meta.database_identity VALUES ($1,$2)',['checkout_fixture_database',marker]);
  // Grants belong to the object creator. PUBLIC receives no application rights.
  await provision.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${mig} IN SCHEMA public GRANT SELECT,INSERT,UPDATE ON TABLES TO ${app}; ALTER DEFAULT PRIVILEGES FOR ROLE ${mig} IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${app}`);
  const config=resolveStagingTestFixtureConfig(env);
  assert.throws(()=>resolveStagingTestFixtureConfig(env,{purpose:'migration'}),/migration credentials/);
  assert.throws(()=>resolveStagingTestFixtureConfig(migrationEnv),/absent at runtime/);
  assert.throws(()=>resolveStagingTestFixtureConfig({...migrationEnv,STAGING_TEST_MIGRATION_URL:roleUrl(app)},{purpose:'migration'}),/same approved/);
  assert.throws(()=>resolveStagingTestFixtureConfig({...env,STAGING_TEST_DATABASE_NAME:'other_test'}),/dedicated fixture/);
  migrationPool=createPostgresPool(roleUrl(mig),{max:1},{env});
  appPool=createPostgresPool(roleUrl(app),{max:1},{env});
  await verifyStagingTestDatabaseIdentity(appPool.query.bind(appPool),config);
  const init=run('scripts/initialize-staging-test-db.js',migrationEnv);assert.equal(init.status,0,init.stderr);
  const migration=run('scripts/db-migrate.js',migrationEnv);assert.equal(migration.status,0,migration.stderr);
  await verifyStagingTestDatabaseIdentity(appPool.query.bind(appPool),config,{requireFixtureOnlyData:true});
  await assert.rejects(verifyStagingTestDatabaseIdentity(appPool.query.bind(appPool),{...config,identity:'wrong'}),/marker/);
  for(const sql of ['CREATE TABLE public.forbidden(id int)','CREATE SCHEMA forbidden','CREATE DATABASE forbidden_test','CREATE ROLE forbidden','ALTER ROLE shweta_two_app CREATEDB','SET ROLE shweta_two_migration','ALTER TABLE inventory ADD COLUMN forbidden int','UPDATE shweta_fixture_meta.database_identity SET identity_value=\'wrong\'']) {
    await assert.rejects(appPool.query(sql),e=>e.code==='42501',sql);
  }
  await assert.rejects(appPool.query("UPDATE schema_migrations SET version='forbidden'"),e=>e.code==='42501');
  await migrationPool.query('CREATE TABLE public.future_object(id integer PRIMARY KEY, value text)');
  await appPool.query("INSERT INTO future_object VALUES (1,'before')");
  await appPool.query("UPDATE future_object SET value='after' WHERE id=1");
  assert.equal((await appPool.query('SELECT value FROM future_object')).rows[0].value,'after');
  await assert.rejects(appPool.query('DELETE FROM future_object'),e=>e.code==='42501');
  await migrationPool.query('DROP TABLE future_object');
  await migrationPool.query('BEGIN');await migrationPool.query('CREATE TABLE rollback_probe(id int)');
  await assert.rejects(migrationPool.query('SELECT undefined_migration_function()'));await migrationPool.query('ROLLBACK');
  assert.equal((await migrationPool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name,null);
  const wrongDatabase=new URL(roleUrl(app));wrongDatabase.pathname='/postgres';
  const deniedDatabase=createPostgresPool(wrongDatabase.toString(),{max:1},{env});
  // Database identity validation must reject even when provider-wide PUBLIC CONNECT exists.
  try { await assert.rejects(verifyStagingTestDatabaseIdentity(deniedDatabase.query.bind(deniedDatabase),config),/configuration rejected/); } finally { await deniedDatabase.end(); }
  const wrong=new URL(roleUrl(app));wrong.password='incorrect';const rejected=createPostgresPool(wrong.toString(),{max:1},{env});try{await assert.rejects(rejected.query('SELECT 1'),e=>e.code==='28P01');}finally{await rejected.end();}
  if(process.env.RUNTIME_IMAGE) {
    const name='shweta-runtime-check-'+process.pid, file='/tmp/shweta-runtime-'+process.pid+'.env';
    const dockerEnv={...env,DATABASE_PROVIDER:'neon',DATABASE_DRIVER:'pg-native',PORT:'3099',SSL_CERT_FILE:'/run/ci/ca-bundle.crt'};
    const url=new URL(roleUrl(app));url.hostname='phase6-main.neon.tech';url.searchParams.set('channel_binding','require');dockerEnv.STAGING_TEST_DATABASE_URL=url.toString();dockerEnv.STAGING_TEST_DATABASE_HOST=url.hostname;
    const keys=Object.keys(dockerEnv).filter(k=>k.startsWith('STAGING_TEST_')||k.startsWith('SHWETA_')||k.startsWith('RAZORPAY_')||['NODE_ENV','STORAGE_BACKEND','DATABASE_PROVIDER','DATABASE_DRIVER','PORT','SSL_CERT_FILE'].includes(k));
    writeFileSync(file,keys.map(k=>`${k}=${dockerEnv[k]}`).join('\n'),{mode:0o600});
    const docker=(...args)=>{const r=spawnSync('docker',args,{encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    const failed=spawnSync('docker',['run','--rm','--network','host','--add-host','phase6-main.neon.tech:127.0.0.1','--env-file',file,'--env','STAGING_TEST_DATABASE_IDENTITY=00000000000000000000000000000000','-v',`${process.env.RUNTIME_CERT_DIR}/ca-bundle.crt:/run/ci/ca-bundle.crt:ro`,process.env.RUNTIME_IMAGE],{encoding:'utf8',timeout:30000});
    assert.equal(failed.status,1,'wrong identity must exit safely');
    const start=Date.now();
    try {
      docker('run','-d','--name',name,'--network','host','--add-host','phase6-main.neon.tech:127.0.0.1','--env-file',file,'-v',`${process.env.RUNTIME_CERT_DIR}/ca-bundle.crt:/run/ci/ca-bundle.crt:ro`,process.env.RUNTIME_IMAGE);
      let ready=false;for(let i=0;i<30;i++){try{ready=(await fetch('http://127.0.0.1:3099/healthz')).status===200;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,1000));}assert.ok(ready,'actual runtime health after identity verification');
      assert.notEqual(docker('exec',name,'id','-u'),'0');
      console.log(`Runtime startup ${Date.now()-start} ms; image bytes ${docker('image','inspect','--format','{{.Size}}',process.env.RUNTIME_IMAGE)}`);
      console.log(docker('exec',name,'sh','-c',"grep VmRSS /proc/1/status"));
      docker('stop','--time','20',name);assert.equal(docker('inspect','--format','{{.State.ExitCode}}',name),'0','graceful shutdown');
    } finally {spawnSync('docker',['rm','-f',name]);unlinkSync(file);}
  }
  console.log('Two-role fixture: migration, runtime identity, DML, DDL rejection, marker and transaction rollback passed.');
} finally {
  await appPool?.end();await migrationPool?.end();await provision?.end();
  if(createdDb) await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
  for(const role of createdRoles) await admin.query(`DROP ROLE ${role}`);
  await admin.end();
}
