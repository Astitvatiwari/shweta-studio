import artworks from '../artworks.js';
import { getRuntimeCatalog, resolveStagingTestFixtureConfig } from './staging-test-fixture.js';

export const stagingTestFixtureConfig = resolveStagingTestFixtureConfig();
export const runtimeCatalog = getRuntimeCatalog(artworks, stagingTestFixtureConfig);
