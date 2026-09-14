# wa-askable

A local archive of your WhatsApp, and a way to ask it questions in English or Egyptian Arabic.

A desktop app. Everything lives in one directory on your machine: the database, the WhatsApp
session, the downloaded media. There is no server component and no account, and nothing listens
on a port.

```bash
bun install          # runs electron's installer + rebuilds better-sqlite3
bun run dev
```

Link it from the QR code on first run, then set an API key in **Settings** if you want the
Franco transliteration, English glosses and the chatbot. Without one it stays in local-only
mode, which is a real mode — see "Two modes".

**It records from the moment you link it and not a second earlier.** Nothing before that can be
recovered. Link it early, and leave it running.

---

## What it does

| Stage | What happens |
|---|---|
| **Capture** | Links as a WhatsApp companion device. Every message your phone receives, this receives. It never sends anything. |
| **Fold** | Arabic is normalised to one canonical spelling; prefixes like `لل` and `وال` are stripped into searchable stems. |
| **Enrich** | Franco-Arab (`3ashan`) is transliterated to Arabic script, and every message gets a short English gloss. |
| **Search** | SQLite FTS5 over three columns — Arabic, English, and stems — so a question in either language reaches the same message. |
| **Ask** | An agent with three read-only tools: list chats, search with filters, and read around a hit. |

### The refresh button does not fetch messages

Worth internalising before you change anything. While connected, messages arrive by **push** —
`messages.upsert` fires in real time. There is nothing to poll for. **Refresh index** drains the
*enrichment backlog* those messages created: transliterating, glossing, and rebuilding the index.

The only history you will ever get is the partial blob WhatsApp pushes just after you link.
Everything else is the future. Link it early.

### It lives in the tray, and that is the point

Closing the window hides it; the app keeps capturing. Quitting from the tray menu stops capture,
and nothing fills the gap afterwards — which is why that menu item is labelled
**"Quit (stops capturing)"**. It starts at login by default. The tray icon is the only place you
will notice that capture has stopped: **red means the phone unlinked the device and you are no
longer recording.**

---

## Two modes

**Local only** (no API key) — capture, folding, stemming and keyword search all work.
Nothing leaves your machine, at all. Franco transliteration, English glosses and the chatbot are
off. This is a real mode, not a degraded one.

**Model-assisted** (key set) — message text is sent to the API for glossing and answering. Be
deliberate about this: it means your contacts' messages leave your machine. If that's not
acceptable, stay in local-only mode, or swap `Enricher` for a local model — it's one class with
two methods.

**Almost any provider works.** The **Settings** tab has a provider picker with built-in presets —
Anthropic, OpenAI, Cohere, Groq, OpenRouter, Ollama, LM Studio — plus **Bring your own…** for any
other endpoint.

Two wire protocols exist in practice: Anthropic's `/v1/messages` and the OpenAI-shaped
`/chat/completions` that nearly everything else implements. Presets pick the right one for you;
"bring your own" lets you choose. Picking the wrong protocol gives 404s, which is the single most
common way this goes wrong.

Pointing it at **Ollama or LM Studio on this machine** gives you a third privacy position worth
knowing about: Franco transliteration, English glosses and the chatbot, with message text never
leaving the machine. Local runners need no API key — a base URL alone is enough. The header names
the host in use, so you can always see where your contacts' messages are going.

Switching between modes is live. Pasting or clearing a key or URL in Settings takes effect
immediately; the WhatsApp connection is deliberately left alone so you never drop messages over
a configuration change.

The key is encrypted with the OS keystore (Keychain / DPAPI / libsecret) and written to
`secret.bin` in the app's data directory. It is never stored in `settings.json`, and it is never
readable from the UI — the settings screen only knows *whether* a key is set. If no keystore is
available, the key is kept in memory for that session only and the app tells you so, rather than
writing a secret to disk in the clear. `ANTHROPIC_API_KEY` in the environment still wins, for
development.

---

## Security

"It runs locally" is not a security model.

**There is no HTTP server any more.** The earlier version listened on `127.0.0.1:4317` and had to
defend that port — any website in any other tab can `fetch()` at localhost — with a per-process
token and a `Sec-Fetch-Site` check. The desktop app talks over Electron IPC instead, so that
entire class of attack is gone rather than mitigated. The renderer runs sandboxed, context-
isolated, with no Node integration, under a strict CSP, and sees exactly the named calls in
`src/preload/index.ts` and nothing else.

**The `auth/` directory is a full WhatsApp account takeover.** Anyone who reads those files can
impersonate you. The app sets `0700`, writes a `.gitignore`, and warns you if the workspace sits
inside a git repo or a synced cloud folder. On **Windows** those POSIX bits do nothing — the app
says so instead of pretending otherwise; there your protection is your user profile's ACLs plus
BitLocker, and keeping the folder out of OneDrive.

An encrypted disk is your job, not the code's.

**On sharing this with a peer:** you're sharing *code*, not data. They pair their own WhatsApp and
get their own empty archive. Never send anyone your `workspace/`.

**On prompt injection:** every string in the database was written by someone else, and group
chats contain text from people you've never met. That's why the agent's entire capability surface
is three read-only functions with no filesystem, shell, or network access. Keep it that way. If
you later give it the ability to *act*, a message in some group becomes a live instruction.

---

## Known limitations

- **Voice notes and images are not implemented.** Media is downloaded, hashed and deduplicated;
  the transcription and captioning hooks in `enrich.ts` are stubs. This is deliberate — get the
  text path working and measure your corpus before deciding which media type is worth building.
- **Egyptian-dialect transcription, when you do build it, runs around 30–45% word error rate.**
  Good enough to *find* a recording, not good enough to *quote* one. The agent is instructed to
  hand you the audio rather than assert what it said. Don't relax that.
- **Stemming is a prefix-strip, not real morphology.** It catches `لل`, `وال`, `بال` and friends.
  It does not handle suffixes, broken plurals, or verb inflection. If recall stays poor after you
  have real data, the next step is CAMeL Tools (Python, so a sidecar process).
- **Franco detection is a heuristic.** It's tuned to *not* fire on developer jargon — `v2`, `5pm`,
  `base64`, `sha256`, `x86` are all explicitly excluded, because otherwise half a developer's
  chat gets sent for pointless transliteration. It trades some recall on short words for that.

---

## Layout

```
src/
  core/            unchanged from the server version — the app is a shell around this
    normalize.ts   Arabic folding, Franco detection, proclitic stemming  (11 tests)
    db.ts          SQLite schema, FTS5, content-hash media dedup
    whatsapp.ts    Baileys client + reconnect backoff  (5 tests)
    enrich.ts      Gloss worker + the agent tool loop
    search.ts      The three tools the agent may call
    workspace.ts   Directory layout + safety audit
  main/            Electron main process
    index.ts       lifecycle, tray residency, power/network reconnect triggers
    ipc.ts         the nine channels that replaced the HTTP routes
    settings.ts    settings + OS-keystore key storage + autostart
    tray.ts        tray icon, status badge, menu
    config.ts      runtime config, rebuilt on every settings change
  preload/index.ts the ONLY surface the renderer sees (sandboxed, CommonJS)
  shared/ipc.ts    the IPC contract
  renderer/        index.html, app.css, app.js, link.js — no inline script (strict CSP)
                   onboarding · Ask (chat history) · Chats browser · Settings (5 sections)
```

| | |
|---|---|
| `bun run dev` | run it |
| `bun test` | 16 unit tests |
| `bun run typecheck` | |
| `bun run smoke` | drives the real IPC bridge from inside the renderer |
| `bun run smoke:lifecycle` | asserts closing hides rather than quits, and quits cleanly |
| `bun run dist` | installers into `release/` for the current OS |

Installers for all three platforms are built by `.github/workflows/build.yml` — signed builds
cannot be cross-compiled, so each OS builds on its own runner. Both it and `release.yml` call
the same `checks.yml`, so a release cannot ship something verified differently from CI.

To cut a release:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

That builds all three platforms and attaches the installers to a **draft** GitHub release — a
human writes the notes and presses publish. Nothing is signed yet, so expect a Gatekeeper
warning on macOS and SmartScreen on Windows until certificates are added.

**`PLAN.md` is the design document**: why Electron over Tauri/PySide6, why the HTTP server was
deleted rather than wrapped, and a build log of every trap hit along the way.

---

## Where to go next

Do not build the media pipeline yet. Run capture for **seven days**, then read the ledger at the
top of the UI. The dedup ratio is the number that decides everything: if most of your media is
forwarded and repeated, enrichment is cheap and you should build it. If almost everything is
unique, it's the dominant cost of the project and needs much tighter scoping.

You cannot guess that number.
