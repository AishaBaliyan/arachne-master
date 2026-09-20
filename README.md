# linq-browser-agent

Turns incoming **Linq iMessage** requests into real web research, and texts back
a structured answer with working links and a screenshot.

```
iMessage ──▶ Linq webhook ──▶ POST /webhook/linq
                                   │  verify signature, rate limit, ack
                                   ▼
                            classify (gpt-5.5)
                        ┌──────────┴──────────┐
                  research tier          browser tier
                  (no browser)          (Stagehand session)
                        │                      │
              search() 3-4 queries      observe → decide → act
              fetch() 6 pages || md     auth wall? stop, never log in
              synthesise → picks               │
              retail lookup per pick    ───────┘ falls back to research
                        │
                        ▼
              render → summary + links + screenshot ──▶ iMessage
```

## Why two tiers

`browserbase.search()` and `browserbase.fetch()` read public pages **without a
browser session** — measured at 0.7s and 1.6s against a 2.7s session launch, with
no anti-bot fight. Reading sources beats driving a browser for almost every
request, so a browser only launches when a task genuinely needs interaction.

## Requirements

- Node.js 18+ (built on v24.15.0)
- Browserbase project, OpenAI key, Linq API key + webhook signing secret
- `ngrok` to expose localhost to Linq (download to this folder as `ngrok.exe`)

## Setup

```bash
npm install
```

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Reasoning and in-page extraction |
| `OPENAI_MODEL` | Stagehand form — **`provider/` prefix required**, e.g. `openai/gpt-5.5` |
| `OPENAI_MODEL_REASONING` | Bare form for direct calls, e.g. `gpt-5.5` |
| `LINQ_API_KEY` | Bearer token for outbound messages |
| `LINQ_WEBHOOK_SECRET` | `whsec_…` signing secret. Unset = unsigned requests accepted |
| `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` | Both required |
| `PUBLIC_BASE_URL` | Blank = auto-detect the running ngrok tunnel |
| `BROWSER_CONCURRENCY` | Max simultaneous Browserbase sessions (default 2) |
| `RATE_LIMIT_PER_HOUR` | Per-sender cap (default 8) |
| `TASK_TIMEOUT_MS` / `RESEARCH_BUDGET_MS` | Time budgets |
| `ARTIFACT_TTL_MS` | How long screenshots stay fetchable (default 1h) |
| `DEBUG_TOKEN` | Enables `POST /debug/run` |

## Run

```bash
node index.js
./ngrok.exe http 3000 --url https://<your-static-domain>.ngrok-free.dev
```

Point the Linq `message.received` webhook at `https://<host>/webhook/linq`.

## Playbooks

| Task type | Behaviour |
| --- | --- |
| `product_research` | Search review roundups, retailer listings **and forum opinion**, compare, then do a targeted retail lookup per pick for live price, stock and a regional buy link |
| `factual_lookup` | Search, read, answer with cited key facts |
| `social_media` | Public pages only. Never logs in |
| `interactive_browse` | Drives a real browser, one observed step at a time |

## Design notes

**Links cannot be hallucinated.** Synthesis schemas have no URL field. The model
emits a `sourceIndex` integer and code maps it to a real URL from the fetched
corpus, or to a retail URL that came from `search()` results. Anything out of
range is dropped.

**The agent cannot log in.** `detectBlock()` runs before every decision and
before any action — deterministic regexes over URL, title and accessibility
tree, no LLM to talk around. On a wall it screenshots the wall, stops, and falls
back to public sources. The decide-loop schema has no field capable of
expressing a credential, so no code path can type one.

**No blind step lists.** The browser tier observes the live page, picks an index
into the observed actions, and feeds prior step outcomes back in — so it cannot
decide to "click the second result" after already navigating away.

**Retail findings are reconciled in code.** Synthesis runs before the price
lookup, so its caveats are restated deterministically afterwards rather than
being allowed to contradict the links right above them. Sold-out picks are
demoted out of rank 1.

**Artifacts are per-run.** `public/runs/<uuid>/<n>.png`, swept on a TTL.
Concurrent requests can never see each other's screenshots.

## Testing without iMessage

```bash
curl -X POST http://localhost:3000/debug/run \
  -H "Content-Type: application/json" -H "x-debug-token: $DEBUG_TOKEN" \
  -d '{"text":"best power bank, top 3 with links, I live in Canada"}'
```

Returns the classification, corpus, structured data and rendered message as
JSON, and **sends nothing over iMessage**.

## Endpoints

| Method | Path | |
| --- | --- | --- |
| `POST` | `/webhook/linq` | Signature-verified inbound webhook; acks in <1s |
| `POST` | `/debug/run` | Full pipeline as JSON, no message sent |
| `GET` | `/health` | Config, models, active sessions, queue depth |
| `GET` | `/runs/<uuid>/<n>.png` | Run screenshots |

## Notes

- Stagehand v4 has no `stagehand.agent()` and no `env: "BROWSERBASE"`. This uses
  the current surface: `browserbase.launch()` → `Stagehand.create({ browser })`.
- gpt-5 models reject an explicit `temperature`; it is only sent for models that
  accept it.
- `.env` holds live credentials and is gitignored. Rotate if this folder is shared.
