/** Single source for release identity. Loadable from both a window
 *  scope (script tag) and a ServiceWorkerGlobalScope (importScripts).
 *  sw.js and pwa.js both read `swCache` from here. */
(function(scope){
  scope.ODTAULAI_RELEASE = {
    version: 'v78',
    buildDate: '2026-09-17',
    swCache: 'odtaulai-v78',
  };
})(typeof self !== 'undefined' ? self : this);
