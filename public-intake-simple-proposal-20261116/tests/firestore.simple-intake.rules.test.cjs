'use strict';
const {after, before, beforeEach, test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {assertFails, assertSucceeds, initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc} = require('firebase/firestore');

// Demo project and local Emulator only; test fixtures are synthetic.
const PROJECT_ID='demo-randstad-simple-intake';
const RULES_PATH=join(__dirname,'..','firestore.rules.candidate');
const MANAGER='synthetic-manager';
const STOCK='synthetic-stock';
const ID_A='submission_ABCDEFGHIJKLMNOPQRST';
const ID_B='submission_BCDEFGHIJKLMNOPQRSTU';
let env;
const anon=()=>env.unauthenticatedContext().firestore();
const signed=uid=>env.authenticatedContext(uid).firestore();
function submission(overrides={}) { return {
  nome:'Pessoa Sintética', cpf:'11144477735', telefone:'11900000000',
  email:'sintetico@example.test', ponto:'Aurora', cliente:'Shopee',
  recebidoEm:serverTimestamp(), revisao:'pendente', ...overrides,
}; }
before(async()=>{env=await initializeTestEnvironment({projectId:PROJECT_ID,firestore:{host:'127.0.0.1',port:8183,rules:readFileSync(RULES_PATH,'utf8')}});});
after(async()=>{if(env) await env.cleanup();});
beforeEach(async()=>{await env.clearFirestore();await env.withSecurityRulesDisabled(async ctx=>{
  const db=ctx.firestore();
  await setDoc(doc(db,'usuarios',MANAGER),{perfil:'gestor'});
  await setDoc(doc(db,'usuarios',STOCK),{perfil:'estoque'});
});});

test('anonymous create-only accepts repeated CPF and blocks public read/list',async()=>{
  const db=anon();
  await assertSucceeds(setDoc(doc(db,'agendamentos',ID_A),submission()));
  await assertSucceeds(setDoc(doc(db,'agendamentos',ID_B),submission({ponto:'Barueri'})));
  await assertFails(getDoc(doc(db,'agendamentos',ID_A)));
  await assertFails(getDocs(collection(db,'agendamentos')));
});
test('only gestor can list and delete one; stock and signed-in clients cannot',async()=>{
  await env.withSecurityRulesDisabled(async ctx=>setDoc(doc(ctx.firestore(),'agendamentos',ID_A),{
    nome:'Pessoa Sintética',cpf:'11144477735',telefone:'11900000000',email:'sintetico@example.test',ponto:'Aurora',cliente:'Shopee',recebidoEm:new Date(),revisao:'pendente'
  }));
  await assertSucceeds(getDocs(collection(signed(MANAGER),'agendamentos')));
  await assertFails(getDocs(collection(signed(STOCK),'agendamentos')));
  await assertFails(deleteDoc(doc(anon(),'agendamentos',ID_A)));
  await assertFails(deleteDoc(doc(signed(STOCK),'agendamentos',ID_A)));
  await assertSucceeds(deleteDoc(doc(signed(MANAGER),'agendamentos',ID_A)));
});
test('schema checks reject malformed fields and clients cannot create unrelated records',async()=>{
  const db=anon();
  await assertFails(setDoc(doc(db,'agendamentos',ID_A),submission({ponto:'Ponto inventado'})));
  await assertFails(setDoc(doc(db,'agendamentos',ID_A),submission({campoExtra:'não permitido'})));
  await assertFails(setDoc(doc(db,'colaboradores','synthetic-id'),{nome:'Pessoa Sintética'}));
  await assertFails(setDoc(doc(signed(MANAGER),'agendamentos',ID_A),submission()));
});
