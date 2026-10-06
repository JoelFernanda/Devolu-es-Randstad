/* Manager-only manual review for public intake submissions.
 * This module never creates public submissions and remains behind a closed app gate.
 */
(function (root, factory) {
  'use strict';
  const repository = factory();
  if (root) root.RandstadPublicIntakeReview = repository;
  if (typeof module !== 'undefined' && module.exports) module.exports = repository;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STATUSES = new Set(['pendente', 'possivel_duplicado', 'revisado', 'descartado']);
  const BASE_FIELDS = new Set([
    'nome', 'cpf', 'telefone', 'email', 'ponto', 'cliente', 'recebidoEm', 'revisao',
  ]);
  const REVIEW_FIELDS = new Set(['revisadoEm', 'revisadoPor']);
  const POINTS = new Set(['Aurora', 'Franco da Rocha', 'Barueri']);
  const CLIENTS = new Set(['Shopee', 'Mercado Livre']);
  const ID_PATTERN = /^submission_[A-Za-z0-9_-]{20,40}$/;

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '')
      .trim().toLowerCase();
  }

  function assertSubmissionId(value) {
    const id = String(value || '');
    if (!ID_PATTERN.test(id)) throw new Error('O identificador do cadastro não é válido.');
    return id;
  }

  function isTimestamp(value) {
    if (!value || typeof value.toDate !== 'function') return false;
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime());
  }

  function validateSubmission(id, input) {
    assertSubmissionId(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('O cadastro público não tem um formato válido.');
    }
    const keys = Object.keys(input);
    for (const key of keys) {
      if (!BASE_FIELDS.has(key) && !REVIEW_FIELDS.has(key)) {
        throw new Error('O cadastro contém um campo não permitido.');
      }
    }
    for (const field of BASE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) {
        throw new Error('O cadastro está incompleto.');
      }
    }
    if (typeof input.nome !== 'string' || input.nome.trim().length < 2 || input.nome.length > 120
      || typeof input.cpf !== 'string' || !/^\d{11}$/.test(input.cpf)
      || typeof input.telefone !== 'string' || !/^\d{10,11}$/.test(input.telefone)
      || typeof input.email !== 'string' || input.email.length > 254
      || !/^[^@ ]{1,100}@[^@ ]{1,100}\.[^@ ]{2,24}$/.test(input.email)
      || !POINTS.has(input.ponto) || !CLIENTS.has(input.cliente)
      || !STATUSES.has(input.revisao) || !isTimestamp(input.recebidoEm)) {
      throw new Error('O cadastro contém dados inválidos.');
    }
    const hasReviewTime=input.revisadoEm!==undefined;
    const hasReviewer=input.revisadoPor!==undefined;
    if(hasReviewTime!==hasReviewer) throw new Error('Os metadados da revisão estão incompletos.');
    if(input.revisao!=='pendente' && !hasReviewTime) throw new Error('Falta a data e o responsável pela revisão.');
    if (hasReviewTime && !isTimestamp(input.revisadoEm)) {
      throw new Error('A data de revisão não é válida.');
    }
    if (hasReviewer
      && (typeof input.revisadoPor !== 'string' || !input.revisadoPor.trim())) {
      throw new Error('O responsável pela revisão não é válido.');
    }
    return {
      nome: input.nome,
      cpf: input.cpf,
      telefone: input.telefone,
      email: input.email,
      ponto: input.ponto,
      cliente: input.cliente,
      recebidoEm: input.recebidoEm,
      revisao: input.revisao,
      ...(input.revisadoEm !== undefined ? { revisadoEm: input.revisadoEm } : {}),
      ...(input.revisadoPor !== undefined ? { revisadoPor: input.revisadoPor } : {}),
    };
  }

  function create(options) {
    if (!options || options.syncEnabled !== true) {
      throw new Error('A revisão de cadastros públicos continua desativada.');
    }
    if (!options.firestore || typeof options.firestore.collection !== 'function') {
      throw new Error('Firestore não foi inicializado.');
    }
    if (roleOf(options.profile) !== 'gestor') {
      throw new Error('Somente o gestor pode revisar cadastros públicos.');
    }
    if (!options.profile.uid || typeof options.serverTimestamp !== 'function') {
      throw new Error('A sessão do gestor não está pronta para revisar cadastros.');
    }

    const collection = options.firestore.collection('agendamentos');
    return Object.freeze({
      async list(limit = 501) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 501) {
          throw new Error('O limite de consulta não é válido.');
        }
        const snapshot = await collection.orderBy('recebidoEm', 'desc').limit(limit).get();
        return snapshot.docs.map((item) => ({
          ...validateSubmission(item.id, item.data()),
          __docId: item.id,
        }));
      },
      async updateReview(id, status) {
        const submissionId = assertSubmissionId(id);
        if (!STATUSES.has(status)) throw new Error('O estado da revisão não é válido.');
        await collection.doc(submissionId).update({
          revisao: status,
          revisadoEm: options.serverTimestamp(),
          revisadoPor: options.profile.uid,
        });
        return { id: submissionId, revisao: status };
      },
      async deleteOne(id) {
        const submissionId = assertSubmissionId(id);
        await collection.doc(submissionId).delete();
        return { id: submissionId };
      },
    });
  }

  return Object.freeze({ create, assertSubmissionId, validateSubmission });
});
