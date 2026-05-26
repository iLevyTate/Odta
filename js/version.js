/** Single source for release identity. Loadable from both a window
 *  scope (script tag) and a ServiceWorkerGlobalScope (importScripts).
 *  sw.js and pwa.js both read `swCache` from here. */
(function(scope){
  scope.ODTAULAI_RELEASE = {
    version: 'v57',
    buildDate: '2026-05-26',
    swCache: 'odtaulai-v57',
  };
})(typeof self !== 'undefined' ? self : this);
