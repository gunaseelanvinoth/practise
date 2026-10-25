import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const handler = require('./handler.cjs');
export default handler;
