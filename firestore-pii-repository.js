/* Role-scoped Firestore repository for collaborators and returns.
 * The main app loads this module; repository methods still require their sync gate.
 * Public intake is handled by separate modules.
 */
(function (root, factory) {
  'use strict';
  const repository = factory();
  if (root) root.RandstadPiiRepository = repository;
  if (typeof module !== 'undefined' && module.exports) module.exports = repository;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MANAGE_ROLES = new Set(['gestor', 'estoque']);
  const READ_ROLES = new Set(['gestor', 'estoque', 'ponto', 'cliente']);
  const POINT_ROLES = new Set(['ponto']);
  const POINTS = new Set(['Aurora', 'Franco da Rocha', 'Barueri']);
  const CLIENTS = new Set(['Shopee', 'Mercado Livre']);
  const COLLABORATOR_FIELDS = new Set([
    'nome', 'cpf', 'telefone', 'email', 'ponto', 'cliente', 'status',
    'volumes', 'dataInsercao', 'dataInsercaoISO', 'origem', 'codigoProtocolo',
    'ultimoReturnId',
  ]);
  const RETURN_FIELDS = new Set([
    'cpf', 'nome', 'telefone', 'ponto', 'cliente', 'quantidadeLinhas', 'volumes',
    'codigoUnico', 'dataHora', 'coletado', 'colaboradorId',
    'protocoloDia', 'protocoloSequencia',
  ]);
  const RETURN_INPUT_FIELDS = new Set([
    'cpf', 'nome', 'telefone', 'ponto', 'cliente', 'itens', 'volumes', 'colaboradorId',
  ]);
  const MANAGER_COLLABORATOR_UPDATE_FIELDS = new Set([
    'nome', 'telefone', 'email', 'ponto', 'cliente',
  ]);
  const POINT_UPDATE_FIELDS = new Set(['cliente']);
  const MAX_COLLABORATOR_IMPORT = 400;

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '')
      .trim().toLowerCase();
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

  function normalizeCpf(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function assertActive(options) {
    if (!options || options.syncEnabled !== true) {
      throw new Error('A sincronização dos registros pessoais continua desativada.');
    }
    if (!options.firestore || typeof options.firestore.collection !== 'function') {
      throw new Error('Firestore não foi inicializado.');
    }
    const role = roleOf(options.profile);
    if (!READ_ROLES.has(role)) throw new Error('Este perfil não pode acessar registros pessoais.');
    return role;
  }

  function assertManager(role) {
    if (!MANAGE_ROLES.has(role)) {
      throw new Error('Somente Gestor e Estoque podem gerenciar estes registros.');
    }
  }

  function assertOpaqueId(id, prefix) {
    const value = String(id || '');
    if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,40}$`).test(value)) {
      throw new Error('O identificador do registro não é válido.');
    }
    return value;
  }

  function allowlisted(input, fieldSet) {
    const data = {};
    for (const [key, value] of Object.entries(input || {})) {
      if (!fieldSet.has(key)) throw new Error('O registro contém um campo não permitido.');
      data[key] = value;
    }
    return data;
  }

  function validateCollaborator(input) {
    const data = allowlisted(input, COLLABORATOR_FIELDS);
    const required = ['nome', 'cpf', 'telefone', 'ponto', 'cliente', 'status'];
    if (required.some((field) => !Object.prototype.hasOwnProperty.call(data, field))) {
      throw new Error('O cadastro não contém todos os campos obrigatórios.');
    }
    if (['nome', 'cpf', 'telefone', 'ponto', 'cliente', 'status']
      .some((field) => typeof data[field] !== 'string')) {
      throw new Error('Os campos básicos do cadastro precisam ser textos.');
    }
    data.nome = data.nome.trim();
    data.cpf = data.cpf.trim();
    data.telefone = data.telefone.trim();
    data.ponto = normalizePoint(data.ponto);
    data.cliente = data.cliente === '' ? '' : normalizeClient(data.cliente);
    if (!data.nome || !data.cpf || data.cpf.length > 20 || !data.telefone) {
      throw new Error('Nome, CPF e telefone são obrigatórios.');
    }
    if (!data.ponto) throw new Error('O ponto do colaborador não é válido.');
    if (data.cliente !== '' && !CLIENTS.has(data.cliente)) {
      throw new Error('O cliente do colaborador não é válido.');
    }
    if (!['aguardando', 'devolvido', 'coletado'].includes(data.status)) {
      throw new Error('O estado do colaborador não é válido.');
    }
    if (data.email !== undefined && typeof data.email !== 'string') {
      throw new Error('O e-mail do colaborador não é válido.');
    }
    if (data.volumes !== undefined
      && (!Number.isSafeInteger(data.volumes) || data.volumes < 0)) {
      throw new Error('A quantidade de volumes do colaborador não é válida.');
    }
    for (const key of ['dataInsercao', 'dataInsercaoISO', 'origem', 'codigoProtocolo']) {
      if (data[key] !== undefined && typeof data[key] !== 'string') {
        throw new Error(`O campo ${key} do colaborador não é válido.`);
      }
    }
    if (data.ultimoReturnId !== undefined) assertOpaqueId(data.ultimoReturnId, 'return');
    return data;
  }

  function validateStoredCollaborator(input, id) {
    assertOpaqueId(id, 'colab');
    const data = validateCollaborator(input);
    if (data.ponto !== String(input.ponto || '').trim()
      || data.cliente !== (input.cliente === '' ? '' : String(input.cliente || '').trim())) {
      throw new Error('Um cadastro remoto tem ponto ou cliente fora do formato canônico.');
    }
    return data;
  }

  function validateReturnInput(input) {
    const data = allowlisted(input, RETURN_INPUT_FIELDS);
    data.nome = String(data.nome || '').trim();
    data.cpf = String(data.cpf || '').trim();
    data.telefone = String(data.telefone || '').trim();
    data.ponto = normalizePoint(data.ponto);
    data.cliente = normalizeClient(data.cliente);
    if (!data.nome || !data.cpf || data.cpf.length > 20 || !data.telefone) {
      throw new Error('Nome, CPF e telefone são obrigatórios.');
    }
    if (!data.ponto || !CLIENTS.has(data.cliente)) {
      throw new Error('O ponto ou cliente da devolução não é válido.');
    }
    if (!Array.isArray(data.itens) || data.itens.length === 0 || data.itens.length > 100) {
      throw new Error('A devolução precisa conter de 1 a 100 itens.');
    }
    data.itens = data.itens.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Um item da devolução não é válido.');
      }
      const safeItem = allowlisted(item, new Set(['codigo', 'descricao', 'qtd']));
      if (typeof safeItem.codigo !== 'string' || !safeItem.codigo.trim()
        || typeof safeItem.descricao !== 'string' || !safeItem.descricao.trim()
        || !Number.isSafeInteger(safeItem.qtd) || safeItem.qtd < 1) {
        throw new Error('Um item da devolução não é válido.');
      }
      return { codigo: safeItem.codigo.trim(), descricao: safeItem.descricao.trim(), qtd: safeItem.qtd };
    });
    if (!Number.isSafeInteger(data.volumes) || data.volumes < 0) {
      throw new Error('A quantidade de volumes não é válida.');
    }
    assertOpaqueId(data.colaboradorId, 'colab');
    return data;
  }

  function validateQueueItem(input, itemId) {
    if (!/^item_0\d{2}$/.test(String(itemId || ''))) {
      throw new Error('O identificador do item da fila não é válido.');
    }
    const item = allowlisted(input, new Set(['codigo', 'descricao', 'qtd']));
    if (typeof item.codigo !== 'string' || !item.codigo.trim() || item.codigo.length > 200
      || typeof item.descricao !== 'string' || !item.descricao.trim() || item.descricao.length > 5000
      || !Number.isSafeInteger(item.qtd) || item.qtd < 1) {
      throw new Error('Um item de material da fila não é válido.');
    }
    return { codigo: item.codigo.trim(), descricao: item.descricao.trim(), qtd: item.qtd };
  }

  function validateStoredReturn(input, id) {
    assertOpaqueId(id, 'return');
    const data = allowlisted(input, RETURN_FIELDS);
    const required = [
      'cpf', 'nome', 'telefone', 'ponto', 'cliente', 'quantidadeLinhas', 'volumes',
      'codigoUnico', 'dataHora', 'coletado', 'colaboradorId',
      'protocoloDia', 'protocoloSequencia',
    ];
    if (Object.keys(data).length !== required.length
      || required.some((field) => !Object.prototype.hasOwnProperty.call(data, field))) {
      throw new Error('Uma devolução remota contém campos ausentes ou extras.');
    }
    if (typeof data.cpf !== 'string' || !data.cpf.trim() || data.cpf.length > 20
      || typeof data.nome !== 'string' || !data.nome.trim()
      || typeof data.telefone !== 'string'
      || normalizePoint(data.ponto) !== data.ponto
      || !CLIENTS.has(data.cliente)
      || !Number.isSafeInteger(data.quantidadeLinhas) || data.quantidadeLinhas < 1
      || data.quantidadeLinhas > 100
      || !Number.isSafeInteger(data.volumes) || data.volumes < 0
      || typeof data.codigoUnico !== 'string' || !/^[A-Z]{2}[0-9]{6}[0-9]{4,}$/.test(data.codigoUnico)
      || typeof data.dataHora !== 'string' || typeof data.coletado !== 'boolean'
      || typeof data.protocoloDia !== 'string' || !/^[0-9]{6}$/.test(data.protocoloDia)
      || !Number.isSafeInteger(data.protocoloSequencia) || data.protocoloSequencia < 1) {
      throw new Error('Uma devolução remota contém dados inválidos.');
    }
    assertOpaqueId(data.colaboradorId, 'colab');
    return data;
  }

  function protocolDay(now) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: '2-digit',
    }).formatToParts(now || new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.day}${values.month}${values.year}`;
  }

  function protocolInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error('O nome do colaborador não é válido para gerar o protocolo.');
    const firstLetter = (word) => word.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase();
    const first = firstLetter(words[0]);
    const last = firstLetter(words[words.length - 1]);
    if (!first || !last) throw new Error('Não foi possível gerar as iniciais do protocolo.');
    return `${first}${last}`;
  }

  function formatDateTime(now) {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now || new Date());
  }

  function create(options) {
    const collection = (name) => options.firestore.collection(name);

    function scopedQuery(name, role) {
      const ref = collection(name);
      if (MANAGE_ROLES.has(role)) return ref;
      if (role === 'ponto') {
        const point = normalizePoint(options.profile.ponto);
        if (!point) throw new Error('O ponto desta conta não está configurado.');
        return ref.where('ponto', '==', point);
      }
      if (role === 'cliente') {
        const client = normalizeClient(options.profile.cliente);
        if (!client) throw new Error('O cliente desta conta não está configurado.');
        return ref.where('cliente', '==', client);
      }
      throw new Error('Este perfil não pode consultar registros pessoais.');
    }

    async function list(name, role, validateRow) {
      const snapshot = await scopedQuery(name, role).get();
      return snapshot.docs.map((item) => ({
        ...validateRow(item.data(), item.id),
        __docId: item.id,
      }));
    }

    function newOpaqueRef(name, prefix) {
      const ref = collection(name);
      const autoId = ref.doc().id;
      return ref.doc(`${prefix}_${autoId}`);
    }

    return Object.freeze({
      assertOpaqueId,
      normalizeClient,
      normalizeCpf,
      normalizePoint,
      protocolDay,
      protocolInitials,
      async listCollaborators() {
        return list('colaboradores', assertActive(options), validateStoredCollaborator);
      },
      async listReturns() {
        const role = assertActive(options);
        const records = await list('devolucoes', role, validateStoredReturn);
        return Promise.all(records.map(async (record) => {
          const returnId = assertOpaqueId(record.__docId, 'return');
          const snapshot = await collection('filaColetas').doc(returnId).collection('itens').get();
          const itemDocs = snapshot.docs.slice().sort((left, right) => left.id.localeCompare(right.id));
          const itens = itemDocs.map((item, index) => {
            const expectedId = `item_${String(index).padStart(3, '0')}`;
            if (item.id !== expectedId) {
              throw new Error('Os identificadores dos itens desta devolução estão incompletos ou divergentes.');
            }
            return validateQueueItem(item.data(), item.id);
          });
          if (!Number.isSafeInteger(record.quantidadeLinhas)
            || itens.length !== record.quantidadeLinhas) {
            throw new Error('Os itens desta devolução estão incompletos ou divergentes.');
          }
          return { ...record, itens };
        }));
      },
      async findCollaboratorsByCpf(cpf) {
        const role = assertActive(options);
        assertManager(role);
        const digits = normalizeCpf(cpf);
        if (!digits) return [];
        const snapshot = await collection('colaboradores').where('cpf', '==', digits).get();
        return snapshot.docs.map((item) => ({
          ...validateStoredCollaborator(item.data(), item.id),
          __docId: item.id,
        }));
      },
      async createCollaborator(input) {
        const role = assertActive(options);
        assertManager(role);
        const data = validateCollaborator(input);
        if (data.status !== 'aguardando' || data.ultimoReturnId || data.codigoProtocolo) {
          throw new Error('Um novo colaborador deve iniciar aguardando e sem histórico de devolução.');
        }
        const ref = newOpaqueRef('colaboradores', 'colab');
        await ref.set(data);
        return { ...data, __docId: ref.id };
      },
      async createCollaborators(inputs) {
        const role = assertActive(options);
        assertManager(role);
        if (!Array.isArray(inputs)) throw new Error('A planilha de colaboradores não é válida.');
        if (inputs.length > MAX_COLLABORATOR_IMPORT) {
          throw new Error(`Importe no máximo ${MAX_COLLABORATOR_IMPORT} colaboradores por vez.`);
        }
        if (!inputs.length) return [];
        if (!options.firestore || typeof options.firestore.batch !== 'function') {
          throw new Error('O Firestore precisa suportar gravação em lote para importar colaboradores.');
        }
        const records = inputs.map(validateCollaborator);
        if (records.some((data) => data.status !== 'aguardando'
          || data.ultimoReturnId || data.codigoProtocolo)) {
          throw new Error('A importação aceita apenas novos colaboradores aguardando devolução.');
        }
        const batch = options.firestore.batch();
        const created = records.map((data) => {
          const ref = newOpaqueRef('colaboradores', 'colab');
          batch.set(ref, data);
          return { ...data, __docId: ref.id };
        });
        await batch.commit();
        return created;
      },
      async updateCollaborator(id, patch) {
        const role = assertActive(options);
        const collaboratorId = assertOpaqueId(id, 'colab');
        const allowed = role === 'ponto' ? POINT_UPDATE_FIELDS : MANAGER_COLLABORATOR_UPDATE_FIELDS;
        if (!MANAGE_ROLES.has(role) && !POINT_ROLES.has(role)) {
          throw new Error('Este perfil não pode alterar o cadastro.');
        }
        const data = allowlisted(patch, allowed);
        if (role === 'ponto') {
          if (data.cliente !== undefined && data.cliente !== '') {
            data.cliente = normalizeClient(data.cliente);
            if (!CLIENTS.has(data.cliente)) throw new Error('O cliente não é válido.');
          }
        }
        await collection('colaboradores').doc(collaboratorId).update(data);
      },
      async createReturn(input) {
        const role = assertActive(options);
        if (!MANAGE_ROLES.has(role) && !POINT_ROLES.has(role)) {
          throw new Error('Este perfil não pode registrar devoluções.');
        }
        if (typeof options.firestore.runTransaction !== 'function') {
          throw new Error('O Firestore precisa suportar transações para registrar devoluções com segurança.');
        }
        if (typeof options.serverTimestamp !== 'function') {
          throw new Error('O horário seguro do servidor não foi configurado para registrar a devolução.');
        }
        const data = validateReturnInput(input);
        if (role === 'ponto' && data.ponto !== normalizePoint(options.profile.ponto)) {
          throw new Error('Este ponto não pode criar devolução para outra unidade.');
        }
        const collaboratorId = data.colaboradorId;
        const collaboratorRef = collection('colaboradores').doc(collaboratorId);
        const day = protocolDay();
        const sequenceRef = collection('sequenciais').doc(day);
        const returnRef = newOpaqueRef('devolucoes', 'return');
        const queueRef = collection('filaColetas').doc(returnRef.id);
        const now = new Date();

        const committed = await options.firestore.runTransaction(async (transaction) => {
          const collaboratorSnapshot = await transaction.get(collaboratorRef);
          const sequenceSnapshot = await transaction.get(sequenceRef);
          if (!collaboratorSnapshot.exists) throw new Error('O cadastro selecionado não existe mais.');
          const collaborator = collaboratorSnapshot.data();
          if (normalizePoint(collaborator.ponto) !== data.ponto
            || normalizeCpf(collaborator.cpf) !== normalizeCpf(data.cpf)) {
            throw new Error('O cadastro não corresponde ao ponto ou CPF selecionado.');
          }
          if (collaborator.status !== 'aguardando') {
            throw new Error('Este cadastro não está aguardando devolução.');
          }
          const currentClient = normalizeClient(collaborator.cliente);
          if (currentClient && currentClient !== data.cliente) {
            throw new Error('O cliente escolhido não corresponde ao cadastro.');
          }
          const priorValue = sequenceSnapshot.exists ? sequenceSnapshot.data().value : 0;
          if (!Number.isSafeInteger(priorValue) || priorValue < 0) {
            throw new Error('O contador de protocolos está inválido; nenhum dado foi gravado.');
          }
          const nextValue = priorValue + 1;
          if (!Number.isSafeInteger(nextValue)) {
            throw new Error('O contador de protocolos atingiu o limite seguro.');
          }
          const initials = protocolInitials(collaborator.nome);
          const codigoUnico = `${initials}${day}${String(nextValue).padStart(4, '0')}`;
          const protocolRef = collection('protocolos').doc(codigoUnico);
          const finalRecord = {
            cpf: String(collaborator.cpf),
            nome: String(collaborator.nome),
            telefone: String(collaborator.telefone || ''),
            ponto: data.ponto,
            cliente: data.cliente,
            quantidadeLinhas: data.itens.length,
            volumes: data.volumes,
            codigoUnico,
            dataHora: formatDateTime(now),
            coletado: false,
            colaboradorId: collaboratorId,
            protocoloDia: day,
            protocoloSequencia: nextValue,
          };
          const collaboratorPatch = {
            status: 'devolvido',
            ultimoReturnId: returnRef.id,
          };
          if (!currentClient) collaboratorPatch.cliente = data.cliente;
          transaction.set(sequenceRef, {
            dateKey: day,
            value: nextValue,
            returnId: returnRef.id,
            codigoUnico,
            colaboradorId: collaboratorId,
          });
          transaction.set(protocolRef, {
            returnId: returnRef.id,
            dateKey: day,
            value: nextValue,
            colaboradorId: collaboratorId,
          });
          transaction.set(returnRef, finalRecord);
          transaction.set(queueRef, {
            returnId: returnRef.id,
            ponto: data.ponto,
            cliente: data.cliente,
            quantidadeLinhas: data.itens.length,
            status: 'pendente',
            coletaId: '',
            criadoEm: options.serverTimestamp(),
            coletadoEm: null,
          });
          data.itens.forEach((item, index) => {
            const itemId = `item_${String(index).padStart(3, '0')}`;
            transaction.set(queueRef.collection('itens').doc(itemId), validateQueueItem(item, itemId));
          });
          transaction.update(collaboratorRef, collaboratorPatch);
          return { ...finalRecord, itens: data.itens };
        });
        return { ...committed, __docId: returnRef.id };
      },
    });
  }

  return Object.freeze({
    create,
    normalizeClient,
    normalizeCpf,
    normalizePoint,
    protocolDay,
    protocolInitials,
    roleOf,
    validateCollaborator,
    validateQueueItem,
    validateReturnInput,
    validateStoredCollaborator,
    validateStoredReturn,
  });
});
