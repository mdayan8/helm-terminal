<div align="center">

<img src="docs/logo.svg" width="96" alt="Helm logo">

# Helm

### One window. Every terminal, every agent, every page.

**Helm is a tiny, fast command center for people who run Claude Code, Codex and friends side by side.**
Spawn agents into auto-tiling splits, tag and route them, keep a browser next to your terminals,
and watch your real plan limits, all from one command bar.

[![Release](https://img.shields.io/github/v/release/mdayan8/helm?color=7c5cff&label=download)](https://github.com/mdayan8/helm/releases/latest)
![Size](https://img.shields.io/badge/app-3.3%20MB-22d3ee)
![Rust](https://img.shields.io/badge/core-Rust%20%2B%20Tauri%202-f97316)
![Platforms](https://img.shields.io/badge/macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)
[![License: MIT](https://img.shields.io/badge/license-MIT-34d399)](LICENSE)

<img src="docs/hero.jpg" alt="Helm with two Claude Code agents, a dev server and a live browser pane, tiled in one window">

</div>

---

## Why

You have three Claude Code sessions, a Codex run, a dev server and the app you're building, spread over
nine terminal tabs and two browser windows. You lose track of which agent is waiting on you, and you
find out you've hit your limit when the request fails.

**Helm puts all of it in one view, and makes the view do the work.**

## Features

|  |  |
|---|---|
| ⚡ **Real terminals, tiny app** | Native PTYs in Rust (`portable-pty`), xterm.js with WebGL rendering. The whole app is **3.3 MB** because it uses the system webview, not a bundled Chromium. |
| 🤖 **Every agent, auto-detected** | Finds `claude`, `codex`, `gemini`, `opencode`, `aider`, `cursor-agent`, `amp`, `goose`, `qwen`, `droid`, `crush`, `copilot` on your PATH and gives each a one-click launcher. Any other CLI works too. |
| 🪟 **Auto-tiling splits** | New panes split the focused pane along its longer side. Drag a header onto another pane's edge to re-split, or onto its centre to swap. `layout grid` re-tiles everything. |
| 🧠 **Smart layout, no AI calls** | Panes that are printing output or waiting on you grow, and idle ones shrink. Plain rules, zero tokens. |
| 🏷️ **Tags and routing** | Tag panes `#api`, `#web` and so on. `view #api` shows only that group. `send #api run the tests` types into every agent in the group at once. |
| 🌐 **Browser panes** | Real webviews (not iframes) beside your terminals. Clicking a link in a terminal opens it in a split. Drop a link from your browser onto a pane edge to open it there. |
| 📊 **Live plan limits** | Your actual Claude **5-hour and weekly %** with reset timers (the numbers `/usage` shows), Codex limits, tokens per model, and a 24-hour activity sparkline. |
| 🔄 **Account rotation** | Add more Claude accounts. New sessions start on the one with the most room. `⇧⌘R` hands a running session to another account with `--continue`, so the conversation carries over. Optional auto-handover when an idle session's account passes 95%. |
| 🎨 **Themes and glass** | 8 themes, see-through window, frosted glass, font size, all live. |
| 💬 **"Make it pink"** | Type `/ neon pink accents, rounder panes` and Claude restyles Helm by editing `~/.helm/custom.css`. Changes appear in about 2 seconds. |
| 🚀 **Launch anything** | `app Slack`, `open Claude`: start any desktop app from the command bar. |
| 📥 **Adopt your terminals** | `adopt` pulls the tabs already open in Terminal / iTerm into Helm. Agents resume where they were. |
| 🔔 **Needs-you alerts** | A pane that rings the bell glows amber until you look at it. The title bar counts how many agents are waiting. |
| 💾 **Picks up where you left off** | Layout, tags and commands are restored on launch. |

<table>
<tr>
<td><img src="docs/themes.jpg" alt="Settings: themes, transparency, accounts"></td>
<td><img src="docs/tags.jpg" alt="Filtering to one tag in the sunset theme"></td>
</tr>
<tr>
<td align="center"><sub>Themes, glass, accounts and "tell Claude" customization</sub></td>
<td align="center"><sub><code>view #web</code> filters to one group (sunset theme)</sub></td>
</tr>
</table>

## Install

**macOS:** grab `Helm.app` from the [latest release](https://github.com/mdayan8/helm/releases/latest), unzip it and drag it to Applications.
The build isn't notarized yet, so clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Helm.app
```

**From source (macOS, Linux, Windows):** you need Rust and Node 18+.

```bash
git clone https://github.com/mdayan8/helm && cd helm
npm install
npm run dev      # hot-reloading dev build
npm run build    # optimized app in src-tauri/target/release/bundle
```

## The command bar

Press **⌘K** and type. Tab completes, ↑ / ↓ walks history.

```text
claude                         new Claude Code pane (auto-tiled)
3x claude #api @~/code/api     three agents, tagged api, started in ~/code/api
codex #api !work               Codex in the api group; !work picks a Claude account
npm run dev [server]           any command, in a pane titled "server"
web localhost:3000             browser pane
app Slack                      launch a desktop app
adopt                          bring Terminal / iTerm tabs into Helm

send #api run the test suite   type into every pane tagged api   (* = all, 2 = pane 2)
> git status                   type into the focused pane
view #api   ·   view all       show one group, auto-gridded
layout grid | cols | rows      re-tile
close   ·   close #api         close focused / a whole group

theme nord · opacity 70 · blur on · font 14 · auto off
account add work   ·   rotate
/ make the active pane glow    ask Claude to restyle Helm
```

## Keys

| | |
|---|---|
| `⌘K` command bar | `⌘,` settings · `⌘/` help |
| `⌘T` new shell | `⌘D` / `⇧⌘D` split right / down |
| `⌘W` close pane | `⌘↩` zoom pane · `⌘B` sidebar |
| `⌘1–9` jump to pane | `⌘[` `⌘]` cycle · `⇧⌘R` rotate account |

Shortcuts are native menu accelerators, so they work even while a browser pane has focus.
On Linux and Windows they use `Ctrl+Shift` so plain `Ctrl` keys still reach your terminal.

## Accounts and limits

<img src="docs/glass.jpg" alt="Helm in the ocean theme with frosted glass" width="100%">

- **Limits** come from the same endpoint Claude Code's `/usage` uses. Your login token is read locally
  (Keychain on macOS, `~/.claude/.credentials.json` elsewhere) and only ever sent to `api.anthropic.com`,
  through curl's stdin so it never appears in the process list. Helm checks every 3 minutes.
- **Extra accounts** live in `~/.helm/accounts/<name>` and are passed to Claude Code as `CLAUDE_CONFIG_DIR`.
  Session history is shared between accounts, so `claude --continue` picks up the same conversation after a switch.
- **Tokens and models** are read from the local Claude Code and Codex logs. Nothing leaves your machine.

## Make it yours

Everything Helm looks like is in `~/.helm`:

```text
~/.helm/config.json    theme, opacity, blur, font size, layout and account toggles
~/.helm/custom.css     your overrides, applied last
~/.helm/CLAUDE.md      the guide Claude reads when you type "/ <request>"
```

Edit them yourself or let Claude do it. Helm reloads them live.

## How it's built

```text
src-tauri/src/main.rs   Rust: PTYs, agent detection, usage + limits, accounts, app launching, menu hotkeys
ui/app.js               layout tree, panes, command bar, smart layout, settings, usage panel
ui/style.css            every colour is a theme variable
```

Tauri 2 · portable-pty · xterm.js (WebGL) · no frontend framework, no bundler.

## Roadmap

- [ ] Codex account rotation
- [ ] Named workspaces (save and restore a whole layout by name)
- [ ] Signed and notarized macOS builds, Linux AppImage, Windows installer
- [ ] Per-pane notifications when an agent finishes

PRs welcome. If Helm saves you a few tab switches, a ⭐ helps other people find it.

## License

[MIT](LICENSE)
