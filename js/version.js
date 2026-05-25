/** Single source for release identity. Loadable from both a window
 *  scope (script tag) and a ServiceWorkerGlobalScope (importScripts).
 *  sw.js and pwa.js both read `swCache` from here. */
(function(scope){
  scope.ODTAULAI_RELEASE = {
    version: 'v54',
    buildDate: '2026-05-25',
    swCache: 'odtaulai-v54',
  };
})(typeof self !== 'undefined' ? self : this);
