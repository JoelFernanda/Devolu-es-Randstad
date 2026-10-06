/* Minimized, append-only Firestore audit for confirmed imports. */
(function (root, factory) {
  'use strict';
  const repository = factory();
  if (root) root.RandstadImportHistoryRepository = repository;
  if (typeof module !== 'undefined' && module.exports) module.exports = repository;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MANAGE_ROLES = new Set(['gestor', 'estoque']);
  const IMPORT_TYPES = new Set(['colaboradores', 'produtos']);
  const MAX_TOTAL_ROWS = 20000;
  const MAX_HISTORY_ROWS = 100;
  const FIELDS = [
    'versao', 'tipo', 'operadorUid', 'status', 'dataHora',
    'totalLinhas', 'linhasGravadas', 'linhasRevisao', 'linhasInvalidas',
  ];

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '')
      .trim().toLowerCase();
  }

  function assertReady(options) {
    if (!options || options.syncEnabled !== true) {
      throw new Error('O histórico remoto de importações ainda está desativado.');
    }
    if (!options.firestore || typeof options.firestore.collection !== 'function') {
      throw new Error('Firestore não foi inicializado.');
    }
    if (!MANAGE_ROLES.has(roleOf(options.profile))) {
      throw new Error('Somente gestor/estoque pode acessar o histórico de importações.');
    }
    if (!options.profile.uid || typeof options.profile.uid !== 'string') {
      throw new Error('O usuário autenticado não tem UID válido.');
    }
    return options.firestore.collection('importacoes');
  }

  function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validateCounts(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('O resumo da importação é inválido.');
    }
    const allowed = new Set(['tipo', 'totalLinhas', 'linhasGravadas', 'linhasRevisao', 'linhasInvalidas']);
    if (Object.keys(input).length !== allowed.size || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new Error('O resumo da importação contém campos não permitidos.');
    }
    if (!IMPORT_TYPES.has(input.tipo)) throw new Error('O tipo de importação é inválido.');
    for (const key of ['totalLinhas', 'linhasGravadas', 'linhasRevisao', 'linhasInvalidas']) {
      if (!isCount(input[key])) throw new Error('As contagens da importação são inválidas.');
    }
    if (input.totalLinhas > MAX_TOTAL_ROWS
      || input.linhasGravadas + input.linhasRevisao + input.linhasInvalidas !== input.totalLinhas) {
      throw new Error('As contagens da importação não fecham.');
    }
    const maxCommitted = input.tipo === 'colaboradores' ? 400 : 500;
    if (input.linhasGravadas > maxCommitted) {
      throw new Error('O total gravado excede o limite do lote.');
    }
    return {
      versao: 1,
      tipo: input.tipo,
      totalLinhas: input.totalLinhas,
      linhasGravadas: input.linhasGravadas,
      linhasRevisao: input.linhasRevisao,
      linhasInvalidas: input.linhasInvalidas,
    };
  }

  function isTimestamp(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime());
    if (!value || typeof value.toDate !== 'function') return false;
    try {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime());
    } catch (_) {
      return false;
    }
  }

  function storedRecord(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== FIELDS.length
      || Object.keys(input).some((key) => !FIELDS.includes(key))) {
      throw new Error('Um registro remoto de importação contém campos não permitidos.');
    }
    if (input.versao !== 1 || !IMPORT_TYPES.has(input.tipo)
      || typeof input.operadorUid !== 'string' || !input.operadorUid.trim()
      || input.operadorUid.length > 128 || input.status !== 'concluida'
      || !isTimestamp(input.dataHora)) {
      throw new Error('Um registro remoto de importação tem formato inválido.');
    }
    const counts = validateCounts({
      tipo: input.tipo,
      totalLinhas: input.totalLinhas,
      linhasGravadas: input.linhasGravadas,
      linhasRevisao: input.linhasRevisao,
      linhasInvalidas: input.linhasInvalidas,
    });
    if (input.versao !== counts.versao) throw new Error('A versão do histórico de importações não é compatível.');
    return { id, ...counts, operadorUid: input.operadorUid, status: input.status, dataHora: input.dataHora };
  }

  function create(options) {
    function collection() {
      return assertReady(options);
    }

    return Object.freeze({
      async create(input) {
        const rows = collection();
        const counts = validateCounts(input);
        if (typeof options.serverTimestamp !== 'function') {
          throw new Error('O horário do servidor não está configurado.');
        }
        const ref = rows.doc();
        const data = {
          ...counts,
          operadorUid: options.profile.uid,
          status: 'concluida',
          dataHora: options.serverTimestamp(),
        };
        await ref.set(data);
        return { id: ref.id, ...data };
      },
      async list() {
        const snapshot = await collection().orderBy('dataHora', 'desc').limit(MAX_HISTORY_ROWS).get();
        return snapshot.docs.map((doc) => storedRecord(doc.id, doc.data()));
      },
    });
  }

  return Object.freeze({ create, MAX_HISTORY_ROWS });
});
