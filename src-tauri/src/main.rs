#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{ipc::Channel, AppHandle, Emitter, State};

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Ptys {
    map: Mutex<HashMap<u32, Pty>>,
    next: AtomicU32,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

/// Split off a trailing incomplete UTF-8 sequence so multibyte chars never break across chunks.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(), // genuinely invalid bytes: let lossy handle them
    };
    let rest = buf.split_off(cut);
    let s = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    s
}

#[tauri::command]
fn pty_spawn(app: AppHandle, st: State<Ptys>, on_data: Channel<String>, cwd: Option<String>, env: Option<HashMap<String, String>>, cols: u16, rows: u16) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(shell());
    if !cfg!(windows) { cmd.arg("-l"); }
    let dir = cwd.filter(|d| !d.is_empty())
        .map(|d| if let Some(r) = d.strip_prefix("~") { home().join(r.trim_start_matches('/')) } else { PathBuf::from(d) })
        .filter(|p| p.is_dir())
        .unwrap_or_else(home);
    cmd.cwd(dir);
    // don't leak a parent agent's session markers into child agents
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE_CODE") || k == "CLAUDECODE" || k.starts_with("CODEX_") { cmd.env_remove(k); }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Helm");
    for (k, v) in env.unwrap_or_default() { cmd.env(k, v); }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = st.next.fetch_add(1, Ordering::Relaxed) + 1;
    st.map.lock().unwrap().insert(id, Pty { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut chunk = [0u8; 16384];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&chunk[..n]);
                    let s = take_utf8(&mut pending);
                    if !s.is_empty() && on_data.send(s).is_err() { break; }
                }
            }
        }
        let _ = app.emit("pty-exit", id);
    });
    Ok(id)
}

#[tauri::command]
fn pty_write(st: State<Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut m = st.map.lock().unwrap();
    let p = m.get_mut(&id).ok_or("no pty")?;
    p.writer.write_all(data.as_bytes()).and_then(|_| p.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(st: State<Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let m = st.map.lock().unwrap();
    let p = m.get(&id).ok_or("no pty")?;
    p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(st: State<Ptys>, id: u32) {
    if let Some(mut p) = st.map.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
    }
}

/// Which known agent CLIs are on the user's login-shell PATH.
#[tauri::command]
fn detect_agents() -> Vec<String> {
    const AGENTS: &str = "claude codex gemini opencode aider cursor-agent amp goose qwen droid crush copilot";
    if cfg!(windows) {
        return AGENTS.split(' ').filter(|a| std::process::Command::new("where").arg(a).output().map(|o| o.status.success()).unwrap_or(false)).map(String::from).collect();
    }
    let script = format!("for a in {AGENTS}; do command -v $a >/dev/null 2>&1 && echo $a; done");
    std::process::Command::new(shell()).args(["-l", "-c", &script]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect())
        .unwrap_or_default()
}

#[derive(Serialize)]
struct Rec { ts: String, model: String, src: &'static str, input: u64, output: u64, cache_read: u64, cache_write: u64 }

#[derive(Serialize)]
struct Usage { records: Vec<Rec>, codex_limits: Option<Value>, codex_limits_ts: String }

fn jsonl_files(dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { jsonl_files(&p, since, out); }
        else if p.extension().is_some_and(|x| x == "jsonl")
            && e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= since) { out.push(p); }
    }
}

fn n(v: &Value, k: &str) -> u64 { v.get(k).and_then(Value::as_u64).unwrap_or(0) }

/// Token usage from local Claude Code + Codex logs, last 8 days.
// ponytail: rescans every poll, add an (path, mtime) cache if this ever gets slow
#[tauri::command]
async fn usage() -> Usage {
    let since = SystemTime::now() - Duration::from_secs(8 * 86400);
    let h = home();
    let mut records = Vec::new();
    let (mut codex_limits, mut codex_limits_ts) = (None, String::new());

    let mut files = Vec::new();
    jsonl_files(&h.join(".claude/projects"), since, &mut files);
    let mut seen = HashSet::new();
    for f in files {
        let Ok(file) = std::fs::File::open(&f) else { continue };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("\"usage\"") { continue; }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let m = &v["message"];
            let Some(u) = m.get("usage") else { continue };
            if let Some(id) = m["id"].as_str() { if !seen.insert(id.to_string()) { continue; } }
            let model = m["model"].as_str().unwrap_or("?");
            if model == "<synthetic>" { continue; }
            records.push(Rec {
                ts: v["timestamp"].as_str().unwrap_or("").into(), model: model.into(), src: "claude",
                input: n(u, "input_tokens"), output: n(u, "output_tokens"),
                cache_read: n(u, "cache_read_input_tokens"), cache_write: n(u, "cache_creation_input_tokens"),
            });
        }
    }

    let mut files = Vec::new();
    jsonl_files(&h.join(".codex/sessions"), since, &mut files);
    for f in files {
        let Ok(file) = std::fs::File::open(&f) else { continue };
        let mut model = String::from("codex");
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("turn_context") && !line.contains("token_count") { continue; }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let p = &v["payload"];
            let ts = v["timestamp"].as_str().unwrap_or("");
            if v["type"] == "turn_context" {
                if let Some(m) = p["model"].as_str() { model = m.into(); }
            } else if p["type"] == "token_count" {
                if let Some(u) = p["info"].get("last_token_usage") {
                    records.push(Rec {
                        ts: ts.into(), model: model.clone(), src: "codex",
                        input: n(u, "input_tokens").saturating_sub(n(u, "cached_input_tokens")), output: n(u, "output_tokens"),
                        cache_read: n(u, "cached_input_tokens"), cache_write: n(u, "cache_write_input_tokens"),
                    });
                }
                if p["rate_limits"].is_object() && ts > codex_limits_ts.as_str() {
                    codex_limits = Some(p["rate_limits"].clone());
                    codex_limits_ts = ts.into();
                }
            }
        }
    }
    Usage { records, codex_limits, codex_limits_ts }
}

fn helm_dir() -> PathBuf { home().join(".helm") }

/// ~/.helm holds config.json, custom.css and CLAUDE.md (the guide Claude reads when you ask it to restyle Helm).
#[tauri::command]
fn helm_read() -> HashMap<String, String> {
    ["config.json", "custom.css", "CLAUDE.md"].iter()
        .map(|f| (f.to_string(), std::fs::read_to_string(helm_dir().join(f)).unwrap_or_default())).collect()
}

#[tauri::command]
fn helm_write(name: String, content: String) -> Result<(), String> {
    if !["config.json", "custom.css", "CLAUDE.md"].contains(&name.as_str()) { return Err("not allowed".into()); }
    std::fs::create_dir_all(helm_dir()).map_err(|e| e.to_string())?;
    std::fs::write(helm_dir().join(name), content).map_err(|e| e.to_string())
}

fn valid_name(n: &str) -> bool { !n.is_empty() && n.len() < 64 && n.chars().all(|c| c.is_alphanumeric() || "-_. ".contains(c)) && !n.contains("..") }

/// Launch a desktop app by name (Slack, Claude, Visual Studio Code …).
#[tauri::command]
fn open_app(name: String) -> Result<(), String> {
    if !valid_name(&name) { return Err("bad app name".into()); }
    let out = if cfg!(target_os = "macos") { std::process::Command::new("open").args(["-a", &name]).output() }
        else if cfg!(windows) { std::process::Command::new("cmd").args(["/c", "start", "", &name]).output() }
        else { std::process::Command::new("gtk-launch").arg(&name).output() };
    match out { Ok(o) if o.status.success() => Ok(()), Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()), Err(e) => Err(e.to_string()) }
}

/// Extra Claude accounts live in ~/.helm/accounts/<name> and are used via CLAUDE_CONFIG_DIR.
#[tauri::command]
fn accounts() -> Vec<(String, String)> {
    let mut v = vec![("default".to_string(), String::new())];
    if let Ok(rd) = std::fs::read_dir(helm_dir().join("accounts")) {
        let mut extra: Vec<_> = rd.flatten().filter(|e| e.path().is_dir())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().to_string_lossy().into_owned())).collect();
        extra.sort();
        v.extend(extra);
    }
    v
}

#[tauri::command]
fn account_add(name: String) -> Result<String, String> {
    if !valid_name(&name) || name == "default" || name.contains(' ') { return Err("use a short name like work or personal".into()); }
    let dir = helm_dir().join("accounts").join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // share session history so `claude --continue` picks up the same conversation after switching accounts
    #[cfg(unix)]
    { let _ = std::os::unix::fs::symlink(home().join(".claude/projects"), dir.join("projects")); }
    Ok(dir.to_string_lossy().into_owned())
}

/// Live plan limits (% used) for one Claude account, the same numbers /usage shows.
/// The token is read locally and only ever sent to api.anthropic.com.
#[tauri::command]
async fn claude_limits(dir: String) -> Result<Value, String> {
    let token = oauth_token(&dir).ok_or("not logged in")?;
    let mut child = std::process::Command::new("curl")
        .args(["-sS", "--max-time", "10", "-H", "@-", "-H", "anthropic-beta: oauth-2025-04-20", "https://api.anthropic.com/api/oauth/usage"])
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    // header via stdin so the token never shows up in the process list
    child.stdin.take().unwrap().write_all(format!("Authorization: Bearer {token}\n").as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| String::from_utf8_lossy(&out.stderr).into_owned())?;
    if v.get("error").is_some() { return Err(v["error"]["message"].as_str().unwrap_or("usage request failed").into()); }
    Ok(v)
}

fn oauth_token(dir: &str) -> Option<String> {
    let cfg = if dir.is_empty() { home().join(".claude") } else { PathBuf::from(dir) };
    let from = |raw: &str| serde_json::from_str::<Value>(raw).ok()?["claudeAiOauth"]["accessToken"].as_str().map(String::from);
    if let Some(t) = std::fs::read_to_string(cfg.join(".credentials.json")).ok().and_then(|r| from(&r)) { return Some(t); }
    if !cfg!(target_os = "macos") { return None; }
    let mut service = "Claude Code-credentials".to_string();
    if !dir.is_empty() {
        use sha2::{Digest, Sha256};
        let h = Sha256::digest(dir.as_bytes());
        service += &format!("-{}", h.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>());
    }
    let out = std::process::Command::new("security").args(["find-generic-password", "-s", &service, "-w"]).output().ok()?;
    from(String::from_utf8_lossy(&out.stdout).trim())
}

/// Tabs open in Terminal.app / iTerm2: their cwd and foreground command, so Helm can reopen them as panes.
#[tauri::command]
async fn adopt_terminals() -> Vec<(String, String)> {
    if !cfg!(target_os = "macos") { return vec![]; }
    let running = |p: &str| std::process::Command::new("pgrep").args(["-xq", p]).status().is_ok_and(|s| s.success());
    let mut ttys = Vec::new();
    for (proc_, script) in [("Terminal", r#"tell application "Terminal" to get tty of every tab of every window"#),
                            ("iTerm2", r#"tell application "iTerm2" to get tty of every session of every tab of every window"#)] {
        if !running(proc_) { continue; } // never launch an app just to ask it
        if let Ok(o) = std::process::Command::new("osascript").args(["-e", script]).output() {
            ttys.extend(String::from_utf8_lossy(&o.stdout).split(',').map(|t| t.trim().trim_start_matches("/dev/").to_string()).filter(|t| !t.is_empty()));
        }
    }
    let mut out = Vec::new();
    for tty in ttys {
        let Ok(ps) = std::process::Command::new("ps").args(["-t", &tty, "-o", "pid=,stat=,args="]).output() else { continue };
        let ps = String::from_utf8_lossy(&ps.stdout).into_owned();
        let rows: Vec<(String, String, String)> = ps.lines().filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.to_string(), it.next()?.to_string(), it.collect::<Vec<_>>().join(" ")))
        }).collect();
        let is_shell = |a: &str| {
            let b = a.split_whitespace().next().unwrap_or("").trim_start_matches('-');
            ["zsh", "bash", "fish", "sh", "login"].contains(&b.rsplit('/').next().unwrap_or(b))
        };
        let Some(pid) = rows.iter().find(|r| is_shell(&r.2) && !r.2.starts_with("login")).map(|r| r.0.clone()) else { continue };
        let pid = pid.as_str();
        let fg = rows.iter().rev().find(|r| r.1.contains('+') && !is_shell(&r.2)).map(|r| r.2.clone()).unwrap_or_default();
        let cwd = std::process::Command::new("lsof").args(["-a", "-p", pid, "-d", "cwd", "-Fn"]).output().ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().find_map(|l| l.strip_prefix('n').map(String::from))).unwrap_or_default();
        out.push((cwd, fg));
    }
    out
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("only http(s) urls".into()); }
    let mut c = if cfg!(target_os = "macos") { std::process::Command::new("open") }
        else if cfg!(windows) { let mut c = std::process::Command::new("cmd"); c.args(["/c", "start", ""]); c }
        else { std::process::Command::new("xdg-open") };
    c.arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        // minimal menu: keeps copy/paste working; app hotkeys live here so they fire even when a browser pane has focus
        .menu(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
            let mac = cfg!(target_os = "macos");
            let m = if mac { "Cmd" } else { "Ctrl+Shift" }; // don't steal ctrl keys from terminals off-mac
            let keys = [
                ("k", "Command Bar", format!("{m}+K")), ("t", "New Shell", format!("{m}+T")),
                ("d", "Split Right", format!("{m}+D")), ("D", "Split Down", if mac { "Cmd+Shift+D".into() } else { "Ctrl+Shift+E".into() }),
                ("w", "Close Pane", format!("{m}+W")), ("enter", "Zoom Pane", format!("{m}+Enter")),
                ("[", "Previous Pane", format!("{m}+[")), ("]", "Next Pane", format!("{m}+]")),
                ("b", "Toggle Sidebar", format!("{m}+B")), ("/", "Help", format!("{m}+/")),
                (",", "Settings", format!("{m}+,")), ("r", "Rotate Account", format!("{m}+Shift+R")),
            ];
            let mut items = Vec::new();
            for (id, label, acc) in keys { items.push(MenuItem::with_id(app, id, label, true, Some(acc.as_str()))?); }
            for i in 1..=9 { items.push(MenuItem::with_id(app, i.to_string(), format!("Pane {i}"), true, Some(format!("{m}+{i}").as_str()))?); }
            let refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = items.iter().map(|i| i as _).collect();
            Menu::with_items(app, &[
                &Submenu::with_items(app, "Helm", true, &[&P::hide(app, None)?, &P::separator(app)?, &P::quit(app, None)?])?,
                &Submenu::with_items(app, "Edit", true, &[&P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?,
                    &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?])?,
                &Submenu::with_items(app, "Panes", true, &refs)?,
                &Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::fullscreen(app, None)?])?,
            ])
        })
        .on_menu_event(|app, e| { let _ = app.emit_to("main", "hotkey", e.id().0.clone()); })
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, detect_agents, usage, open_external, helm_read, helm_write, open_app, accounts, account_add, claude_limits, adopt_terminals])
        .run(tauri::generate_context!())
        .expect("error while running helm");
}

#[cfg(test)]
mod tests {
    #[test]
    fn utf8_split() {
        let mut b = "héllo ✓".as_bytes().to_vec();
        let last = b.pop().unwrap();
        assert_eq!(super::take_utf8(&mut b), "héllo ");
        b.push(last);
        assert_eq!(super::take_utf8(&mut b), "✓");
        assert!(b.is_empty());
    }
}
