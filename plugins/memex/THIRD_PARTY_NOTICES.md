# Third-party notices

Third-party components vendored into the Memex plugin, under its MIT license, are listed below.

## OpenWiki upstream

- Project: `langchain-ai/openwiki`
- Repository: https://github.com/langchain-ai/openwiki
- Inspected revision: `326a307203345128a60b92a356978c46e2992df3`
- Upstream package version at that revision: `0.1.1`
- License: MIT License
- License copy: [UPSTREAM_LICENSE](UPSTREAM_LICENSE)

The plugin preserves upstream product concepts and documentation outcomes while replacing the upstream agent/provider/runtime stack with host-native reasoning and a new deterministic runtime. It does not bundle the upstream npm package or its runtime dependencies.

## LadybugDB graph engine (vendored, optional native)

- Project: `LadybugDB/ladybug`
- Repository: https://github.com/LadybugDB/ladybug
- Vendored package: `@ladybugdb/wasm-core@0.18.2` (nodejs WebAssembly variant), under `vendor/ladybug-wasm/`
- Vendored runtime dependencies of that variant: `threads`, `uuid`, `tiny-worker`, and their transitive pure-JS packages, under `vendor/ladybug-wasm/nodejs/node_modules/`
- Optional native tier (not vendored, opt-in via `npm i @ladybugdb/core`): `@ladybugdb/core@0.18.2` with prebuilt platform binaries
- License: MIT License
- License copy: [vendor/licenses/ladybug-wasm.txt](vendor/licenses/ladybug-wasm.txt)

LadybugDB is the current maintained successor to KuzuDB. The wasm variant is
committed so the read-only Cypher graph surface works with no install step; the
native package is an optional performance tier and is never required at install
or runtime.

## Build-only packages

Development uses the exact versions recorded in `package-lock.json`, including TypeScript, ESLint, `@eslint/js`, and `typescript-eslint`. These packages are not runtime dependencies and are not required by the compiled plugin archive. Their own license files remain authoritative when development dependencies are installed.

## No endorsement

Names and links identify provenance. LangChain AI and upstream contributors do not endorse this plugin adaptation.
