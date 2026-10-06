// App Check is intentionally disabled in the local pilot copy.
// The reCAPTCHA site key is public, but its matching secret belongs only in Firebase Console.
window.RANDSTAD_APPCHECK_CONFIG = Object.freeze({
  enabled: false,
  provider: 'recaptcha-v3',
  siteKey: ''
});
