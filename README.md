# wa-askable

A local archive of your WhatsApp, and a way to ask it questions in English or Egyptian Arabic.

Everything lives in one directory on your machine: the database, the WhatsApp session, the
downloaded media. There is no server component and no account.

```bash
cp .env.example .env      # optional — see "Two modes" below
npm install
npm run dev
```

Open the URL it prints. It contains a one-time token; restarting the process invalidates it.

---

## What it does

| Stage | What happens |
|---|---|
| **Capture** | Links as a WhatsApp companion device. Every message your phone receives, this receives. It never sends anything. |
| **Fold** | Arabic is normalised to one canonical spelling; prefixes like `لل` and `وال` are stripped into searchable stems. |
| **Enrich** | Franco-Arab (`3ashan`) is transliterated to Arabic script, and every message gets a short English gloss. |
| **Search** | SQLite FTS5 over three columns — Arabic, English, and stems — so a question in either language reaches the same message. |
| **Ask** | An agent with four read-only tools: list chats, search with filters, read around a hit, and try again. |

### The refresh button does not fetch messages

Worth internalising before you change anything. While connected, messages arrive by **push** —
`messages.upsert` fires in real time. There is nothing to poll for. **Refresh index** drains the
*enrichment backlog* those messages created: transliterating, glossing, and rebuilding the index.

The only history you will ever get is the partial blob WhatsApp pushes just after you link.
Everything else is the future. Link it early.

---

## Two modes

**Local only** (no `ANTHROPIC_API_KEY`) — capture, folding, stemming and keyword search all work.
Nothing leaves your machine, at all. Franco transliteration, English glosses and the chatbot are
off. This is a real mode, not a degraded one.

**Model-assisted** (key set) — message text is sent to the API for glossing and answering. Be
deliberate about this: it means your contacts' messages leave your machine. If that's not
acceptable, stay in local-only mode, or swap `Enricher` for a local model — it's one class with
two methods.

---

## Security

"It runs locally" is not a security model. Three specific things, two of which the code handles:

**1. Any website you visit can call `http://127.0.0.1:4317`.** A page in another tab can fire
`fetch()` at this server. Without a check it would happily return your entire message history.
Handled two ways: a per-process token the browser only gets by loading our own page, and a
`Sec-Fetch-Site` / `Origin` check that rejects anything a different site initiated. Verify it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/status                  # 401
curl -s -H "Sec-Fetch-Site: cross-site" -H "x-session-token: $T" ... /api/status    # 403
```

**2. Binding to `0.0.0.0` publishes the archive to the local network.** `assertLoopback()`
refuses to start on anything but the loopback address. If you genuinely need remote access, use
an SSH tunnel rather than editing that function.

**3. The `auth/` directory is a full WhatsApp account takeover.** Anyone who reads those files can
impersonate you. The code sets `0700` and writes a `.gitignore`, and warns you if the workspace
sits inside a git repo or a synced cloud folder — but an encrypted disk is your job, not the
code's.

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
  ui/index.html    The whole interface — no build step, so it's easy to hand over
```

`npm test` · `npm run typecheck` · `npm run build`

---

## Where to go next

Do not build the media pipeline yet. Run capture for **seven days**, then read the ledger at the
top of the UI. The dedup ratio is the number that decides everything: if most of your media is
forwarded and repeated, enrichment is cheap and you should build it. If almost everything is
unique, it's the dominant cost of the project and needs much tighter scoping.

You cannot guess that number.
