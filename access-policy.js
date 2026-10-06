/* Client-side role defaults. Firestore Rules remain the security boundary. */
(function (root, factory) {
  'use strict';
  const policy = factory();
  if (root) root.RandstadAccessPolicy = policy;
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MANAGER_MODULES = Object.freeze([
    'dashboard',
    'colaboradores',
    'produtos',
    'importar',
    'historico-import',
    'lavanderia',
    'relatorios',
    'historico-coletas'
  ]);
  const STOCK_MODULES = Object.freeze([
    'dashboard',
    'colaboradores',
    'produtos',
    'importar',
    'historico-import',
    'lavanderia',
    'relatorios'
  ]);

  // perfilBanco is authoritative when present; perfil is kept as a UI fallback.
  function roleOf(profile) {
    if (!profile) return '';
    return String(profile.perfilBanco || profile.perfil || '').trim().toLowerCase();
  }

  function modulesFor(profile) {
    const role = roleOf(profile);
    if (role === 'gestor') return MANAGER_MODULES.slice();
    if (role === 'estoque') return STOCK_MODULES.slice();
    return [];
  }

  // Both manager and stock can manage ordinary business records.
  function canManageBusiness(profile) {
    const role = roleOf(profile);
    return role === 'gestor' || role === 'estoque';
  }

  // The stock role intentionally never inherits the destructive manager action.
  function canEraseBase(profile) {
    return roleOf(profile) === 'gestor';
  }

  return Object.freeze({ roleOf, modulesFor, canManageBusiness, canEraseBase });
});
