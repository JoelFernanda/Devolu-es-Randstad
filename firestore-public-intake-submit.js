/* Create-only public intake submission.
 * No reads, duplicate lookups, canonical collaborator writes, or localStorage writes.
 * The production gate must remain closed until anti-abuse controls and Rules are validated.
 */
(function (root, factory) {
  'use strict';
  const submitter = factory();
  if (root) root.RandstadPublicIntakeSubmit = submitter;
  if (typeof module !== 'undefined' && module.exports) module.exports = submitter;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const POINTS = new Set(['Aurora', 'Franco da Rocha', 'Barueri']);
  const CLIENTS = new Set(['Shopee', 'Mercado Livre']);

  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Confira os dados do cadastro.');
    }
    const allowed = new Set(['nome', 'cpf', 'telefone', 'email', 'ponto', 'cliente']);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new Error('O cadastro contém um campo não permitido.');
    }
    const data = {
      nome: typeof input.nome === 'string' ? input.nome.trim() : '',
      cpf: typeof input.cpf === 'string' ? input.cpf.replace(/\D/g, '') : '',
      telefone: typeof input.telefone === 'string' ? input.telefone.replace(/\D/g, '') : '',
      email: typeof input.email === 'string' ? input.email.trim().toLowerCase() : '',
      ponto: input.ponto,
      cliente: input.cliente,
    };
    if (data.nome.length < 2 || data.nome.length > 120
      || !/^\d{11}$/.test(data.cpf)
      || !/^\d{10,11}$/.test(data.telefone)
      || data.email.length > 254
      || !/^[^@ ]{1,100}@[^@ ]{1,100}\.[^@ ]{2,24}$/.test(data.email)
      || !POINTS.has(data.ponto) || !CLIENTS.has(data.cliente)) {
      throw new Error('Confira nome, CPF, telefone, e-mail, cliente e ponto.');
    }
    return data;
  }

  function create(options) {
    if (!options || options.syncEnabled !== true) {
      throw new Error('O cadastro público ainda não está liberado.');
    }
    if (!options.firestore || typeof options.firestore.collection !== 'function'
      || typeof options.serverTimestamp !== 'function') {
      throw new Error('O serviço de cadastro não está disponível.');
    }
    const collection = options.firestore.collection('agendamentos');
    if (!collection || typeof collection.doc !== 'function') {
      throw new Error('O serviço de cadastro não está disponível.');
    }
    return Object.freeze({
      async submit(input) {
        const data = validate(input);
        const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
        const rawId = typeof options.createId === 'function'
          ? options.createId()
          : (cryptoApi && typeof cryptoApi.randomUUID === 'function' ? cryptoApi.randomUUID() : '');
        if (typeof rawId !== 'string' || !/^[A-Za-z0-9_-]{20,40}$/.test(rawId)) {
          throw new Error('Não foi possível preparar o identificador seguro do cadastro.');
        }
        const id = `submission_${rawId}`;
        const recordRef = collection.doc(id);
        if (!recordRef || typeof recordRef.set !== 'function') {
          throw new Error('O serviço de cadastro não está disponível.');
        }
        await recordRef.set({
          ...data,
          recebidoEm: options.serverTimestamp(),
          revisao: 'pendente',
        });
        return { id };
      },
    });
  }

  return Object.freeze({ create, validate });
});
