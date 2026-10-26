---
name: run-octop
description: Launch headless Chromium against the running Octop dashboard container (http://localhost:8088) and drive it — log in, navigate, screenshot, read console errors. Use when asked to run, test, or screenshot the Octop app/dashboard in a browser.
---

Octop's dashboard is a React SPA served by the `octop` container (see
`../../../docker-compose.yml`). An agent here has no display, so "run the
app" means driving headless Chromium via the REPL driver at
`driver.mjs` and producing a screenshot that proves the page rendered.

All paths below are relative to `octop-orgchester/.claude/skills/run-octop/`.

## Prerequisites (one-time, already done in this checkout)

```bash
npm install playwright@1.49.1
npx playwright install --with-deps chromium   # browser + system libs (xvfb, libnss3, ...)
```

`chromium-cli` (mentioned in the upstream `run` skill's browser example)
does **not exist** — it's a placeholder/hallucinated npm package name.
Use Playwright's own `chromium` launcher directly, as this driver does.

## The container must already be running

```bash
cd ../../.. && docker compose up -d   # from octop-orgchester/
curl -sf http://localhost:8088/api/health
```

## Run (agent path)

```bash
node driver.mjs
```

Wrap in tmux for interactive use — **wait for each prompt/result before
sending the next command**, or input lands in the wrong place (sent
before a `quit` finishes, it falls through to the underlying shell):

```bash
tmux new-session -d -s octop -x 220 -y 50
tmux send-keys -t octop 'node driver.mjs' Enter
timeout 15 bash -c 'until tmux capture-pane -t octop -p | tail -1 | grep -q "^driver>"; do sleep 0.3; done'
tmux send-keys -t octop 'launch' Enter
timeout 20 bash -c 'until tmux capture-pane -t octop -p -S -3 | grep -q "launched"; do sleep 0.3; done'
```

Screenshots land in `/tmp/shots/` (override: `SCREENSHOT_DIR`).

### Login

There's no cookie/header shortcut — the login form has a client-side
drag-to-verify slider captcha that must be completed before submit:

```
login <username> <password>
```

This fills both fields, drags the slider (`slide-captcha`), then
presses Enter. The admin password lives in
`../../../data/credential.txt` on the host (root-owned — `sudo cat`),
written by the container's first-boot `octop init`. **It is not
necessarily the same as `OCTOP_DEFAULT_PASSWORD` in `.env`** if `.env`
was edited after the container's first boot (the `.initialized` marker
skips re-running `octop init`, so an old password can keep working
after `.env` changes) — `credential.txt` is always the source of truth
for the *running* container.

### Commands

| command | what it does |
|---|---|
| `launch` | launch headless Chromium |
| `nav [url]` | go to url (default: `http://localhost:8088`) |
| `login <user> <pass>` | fill + slide captcha + submit, waits for redirect off `/login` |
| `slide-captcha` | just the captcha drag (login calls this itself) |
| `click <css-sel>` | click element |
| `click-text <text>` | click the first button/link/element containing text |
| `fill <css-sel> <text>` | fill an input |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css-sel>` | wait for element, 15s timeout |
| `wait-text <text>` | wait for text to appear, 15s timeout |
| `has-text <text>` | YES/NO + count — check presence without waiting |
| `ss [name]` | full-page screenshot -> `/tmp/shots/<name>.png` |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print innerText (whole page if no selector) |
| `url` | print current page URL |
| `console [--errors]` | print captured browser console lines (or just errors/pageerrors) |
| `quit` | close browser, exit the REPL |

## Gotchas

- **The sidebar/dashboard UI is in Chinese by default** (no `Accept-Language`
  override in the driver) — `click-text`/`has-text` need the Chinese
  label (e.g. `模型` for "Models", not "Models").
- **Slider captcha is client-side only** (`src/pages/Login/SlideCaptcha.tsx`
  in `../../../../Octop/dashboard/`) — no server round trip, just a
  `mousedown` + `mousemove` sequence past 92% of the track width. Must
  use real `page.mouse` events, not a DOM `.click()` — it listens on
  `window`, not the element.
- **This container does not have the Agency feature installed.** The
  Agency feature lives entirely in `../../` (the `customize/` repo) as
  new files + patches for `Octop/` — `install.sh` has only ever been
  dry-run against disposable `/tmp` copies, never against the real
  `Octop/` checkout this container builds from. Driving the dashboard
  here will correctly show no "Agency" nav item; that's expected, not
  a bug, unless someone has since run `customize/install.sh` against
  `Octop/` and rebuilt the image.
- **Container has no outbound internet** in this sandboxed environment
  (confirmed: DNS and raw TCP egress both fail from inside `octop`,
  while the host resolves/connects fine) — any provider that calls out
  to a real LLM API will time out when actually used from here, even
  though it's configured correctly. Not fixable from inside the
  container; it's a property of this sandbox's container networking.

## Troubleshooting

- **`launch` hangs / missing `.so` errors:** re-run
  `npx playwright install --with-deps chromium`.
- **Commands appear to run but nothing happens / wrong output shows up:**
  a previous command (often `quit`) hadn't finished before the next
  `tmux send-keys` landed, so it went to the restarted shell prompt
  instead of the driver. Always poll for the expected prompt/output
  before sending the next command (see the tmux snippet above).
- **`login TIMEOUT, still at .../login`:** check `ss` + `text` — most
  likely the captcha slider wasn't completed (check for "Slide to the
  end to verify" in the page text) or the password is stale (re-check
  `data/credential.txt`, not `.env`).
