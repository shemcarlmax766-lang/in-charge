/** Bundles the test entry with Vite (same JSX/transform pipeline the app uses). */
import { build } from 'vite';
import config from './vite.test.config.mjs';

await build(config);
console.log('test bundle built → client/test/.build/app.js');
