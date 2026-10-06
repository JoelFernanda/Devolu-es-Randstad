/* In-memory session state for PII records. Never persist this object. */
(function (root, factory) {
  'use strict';
  const stateApi = factory();
  if (root) root.RandstadPiiState = stateApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = stateApi;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const READ_ROLES = new Set(['gestor', 'estoque', 'ponto', 'cliente']);
  const POINTS = new Set(['Aurora', 'Franco da Rocha', 'Barueri']);
  const CLIENTS = new Set(['Shopee', 'Mercado Livre']);
  let ownerUid = null;
  let generation = 0;
  let collaborators = [];
  let returns = [];

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '').trim().toLowerCase();
  }

  function normalizePoint(value) {
    const point = String(value || '').trim();
    const canonical = point === 'Vila Aurora' ? 'Aurora' : point;
    return POINTS.has(canonical) ? canonical : '';
  }

  function normalizeClient(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'sh' || text === 'shopee') return 'Shopee';
    if (text === 'ml' || text === 'mercado livre' || text === 'mercadolivre') return 'Mercado Livre';
    return '';
  }

  function assertProfile(profile) {
    const uid = String(profile && profile.uid || '').trim();
    const role = roleOf(profile);
    if (!uid || !READ_ROLES.has(role)) {
      throw new Error('Este perfil não pode manter registros pessoais em memória.');
    }
    if (role === 'ponto' && !normalizePoint(profile.ponto)) {
      throw new Error('O ponto desta conta não está configurado.');
    }
    if (role === 'cliente' && !CLIENTS.has(normalizeClient(profile.cliente))) {
      throw new Error('O cliente desta conta não está configurado.');
    }
    return { uid, role };
  }

  function assertOwner(profile) {
    const current = assertProfile(profile);
    if (!ownerUid || current.uid !== ownerUid) {
      throw new Error('O estado pessoal desta sessão não está disponível.');
    }
    return current;
  }

  function assertOpaqueId(id, prefix) {
    const value = String(id || '');
    if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,40}$`).test(value)) {
      throw new Error('O identificador pessoal não é opaco ou válido.');
    }
    return value;
  }

  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
    const result = {};
    Object.keys(value).forEach((key) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      result[key] = copy(value[key]);
    });
    return result;
  }

  function assertScoped(profile, row) {
    const role = roleOf(profile);
    if (role === 'ponto' && normalizePoint(row.ponto) !== normalizePoint(profile.ponto)) {
      throw new Error('O registro retornado está fora do ponto autorizado.');
    }
    if (role === 'cliente' && normalizeClient(row.cliente) !== normalizeClient(profile.cliente)) {
      throw new Error('O registro retornado está fora do cliente autorizado.');
    }
  }

  function checkedRows(profile, rows, kind) {
    if (!Array.isArray(rows)) throw new Error('A lista de registros pessoais não é válida.');
    return rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('Um registro pessoal não é válido.');
      }
      assertOpaqueId(row.__docId, kind === 'collaborator' ? 'colab' : 'return');
      assertScoped(profile, row);
      return copy(row);
    });
  }

  function replace(profile, data) {
    clear();
    const current = assertProfile(profile);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('O conjunto de registros pessoais não é válido.');
    }
    const nextCollaborators = checkedRows(profile, data.collaborators, 'collaborator');
    const nextReturns = checkedRows(profile, data.returns, 'return');

    ownerUid = current.uid;
    collaborators = nextCollaborators;
    returns = nextReturns;
  }

  async function hydrate(profile, repository) {
    clear();
    const requestGeneration = generation;
    assertProfile(profile);
    if (!repository || typeof repository.listCollaborators !== 'function'
      || typeof repository.listReturns !== 'function') {
      throw new Error('O repositório pessoal não está disponível.');
    }
    const [nextCollaborators, nextReturns] = await Promise.all([
      repository.listCollaborators(),
      repository.listReturns(),
    ]);
    if (generation !== requestGeneration) {
      throw new Error('A sessão mudou durante a leitura dos registros pessoais.');
    }
    replace(profile, { collaborators: nextCollaborators, returns: nextReturns });
    return true;
  }

  function listCollaborators(profile) {
    assertOwner(profile);
    return copy(collaborators);
  }

  function getCollaborator(profile, id) {
    assertOwner(profile);
    const opaqueId = assertOpaqueId(id, 'colab');
    const record = collaborators.find((item) => item.__docId === opaqueId);
    return record ? copy(record) : null;
  }

  function listReturns(profile) {
    assertOwner(profile);
    return copy(returns);
  }

  function recordCommittedCollaboratorUpdate(profile, id, patch) {
    const current = assertOwner(profile);
    if (!['gestor', 'estoque'].includes(current.role)) {
      throw new Error('Este perfil não pode atualizar o cadastro em memória.');
    }
    const collaboratorId = assertOpaqueId(id, 'colab');
    const index = collaborators.findIndex((item) => item.__docId === collaboratorId);
    if (index < 0) throw new Error('O cadastro não está carregado nesta sessão.');
    const existing = collaborators[index];
    if (existing.status !== 'aguardando'
      || returns.some((item) => item.colaboradorId === collaboratorId)) {
      throw new Error('Cadastros com devolução registrada não podem ser alterados por esta tela.');
    }
    const allowed = new Set(['nome', 'cpf', 'telefone', 'email', 'ponto', 'cliente']);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some((key) => !allowed.has(key))) {
      throw new Error('Os campos alterados não são válidos.');
    }
    const updated = { ...existing, ...copy(patch) };
    if (!normalizePoint(updated.ponto)) throw new Error('O ponto do cadastro não é válido.');
    if (updated.cliente !== '' && !normalizeClient(updated.cliente)) {
      throw new Error('O cliente do cadastro não é válido.');
    }
    collaborators = collaborators.map((item, position) => position === index ? updated : item);
    return copy(updated);
  }

  function recordCommittedReturn(profile, record) {
    assertOwner(profile);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('O comprovante confirmado não é válido.');
    }
    const returnId = assertOpaqueId(record.__docId, 'return');
    const collaboratorId = assertOpaqueId(record.colaboradorId, 'colab');
    const existingIndex = returns.findIndex((item) => item.__docId === returnId);
    if (existingIndex >= 0) {
      const existing = returns[existingIndex];
      if (existing.colaboradorId !== collaboratorId) throw new Error('O comprovante conflita com o estado em memória.');
      return copy(existing);
    }
    const collaboratorIndex = collaborators.findIndex((item) => item.__docId === collaboratorId);
    if (collaboratorIndex < 0) throw new Error('O cadastro não está carregado nesta sessão.');
    const collaborator = collaborators[collaboratorIndex];
    if (collaborator.status !== 'aguardando'
      || normalizePoint(collaborator.ponto) !== normalizePoint(record.ponto)
      || (normalizeClient(collaborator.cliente)
        && normalizeClient(collaborator.cliente) !== normalizeClient(record.cliente))) {
      throw new Error('O cadastro mudou e o comprovante não pode ser aplicado ao estado em memória.');
    }
    assertScoped(profile, record);
    const updatedCollaborator = {
      ...collaborator,
      status: 'devolvido',
      ultimoReturnId: returnId,
    };
    if (!normalizeClient(updatedCollaborator.cliente)) {
      updatedCollaborator.cliente = normalizeClient(record.cliente);
    }
    collaborators = collaborators.map((item, index) => index === collaboratorIndex ? updatedCollaborator : item);
    const updatedReturn = copy(record);
    returns = [...returns, updatedReturn];
    return copy(updatedReturn);
  }

  function clear() {
    generation += 1;
    ownerUid = null;
    collaborators = [];
    returns = [];
  }

  return Object.freeze({
    assertOpaqueId,
    clear,
    getCollaborator,
    hydrate,
    listCollaborators,
    listReturns,
    recordCommittedCollaboratorUpdate,
    recordCommittedReturn,
    replace,
  });
});
