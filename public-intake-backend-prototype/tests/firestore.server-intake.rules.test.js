'use strict';

const {after, before, beforeEach, test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {assertFails, assertSucceeds, initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc} = require('firebase/firestore');

// Isolated draft-rule suite only: demo project and a local Emulator listener.
const PROJECT_ID = 'demo-randstad-rules-test';
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8182;
const RULES_PATH = join(__dirname, '..', 'firestore.server-intake.rules');
const MANAGER = 'synthetic-intake-manager';
const STOCK = 'synthetic-intake-stock';
const POINT = 'synthetic-intake-point';
const DRIVER = 'synthetic-intake-driver';
const SUBMISSION = 'submission_synthetic_opaque_00000001';
const CLAIM = 'claim_synthetic_opaque_00000001';

let testEnv;
const anonDb = () => testEnv.unauthenticatedContext().firestore();
const actorDb = uid => testEnv.authenticatedContext(uid).firestore();

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: FIRESTORE_HOST,
      port: FIRESTORE_PORT,
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'usuarios', MANAGER), {perfil: 'gestor'});
    await setDoc(doc(db, 'usuarios', STOCK), {perfil: 'estoque'});
    await setDoc(doc(db, 'usuarios', POINT), {perfil: 'ponto', ponto: 'Aurora'});
    await setDoc(doc(db, 'usuarios', DRIVER), {perfil: 'motorista'});
    await setDoc(doc(db, 'agendamentos', SUBMISSION), {
      nome: 'Pessoa Sintética', cpf: '00000000000', email: 'synthetic@example.test',
    });
    await setDoc(doc(db, 'intakeCpfClaims', CLAIM), {submissionId: SUBMISSION});
  });
});

test('claims are inaccessible to anonymous and all authenticated client profiles', async () => {
  for (const db of [anonDb(), actorDb(MANAGER), actorDb(STOCK), actorDb(POINT), actorDb(DRIVER)]) {
    await assertFails(getDoc(doc(db, 'intakeCpfClaims', CLAIM)));
    await assertFails(getDocs(collection(db, 'intakeCpfClaims')));
    await assertFails(setDoc(doc(db, 'intakeCpfClaims', `${CLAIM}_new`), {submissionId: SUBMISSION}));
    await assertFails(deleteDoc(doc(db, 'intakeCpfClaims', CLAIM)));
  }
});

test('submission documents are readable only by the manager profile', async () => {
  await assertSucceeds(getDoc(doc(actorDb(MANAGER), 'agendamentos', SUBMISSION)));
  await assertSucceeds(getDocs(collection(actorDb(MANAGER), 'agendamentos')));
  for (const db of [anonDb(), actorDb(STOCK), actorDb(POINT), actorDb(DRIVER)]) {
    await assertFails(getDoc(doc(db, 'agendamentos', SUBMISSION)));
    await assertFails(getDocs(collection(db, 'agendamentos')));
  }
});

test('all client profiles are denied submission writes and unrelated documents', async () => {
  for (const db of [anonDb(), actorDb(MANAGER), actorDb(STOCK), actorDb(POINT), actorDb(DRIVER)]) {
    await assertFails(setDoc(doc(db, 'agendamentos', `${SUBMISSION}_new`), {nome: 'Sintético'}));
    await assertFails(updateDoc(doc(db, 'agendamentos', SUBMISSION), {cpf: '11111111111'}));
    await assertFails(deleteDoc(doc(db, 'agendamentos', SUBMISSION)));
    await assertFails(setDoc(doc(db, 'colaboradores', 'synthetic_opaque_collaborator_0001'), {nome: 'Sintético'}));
  }
});
