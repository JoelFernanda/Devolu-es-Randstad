/* Firestore repository for the product catalog.
 * Loaded by the development copy, but no app action can call it unless both
 * synchronization gates are explicitly enabled after emulator validation.
 */
(function (root, factory) {
  'use strict';
  const repository = factory();
  if (root) root.RandstadProductsRepository = repository;
  if (typeof module !== 'undefined' && module.exports) module.exports = repository;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MANAGE_ROLES = new Set(['gestor', 'estoque']);
  const READ_ROLES = new Set(['gestor', 'estoque', 'ponto']);
  const VALID_CLIENTS = new Set(['Shopee', 'Mercado Livre']);
  const MAX_BATCH_WRITES = 500;

  function roleOf(profile) {
    return String(profile && (profile.perfilBanco || profile.perfil) || '')
      .trim().toLowerCase();
  }

  function normalizeClient(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'sh' || text === 'shopee') return 'Shopee';
    if (text === 'ml' || text === 'mercado livre' || text === 'mercadolivre') {
      return 'Mercado Livre';
    }
    return '';
  }

  function requireProduct(product) {
    const codigo = String(product && product.codigo || '').trim();
    const descricao = String(product && product.descricao || '').trim();
    const cliente = normalizeClient(product && product.cliente);
    if (!codigo) throw new Error('O código do produto é obrigatório.');
    if (codigo.length > 200) throw new Error('O código do produto excede 200 caracteres.');
    if (!descricao) throw new Error('A descrição do produto é obrigatória.');
    if (descricao.length > 5000) throw new Error('A descrição excede 5.000 caracteres.');
    if (!VALID_CLIENTS.has(cliente)) throw new Error('O cliente do produto é inválido.');
    return { codigo, descricao, cliente };
  }

  // Preserve product-code case to match the current app's exact duplicate check.
  // Encoding the composite key prevents slash characters from changing the path.
  function documentId(product) {
    const normalized = requireProduct(product);
    return 'prod_' + encodeURIComponent(
      normalized.cliente.toLowerCase() + '|' + normalized.codigo
    );
  }

  function assertReady(options, manage) {
    if (!options || options.syncEnabled !== true) {
      throw new Error('Sincronização de produtos ainda está desativada.');
    }
    if (!options.firestore || typeof options.firestore.collection !== 'function') {
      throw new Error('Firestore não foi inicializado.');
    }
    const role = roleOf(options.profile);
    const allowed = manage ? MANAGE_ROLES.has(role) : READ_ROLES.has(role);
    if (!allowed) {
      throw new Error(manage
        ? 'Este perfil não pode gerenciar produtos.'
        : 'Este perfil não pode consultar produtos.');
    }
  }

  function record(product) {
    return {
      ...requireProduct(product),
      productKey: documentId(product)
    };
  }

  function storedRecord(id, input) {
    const allowed = new Set(['codigo', 'descricao', 'cliente', 'productKey']);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== allowed.size
      || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new Error('Um produto remoto contém campos não permitidos.');
    }
    if (typeof input.codigo !== 'string' || typeof input.descricao !== 'string'
      || typeof input.cliente !== 'string' || typeof input.productKey !== 'string') {
      throw new Error('Um produto remoto contém campos com formato inválido.');
    }
    const data = requireProduct(input);
    if (data.codigo !== input.codigo || data.descricao !== input.descricao
      || data.cliente !== input.cliente || input.productKey !== id
      || documentId(data) !== id) {
      throw new Error('A chave ou os dados de um produto remoto não correspondem.');
    }
    return { id, ...data, productKey: id };
  }

  function create(options) {
    function ready(manage) {
      assertReady(options, manage);
      return options.firestore.collection('produtos');
    }

    function reference(product, manage) {
      return ready(manage !== false).doc(documentId(product));
    }

    return Object.freeze({
      documentId,
      async list() {
        const snapshot = await ready(false).get();
        return snapshot.docs.map((item) => storedRecord(item.id, item.data()));
      },
      async get(product) {
        const ref = reference(product, false);
        const snapshot = await ref.get();
        return snapshot.exists ? storedRecord(snapshot.id, snapshot.data()) : null;
      },
      async create(product) {
        const ref = reference(product);
        const data = record(product);
        await options.firestore.runTransaction(async (transaction) => {
          const existing = await transaction.get(ref);
          if (existing.exists) throw new Error('Já existe um produto com este cliente e código.');
          transaction.set(ref, data);
        });
        return { id: ref.id, ...data };
      },
      async updateDescription(product) {
        const ref = reference(product);
        const data = record(product);
        await ref.update({ descricao: data.descricao });
        return { id: ref.id, ...data };
      },
      async rename(previousProduct, nextProduct) {
        const oldRef = reference(previousProduct);
        const newRef = reference(nextProduct);
        const data = record(nextProduct);
        if (oldRef.path === newRef.path) {
          await oldRef.update({ descricao: data.descricao });
          return { id: oldRef.id, ...data };
        }
        await options.firestore.runTransaction(async (transaction) => {
          const oldSnapshot = await transaction.get(oldRef);
          if (!oldSnapshot.exists) throw new Error('O produto original não foi encontrado no Firestore.');
          const newSnapshot = await transaction.get(newRef);
          if (newSnapshot.exists) throw new Error('Já existe um produto com este cliente e código.');
          transaction.set(newRef, data);
          transaction.delete(oldRef);
        });
        return { id: newRef.id, ...data };
      },
      async upsert(product) {
        const ref = reference(product);
        const data = record(product);
        await ref.set(data, { merge: true });
        return { id: ref.id, ...data };
      },
      async upsertMany(products) {
        const byId = new Map();
        for (const product of products || []) {
          const data = record(product);
          byId.set(data.productKey, data);
        }
        if (byId.size > MAX_BATCH_WRITES) {
          throw new Error('Importe no máximo 500 produtos por vez.');
        }
        if (byId.size === 0) return [];
        const collection = ready(true);
        const batch = options.firestore.batch();
        for (const [id, data] of byId.entries()) {
          batch.set(collection.doc(id), data, { merge: true });
        }
        await batch.commit();
        return Array.from(byId.entries(), ([id, data]) => ({ id, ...data }));
      },
      async remove(product) {
        const ref = reference(product);
        await ref.delete();
      }
    });
  }

  return Object.freeze({
    create,
    documentId,
    normalizeClient,
    roleOf
  });
});
