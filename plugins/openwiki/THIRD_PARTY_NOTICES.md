# Third-party notices

## OpenWiki upstream

- Project: `langchain-ai/openwiki`
- Repository: https://github.com/langchain-ai/openwiki
- Inspected revision: `326a307203345128a60b92a356978c46e2992df3`
- Upstream package version at that revision: `0.1.1`
- License: MIT License
- License copy: [UPSTREAM_LICENSE](UPSTREAM_LICENSE)

The plugin preserves upstream product concepts and documentation outcomes while replacing the upstream agent/provider/runtime stack with host-native reasoning and a new deterministic runtime. It does not bundle the upstream npm package or its runtime dependencies.

## Build-only packages

Development uses the exact versions recorded in `package-lock.json`, including TypeScript, ESLint, `@eslint/js`, and `typescript-eslint`. These packages are not runtime dependencies and are not required by the compiled plugin archive. Their own license files remain authoritative when development dependencies are installed.

## No endorsement

Names and links identify provenance. LangChain AI and upstream contributors do not endorse this plugin adaptation.
