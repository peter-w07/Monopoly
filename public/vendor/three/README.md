# Vendored three.js

- **Version:** three@0.186.1 (r186), MIT licensed — see `LICENSE` (copied verbatim from the npm package).
- **Source:** `npm pack three@0.186.1` (tarball integrity
  `sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==`).
- **Not an npm dependency.** The client has no bundler and no import map, so the files are served as
  static ES modules from `/vendor/three/`. Do not add `three` to `package.json`.

| File | From the package | Notes |
|---|---|---|
| `three.module.js` | `build/three.module.js` | minified (see below); imports `./three.core.js` |
| `three.core.js` | `build/three.core.js` | minified; since r171 the build is split in two files, both are required |
| `addons/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` | import specifier rewritten |
| `addons/RoundedBoxGeometry.js` | `examples/jsm/geometries/RoundedBoxGeometry.js` | import specifier rewritten |
| `addons/RoomEnvironment.js` | `examples/jsm/environments/RoomEnvironment.js` | import specifier rewritten |

## How it was vendored

1. `npm pack three@0.186.1` in a temp folder, then extract the tarball.
2. r186 no longer ships `*.min.js` builds and our server sends static files uncompressed, so the two core
   files were minified once with `npx esbuild@0.28.2 <file> --minify --format=esm --legal-comments=inline`
   (2.1 MB → 0.77 MB). The export list was checked against the unminified build in Node: same 444
   exports, `REVISION === '186'`.
3. Each addon's bare `} from 'three';` was rewritten to `} from '../three.module.js';` (the only import
   they have), so the browser resolves them without an import map.

## Rules

- Import three **only** through `public/r3d/three.js`. Every module must reach `three.module.js` through
  the same URL, otherwise the browser loads two copies of three and `instanceof` checks break.
- Only `renderer3d.js` (lazy-loaded by `renderer-switch.js` when a player picks 3D) pulls these files in;
  2D players download none of them.

## Updating

Repeat the steps above with the new version, add any new addon the same way, then read the three.js
migration guide (https://github.com/mrdoob/three.js/wiki/Migration-Guide) for breaking changes — for
example r186 removed `PCFSoftShadowMap` (use `PCFShadowMap` + `shadow.radius`) and r183 deprecated
`THREE.Clock`.
