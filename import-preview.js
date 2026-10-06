/* Pure, redacted import preview. No Firestore, storage, upload, or mutation APIs. */
(function (root, factory) {
  'use strict';
  const preview = factory();
  if (root) root.RandstadImportPreview = preview;
  if (typeof module !== 'undefined' && module.exports) module.exports = preview;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_ROWS = 20000;
  const POINTS = new Map([
    ['aurora', 'Aurora'], ['vila aurora', 'Aurora'],
    ['franco da rocha', 'Franco da Rocha'], ['barueri', 'Barueri'],
  ]);
  const CLIENTS = new Map([
    ['sh', 'Shopee'], ['shopee', 'Shopee'],
    ['ml', 'Mercado Livre'], ['mercado livre', 'Mercado Livre'],
    ['mercadolivre', 'Mercado Livre'],
  ]);

  function fold(value) {
    return String(value == null ? '' : value).normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function headerMap(row) {
    const result = new Map();
    if (!row || typeof row !== 'object' || Array.isArray(row)) return result;
    Object.keys(row).forEach((key) => result.set(fold(key), row[key]));
    return result;
  }

  function first(row, ...aliases) {
    for (const alias of aliases) {
      const key = fold(alias);
      if (row.has(key)) return row.get(key);
    }
    return '';
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function report(rows) {
    const totals = { total: rows.length, ready: 0, review: 0, invalid: 0, rows };
    rows.forEach((item) => { totals[item.status] += 1; });
    return Object.freeze(totals);
  }

  function assertRows(input) {
    const rows = Array.from(input || []);
    if (rows.length > MAX_ROWS) throw new Error('Arquivo acima do limite para prévia.');
    return rows;
  }

  function previewCollaborators(input, existingInput) {
    const inputRows = assertRows(input);
    const normalized = inputRows.map((raw) => {
      const row = headerMap(raw);
      const nameValue = first(row, 'Nome');
      const cpfValue = first(row, 'CPF');
      const phoneValue = first(row, 'Telefone', 'Tel');
      const pointValue = first(row, 'Ponto', 'Unidade');
      const clientValue = first(row, 'Cliente');
      const reasons = [];
      const cpf = typeof cpfValue === 'string' ? cpfValue.replace(/[^0-9]/g, '') : '';
      if (!text(nameValue)) reasons.push('nome_ausente_ou_nao_textual');
      if (typeof cpfValue !== 'string') reasons.push('cpf_deve_ser_texto');
      else if (!cpf || cpf.length > 20) reasons.push('cpf_vazio_ou_fora_do_limite');
      if (!text(phoneValue)) reasons.push('telefone_ausente_ou_nao_textual');
      const point = typeof pointValue === 'string' ? POINTS.get(pointValue.trim().toLowerCase()) || '' : '';
      if (!point) reasons.push('ponto_invalido');
      let client = '';
      if (typeof clientValue !== 'string') reasons.push('cliente_nao_textual');
      else if (clientValue.trim()) {
        client = CLIENTS.get(clientValue.trim().toLowerCase()) || '';
        if (!client) reasons.push('cliente_invalido');
      }
      return { cpf, reasons, point, client };
    });

    const sourceCounts = new Map();
    normalized.forEach((item) => {
      if (item.cpf) sourceCounts.set(item.cpf, (sourceCounts.get(item.cpf) || 0) + 1);
    });
    const existingCounts = new Map();
    Array.from(existingInput || []).forEach((item) => {
      const cpf = item && typeof item.cpf === 'string' ? item.cpf.replace(/[^0-9]/g, '') : '';
      if (cpf) existingCounts.set(cpf, (existingCounts.get(cpf) || 0) + 1);
    });

    return report(normalized.map((item, index) => {
      const duplicateRowsInFile = item.cpf ? Math.max(0, (sourceCounts.get(item.cpf) || 0) - 1) : 0;
      const existingMatches = item.cpf ? (existingCounts.get(item.cpf) || 0) : 0;
      const reasons = item.reasons.slice();
      if (duplicateRowsInFile) reasons.push('cpf_repetido_no_arquivo_revisao_manual');
      if (existingMatches) reasons.push('cpf_com_correspondencia_existente_revisao_manual');
      const status = item.reasons.length ? 'invalid' : (duplicateRowsInFile || existingMatches ? 'review' : 'ready');
      return Object.freeze({ row: index + 2, status, reasons: Object.freeze(reasons), duplicateRowsInFile, existingMatches });
    }));
  }

  function previewProducts(input, existingInput) {
    const inputRows = assertRows(input);
    const normalized = inputRows.map((raw) => {
      const row = headerMap(raw);
      const codeValue = first(row, 'Código', 'Codigo', 'Cod');
      const descriptionValue = first(row, 'Descrição', 'Descricao', 'Desc');
      const clientValue = first(row, 'Cliente');
      const reasons = [];
      const code = text(codeValue);
      if (!code) reasons.push('codigo_ausente_ou_nao_textual');
      if (!text(descriptionValue)) reasons.push('descricao_ausente_ou_nao_textual');
      let client = '';
      if (typeof clientValue !== 'string') reasons.push('cliente_invalido');
      else {
        client = CLIENTS.get(clientValue.trim().toLowerCase()) || '';
        if (!client) reasons.push('cliente_invalido');
      }
      return { code, client, reasons };
    });

    const keyFor = (client, code) => `${client}\u0000${code}`;
    const sourceCounts = new Map();
    normalized.forEach((item) => {
      if (item.client && item.code) {
        const key = keyFor(item.client, item.code);
        sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
      }
    });
    const existingCounts = new Map();
    Array.from(existingInput || []).forEach((item) => {
      if (!item || typeof item.codigo !== 'string' || typeof item.cliente !== 'string') return;
      const client = CLIENTS.get(item.cliente.trim().toLowerCase()) || '';
      if (!client || !item.codigo.trim()) return;
      const key = keyFor(client, item.codigo.trim());
      existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
    });

    return report(normalized.map((item, index) => {
      const key = item.client && item.code ? keyFor(item.client, item.code) : '';
      const duplicateRowsInFile = key ? Math.max(0, (sourceCounts.get(key) || 0) - 1) : 0;
      const existingMatches = key ? (existingCounts.get(key) || 0) : 0;
      const reasons = item.reasons.slice();
      if (duplicateRowsInFile) reasons.push('produto_repetido_no_arquivo_revisao_manual');
      if (existingMatches) reasons.push('produto_ja_cadastrado_revisao_manual');
      const status = item.reasons.length ? 'invalid' : (duplicateRowsInFile || existingMatches ? 'review' : 'ready');
      return Object.freeze({ row: index + 2, status, reasons: Object.freeze(reasons), duplicateRowsInFile, existingMatches });
    }));
  }

  return Object.freeze({ MAX_ROWS, previewCollaborators, previewProducts });
});
