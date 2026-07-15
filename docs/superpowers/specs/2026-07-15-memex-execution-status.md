# Memex — Stato di esecuzione (2026-07-15)

Compagno operativo del PRD (`2026-07-14-memex-prd.md`, commit `64af42e`, emendato `f2de3f6`). Il PRD è la direzione; questo file è dove siamo adesso.

## La direzione in una frase

Rinominare `openwiki` in **Memex** e farne una wiki agentica autosufficiente: grafo unificato codice+concetti+pagine, embeddings veri vendorizzati (WASM, offline), retrieval ibrido istantaneo (<1s, zero LLM in lettura) — "l'agent compila in scrittura, il runtime risponde in lettura".

## Decisioni chiave prese (vincolanti)

| Decisione | Esito |
|---|---|
| Nome | **memex** (CLI `memex`, storage `~/.memex/`) |
| Scope v1 | codice + markdown; PDF/immagini in fase successiva |
| Embeddings | `multilingual-e5-small` int8 su onnxruntime-web WASM, tutto vendorizzato — **142 MiB reali** (non i ~40 MB stimati: il vocabolario multilingue è un floor strutturale; emendamento PRD §16) |
| Modello su GitHub | niente Git LFS: file **spezzato in parti <95 MB**, sha256 per parte + assemblato, concatenazione in memoria |
| Parità GitNexus | solo lettura (query/context/impact/path/map/changes/communities); niente rename di simboli |
| Grammatica ref `enrich` | id nodo 64-hex oppure `kind:path:name` nello stesso envelope — canonica per tutte le slice |
| schemaVersion | bump su `CodeGraphV1` (1→2); formato store invariato; snapshot corrotti degradano a rebuild **non silenzioso** |

## Stato per fase

### Fase 0 — Dogfooding ▶ in corso
- **T0.2 (Husme, repo privata) ✅ COMPLETATA** — trovati 2 difetti major reali: `context()` fallisce opaco su repo a zero commit (**DF-H1**); i repo Git annidati vengono **omessi dal grafo in silenzio**, zero diagnostica (**DF-H2**). Più 4 minori (DF-H3..H6). Working tree di Husme ripristinato byte-identico. Q&A: 4/5 corrette. Evidenze committate in `artifacts/dogfooding/`.
- **T0.1 (questo repo) ▶ riavviata** — il primo tentativo è stato ucciso dal limite di sessione senza produrre nulla; sessione fresca in volo.
- ⚠️ La premessa di scala su Husme era errata (31 file reali git-aware, non ~3.600): il target PRD "<60s a scala" resta da verificare con corpus sintetico al T9.1.

### Wave B — Fix difetti ▶ in corso
- Fixer per **DF-H1 + DF-H2** in volo (worktree isolato, TDD failing-first). DF-H5/H6 attendono repro a basso carico.

### Fase 1 — Rename → memex ⏸ in coda (dopo Wave B)

### Fase 2 — Layer di intelligenza: piani in review avanzata
| Slice | Piano | Stato |
|---|---|---|
| 2a (piani concept/page + enrich) | 9 task, 2.376 righe | Revisione 1 consegnata dopo verdetto REVISE (2 Critical fixati) → **ri-review in volo** |
| 2b (embeddings + retrieval ibrido) | ~155 KB scritto | Sessione morta prima del report → **completamento in volo** (audit di completezza + fix 1 NUL byte) |
| 2c (community, path/explain, report) | 14 task, 2.761 righe | Verdetto REVISE (1 Critical condiviso con 2a, adjudicato cross-piano) → **revisione in volo** |
- **Vendoring asset (TV.1)**: acquisizione completata e verificata (inferenza reale 384-dim, suite verde, licenze MIT corrette); chunking del modello a metà al momento del riavvio host → **completamento in volo**.

## Flotta sessioni attive (6, tutte Sonnet 5)
`dogfood-t01` (restart) · `fix-h1-h2` (Wave B) · `finish-vendor` · `finish-plan-2b` · `revise-plan-2c` · `rereview-plan-2a`

## Incidenti ambientali (reali, gestiti)
1. **iCloud su ~/Documents**: stalla git (timeout su `index.lock`, status appesi) sotto carico — mitigato (`.claude/` escluso dalle scansioni, retry sui lock); raccomandazione aperta: spostare i repo fuori da iCloud a orchestrazione finita.
2. **Hook GitNexus**: il nag di staleness faceva stallare i subagent in attesa di reindex (~15 processi gitnexus, load 14.5) — ora ogni dispatch impone di ignorarlo.
3. **Limite di sessione + riavvio host**: hanno interrotto due volte la flotta; stato ricostruito da ledger + filesystem, zero lavoro perso salvo la T0.1.
4. **NUL byte negli authoring**: l'escape del null-byte finiva nei file come byte grezzo — check byte-level ora obbligatorio nei deliverable.

## Prossimi passi (ordine)
1. Chiudere Wave A: ri-review 2a → APPROVED; review round-2 di 2b e 2c; merge del branch vendor.
2. Chiudere Fase 0: report T0.1 + fix di Wave B mergiati.
3. Wave C: rename `openwiki`→`memex` (sessione seriale dedicata).
4. Wave D→F: esecuzione slice 2a → 2b → 2c sui piani approvati.
5. Wave G: verifica finale T9.1 (incluso corpus sintetico per il target di scala) + report.
