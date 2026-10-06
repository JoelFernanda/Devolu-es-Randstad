/* Local-only backup/restore helpers. No Firebase access or automatic writes. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (root) root.RandstadLocalBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const FORMAT = 'randstad-local-backup';
  const VERSION = 1;
  const STORAGE_KEY = 'randstad_dev_v19';
  const RESTORE_CONFIRMATION = 'RESTAURAR';
  const ROLES = Object.freeze(['gestor']);
  const REQUIRED_CLOSED_GATES = Object.freeze([
    'data', 'products', 'points', 'individualCollection', 'publicIntakeReview',
    'publicIntake', 'piiRegistration'
  ]);
  const ARRAY_COLLECTIONS = Object.freeze([
    'colaboradores', 'produtos', 'devolucoes', 'importacoes', 'lavanderia', 'cobrancas'
  ]);
  const OBJECT_COLLECTIONS = Object.freeze(['sequenciais', 'volumesPorPonto']);
  const CLIENTS = Object.freeze(['Shopee', 'Mercado Livre']);
  const pendingPlans = new WeakMap();

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '').trim().toLowerCase();
  }

  function assertAuthorized(profile, gates) {
    if (!ROLES.includes(roleOf(profile))) {
      throw new Error('Backup e restauração locais são exclusivos do perfil gestor.');
    }
    if (!isObject(gates) || REQUIRED_CLOSED_GATES.some((name) => gates[name] !== false)) {
      throw new Error('Backup local indisponível enquanto qualquer sincronização estiver ativa.');
    }
  }

  function validateDatabase(data) {
    const errors = [];
    const counts = {};
    if (!isObject(data)) return { valid: false, errors: ['raiz_deve_ser_objeto'] };

    for (const key of ARRAY_COLLECTIONS) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(`campo_ausente:${key}`);
        continue;
      }
      if (!Array.isArray(data[key])) {
        errors.push(`tipo_invalido:${key}`);
        continue;
      }
      if (data[key].some((record) => !isObject(record))) {
        errors.push(`registro_deve_ser_objeto:${key}`);
        continue;
      }
      counts[key] = data[key].length;
    }

    for (const key of OBJECT_COLLECTIONS) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(`campo_ausente:${key}`);
        continue;
      }
      if (!isObject(data[key])) {
        errors.push(`tipo_invalido:${key}`);
        continue;
      }
      if (Object.values(data[key]).some((value) => !Number.isSafeInteger(value) || value < 0)) {
        errors.push(`contador_invalido:${key}`);
      }
    }

    if (!isObject(data.historicoCliente)) {
      errors.push('tipo_invalido:historicoCliente');
    } else {
      for (const client of CLIENTS) {
        const clientHistory = data.historicoCliente[client];
        if (!isObject(clientHistory)) {
          errors.push(`historico_cliente_invalido:${client}`);
          continue;
        }
        for (const status of ['concluidas', 'pendentes']) {
          const entries = clientHistory[status];
          if (!Array.isArray(entries) || entries.some((entry) => !isObject(entry))) {
            errors.push(`historico_lista_invalida:${client}:${status}`);
          } else {
            counts[`historicoCliente.${client}.${status}`] = entries.length;
          }
        }
      }
    }
    return { valid: errors.length === 0, errors, counts };
  }

  function parseBackup(text) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('Selecione um arquivo JSON válido.');
    if (typeof Blob !== 'undefined' && new Blob([text]).size > 50 * 1024 * 1024) {
      throw new Error('O arquivo excede o limite de 50 MB.');
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('O arquivo não contém JSON válido.');
    }
    if (!isObject(payload)) throw new Error('A base do backup precisa ser um objeto JSON.');

    let data = payload;
    if (payload.format !== undefined || payload.version !== undefined || payload.data !== undefined) {
      if (payload.format !== FORMAT || payload.version !== VERSION || !isObject(payload.data) ||
          typeof payload.exportedAt !== 'string' || !payload.exportedAt.trim()) {
        throw new Error('O envelope de backup está inválido ou não é compatível.');
      }
      data = payload.data;
    }
    const validation = validateDatabase(data);
    if (!validation.valid) throw new Error(`A estrutura do backup não é compatível (${validation.errors[0]}).`);
    return { data, counts: validation.counts };
  }

  function readStoredValue(storage) {
    try {
      return storage.getItem(STORAGE_KEY);
    } catch (_) {
      throw new Error('Não foi possível conferir o armazenamento local.');
    }
  }

  function makeEnvelope(data, now) {
    const validation = validateDatabase(data);
    if (!validation.valid) throw new Error(`A base atual não pode ser exportada (${validation.errors[0]}).`);
    const copiedData = JSON.parse(JSON.stringify(data));
    const exportedAt = now === undefined ? new Date().toISOString() : new Date(now).toISOString();
    return JSON.stringify({ format: FORMAT, version: VERSION, exportedAt, data: copiedData }, null, 2);
  }

  function exportBackup(options) {
    const config = options || {};
    assertAuthorized(config.profile, config.gates);
    return makeEnvelope(config.data, config.now);
  }

  function prepareRestore(options) {
    const config = options || {};
    assertAuthorized(config.profile, config.gates);
    if (!config.storage || typeof config.storage.getItem !== 'function') {
      throw new Error('Não foi possível ler o armazenamento local com segurança.');
    }
    const incoming = parseBackup(config.backupText);
    const currentValidation = validateDatabase(config.currentData);
    if (!currentValidation.valid) {
      throw new Error(`A base atual não pode ser protegida (${currentValidation.errors[0]}).`);
    }

    const beforeRaw = readStoredValue(config.storage);
    if (beforeRaw !== null) {
      const stored = parseBackup(beforeRaw);
      if (JSON.stringify(stored.data) !== JSON.stringify(config.currentData)) {
        throw new Error('A base local mudou desde a abertura da tela; atualize antes de restaurar.');
      }
    }

    const rollbackText = makeEnvelope(config.currentData, config.now);
    const targetRaw = JSON.stringify(incoming.data);
    const plan = Object.freeze({
      currentCounts: currentValidation.counts,
      restoreCounts: incoming.counts,
      rollbackText
    });
    pendingPlans.set(plan, { beforeRaw, targetRaw });
    return plan;
  }

  function commitRestore(options) {
    const config = options || {};
    assertAuthorized(config.profile, config.gates);
    const plan = config.plan;
    const internal = plan && pendingPlans.get(plan);
    if (!internal) throw new Error('A preparação da restauração expirou; selecione o arquivo novamente.');
    if (config.confirmation !== RESTORE_CONFIRMATION) {
      throw new Error('Digite RESTAURAR para confirmar a substituição local.');
    }
    if (config.rollbackConfirmed !== true) {
      throw new Error('Confirme que a cópia de segurança da base atual foi salva.');
    }
    const storage = config.storage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new Error('O armazenamento local não está disponível.');
    }
    if (readStoredValue(storage) !== internal.beforeRaw) {
      throw new Error('A base local mudou desde a preparação; nada foi substituído. Prepare novamente.');
    }

    try {
      storage.setItem(STORAGE_KEY, internal.targetRaw);
      if (readStoredValue(storage) !== internal.targetRaw) throw new Error('Falha ao conferir a gravação.');
    } catch (_) {
      let currentRaw;
      try { currentRaw = storage.getItem(STORAGE_KEY); } catch (_) { currentRaw = undefined; }
      if (currentRaw === undefined || currentRaw !== internal.beforeRaw) {
        try {
          if (internal.beforeRaw === null && typeof storage.removeItem === 'function') storage.removeItem(STORAGE_KEY);
          else if (internal.beforeRaw !== null) storage.setItem(STORAGE_KEY, internal.beforeRaw);
        } catch (_) { /* Keep the original error generic; report the restore as failed. */ }
      }
      throw new Error('A restauração falhou. A cópia anterior foi preservada quando possível; confira os dados antes de tentar novamente.');
    }
    pendingPlans.delete(plan);
    return { restored: true, counts: plan.restoreCounts };
  }

  return Object.freeze({
    FORMAT, VERSION, STORAGE_KEY, RESTORE_CONFIRMATION,
    validateDatabase, parseBackup, exportBackup, prepareRestore, commitRestore
  });
});
