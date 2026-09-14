# wa-askable — Desktop Build Plan

**Status:** planning · **Created:** 2026-09-14
**Target:** standalone, installable desktop app — Electron + TypeScript, Bun for install/build.

---

## 0. What exists today

A Node service (`files.zip`, 12 files, ~74 KB) that already works:

```
src/
  core/
    normalize.ts   Arabic folding, Franco detection, proclitic stemming  (11 tests)
    db.ts          SQLite schema, FTS5, content-hash media dedup
    whatsapp.ts    Baileys companion-device client
    enrich.ts      Gloss worker + the agent tool loop
    search.ts      The three tools the agent may call
    workspace.ts   Directory layout + safety audit
  server/
    security.ts    Token auth, cross-site blocking, loopback enforcement
    app.ts         Routes
  ui/index.html    The whole interface — no build step
```

Runtime deps: `@whiskeysockets/baileys`, `better-sqlite3`, `fastify`, `@fastify/static`,
`@fastify/websocket`, `@anthropic-ai/sdk`, `pino`, `qrcode`.

**This code is not being rewritten.** `core/*` moves into the Electron main process unchanged.
`server/*` is deleted (see §2.2).

---

## 1. The premise correction — read this before writing any settings UI

There is **no folder of existing chats to point the app at.** WhatsApp Desktop keeps its local
store encrypted with keys in the OS keychain, and `whatsapp.ts` does not read it. The app links as
a **companion device** and captures messages by push, live, from the moment it is linked.

From the existing README:

> The only history you will ever get is the partial blob WhatsApp pushes just after you link.
> Everything else is the future. Link it early.

Consequences that must be designed in, not bolted on:

- The directory setting is **where the archive is written**, not where it is read from.
- First run is a **QR code**, not a folder picker. The folder picker is a secondary setting.
- The first-run copy must say plainly: *"Recording starts now. Nothing before this moment can be
  recovered."* Getting this wrong generates the same bug report from every user.
- **Uptime is the product.** An app that only captures while a window is open is strictly worse
  than `npm run dev`. See §4, Phase 2 — tray residency is a correctness requirement, not polish.

---

## 2. Decisions

### 2.1 Electron, not Tauri / Wails / PySide6

`@whiskeysockets/baileys` and `better-sqlite3` are Node-only. Tauri/Wails/Neutralino would each
require shipping a bundled Node sidecar next to the Rust/Go binary — Electron's runtime cost *plus*
a second language *plus* a hand-rolled IPC bridge. The "small binary" win evaporates the moment the
core cannot run in the shell's own runtime.

### 2.2 Delete the HTTP server; use IPC

Do **not** point a `BrowserWindow` at `http://127.0.0.1:4317`. Run `core/*` in the Electron main
process and expose it over `contextBridge` + `ipcMain.handle`.

- `security.ts` mostly deletes itself. The session token, the `Sec-Fetch-Site` check, and
  `assertLoopback()` exist solely because a TCP port was open that any website in any tab could
  `fetch()`. No port, no attack. **Keep the CSP header** and keep the reasoning in a comment.
- No port conflicts, no "restart invalidates your bookmark", no token-in-the-URL-fragment.
- `app.ts`'s routes become ~8 `ipcMain.handle()` calls.
- `index.html` funnels every call through a single `fetch()` helper (line ~163) — that is the one
  function to rewrite. `fetch('/api/x')` becomes `window.wa.x()`.

Cost: roughly a day. It is the difference between an app and a browser in a costume.

### 2.3 Stay TypeScript — no Python rewrite

A Python path is viable ([neonize](https://github.com/krypton-byte/neonize) wraps Go's `whatsmeow`
via FFI, same multi-device protocol as Baileys, prebuilt wheels for Linux/macOS/Windows/ARM,
native asyncio). It was evaluated and rejected:

- ~74 KB of working, carefully-reasoned TypeScript would be discarded for zero user-visible gain.
- PySide6 packaging (PyInstaller/Briefcase + bundled interpreter, Qt LGPL constraints) is
  materially worse than electron-builder, and `index.html` would be rebuilt in Qt widgets.
- neonize is a CGo shared library — a fault in the Go layer takes the process down. Baileys is
  pure JS and easier to debug when WhatsApp changes the protocol, which it does.

All three roadmap limitations are reachable in TypeScript. See §5.

**Crossover point (revisit if reached):** if local Whisper *and* CAMeL-grade morphology both get
built, the sidecar becomes most of the system and Electron is a browser wrapped around a Python
app. Rewrite deliberately at that point, with a measured corpus — not in advance.

### 2.4 Bun — chosen, with a documented escape hatch

**Decision: Bun**, for install and script-running speed. Recorded honestly:

Bun **cannot run Electron.** Electron bundles its own Node build and executes the main process in
it; Bun's runtime never enters the picture. Bun's role here is strictly:

- `bun install` — dependency installation
- `bun run <script>` — task running
- `bun build` / Vite-via-Bun — renderer bundling

The known risk is `better-sqlite3` (and later `onnxruntime-node`, and later still a whisper
binding) being rebuilt against Electron's ABI. This step has a long tail of documented failures
across *all* package managers, and Bun is the least-trodden path through it.

Two Bun-specific gotchas that will bite on day one:

1. **Bun blocks lifecycle scripts by default.** `better-sqlite3` needs its install script. Add to
   `package.json`:
   ```json
   "trustedDependencies": ["better-sqlite3", "onnxruntime-node", "electron"]
   ```
   or run `bun pm trust better-sqlite3`.
2. **Invoke the rebuild explicitly.** Do not rely on electron-builder's package-manager
   auto-detection. Call `@electron/rebuild` directly from a script.

**Escape hatch — the trigger is defined in advance:** if native rebuild costs more than **one
working day** across the three target platforms, switch the *install step only* to npm
(`npm ci` in CI, Bun still used for scripts and bundling). This is a pre-agreed fallback, not a
failure. Note it here rather than rediscovering it under deadline.

---

## 3. Architecture

```
electron/
  main/
    index.ts        app lifecycle, single-instance lock, tray, windows
    ipc.ts          ipcMain.handle map  (replaces server/app.ts)
    settings.ts     safeStorage-backed config (API key, workspace, autostart)
    tray.ts         tray icon + connection-state badge
  preload/
    index.ts        contextBridge — the only surface the renderer sees
src/core/*          UNCHANGED from today
src/ui/             index.html, migrated off fetch()
```

### IPC map (replaces the Fastify routes)

| Channel | Replaces | Notes |
|---|---|---|
| `session:get` | `GET /api/session` | drop `token`; keep `localOnly`, `model`, `workspace` |
| `workspace:open` | `POST /api/workspace/open` | + native folder picker via `dialog` |
| `status:get` | `GET /api/status` | or push over `webContents.send` — see below |
| `whatsapp:connect` | `POST /api/whatsapp/connect` | |
| `whatsapp:disconnect` | `POST /api/whatsapp/disconnect` | |
| `refresh:run` | `POST /api/refresh` | drains enrichment backlog; does **not** fetch messages |
| `chats:list` | `GET /api/chats` | |
| `search:run` | `POST /api/search` | |
| `ask:send` | `POST /api/ask` | |

**Replace polling with push.** `index.html` currently has a `poll()` loop. `WhatsAppArchive`
already extends `EventEmitter` and emits `status`, `captured`, and `history-synced` — forward those
straight to the renderer with `webContents.send`. Deletes the poll loop and makes QR display
instant.

### Security posture after the move

Kept: CSP header · `contextIsolation: true` · `nodeIntegration: false` · `sandbox: true` ·
workspace `0700` + `.gitignore` + `auditWorkspace()` · the agent's three read-only tools.

Dropped (no longer meaningful): session token · `Sec-Fetch-Site`/Origin checks · `assertLoopback()`.

**Unchanged and non-negotiable:** the agent gets no filesystem, shell, or network access. Every
string in the database was written by someone else; group chats contain text from people the user
has never met. Prompt-injection resistance here is structural — three read-only functions — and
must stay that way. If the agent is ever given the ability to *act*, a message in some group
becomes a live instruction.

---

## 4. Phases

### Phase 0 — Scaffold (it launches) ✅ **COMPLETE**
- `bun init`; add Electron + `electron-vite` (or `vite-plugin-electron`) + TypeScript.
- Move `src/core/*` in verbatim. Do not refactor it in this phase.
- Native modules stay in `dependencies`; everything bundleable goes to `devDependencies` —
  electron-builder needs to collect native binaries, and Vite will otherwise bundle them twice.
- Get `better-sqlite3` rebuilding against Electron's ABI. `trustedDependencies` + explicit
  `@electron/rebuild`. **This is the phase that can blow the schedule — timebox it (§2.4).**
- Exit: window opens, `openDatabase()` succeeds on a real file.

### Phase 1 — IPC parity (no port) ✅ **COMPLETE**
- `preload/index.ts` contextBridge surface.
- `ipc.ts` implementing the table in §3.
- Delete `src/server/`. Keep the CSP; keep `security.ts`'s reasoning as a comment somewhere.
- Rewrite the single `fetch()` helper in `index.html`.
- Swap `poll()` for `webContents.send` push.
- Exit: full feature parity with `npm run dev`, no TCP port bound.

### Phase 2 — Actually captures (the phase that matters) ✅ **COMPLETE**
- **Tray-resident.** `window.on('close')` hides; real quit only from the tray menu.
- **Launch at login** — `app.setLoginItemSettings({ openAtLogin: true })`, opt-out in settings.
- **Single-instance lock** — `app.requestSingleInstanceLock()`. Two processes on one SQLite WAL
  and one `auth/` dir is corruption plus a possible unlink.
- **Reconnect backoff.** Current code is a flat `setTimeout(..., 3000)` loop; a laptop waking to no
  wifi will spin. Exponential backoff + `powerMonitor` `resume` + `online`/`offline`.
- **Tray badge for connection state.** `logged_out` must be visible without opening the window or
  a week of capture is lost silently.
- Exit: laptop sleeps, wakes, reconnects; messages captured with no window open.

### Phase 3 — Settings (usable by someone else) ✅ **COMPLETE**
- **API key** → `safeStorage.encryptString()` into `app.getPath('userData')`. `.env` + restart is
  not a UX. Must be changeable at runtime — flipping local-only ↔ model-assisted should not need a
  relaunch.
- **AI provider config** — model id, base URL, key. Keep the two modes explicit and honest in the
  UI: *local-only is a real mode, not a degraded one.*
- **Workspace** — default `app.getPath('userData')/workspace`; native `dialog.showOpenDialog`
  instead of a text input. Keep `auditWorkspace()`; the iCloud/Dropbox check gets *more* relevant
  once a picker makes `~/Documents` one click away.
- `chmod 0700` is a **no-op on Windows** — add an ACL check or drop the claim on that platform.
- Exit: a non-technical user can install, link, and ask a question.

### Phase 4 — Standalone packaging ✅ **COMPLETE**
- `electron-builder`: macOS `dmg`+`zip`, Windows `nsis`, Linux `AppImage`+`deb`.
- `asar: true`, with native `.node` binaries and the `sqlite-vec` extension in `asarUnpack`.
- **Cross-compiling signed builds is not a thing** — macOS builds on macOS, Windows on Windows.
  GitHub Actions matrix.
- Signing + notarization (macOS) / Authenticode (Windows). Only worth it if shipping to others.
- Auto-update via `electron-updater`. Same condition.
- Exit: a downloadable installer that works on a clean machine with no toolchain.

### Phase 5 — Enrichment upgrades
See §5. Do not start before reading §6.

---

## 5. The three limitations, in TypeScript

Verdict: **two are comfortably TS; the third mostly dissolves once the first is done.**

### 5.1 Embeddings / semantic search — TS, fully, no compromise ✅

- `@huggingface/transformers` (transformers.js v3, ONNX Runtime under the hood) runs
  feature-extraction in Node.
- `Xenova/multilingual-e5-large` has published ONNX weights and covers Arabic. **Use `e5-small` or
  `e5-base`** unless a ~2 GB download in the first-run path is acceptable.
- E5 models require prefixes: `query: ` for queries, `passage: ` for documents. Easy to get wrong.
- `sqlite-vec` is a **loadable extension** — `db.loadExtension()` on the existing `better-sqlite3`
  handle, sitting alongside the FTS5 index. No sidecar, no second process.
- **Trick the schema already sets up:** `body_en` holds English glosses. Embedding the *English
  gloss* sidesteps Arabic embedding quality entirely and costs nothing extra. Benchmark both
  against a real corpus before committing.

### 5.2 Voice-note transcription — TS, at a lower ceiling ⚠️

- `whisper-node-addon` ships prebuilt whisper.cpp bindings for Node **and Electron**, all
  platforms, zero-config. `nodejs-whisper` was updated 2026-08. **Avoid `smart-whisper`** — last
  published two years ago.
- Accuracy: the README's 30–45% WER figure still holds. But current best-in-class Egyptian is not
  Whisper — a 2025 comparison puts **SeamlessM4T-v2 at 30.05% WER / 12.52% CER on Egyptian vs
  Whisper-medium's 39.38% / 15.97%** — and SeamlessM4T is PyTorch with no JS runtime.
- So TS reaches *good-enough-to-find-a-recording*; Python reaches meaningfully better. Given the
  agent is already instructed to hand over the audio rather than quote it, the TS ceiling is
  acceptable. **Keep that instruction. Do not relax it.**

### 5.3 Arabic morphology — the real gap ❌→ mitigated

- No CAMeL Tools equivalent exists in JS. CAMeL Tools, AlKhalil, Qutuf are Python/Java, no ports.
- Reachable in TS: the **Snowball Arabic light stemmer** (`arabicstemmer`, also in `natural`). A
  genuine upgrade on `normalize.ts` because it strips **suffixes**, which the current prefix-only
  `stripProclitic()` does not. Still no lemmas, broken plurals, verb inflection, or dialect model.
- **Doing 5.1 largely dissolves 5.3.** The only reason to want CAMeL Tools is recall — `للشقة`
  failing to reach `الشقة`. Vector search ignores surface forms entirely; broken plurals and
  inflection are exactly what embeddings handle natively and stemmers handle badly. Add semantic
  search and morphology stops being the recall bottleneck; Snowball suffix-stripping covers most of
  the remainder for a few hours' work.

**Order: embeddings → Snowball suffixes → measure recall → transcription only if §6 says so.**

### 5.4 The cost: native modules go 1 → 3

`better-sqlite3` + `onnxruntime-node` + a whisper binding. The `install-app-deps` tax compounds —
the fragile step from §2.4 gets three times the surface. Two mitigations:

- `sqlite-vec` ships as a `.dylib`/`.dll`/`.so`, **not a node-gyp build** — a file to bundle, not a
  rebuild that can fail.
- `onnxruntime-node` ships prebuilts for the common triples.

Pin all three hard. Get CI building all targets before adding the second one.

---

## 6. The gate before Phase 5

From the existing README, and it still governs:

> Do not build the media pipeline yet. Run capture for **seven days**, then read the ledger at the
> top of the UI. The dedup ratio is the number that decides everything: if most of your media is
> forwarded and repeated, enrichment is cheap and you should build it. If almost everything is
> unique, it's the dominant cost of the project and needs much tighter scoping.
>
> You cannot guess that number.

Phases 0–4 ship the shell and start the clock. **Phase 5 scope is decided by data that does not
exist yet.** Electron makes it tempting to start adding UI instead. Don't.

---

## 7. Standalone-build specifics

- **Model weights:** decide ship-in-installer vs download-on-first-run. `e5-small` (~120 MB) can
  ship; `e5-large` (~2 GB) cannot. Whisper models must download on demand. A "standalone" app that
  silently pulls 2 GB on first launch is not standalone — say so in the UI if it does.
- **`asarUnpack`** every `.node` binary and the `sqlite-vec` extension, or they will not load.
- **First-run must work offline** for local-only mode. That is the whole promise of local-only.
- **Uninstall should offer to delete the workspace** — and must say exactly what is being deleted.

---

## 8. Open items

- [ ] Primary OS target? Changes Phase 4 substantially, nothing before it.
- [ ] Audience: self-only (skip signing + auto-update entirely) or shipping to others?
- [ ] `e5-small` vs `e5-base` vs API embeddings — benchmark on a real corpus, not in the abstract.
- [ ] Embed `body_en` gloss, `body_ar`, or both? Same benchmark.
- [ ] **Doc fix:** README says the agent has "four read-only tools"; `TOOL_DEFINITIONS` has three.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| WhatsApp account ban — unofficial clients carry real risk | **High** | Accept knowingly. It is the user's own account. Baileys already avoids presence/read receipts. |
| Native rebuild under Bun | **Low** (was Medium) | Resolved in Phase 0 — see §11. better-sqlite3 v13 is N-API + prebuildify; rebuild succeeded under Bun. |
| Protocol change breaks Baileys | Medium | Pin version; upstream is active |
| `auth/` directory theft = full account takeover | **High** | `0700`, `.gitignore`, workspace audit, encrypted disk is the user's job |
| Silent capture loss after unlink | Medium | Tray badge (Phase 2) |
| Installer bloat from model weights | Low | §7 |

---

## 10. Sources

**Stack / packaging**
- [electron-builder](https://www.electron.build/index.html) · [config docs](https://www.electron.build/docs/configuration/)
- [electron-vite](https://electron-vite.org/) · [vite-plugin-electron](https://github.com/electron-vite/vite-plugin-electron)
- [Electron: using native node modules](https://github.com/electron/electron/blob/v7.1.5/docs/tutorial/using-native-node-modules.md)
- [electron-builder #7753 — install-app-deps vs node-gyp-rebuild](https://github.com/electron-userland/electron-builder/issues/7753)
- [better-sqlite3 #736 — electron-builder hangs](https://github.com/WiseLibs/better-sqlite3/issues/736) · [#1401 — Windows 11 + Electron](https://github.com/WiseLibs/better-sqlite3/issues/1401)
- [better-sqlite3 ABI mismatch troubleshooting](https://docs.triliumnotes.org/developer-guide/troubleshooting/better-sqlite3)
- [Bun as a package manager](https://oneuptime.com/blog/post/2026-01-31-bun-package-manager/view)
- [bun + better-sqlite3 postinstall failure](https://github.com/better-auth/better-auth/issues/5928)

**Python path (evaluated, rejected — §2.3)**
- [neonize](https://github.com/krypton-byte/neonize) · [PyPI](https://libraries.io/pypi/neonize)

**Embeddings / vector search**
- [Transformers.js docs](https://huggingface.co/docs/transformers.js/en/index) · [releases](https://github.com/xenova/transformers.js/releases)
- [Xenova/multilingual-e5-large](https://huggingface.co/Xenova/multilingual-e5-large)
- [sqlite-vec](https://github.com/asg017/sqlite-vec) · [sqlite-vec + Xenova walkthrough](https://stephencollins.tech/posts/how-to-use-sqlite-vec-to-store-and-query-vector-embeddings)

**Transcription**
- [whisper-node-addon](https://github.com/Kutalia/whisper-node-addon) · [nodejs-whisper](https://github.com/ChetanXpro/nodejs-whisper)
- [Overcoming Data Scarcity in Multi-Dialectal Arabic ASR via Whisper Fine-Tuning](https://arxiv.org/html/2506.02627v1)
- [Casablanca: Multidialectal Arabic ASR](https://arxiv.org/pdf/2410.04527) · [VoxArabica](https://arxiv.org/pdf/2310.11069)
- [whisper-large-v3-egyptian-arabic](https://huggingface.co/AbdelrahmanHassan/whisper-large-v3-egyptian-arabic)

**Arabic NLP**
- [Arabic-Resources](https://github.com/NNLP-IL/Arabic-Resources) · [awesome-arabic](https://github.com/01walid/awesome-arabic)
- [CAMeL Tools paper](https://aclanthology.org/2020.lrec-1.868.pdf)
- [Evaluation of Semantic Search and RAG for Arabic](https://arxiv.org/pdf/2403.18350)


---

## 11. Phase 0 build log — what actually happened

Recorded because three of these contradict what the plan assumed.

### Resolved versions (pin these)

| Package | Version | Note |
|---|---|---|
| Electron | 44.3.0 | |
| Vite | 8.3.0 | via electron-vite |
| better-sqlite3 | **13.0.3** | was `^11.3.0` — see below |
| Node (dev host) | v24.13.0 | nvm.fish, `~/.local/share/nvm/v24.13.0/bin` |
| Bun | 1.3.8 | |

### 11.1 `better-sqlite3@^11` does not compile against Electron 44 — **upgrade is mandatory**

```
error: no matching function for call to 'v8::External::Value()'
  candidate: 'void* v8::External::Value(ExternalPointerTypeTag tag) const'
```

Electron 44's V8 requires an `ExternalPointerTypeTag` argument that v11 does not pass. The
version pinned in the original `package.json` cannot be used. **Fixed by moving to 13.0.3.**

### 11.2 The §2.4 / §5.4 native-module risk is much smaller than assumed — *good news*

better-sqlite3 v13 depends on `node-addon-api ^8` (**N-API**, ABI-stable) and ships
**prebuildify-layout binaries for all six target triples**:

```
prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node
```

N-API is ABI-stable across Node *and* Electron versions, so the per-Electron-version rebuild
treadmill largely disappears, and all three OS targets (§8) are covered by shipped binaries.
The one-working-day escape hatch in §2.4 was **not needed** — `electron-rebuild` succeeded
under Bun on the first try after the version bump, including from Bun's own `postinstall`.

This also downgrades §5.4: `onnxruntime-node` likewise ships prebuilts, and `sqlite-vec` is a
loadable extension rather than a build. Re-evaluate §5.4's "1 → 3 native modules" tax as
mostly a *bundling* problem (`asarUnpack`) rather than a *compilation* one.

### 11.3 A sandboxed preload must be CommonJS — confirmed against docs

Electron's ESM support matrix: **Renderer (Sandboxed) → ESM Loader in Preload: Unsupported.**
ESM preloads require both the `.mjs` extension *and* `sandbox: false`. Since the renderer holds
other people's private messages, the sandbox stays on, so the preload is built as CJS:

```ts
preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } }
```

with `webPreferences.preload` pointing at `../preload/index.cjs`.

**Constraint this puts on Phase 1:** a sandboxed preload only gets a polyfilled `require`
limited to `electron` (`contextBridge`, `ipcRenderer`, `nativeImage`, `webFrame`, `webUtils`),
`events`, `timers`, `url`, plus `Buffer`/`process` globals. The preload cannot import from
`core/*`. Every type shared with the renderer must be a structurally-cloneable plain object
passed over IPC — no class instances, no `Database` handles, no `EventEmitter`s.

### 11.4 Bun does not reliably run Electron's binary-download postinstall

Even with `"electron"` in `trustedDependencies`, `node_modules/electron/dist/` was empty and
the first launch stalled on `Downloading Electron binary...`. Fix — run it explicitly:

```bash
node node_modules/electron/install.js
```

Add this to the setup script / CI so a clean checkout is not mysteriously broken.

### 11.5 Dev environment notes (WSL)

- `node` is **not** on bash's `PATH`; the `npm` that resolves is Windows' nvm4w via `/mnt/c`
  and is useless for Linux native builds. Export
  `PATH="$HOME/.local/share/nvm/v24.13.0/bin:$PATH"` before any build command, or run through
  fish where `nvm use lts` works.
- WSLg is active (`DISPLAY=:0`, `wayland-0`), so Electron windows do open.
- The repo lives on `/mnt/d` (drvfs). `bun install` took minutes rather than seconds. Consider
  moving the working copy to the WSL filesystem (`~/`) if iteration speed becomes annoying.
- Targets are Windows + Linux + macOS (§8 answered), so Phase 4 **requires** a GitHub Actions
  matrix — signed builds cannot be cross-compiled.

### 11.6 Bundling: two externalization traps, both fatal, both silent at build time

The build succeeded and the app still failed to start, twice, for related reasons.

**(a) `electron` must be external.** It lives in `devDependencies`, so
`externalizeDepsPlugin()` — which only externalizes `dependencies` — left it to be bundled.
Vite then inlined the npm launcher stub (the one that reads `path.txt` and re-execs
`install.js`) into `out/main/index.js`. At runtime `__dirname` is `out/main/`, not
`node_modules/electron/`, so the app died with:

```
Cannot find module '/…/out/main/install.js'
Error: Electron failed to install correctly.
```

Misleading message — nothing was wrong with the Electron install.

**(b) `build.rollupOptions.external` REPLACES the plugin's list, it does not merge.**
Fixing (a) by setting `external: ['electron']` clobbered what `externalizeDepsPlugin()` had
populated, so `better-sqlite3` was bundled instead, and looked for its binary at the bundle's
`__dirname`:

```
Cannot find module '/…/out/build/Release/better_sqlite3.node'
```

**Fix — build the list explicitly, in one place:**

```ts
const EXTERNAL = ['electron', ...Object.keys(pkg.dependencies ?? {})];
```

applied to both `main` and `preload`. Diagnostic signal: the main bundle went 34 kB → 6.5 kB
once deps were genuinely external. **If `out/main/index.js` is more than a few kB, something is
being bundled that should not be.** Worth a CI size assertion.

---

## 12. Phase 0 exit — verified

```
[phase0] workspace : /home/hady/.config/Electron/workspace
[phase0] database  : opened, schema applied
[phase0] stats     : {"chats":0,"messages":0,"pending":0,"mediaUnique":0,...}
```

- Electron 44.3.0 window opens under WSLg; process stays up with no errors.
- `better-sqlite3` 13.0.3 loads under Electron's ABI and creates the schema.
- All 12 objects present: `chats`, `messages`, `media`, `meta`, `messages_fts`
  (+ `_config/_data/_docsize/_idx`) and the three sync triggers `messages_ai/ad/au`.
- Workspace root and `auth/` created `0700`; `.gitignore` guard written.
- `tsc --noEmit` clean. `bun test` — **11/11 pass** (normalize.ts suite carried over intact).

**Next: Phase 1** — preload contextBridge + `ipcMain.handle` map (§3), delete `reference/`
(the old `app.ts` / `security.ts`), rewrite the single `fetch()` helper in `index.html`, and
swap `poll()` for `webContents.send`. Note the §11.3 constraint: the sandboxed preload cannot
import `core/*`, so everything crossing IPC must be a plain cloneable object.

---

## 13. Phase 1 build log

`src/server/` is gone. Nine `ipcMain.handle` channels + two push events replace the Fastify
routes; `src/shared/ipc.ts` holds the contract. New files: `main/ipc.ts`, `main/config.ts`,
`shared/ipc.ts`, `renderer/app.js`.

### 13.1 The CSP was blocking the entire UI — and this bug predates the port

`index.html` was one large inline `<script>`, while the CSP (carried over verbatim from
`server/security.ts`) is `default-src 'self'` with **no `script-src`**:

```
[renderer:error] Executing inline script violates the following Content Security Policy
directive 'default-src 'self''. The action has been blocked.
```

The page's JavaScript never executed. Fastify sent the same header on every response, so this
was equally broken before the port — it is not a regression, it is a pre-existing bug the move
surfaced. Notably `PUBLIC_PATHS` in the old `security.ts` already listed `/app.js`, suggesting
an external script file was once intended.

**Fix:** extracted the 130-line inline script to `src/renderer/app.js`, loaded via
`<script type="module" src="./app.js">`. Adding `'unsafe-inline'` would have been one character
of work and exactly the wrong trade — this app's threat model is text written by other people,
including strangers in group chats. Keep `script-src` strict.

### 13.2 `ready-to-show` races the page's async boot — use `did-finish-load`

Per Electron's source, `ready-to-show` fires from `OnFirstNonEmptyLayout` and `did-finish-load`
from `DidFinishLoad` — independent Chromium callbacks **with no guaranteed ordering**.
Anything that inspects a fully-booted renderer must hook `did-finish-load`.

### 13.3 Electron wraps IPC handler errors, and the wrapper reaches the user

A handler throwing `"Answering questions needs a model…"` arrives in the renderer as:

```
Error invoking remote method 'ask:send': Error: Answering questions needs a model…
```

The old HTTP version returned a clean message. `preload/index.ts` now unwraps it in a private
`invoke()` helper so UI copy stays readable. Not exposed across the bridge.

### 13.4 Renderer console forwarding is worth keeping

`webContents.on('console-message', …)` piped into the main log found §13.1 in one run after two
wrong guesses (a race, then a thrown error). Electron 35 deprecated the positional arguments in
favour of a details object: `({ level, message, lineNumber, sourceId })`.

### 13.5 Push replaces polling

`WhatsAppArchive` already extended `EventEmitter`. `status` is forwarded straight through, so
the QR appears the moment Baileys emits it rather than up to 2.5s later. `captured` fires once
per message and a busy group would flood it, so stats are coalesced on a 1s timer.
`setInterval(poll, 2500)` is deleted.

### 13.6 Verification

`bun run smoke` drives the real contextBridge from inside the renderer and exits non-zero on
failure — wired for CI in Phase 4.

```
bridge     = object
modeText   = local only · nothing leaves this machine     ← page's own boot IIFE ran
wsPath     = /home/hady/.config/Electron/workspace
status     = idle
leaks      = undefined,undefined,undefined                ← no require/process/ipcRenderer
askError   = Answering questions needs a model. Set ANTHROPIC_API_KEY and restart,
```

`tsc --noEmit` clean · `bun test` 11/11 · normal launch stays up with no renderer errors.

**Known gap carried to Phase 3:** the workspace field is still a text input. The native
`dialog.showOpenDialog` picker is Phase 3 scope, deliberately not pulled forward.

---

## 14. Phase 2 build log

New files: `main/tray.ts`, `main/tray-icons.ts`, `main/settings.ts`, `test/reconnect.test.ts`.
Modified: `main/index.ts`, `main/ipc.ts`, `core/whatsapp.ts`.

### 14.1 `setLoginItemSettings` is macOS + Windows only — Linux needed writing by hand

Electron's docs mark the API **macOS, Windows**. Since Linux is a declared target (§8), autostart
there is an XDG desktop entry written directly:

```
~/.config/autostart/wa-askable.desktop   →  Exec=<execPath> --hidden
```

`applyAutostart()` returns whether autostart is *actually* in effect and the tray checkbox is set
from the return value, not the request. Silently failing here means the user believes the archive
is capturing when it is not — the single worst failure mode this app has.

### 14.2 `net.online` is a property, not an event

Chromium exposes no network-change signal to the main process. So it is polled on a 15s
`unref()`ed timer, and only for the `false → true` edge. Without it, a laptop returning from a
dead network waits out the backoff — up to five minutes of messages that no longer exist
anywhere. `powerMonitor` `resume` and `unlock-screen` cover the wake case properly, as events.

### 14.3 Reconnect backoff — extracted so it could be tested

The old code was `setTimeout(() => void this.connect(), 3_000)` on every close. On a laptop that
wakes with no wifi that spins every 3 seconds indefinitely.

Now exponential with jitter, 2s → 5min cap, reset to zero on a successful `open`.
`reconnectDelay(attempt, rand)` is exported as a pure function precisely so the schedule can be
asserted without a socket — **5 new tests** covering growth, the cap at extreme attempt counts,
jitter spread, and integrality. Jitter is not decoration: without it every linked device on a
machine retries in lockstep.

Two related fixes found while writing it:

- `fetchLatestBaileysVersion()` needs the network and was outside any try/catch — offline at wake
  threw out of `connect()` and killed the reconnect loop entirely. Now caught and backed off.
- A `connecting` guard: a `resume` event and a socket close can land together, and two concurrent
  connects would race for the same `auth/` directory.

### 14.4 Auto-resume is what makes autostart worth anything

`resumeLastWorkspace()` reopens the last workspace and connects on launch, with no window and no
click. `workspace:open` records `lastWorkspace` in settings. Without this, tray residency just
means a quiet app that is not recording — verified by the lifecycle test reporting
`trayState = connecting` immediately after a headless start.

### 14.5 Tray details that matter

- The `Tray` is held at module scope. Electron's docs are explicit: a garbage-collected Tray
  vanishes from the system tray.
- Icons are generated 16×16 PNGs inlined as data URLs (`nativeImage.createFromDataURL`), not
  asset files — no asar packing, no `asarUnpack` rule, no dev-vs-packaged path lookup. ~200 bytes
  each.
- Four states: grey idle, amber connecting/QR, green capturing, **red unlinked**. Red is the
  load-bearing one; `logged_out` is the state where capture has stopped and every message from
  then on is lost permanently.
- Quit is labelled **"Quit (stops capturing)"**. It should read as a consequence, not a verb.
- `window-all-closed` is now an intentional no-op, and `close` hides instead of destroying.

### 14.6 Verification

`bun run smoke:lifecycle` asserts Phase 2's actual contract rather than trusting a human to click
the X:

```
[lifecycle] OK
  trayCreated     = true          trayState  = connecting   ← auto-resumed, no interaction
  windowDestroyed = false         windowVisible = false      ← close hid it, did not quit
  reopened        = true                                     ← tray reopens the same window
  settings        = { openAtLogin: true, lastWorkspace: '…' }
```

It finishes through the **real quit path** (`hooks.quit()` → `before-quit` → close socket →
checkpoint WAL) behind an 8s watchdog, because a hang there strands the process in the tray with
no window. Exit 0 = graceful shutdown completed.

`--hidden` verified: `trayCreated = true`, `windowVisible = false`.

`tsc --noEmit` clean · `bun test` **16/16** · `bun run smoke` still OK.

### 14.7 Carried forward

- Tray was verified under WSLg, which has a working tray. **Linux tray support varies** by desktop
  environment (GNOME needs an AppIndicator extension). Re-verify on the real Linux target in
  Phase 4; the app must stay usable if the tray never appears.
- Autostart `Exec=` currently points at the dev Electron binary. In a packaged build
  `process.execPath` is the app binary, which is correct — but confirm it after Phase 4.
- Notifications on unlink are not implemented. The tray icon turns red; a system notification
  would be louder. Deferred deliberately — measure whether the icon is enough first.

---

## 15. Phase 3 build log

Modified: `main/settings.ts`, `main/config.ts`, `main/ipc.ts`, `preload/index.ts`,
`shared/ipc.ts`, `core/workspace.ts`, `renderer/index.html`, `renderer/app.js`.

### 15.1 The plan's `safeStorage.encryptString()` is deprecated and dies in Electron 46

> The synchronous API (`isEncryptionAvailable`/`encryptString`/`decryptString`) is deprecated and
> will be removed in Electron 46.

We are on 44, so writing what §4 Phase 3 specified would have been dead code within two majors.
Uses the async API throughout: `isAsyncEncryptionAvailable()`, `encryptStringAsync()`,
`decryptStringAsync()` — note the last resolves to `{ result }`, not a bare string.

### 15.2 The key is write-only across the bridge

`settings:get` reports `hasKey: boolean` and never the key itself, under any field name. Asserted
in the smoke test (`keyNeverReturned`, `keyStillNotReturned`) by scanning the whole serialised
response for the token prefix, so a future field that leaks it fails the build rather than review.

Storage: encrypted bytes in `<userData>/secret.bin`, mode `0600`. Never `settings.json`.

### 15.3 No keystore → memory only, never plaintext

On a Linux box with no libsecret provider, `isAsyncEncryptionAvailable()` is false. The key is
then held in memory for the session and **not** written to disk, and the UI says so rather than
letting the user discover it after a restart. A secret silently written in plaintext would be
worse than not persisting it.

`ANTHROPIC_API_KEY` in the environment still wins, so a dev shell behaves exactly as before; the
UI says when that is happening so the settings field does not appear to be ignored.

### 15.4 Live provider rebuild — the actual Phase 3 deliverable

`Enricher` and the Anthropic client both capture the key at construction, so a settings change
replaces both (`rebuildProvider()`). `cfg` is re-read from storage rather than patched by hand, so
there is exactly one path from stored settings to running configuration.

**The WhatsApp socket is deliberately left alone.** Re-linking because someone pasted an API key
would be absurd, and would drop messages while it reconnected.

Proof in the smoke test — `ask()` after setting a key returns `401` from the API rather than the
local-only guard message, which means the client really was rebuilt in place:

```
settingsShape       = claude-sonnet-5|false|true|true
afterSet            = true|false|claude-opus-5      ← key set, localOnly flipped, no relaunch
askAfterKey         = 401 {"type":"error",...       ← past the guard, real call, rebuilt client
afterClear          = false|true                    ← and straight back to local-only
keyNeverReturned    = true
```

Note: that check makes one real request to the API with a deliberately invalid key. 401 is the
signal; nothing is sent but the auth attempt.

### 15.5 `chmod 0700` is a no-op on Windows — the claim is now platform-honest

`openWorkspace()` already swallowed the `chmod` failure, and `auditWorkspace()` tested
`mode & 0o077`, which is meaningless on Windows. The UI then told the user
*"Permissions set to owner-only"* — on Windows, a lie, about a directory that is a full WhatsApp
account takeover.

Now: the POSIX check runs only on non-Windows, Windows gets an explicit warning that file
permissions cannot be enforced there and that BitLocker plus a non-synced location are the real
controls, and the UI success message no longer claims anything about permissions.

### 15.6 Native folder picker

`dialog.showOpenDialog` with `['openDirectory', 'createDirectory', 'promptToCreate']` —
`createDirectory` is macOS-only and `promptToCreate` Windows-only, both ignored elsewhere, so one
list covers all three targets. `defaultPath` is the current workspace.

### 15.7 Verification

`tsc --noEmit` clean · `bun test` 16/16 · `bun run smoke` OK incl. the settings block ·
`bun run smoke:lifecycle` OK.

### 15.8 Carried forward

- `README.md` still documents the old `npm run dev` / Fastify layout and says the agent has "four
  read-only tools" when `TOOL_DEFINITIONS` has three. Rewrite it at Phase 4 as the handover doc.
- Model is a free-text field. A list fetched from the API would be friendlier, but it must stay
  typeable for models the picker does not know about.

---

## 16. Phase 4 build log

New: `electron-builder.yml`, `.github/workflows/build.yml`, `scripts/postinstall.mjs`,
`build/icon.png`. README rewritten as the handover doc.

### 16.1 The repo could not be installed from scratch — and it was committed that way

`electron`, `electron-vite`, `vite`, `typescript`, `@electron/rebuild` and `@types/node` were
**installed in node_modules but never recorded in package.json**. The original `bun add -d` hit a
300s tool timeout; the packages landed, the manifest write did not. Everything worked for four
phases purely because the local tree happened to contain them.

A fresh clone — or CI — would have failed immediately. Found only by building on a second
machine-equivalent (a clean copy on another filesystem). **CI now runs `bun run setup` after
`bun install --frozen-lockfile` precisely so this class of bug fails the build, not a user.**

Lesson worth keeping: a tool timeout that moves a command to the background can lose a partial
write. Verify the manifest, not just that the command eventually exited 0.

### 16.2 Packaging on `/mnt/d` (drvfs) is unusable; on ext4 it is 8 seconds

electron-builder reports:

> note: bun does not support any CLI for dependency tree extraction, utilizing file traversal
> collector instead

So it walks `node_modules` by hand. Measured, same config, same machine:

| | `/mnt/d` (drvfs) | `~/` (ext4) |
|---|---|---|
| `bun install` (clean) | minutes | **3.97s** |
| `electron-vite build` | ~2s | **0.52s** |
| `electron-builder --dir` | **>15 min, never finished** | **8.16s** |

**This is the filesystem, not Bun.** Bun's traversal is fine on a normal disk. §2.4's escape
hatch (switch installs to npm) is therefore *not* triggered — the fix is where the repo lives.

**Recommendation: move the working copy to the WSL filesystem.** Local packaging is impractical
from `/mnt/d`. CI runners use native disks and are unaffected.

### 16.3 `postinstall` had to become a script

Bun does not reliably run Electron's own binary-download postinstall (§11.4), so it must be
invoked explicitly — but Bun may also run the *root* postinstall before `node_modules/electron`
is linked, and then the explicit call fails with `MODULE_NOT_FOUND` and **aborts the whole
install**, leaving a half-populated tree. That is exactly what happened on the clean-install test.

`scripts/postinstall.mjs` guards every step and degrades to a warning; `bun run setup --strict`
runs the same steps and fails loudly, which is what you want when repairing an install rather
than performing one.

### 16.4 Blocked lifecycle scripts on a clean install

`bun pm untrusted` reported `esbuild`, `protobufjs`, `electron-winstaller`. The build survives
without them on Linux, but **`electron-winstaller` selects a 7z architecture and is needed by the
Windows nsis target**, so CI would have hit it. Added to `trustedDependencies`.

### 16.5 asar and native binaries

A `.node` cannot be loaded from inside an asar. `asarUnpack` covers `**/*.node` plus
`node_modules/better-sqlite3/**`. Verified in a real packaged build — the app opens its database
from `resources/app.asar.unpacked/.../prebuilds/linux-x64.node`.

better-sqlite3 ships all six triples (16 MB). Per-platform `files` filters drop the foreign ones:
a Linux build went from 8 prebuilds to 4. When Phase 5 adds `onnxruntime-node` and a whisper
binding, they follow the same pattern.

### 16.6 Artifacts built and verified

```
wa-askable-0.1.0-x86_64.AppImage   151M
wa-askable-0.1.0-arm64.AppImage    152M
wa-askable_0.1.0_amd64.deb         117M
```

The packaged binary was run, not just built:

```
workspace = /home/hady/.config/wa-askable/workspace   ← real packaged userData path
bridge    = object      leaks = undefined,undefined,undefined
afterSet  = true|false|claude-opus-5    afterClear = false|true
```

### 16.7 Signing, updates, and what is deliberately not wired

- **CI matrix** (`ubuntu`/`windows`/`macos`) — signed builds cannot be cross-compiled.
- Signing env vars (`CSC_LINK`, `APPLE_ID`, …) are referenced but optional, so forks and
  unsigned builds still produce working artifacts. **No certificates exist yet**; macOS builds
  will be unsigned and Gatekeeper will complain until an Apple Developer ID is added.
- **`publish: null`** — no auto-update. `electron-updater` needs somewhere to publish and an
  identity to trust; a half-wired updater is worse than none.
- `deleteAppDataOnUninstall: false` — the archive holds other people's messages and WhatsApp
  credentials. Deleting it silently on uninstall would be wrong.

### 16.8 Open items

- **`homepage` in package.json is a placeholder** (`github.com/hadywalied/wa-askable`) added
  because deb packaging requires one. Point it at the real repository before publishing.
- macOS builds are untested — no Mac available here. The CI matrix will be the first real run.
- Linux tray support still unverified outside WSLg (§14.7).

---

## 17. Post-Phase-4: provider base URL, release pipeline, and CI fixes

### 17.1 Two CI bugs that only a real runner could find

**`chrome-sandbox` must be root-owned 4755.** Electron ships it unprivileged, so on a fresh
runner the browser process aborts with a FATAL before any test executes. Fixed by chown/chmod
rather than `--no-sandbox`: the app ships with the sandbox on, and disabling it in CI would make
the smoke tests pass while exercising a configuration nobody runs.

**`node_modules/.bin/electron-rebuild` does not exist on Windows.** The shim is extensionless on
POSIX but `.cmd`/`.ps1` on Windows, so `existsSync` on the bare name is false and the Windows job
failed with "@electron/rebuild not linked yet" while the package sat right there.
`scripts/postinstall.mjs` now resolves the package's own `bin` entry and runs it through `node`,
which behaves identically on all three platforms.

**And the `dist:*` scripts were missing from package.json** — written during Phase 4 but never
committed, same failure mode as §16.1. Two lost manifest writes on `/mnt/d` in one project is
enough evidence: **move the working copy off drvfs.**

### 17.2 Provider base URL

`Settings → API base URL` sets `baseURL` on the Anthropic SDK, so any compatible endpoint works —
a local agent, a proxy, a self-hosted gateway.

A base URL **alone** enables model-assisted mode: `localOnly = !key && !baseUrl`. A service on
`127.0.0.1` usually needs no credential, and demanding one would make the local-provider case
impossible. The SDK still wants a non-empty `apiKey`, so a `'local'` placeholder is passed.

Threaded through both `Enricher` (glossing) and the agent client — missing either would leave
half the pipeline still talking to Anthropic. The header now names the host it is configured
against, because "model-assisted" describes two very different privacy positions.

Asserted in the smoke test: `baseUrlOnly = false|false|http://127.0.0.1:9` — no key, not
local-only, URL applied.

### 17.3 Release pipeline

`checks.yml` is a `workflow_call` reusable workflow holding the single definition of "verified":
typecheck, unit tests, both smoke harnesses, and the bundle-size guard. `build.yml` and
`release.yml` both call it, so **a release cannot ship something verified differently from CI**.

- `build.yml` — push/PR. Builds installers with `--publish never` to prove they build.
- `release.yml` — tag `v*`. Same checks, then `--publish always` into a **draft** GitHub release,
  plus `upload-artifact` as a fallback if the publisher is ever misconfigured.

Draft is deliberate: a human writes the notes and presses publish, so a mistyped tag is not
instantly an installable download.

`publish:` in `electron-builder.yml` is a **release target, not auto-update**. electron-updater
stays unwired until there is a signing identity users can trust — an updater that silently
installs unsigned builds is worse than none.
