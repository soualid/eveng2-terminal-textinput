# eveng2-terminal-textinput

**Typed text input for [Even Terminal](https://www.evenrealities.com/terminal)** — the Terminal Mode of the Even Realities G2 smart glasses.

The official Terminal Mode drives your coding agents (Claude Code, Codex…) by
voice, with a tap on the glasses' temple. This project adds the missing piece:
**typing your prompts from a plain web page on your phone**, while keeping the
glasses HUD — both see exactly the same sessions.

- 📋 **All your Claude Code sessions**, with live status (`busy` / `idle`),
  including sessions started elsewhere on the machine
- 💬 **Live transcript**: streamed text, expandable tool calls (input/output),
  cost and duration per turn
- ⌨️ **Text composer** to send a prompt — resume an existing session or create
  a new one in any project directory
- 📎 **Screenshot input**: attach images from the phone; they're saved locally
  and referenced by path in the prompt, so Claude Code reads them with its Read
  tool (even-terminal's API stays text-only)
- ✅ **Permission and question prompts** answered with buttons, plus an
  interrupt button
- 🌐 **Unified view**: one list aggregating the sessions of every running
  `even-terminal` instance, with a per-project pill on each row and a global
  bar of pills showing what's running where at a glance (also acts as a filter);
  the header selector still lets you focus a single project
- 🪶 **Zero dependencies, zero patching**: one Node server file + one HTML
  page; the official app is left untouched

## How it works

On startup, `even-terminal` writes a pidfile to `~/.even-terminal/instances/`
containing its HTTP port and bearer token. `server.mjs` discovers live
instances from those pidfiles, serves the mobile page, and proxies `/api/*` to
the selected instance while injecting the `Authorization` header — the token
never leaves the machine.

```
phone (Safari) ──► server.mjs :8790 ──► even-terminal :4444 ──► Claude Code
G2 glasses ◄── Even Realities app ◄──────────┘
```

The page relies only on even-terminal's existing API:

| Endpoint | Purpose |
|---|---|
| `GET /api/sessions` | session list (everything under `~/.claude/projects`) |
| `GET /api/events` (SSE) | live transcript: `text_delta`, `tool_start/end`, `permission_request`… |
| `POST /api/prompt` | send text — resumes a session or creates one |
| `POST /api/permission-response` / `question-response` / `interrupt` | drive the current turn |

Since everything flows through even-terminal, the glasses display the same
thing: type on the phone, follow along and approve on the glasses (or the
other way around).

## Requirements

- Node.js ≥ 18
- [`@evenrealities/even-terminal`](https://www.npmjs.com/package/@evenrealities/even-terminal)
  running and paired with the Even Realities app (Terminal Mode enabled)

## Install & run

```sh
git clone https://github.com/soualid/eveng2-terminal-textinput.git
cd eveng2-terminal-textinput
npm start
```

The companion listens on **port 8790** by default. Open one of the printed
URLs on your phone — `http://<your-machine-ip>:8790/` (prefer the Tailscale IP).
Tip: Safari's "Share → Add to Home Screen" gives you a proper full-screen app.

## Configuration

Everything is driven by environment variables; none are required:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8790` | companion listen port |
| `BIND_HOST` | `0.0.0.0` | listen interface — set your Tailscale IP (`100.x`) to restrict access to your tailnet |
| `EVEN_TERMINAL_PORT` | *(most recent)* | default even-terminal instance when several are running (the UI selector still takes precedence) |

## Known limitations

- Typing into a session that is **still open in an interactive terminal**
  forks it (two writers on the same history). Keep those read-only; write to
  finished sessions or ones created from this page.
- SSE replay only covers sessions alive inside the even-terminal process; for
  the others, the page loads the latest exchanges from disk.
- The page has no authentication of its own: don't expose it beyond your
  tailnet or a trusted LAN (`BIND_HOST`).
- `claude` provider only for now (even-terminal's API also speaks Codex).

## License

[MIT](LICENSE) — personal project, not affiliated with Even Realities or
Anthropic.
