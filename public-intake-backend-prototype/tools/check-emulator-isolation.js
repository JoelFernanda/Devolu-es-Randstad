'use strict';

// Self-contained read-only guard. No Firebase network calls and no deploy path.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'demo-randstad-rules-test';
function fail(reason) { console.error(`Isolation check FAILED: ${reason}`); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.server-intake.emulator.json'), 'utf8'));
if (cfg.firestore?.rules !== 'firestore.server-intake.rules') fail('Only draft rules may be selected.');
if (cfg.emulators?.firestore?.host !== '127.0.0.1' || cfg.emulators?.firestore?.port !== 8182) fail('Emulator must bind to 127.0.0.1:8182.');
if (cfg.emulators?.ui?.enabled !== false || cfg.emulators?.singleProjectMode !== true) fail('UI must be off and single-project mode on.');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.server-intake.rules'), 'utf8');
if (!rules.includes('DRAFT FOR ISOLATED EMULATOR TESTS ONLY') || !rules.includes('allow read, write: if false;')) fail('Draft must remain explicitly marked and default-deny.');
const test = fs.readFileSync(path.join(ROOT, 'tests', 'firestore.server-intake.rules.test.js'), 'utf8');
if (!test.includes(`const PROJECT_ID = '${PROJECT}';`) || !test.includes("const FIRESTORE_HOST = '127.0.0.1';") || !test.includes('const FIRESTORE_PORT = 8182;')) fail('Test suite is not pinned to demo project and local port.');
if (/devo-randstad|firebase deploy|gcloud\s+firestore/i.test(test + rules)) fail('Production/deploy reference found in executable test files.');
console.log(`Isolation OK — project=${PROJECT}, host=127.0.0.1, port=8182, draft rules only; deployment is not part of this package.`);
