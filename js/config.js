/**
 * Centralized configuration — single source of truth for vendor URLs, model
 * identifiers, and localStorage/IndexedDB key names.
 *
 * Loaded before all other app modules (see index.html script order).
 * Modules reference `ODTAULAI_CONFIG.*` instead of maintaining their own
 * copies, eliminating version-drift and duplicated magic strings.
 *
 * All runtime dependencies are vendored locally (see js/vendor/ and
 * assets/models/) so the app works fully offline from a fresh install.
 * Model weights are not committed by default — run `npm run fetch-models`
 * once on your machine to populate assets/models/, then commit them.
 */
window.ODTAULAI_CONFIG = Object.freeze({
  // ── Vendored library paths (relative to index.html) ──────────────────────
  // Pinned versions match the tarballs under js/vendor/. To upgrade, replace
  // the file under js/vendor/ and bump the version comment here.
  TRANSFORMERS_URL: './js/vendor/transformers/transformers.min.mjs', // v3.3.1
  CHRONO_URL:       './js/vendor/chrono-node.min.mjs',               // v2.7.7
  /** Where transformers.js loads ORT WASM artefacts from. Must end with `/`. */
  TRANSFORMERS_WASM_DIR: './js/vendor/transformers/',
  /** Root for local model weights. Transformers.js resolves `EMBED_MODEL`
   *  beneath this path: `${MODEL_BASE_PATH}${EMBED_MODEL}/...`. */
  MODEL_BASE_PATH: './assets/models/',

  // ── Embedding model ──────────────────────────────────────────────────────
  // Single model for every device — bge-small runs on WebGPU (fp32/fp16) and
  // WASM equally well, ~33 MB quantized, 384-dim, mobile-friendly.
  EMBED_MODEL:     'Xenova/bge-small-en-v1.5',
  EMBED_DIM:       384,
  /** Version string for IndexedDB migration — bump when model changes */
  EMBED_MODEL_VER: 'bge-small-en-v1.5-unified-v3',

  // ── localStorage keys ────────────────────────────────────────────────────
  STORAGE_KEYS: Object.freeze({
    STATE:              'stupind_state',
    ARCHIVE:            'stupind_archive',
    CARD_DENSITY:       'stupind_card_density',
    SHOW_DONE_ALL:      'stupind_show_done_all',
    SWIPE_TIP_DISMISSED:'odtaulai_swipe_tip_dismissed',
    TB_SNOOZE:          'odtaulai_tb_snooze',
    SYNC_PEER:          'stupind_peer_id_v2',
    SYNC_PEER_V1:       'stupind_peer_id',
    SYNC_ROOM:          'stupind_sync_room',
    ARCHIVED_PREFIX:    'stupind_archived_',
    CAL_FEEDS:          'stupind_calfeeds',
    CAL_FEEDS_PROXY:    'stupind_calfeeds_proxy',
    INTEL_CFG:          'stupind_intel_cfg',
  }),

  // ── IndexedDB databases ──────────────────────────────────────────────────
  IDB: Object.freeze({
    INTEL_DB:  'stupind_intel',
    BACKUP_DB: 'stupind_backup',
  }),

  // ── Timer intervals (ms) ─────────────────────────────────────────────────
  REMINDER_CHECK_MS: 30_000,
  SW_UPDATE_CHECK_MS: 30 * 60 * 1000,
});
