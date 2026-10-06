/* Optional Firebase App Check bootstrap for the local web copy. */
(function (global) {
  'use strict';

  let active = false;

  function initialize(config) {
    const settings = config || global.RANDSTAD_APPCHECK_CONFIG || { enabled: false };
    if (settings.enabled !== true) return false;

    if (settings.provider !== 'recaptcha-v3') {
      throw new Error('O provedor App Check configurado ainda não é suportado por este inicializador.');
    }
    const siteKey = String(settings.siteKey || '').trim();
    if (!siteKey) {
      throw new Error('App Check foi solicitado, mas falta a chave pública do reCAPTCHA v3.');
    }
    if (!global.firebase || typeof global.firebase.appCheck !== 'function') {
      throw new Error('O SDK compatível do Firebase App Check não carregou.');
    }
    if (active) return true;

    const appCheck = global.firebase.appCheck();
    if (!appCheck || typeof appCheck.activate !== 'function') {
      throw new Error('Não foi possível inicializar o Firebase App Check.');
    }
    // Starts automatic token refresh. Enforcement remains a separate Firebase Console setting.
    appCheck.activate(siteKey, true);
    active = true;
    return true;
  }

  global.RandstadAppCheck = Object.freeze({
    initialize,
    isActive: function () { return active; }
  });
})(window);
