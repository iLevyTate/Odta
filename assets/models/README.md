# Embedding model weights

The app loads embedding model files from this directory at runtime so it
works fully offline. The weights aren't tracked in the initial commit
because they're ~33 MB of binary data.

To populate (one-time, on your machine):

```bash
npm run fetch-models
```

That runs [`scripts/fetch-models.mjs`](../../scripts/fetch-models.mjs)
which downloads the files for `Xenova/bge-small-en-v1.5` from Hugging Face
into `Xenova/bge-small-en-v1.5/`. Commit the result so anyone who clones
the repo afterwards gets the offline-ready build without needing to
re-fetch.

Expected layout after running:

```
Xenova/
└── bge-small-en-v1.5/
    ├── config.json
    ├── tokenizer.json
    ├── tokenizer_config.json
    ├── special_tokens_map.json
    └── onnx/
        └── model_quantized.onnx
```

If you change the model preset, update both `scripts/fetch-models.mjs`
(`FILES` array) and the model entries in `sw.js` so the service worker
precaches the new set.
