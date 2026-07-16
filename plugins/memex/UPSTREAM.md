# Upstream provenance

This agent-native plugin is a transformation of ideas and durable outcomes from [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki), inspected and pinned at commit [`326a307203345128a60b92a356978c46e2992df3`](https://github.com/langchain-ai/openwiki/commit/326a307203345128a60b92a356978c46e2992df3) on 2026-07-11.

The pinned upstream package identified itself as version `0.1.1` and used the MIT License. The plugin's independent release starts at `0.1.0`; these version numbers describe different artifacts.

## Preserved outcomes

- Code and personal wiki modes.
- Standard engineering documentation map.
- Source-backed updates and provenance.
- Git-aware repository context.
- Logical source kinds: `git-repo`, `gmail`, `hackernews`, `notion`, `slack`, `web-search`, and `x`.
- Local state and update metadata concepts.

## Deliberate transformation

The plugin uses the active Codex or Claude Code agent for synthesis and a new dependency-free deterministic runtime for lifecycle operations. It does not vendor or invoke the upstream Ink UI, LangChain/DeepAgents runtime, provider onboarding, ChatGPT OAuth, or SQLite checkpoint implementation.

## Attribution and endorsement

The upstream MIT text is reproduced verbatim in [UPSTREAM_LICENSE](UPSTREAM_LICENSE). Modification and redistribution follow those terms. This project is not endorsed by, sponsored by, or affiliated with LangChain AI or the upstream OpenWiki maintainers. This plugin is independently named `Memex`; the upstream reference above documents provenance only, not naming continuity or upstream certification.

Publisher of this plugin adaptation: Giulio Leone.
