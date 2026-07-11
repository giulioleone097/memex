# ADR 0001: OpenWiki native segmented graph store

## Decision

Use the OpenWiki-owned, dependency-free v2 segmented graph store. Do not ship LadybugDB or any external database fallback.

## Context

LadybugDB v0.18.1 is MIT-licensed and its benchmark numbers are useful directional context, but it fails the required clean, offline, self-contained portability gate. Evaluator evidence found macOS arm64 artifacts linked to `/opt/homebrew/opt/openssl@3/lib/{libssl,libcrypto}.3.dylib`, x64 artifacts linked to `/usr/local/opt/...`, arm64 ad-hoc signing with no TeamIdentifier, x64 unsigned artifacts, Windows VC-runtime imports, six platform tarballs totaling 34.2 MB compressed and about 110 MB unpacked, and no third-party notice inventory in the tarballs.

This is a portability and supply-chain veto, not a performance comparison. The evaluator's monolithic baseline (100k nodes / 300k edges) measured 1,092 ms reopen/full parse and 977 MB RSS; Ladybug directional measurements were faster. OpenWiki v2 targets bounded lazy reads and reports its own bytes/files read, time, size, and RSS. It does not emulate or depend on Ladybug behavior.

## Consequences

- Runtime remains Node >=20, no native binary, compiler, network, or first-use installation.
- Immutable content-addressed generations, atomic manifest switching, prior-generation recovery, filesystem locking, and confined permissions are OpenWiki responsibilities.
- Public graph operations use storage ports and bucket reads; compatibility snapshot reading is deprecated and build-only.

## Evidence

- [LadybugDB v0.18.1 release](https://github.com/LadybugDB/ladybug/releases/tag/v0.18.1)
- [@ladybugdb/core package](https://www.npmjs.com/package/@ladybugdb/core)
- [LadybugDB system requirements](https://docs.ladybugdb.com/system-requirements/)
- [LadybugDB Node.js client](https://docs.ladybugdb.com/client-apis/nodejs/)
