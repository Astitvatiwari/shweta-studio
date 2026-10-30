import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const productionConfig = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const stagingConfig = await readFile(new URL('../netlify.staging.toml', import.meta.url), 'utf8');
const apiTarget = (config) => config.match(/from = "\/api\/\*"[\s\S]*?to = "([^"]+)"/)?.[1];

assert.equal(apiTarget(productionConfig), 'https://api.shwetastudio.com/api/:splat');
assert.equal(apiTarget(stagingConfig), 'https://shweta-studio-staging-api.onrender.com/api/:splat');
assert.ok(stagingConfig.includes('signed = "NETLIFY_PROXY_SIGNING_SECRET"'));
assert.ok(!stagingConfig.includes('api.shwetastudio.com'));

console.log('Staging proxy isolation passed.');
