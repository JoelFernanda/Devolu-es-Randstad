/* Staged, row-by-row sanitized collection repository.
 * Loaded by the local copy but not authorized by production rules; every action
 * requires explicit sync gates and a server-scoped profile. It commits one opaque
 * return queue row and its sanitized receipt at a time.
 */
(function (root, factory) {
  'use strict';
  const service = factory();
  if (root) root.RandstadIndividualCollection = service;
  if (typeof module !== 'undefined' && module.exports) module.exports = service;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const ROLES = new Set(['gestor', 'estoque', 'motorista']);
  const POINTS = new Set(['Aurora', 'Franco da Rocha', 'Barueri']);
  const CLIENTS = new Set(['Shopee', 'Mercado Livre']);
  const QUEUE_FIELDS = new Set([
    'returnId', 'ponto', 'cliente', 'quantidadeLinhas',
    'status', 'coletaId', 'criadoEm', 'coletadoEm',
  ]);
  const QUEUE_ITEM_FIELDS = new Set(['codigo', 'descricao', 'qtd']);
  const RECEIPT_FIELDS = new Set([
    'returnId', 'ponto', 'cliente', 'quantidadeLinhasColetadas',
    'devolucoesColetadas', 'status', 'concluidaEm',
  ]);

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '')
      .trim().toLowerCase();
  }

  function normalizePoint(value) {
    const point = String(value || '').trim();
    const canonical = point === 'Vila Aurora' ? 'Aurora' : point;
    return POINTS.has(canonical) ? canonical : '';
  }

  function assertOpaqueReturnId(value) {
    const id = String(value || '');
    if (!/^return_[A-Za-z0-9_-]{20,40}$/.test(id)) {
      throw new Error('O identificador da devolução não é válido.');
    }
    return id;
  }

  function requireSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`O campo ${label} precisa ser um inteiro não negativo.`);
    }
    return value;
  }

  function scopedProfilePoint(profile) {
    if (!profile || !Object.prototype.hasOwnProperty.call(profile, 'ponto')) return '';
    const point = normalizePoint(profile.ponto);
    if (!point) throw new Error('O ponto configurado no perfil não é válido.');
    return point;
  }

  function driverPointScope(profile) {
    // No point in the profile means the driver may choose among all three points.
    return scopedProfilePoint(profile);
  }

  function allowlisted(data, fields, label) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${label} não é válido.`);
    }
    for (const key of Object.keys(data)) {
      if (!fields.has(key)) throw new Error(`${label} contém um campo não permitido.`);
    }
    return data;
  }

  function validateQueueItem(data, itemId) {
    if (!/^item_0\d{2}$/.test(String(itemId || ''))) {
      throw new Error('O identificador do material da fila não é válido.');
    }
    allowlisted(data, QUEUE_ITEM_FIELDS, 'Um material da fila');
    if (typeof data.codigo !== 'string' || !data.codigo.trim() || data.codigo.length > 200
      || typeof data.descricao !== 'string' || !data.descricao.trim() || data.descricao.length > 5000
      || !Number.isSafeInteger(data.qtd) || data.qtd < 1) {
      throw new Error('Um material da fila não é válido.');
    }
    return Object.freeze({
      codigo: data.codigo.trim(),
      descricao: data.descricao.trim(),
      qtd: data.qtd,
    });
  }

  async function hydrateQueueItems(rows, firestore) {
    return Promise.all(rows.map(async (row) => {
      const snapshot = await firestore.collection('filaColetas').doc(row.returnId)
        .collection('itens').get();
      const itemDocs = snapshot.docs.slice().sort((left, right) => left.id.localeCompare(right.id));
      const items = itemDocs.map((doc, index) => {
        const expectedId = `item_${String(index).padStart(3, '0')}`;
        if (doc.id !== expectedId) {
          throw new Error('Os identificadores dos materiais da fila estão incompletos ou divergentes.');
        }
        return validateQueueItem(doc.data(), doc.id);
      });
      if (items.length !== row.quantidadeLinhas) {
        throw new Error('A quantidade de materiais não corresponde à fila.');
      }
      return Object.freeze({ ...row, itensResumo: Object.freeze(items) });
    }));
  }

  function validateQueueRecord(data, docId) {
    allowlisted(data, QUEUE_FIELDS, 'A fila de coleta');
    if (data.returnId !== docId || assertOpaqueReturnId(data.returnId) !== docId) {
      throw new Error('O vínculo da devolução na fila não é válido.');
    }
    if (!normalizePoint(data.ponto) || !CLIENTS.has(data.cliente)) {
      throw new Error('O ponto ou cliente da fila não é válido.');
    }
    if (!Number.isSafeInteger(data.quantidadeLinhas) || data.quantidadeLinhas < 1
      || data.quantidadeLinhas > 100) {
      throw new Error('A quantidade de itens da fila não é válida.');
    }
    if (!['pendente', 'coletado'].includes(data.status)) {
      throw new Error('O estado da fila não é válido.');
    }
    if (typeof data.coletaId !== 'string'
      || (data.status === 'pendente' && data.coletaId !== '')
      || (data.status === 'coletado' && data.coletaId !== docId)) {
      throw new Error('O identificador da coleta não corresponde à devolução.');
    }
    if (!data.criadoEm || typeof data.criadoEm.toDate !== 'function') {
      throw new Error('A data de criação da fila não é válida.');
    }
    if (data.status === 'pendente' && data.coletadoEm !== null) {
      throw new Error('Uma devolução pendente não pode ter data de coleta.');
    }
    if (data.status === 'coletado'
      && (!data.coletadoEm || typeof data.coletadoEm.toDate !== 'function')) {
      throw new Error('A data da coleta não é válida.');
    }
    return Object.freeze({
      returnId: docId,
      ponto: normalizePoint(data.ponto),
      cliente: data.cliente,
      quantidadeLinhas: data.quantidadeLinhas,
      status: data.status,
      coletaId: data.coletaId,
      criadoEm: data.criadoEm,
      coletadoEm: data.coletadoEm,
    });
  }

  function validateReceipt(data, returnId) {
    allowlisted(data, RECEIPT_FIELDS, 'O comprovante de coleta');
    if (data.returnId !== returnId
      || normalizePoint(data.ponto) === ''
      || !CLIENTS.has(data.cliente)
      || !Number.isSafeInteger(data.quantidadeLinhasColetadas)
      || data.quantidadeLinhasColetadas < 1
      || data.quantidadeLinhasColetadas > 100
      || data.devolucoesColetadas !== 1
      || data.status !== 'concluida'
      || !data.concluidaEm
      || typeof data.concluidaEm.toDate !== 'function') {
      throw new Error('O comprovante de coleta não corresponde à devolução.');
    }
    return Object.freeze({
      returnId,
      ponto: normalizePoint(data.ponto),
      cliente: data.cliente,
      quantidadeLinhasColetadas: data.quantidadeLinhasColetadas,
      devolucoesColetadas: 1,
      status: 'concluida',
      concluidaEm: data.concluidaEm,
    });
  }

  function summarizePending(records) {
    const rows = Array.from(records || []);
    return Object.freeze({
      devolucoesPendentes: rows.length,
      linhasPendentes: rows.reduce((sum, row) => sum + requireSafeInteger(row.quantidadeLinhas, 'quantidadeLinhas'), 0),
    });
  }

  function create(options) {
    function assertReady() {
      if (!options || options.syncEnabled !== true) {
        throw new Error('A coleta individual sincronizada continua desativada.');
      }
      if (!options.firestore || typeof options.firestore.collection !== 'function'
        || typeof options.firestore.runTransaction !== 'function') {
        throw new Error('Firestore com suporte a transações não foi inicializado.');
      }
      if (typeof options.serverTimestamp !== 'function') {
        throw new Error('O horário seguro do servidor não foi configurado.');
      }
      if (!ROLES.has(roleOf(options.profile))) {
        throw new Error('Este perfil não pode confirmar coletas.');
      }
    }

    function queueCollection() {
      return options.firestore.collection('filaColetas');
    }

    return Object.freeze({
      normalizePoint,
      validateQueueRecord,
      summarizePending,
      async listPending(pointInput) {
        assertReady();
        const profilePoint = roleOf(options.profile) === 'motorista'
          ? driverPointScope(options.profile) : '';
        const requestedPoint = pointInput == null || pointInput === ''
          ? '' : normalizePoint(pointInput);
        if (pointInput && !requestedPoint) throw new Error('O ponto informado não é válido.');
        if (profilePoint && requestedPoint && requestedPoint !== profilePoint) {
          throw new Error('Este motorista não pode consultar outro ponto.');
        }
        const point = profilePoint || requestedPoint;
        let query = queueCollection().where('status', '==', 'pendente');
        if (point) query = query.where('ponto', '==', point);
        const snapshot = await query.get();
        const queueRows = snapshot.docs.map((doc) => validateQueueRecord(doc.data(), doc.id))
          .filter((row) => row.status === 'pendente');
        const rows = await hydrateQueueItems(queueRows, options.firestore);
        return Object.freeze({ rows, totals: summarizePending(rows) });
      },
      async listCompleted(pointInput) {
        assertReady();
        const profilePoint = roleOf(options.profile) === 'motorista'
          ? driverPointScope(options.profile) : '';
        const requestedPoint = pointInput == null || pointInput === ''
          ? '' : normalizePoint(pointInput);
        if (pointInput && !requestedPoint) throw new Error('O ponto informado não é válido.');
        if (profilePoint && requestedPoint && requestedPoint !== profilePoint) {
          throw new Error('Este motorista não pode consultar outro ponto.');
        }
        const point = profilePoint || requestedPoint;
        let query = queueCollection().where('status', '==', 'coletado');
        if (point) query = query.where('ponto', '==', point);
        const snapshot = await query.get();
        const queueRows = snapshot.docs.map((doc) => validateQueueRecord(doc.data(), doc.id))
          .filter((row) => row.status === 'coletado');
        const rows = await hydrateQueueItems(queueRows, options.firestore);
        return Object.freeze({
          rows,
          totals: Object.freeze({
            devolucoesColetadas: rows.length,
            linhasColetadas: rows.reduce((sum, row) => sum + row.quantidadeLinhas, 0),
          }),
        });
      },
      async completeOne(returnIdInput) {
        assertReady();
        const returnId = assertOpaqueReturnId(returnIdInput);
        const role = roleOf(options.profile);
        const queueRef = queueCollection().doc(returnId);
        // Verify the immutable item children before allowing a direct call to complete a row.
        const initialQueueSnapshot = await queueRef.get();
        if (!initialQueueSnapshot.exists) throw new Error('A devolução não está na fila de coleta.');
        const initialRow = validateQueueRecord(initialQueueSnapshot.data(), initialQueueSnapshot.id);
        const initialProfilePoint = role === 'motorista' ? driverPointScope(options.profile) : '';
        if (role === 'motorista' && initialProfilePoint && initialRow.ponto !== initialProfilePoint) {
          throw new Error('Este motorista não pode confirmar coleta em outro ponto.');
        }
        await hydrateQueueItems([initialRow], options.firestore);
        // Deterministic event ID gives each return at most one collection receipt.
        const receiptRef = options.firestore.collection('coletasDevolucoes').doc(returnId);
        return options.firestore.runTransaction(async (transaction) => {
          const queueSnapshot = await transaction.get(queueRef);
          const receiptSnapshot = await transaction.get(receiptRef);
          if (!queueSnapshot.exists) throw new Error('A devolução não está na fila de coleta.');
          const row = validateQueueRecord(queueSnapshot.data(), queueSnapshot.id);
          const profilePoint = role === 'motorista'
            ? driverPointScope(options.profile) : '';
          if (role === 'motorista' && profilePoint && row.ponto !== profilePoint) {
            throw new Error('Este motorista não pode confirmar coleta em outro ponto.');
          }
          if (receiptSnapshot.exists) {
            const receipt = validateReceipt(receiptSnapshot.data(), returnId);
            if (row.status !== 'coletado' || row.coletaId !== returnId
              || receipt.ponto !== row.ponto || receipt.cliente !== row.cliente
              || receipt.quantidadeLinhasColetadas !== row.quantidadeLinhas) {
              throw new Error('A fila e o comprovante estão inconsistentes; nada foi alterado.');
            }
            return Object.freeze({ alreadyCompleted: true, row, receipt });
          }
          if (row.status !== 'pendente') {
            throw new Error('A devolução não está pendente, mas não há comprovante correspondente.');
          }
          const completedAt = options.serverTimestamp();
          const receipt = {
            returnId,
            ponto: row.ponto,
            cliente: row.cliente,
            quantidadeLinhasColetadas: row.quantidadeLinhas,
            devolucoesColetadas: 1,
            status: 'concluida',
            concluidaEm: completedAt,
          };
          transaction.update(queueRef, {
            status: 'coletado',
            coletaId: returnId,
            coletadoEm: completedAt,
          });
          transaction.set(receiptRef, receipt);
          return Object.freeze({
            alreadyCompleted: false,
            row: Object.freeze({ ...row, status: 'coletado', coletaId: returnId, coletadoEm: completedAt }),
            receipt,
          });
        });
      },
    });
  }

  return Object.freeze({
    create,
    normalizePoint,
    assertOpaqueReturnId,
    validateQueueItem,
    validateQueueRecord,
    validateReceipt,
    summarizePending,
    roleOf,
  });
});
