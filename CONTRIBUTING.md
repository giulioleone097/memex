# Contributing to Memex

Thanks for helping make agent memory more trustworthy.

## Before opening a change

1. Open an issue for behavior changes that affect storage, privacy, plugin contracts, or public CLI/MCP schemas.
2. Keep changes focused and preserve the shared Codex/Claude runtime contract.
3. Add or update behavior-focused tests for supported behavior and credible regressions.
4. Never commit secrets, personal Memex data, generated wiki contents, or private repository evidence.

## Local verification

From the repository root:

```bash
npm --prefix plugins/memex ci
npm --prefix plugins/memex run build
npm --prefix plugins/memex run typecheck
npm --prefix plugins/memex run lint
npm --prefix plugins/memex test
```

For plugin packaging changes, also run:

```bash
node --test plugins/memex/tests/packaging/structure.test.mjs
claude plugin validate --strict plugins/memex
claude plugin validate --strict .
```

## Pull requests

Explain the user-visible behavior, the architectural boundary touched, and the exact proof you ran. Keep generated diagnostics, local caches, and unrelated formatting out of the diff.

By contributing, you agree that your contributions are licensed under the MIT License.
