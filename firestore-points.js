/* Firestore repository for independent per-point physical-volume counters.
 * Driver access is read-only and scoped; collection completion never changes volumes.
 * The app and rules remain gated until the full point workflow is validated.
 */
(function (root, factory) {
  'use strict';
  const repository = factory();
  if (root) root.RandstadPointsRepository = repository;
  if (typeof module !== 'undefined' && module.exports) module.exports = repository;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MANAGE_ROLES = new Set(['gestor', 'estoque']);
  const READ_ROLES = new Set(['gestor', 'estoque', 'ponto', 'motorista']);
  const POINT_KEYS = new Set(['Aurora', 'Franco da Rocha', 'Barueri']);

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '')
      .trim().toLowerCase();
  }

  function normalizePoint(value) {
    const point = String(value || '').trim();
    const canonical = point === 'Vila Aurora' ? 'Aurora' : point;
    return POINT_KEYS.has(canonical) ? canonical : '';
  }

  function requireVolume(value) {
    const volume = Number(value);
    if (!Number.isSafeInteger(volume) || volume < 0) {
      throw new Error('O volume deve ser um número inteiro não negativo.');
    }
    return volume;
  }

  function assertReady(options, point, operation) {
    if (!options || options.syncEnabled !== true) {
      throw new Error('A sincronização dos pontos ainda está desativada.');
    }
    if (!options.firestore || typeof options.firestore.collection !== 'function') {
      throw new Error('Firestore não foi inicializado.');
    }
    const role = roleOf(options.profile);
    const rawDriverPoint = options.profile && options.profile.ponto;
    const driverPoint = rawDriverPoint ? normalizePoint(rawDriverPoint) : '';
    if (role === 'motorista' && rawDriverPoint && !driverPoint) {
      throw new Error('O ponto configurado no perfil do motorista não é válido.');
    }
    const ownPoint = role === 'ponto'
      && point
      && normalizePoint(options.profile.ponto) === point;
    const driverMayRead = role === 'motorista'
      && (!driverPoint || !point || driverPoint === point);
    const allowed = operation === 'manage'
      ? MANAGE_ROLES.has(role)
      : operation === 'write'
        ? MANAGE_ROLES.has(role) || ownPoint
        : READ_ROLES.has(role);
    if (!allowed) {
      throw new Error(operation === 'read'
        ? 'Este perfil não pode consultar os volumes dos pontos.'
        : operation === 'manage'
          ? 'Este perfil não pode listar todos os pontos.'
          : 'Este perfil não pode alterar volumes dos pontos.');
    }
    if (role === 'ponto' && point && !ownPoint) {
      throw new Error('Este ponto não pertence à sua conta.');
    }
    if (role === 'motorista' && point && !driverMayRead) {
      throw new Error('Este ponto não pertence ao escopo da sua conta.');
    }
    return role;
  }

  function create(options) {
    function reference(point) {
      return options.firestore.collection('pontos').doc(point);
    }

    async function readCanonicalPoints() {
      const items = await Promise.all([...POINT_KEYS].map((point) => reference(point).get()));
      return items.filter((item) => item.exists)
        .map((item) => ({ id: item.id, ...item.data() }));
    }

    return Object.freeze({
      normalizePoint,
      async list() {
        assertReady(options, '', 'manage');
        return readCanonicalPoints();
      },
      async listReadable() {
        const role = assertReady(options, '', 'read');
        if (MANAGE_ROLES.has(role)) return readCanonicalPoints();
        if (role === 'motorista' && !options.profile.ponto) return readCanonicalPoints();
        if (role === 'ponto' || role === 'motorista') {
          const point = normalizePoint(options.profile.ponto);
          if (!point) throw new Error('O ponto do perfil não é válido.');
          const item = await reference(point).get();
          return item.exists ? [{ id: item.id, ...item.data() }] : [];
        }
        throw new Error('Este perfil não pode listar os volumes dos pontos.');
      },
      async get(pointName) {
        const point = normalizePoint(pointName);
        if (!point) throw new Error('O ponto informado não é válido.');
        assertReady(options, point, 'read');
        const snapshot = await reference(point).get();
        return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
      },
      async setVolume(pointName, value) {
        const point = normalizePoint(pointName);
        if (!point) throw new Error('O ponto informado não é válido.');
        const role = assertReady(options, point, 'write');
        const volumes = requireVolume(value);
        const ref = reference(point);
        await options.firestore.runTransaction(async (transaction) => {
          const current = await transaction.get(ref);
          if (!current.exists && role === 'ponto') {
            throw new Error('O gestor ainda não inicializou este ponto.');
          }
          transaction.set(ref, { ponto: point, volumes }, { merge: true });
        });
        return { id: point, ponto: point, volumes };
      }
    });
  }

  return Object.freeze({ create, normalizePoint, requireVolume, roleOf });
});
