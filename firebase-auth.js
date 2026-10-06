/* Firebase Authentication + Firestore user-profile lookup. */
(function (global) {
  'use strict';

  const VALID_PROFILES = new Set(['gestor', 'motorista', 'ponto', 'cliente', 'estoque']);
  const POINT_KEYS = {
    'Vila Aurora': 'Aurora',
    'Aurora': 'Aurora',
    'Franco da Rocha': 'Franco da Rocha',
    'Barueri': 'Barueri'
  };
  const CLIENT_KEYS = {
    'shopee': 'Shopee',
    'mercado livre': 'Mercado Livre'
  };

  let auth = null;
  let firestore = null;
  let initialized = false;

  function initialize() {
    if (initialized) return { auth, firestore };
    if (!global.firebase || !global.RANDSTAD_FIREBASE_CONFIG) {
      throw new Error('Firebase não carregou. Atualize a página e tente novamente.');
    }
    const app = global.firebase.apps.length
      ? global.firebase.app()
      : global.firebase.initializeApp(global.RANDSTAD_FIREBASE_CONFIG);
    if (global.RANDSTAD_APPCHECK_CONFIG && global.RANDSTAD_APPCHECK_CONFIG.enabled === true) {
      if (!global.RandstadAppCheck) {
        throw new Error('O inicializador local do App Check não carregou.');
      }
      global.RandstadAppCheck.initialize(global.RANDSTAD_APPCHECK_CONFIG);
    }
    auth = app.auth();
    firestore = app.firestore();
    initialized = true;
    return { auth, firestore };
  }

  function normalizeProfile(raw, firebaseUser) {
    const perfil = String(raw.perfil || '').trim().toLowerCase();
    if (!VALID_PROFILES.has(perfil)) {
      throw new Error('Seu perfil de acesso não está configurado corretamente. Fale com o gestor.');
    }

    const profile = {
      ...raw,
      uid: firebaseUser.uid,
      email: firebaseUser.email || raw.email || '',
      perfilBanco: perfil,
      perfil
    };

    if (perfil === 'ponto') {
      const point = String(raw.ponto || '').trim();
      if (!POINT_KEYS[point]) {
        throw new Error('O ponto de coleta desta conta ainda não foi definido. Fale com o gestor.');
      }
      profile.pontoNome = point === 'Aurora' ? 'Vila Aurora' : point;
      profile.pontoKey = POINT_KEYS[point];
      profile.ponto = POINT_KEYS[point];
      // Reusa o menu já existente de usuários de ponto; rules will still use perfilBanco.
      profile.perfil = 'loja';
    }

    if (perfil === 'cliente') {
      const client = String(raw.cliente || '').trim().toLowerCase();
      if (!CLIENT_KEYS[client]) {
        throw new Error('O cliente desta conta ainda não foi definido. Fale com o gestor.');
      }
      profile.cliente = CLIENT_KEYS[client];
    }

    if (perfil === 'estoque') {
      // Derive the modules from the authenticated profile, not a Firestore array.
      const policy = global.RandstadAccessPolicy;
      if (!policy) throw new Error('A política de acesso não carregou. Atualize a página e tente novamente.');
      profile.modulosPermitidos = policy.modulesFor(profile);
      profile.acessoConfigurado = profile.modulosPermitidos.length > 0;
    }

    return profile;
  }

  async function profileFor(firebaseUser) {
    const { firestore } = initialize();
    const snap = await firestore.collection('usuarios').doc(firebaseUser.uid).get();
    if (!snap.exists) {
      throw new Error('Sua conta ainda não tem um perfil cadastrado. Fale com o gestor.');
    }
    return normalizeProfile(snap.data(), firebaseUser);
  }

  async function signIn(email, password) {
    const { auth } = initialize();
    const credential = await auth.signInWithEmailAndPassword(String(email || '').trim(), password || '');
    try {
      return await profileFor(credential.user);
    } catch (error) {
      await auth.signOut();
      throw error;
    }
  }

  async function signOut() {
    const { auth } = initialize();
    return auth.signOut();
  }

  function listen(onProfile, onError) {
    const { auth } = initialize();
    return auth.onAuthStateChanged(async function (firebaseUser) {
      if (!firebaseUser) {
        onProfile(null);
        return;
      }
      try {
        onProfile(await profileFor(firebaseUser));
      } catch (error) {
        await auth.signOut();
        if (typeof onError === 'function') onError(error);
      }
    });
  }

  function messageFor(error) {
    const code = error && error.code || '';
    if (code === 'auth/invalid-email') return 'Confira o formato do e-mail.';
    if (code === 'auth/user-disabled') return 'Esta conta está desativada. Fale com o gestor.';
    if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
      return 'E-mail ou senha inválidos.';
    }
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      return 'O perfil não pôde ser lido. Confira as regras do Firestore.';
    }
    return error && error.message || 'Não foi possível entrar. Tente novamente.';
  }

  global.RandstadAuth = { initialize, signIn, signOut, listen, profileFor, messageFor };
})(window);
