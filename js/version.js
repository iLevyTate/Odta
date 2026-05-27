/** Single source for release identity. Loadable from both a window
 *  scope (script tag) and a ServiceWorkerGlobalScope (importScripts).
 *  sw.js and pwa.js both read `swCache` from here. */
(function(scope){
  scope.ODTAULAI_RELEASE = {
    version: 'v59',
    buildDate: '2026-05-27',
    swCache: 'odtaulai-v59',
  };
})(typeof self !== 'undefined' ? self : this);
