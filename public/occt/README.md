# OpenCascade for the browser

`occt-import-js.js` and `occt-import-js.wasm` are copied unmodified from the `occt-import-js` npm package (v0.0.23, `dist/`).
They are LGPL-2.1 (see `license.occt-import-js.txt` and `license.occt.txt`). `forge-occt-worker.js` is Forge's worker that
parses STEP / IGES / BREP off the main thread (used by `src/lib/forge/import/occt.ts`).

After upgrading the package: `cp node_modules/occt-import-js/dist/occt-import-js.{js,wasm} public/occt/`.
