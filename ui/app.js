const T = window.__TAURI__;
const { invoke, Channel } = T.core;
const { Webview } = T.webview;
const { LogicalPosition, LogicalSize } = T.dpi;
const win = T.window.getCurrentWindow();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

const stage = $('#stage'), cmd = $('#cmd');
const panes = new Map();          // id -> pane
let tree = null;                  // leaf {id} | split {dir:'h'|'v', r, a, b}
let focused = null, view = null;  // view: null | {tag} | {zoom:id}
let seq = 0, agents = [], overlay = 0;
const history = [];
let hpos = 0;

const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const dur = ms => { const m = Math.max(0, Math.round(ms / 6e4)); return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

function toast(msg) {
  $('#toast')?.remove();
  const d = Object.assign(document.createElement('div'), { id: 'toast', textContent: msg });
  document.body.append(d);
  setTimeout(() => d.remove(), 3200);
}

// ---------- config + themes (~/.helm/config.json, ~/.helm/custom.css) ----------
const THEMES = {
  midnight: { bg: '#0a0c11', panel: '#0f1218', line: '#1c2130', text: '#d7dbe6', mute: '#6b7387', acc: '#7c5cff', acc2: '#22d3ee' },
  tokyo:    { bg: '#16161e', panel: '#1a1b26', line: '#292e42', text: '#c0caf5', mute: '#565f89', acc: '#7aa2f7', acc2: '#bb9af7' },
  dracula:  { bg: '#1e1f29', panel: '#282a36', line: '#3a3c4e', text: '#f8f8f2', mute: '#6272a4', acc: '#bd93f9', acc2: '#ff79c6' },
  nord:     { bg: '#242933', panel: '#2e3440', line: '#3b4252', text: '#e5e9f0', mute: '#7b88a1', acc: '#88c0d0', acc2: '#a3be8c' },
  matrix:   { bg: '#030604', panel: '#07100a', line: '#123019', text: '#b6f5c4', mute: '#3f7a4f', acc: '#22c55e', acc2: '#a3e635' },
  sunset:   { bg: '#140c12', panel: '#1c111a', line: '#3a2333', text: '#f5e1ea', mute: '#9a7184', acc: '#fb7185', acc2: '#fbbf24' },
  ocean:    { bg: '#06131c', panel: '#0a1b27', line: '#16324a', text: '#d6ecf7', mute: '#5f87a0', acc: '#38bdf8', acc2: '#2dd4bf' },
  paper:    { bg: '#eceef3', panel: '#ffffff', line: '#dde1ea', text: '#1e2230', mute: '#6b7387', acc: '#6d4aff', acc2: '#0891b2', light: true },
};
const ANSI_DARK = { black: '#1c2130', brightBlack: '#4a5165', red: '#fb7185', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d7dbe6' };
const ANSI_LIGHT = { black: '#1e2230', brightBlack: '#6b7387', red: '#dc2626', green: '#059669', yellow: '#b45309', blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#94a3b8', brightWhite: '#475569' };
const DEFAULTS = { theme: 'midnight', opacity: 100, blur: false, fontSize: 13, autoLayout: true, autoPick: true, autoRotate: false, rotateAt: 95 };
let config = { ...DEFAULTS }, configText = '', cssText = '';

const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; };
const theme = () => ({ ...(THEMES[config.theme] || THEMES.midnight), ...(config.colors || {}) });
function termTheme() {
  const t = theme();
  return { ...(t.light ? ANSI_LIGHT : ANSI_DARK), background: 'rgba(0,0,0,0)', foreground: t.text, cursor: t.acc, cursorAccent: t.panel, selectionBackground: rgba(t.acc, .3) };
}
function applyConfig() {
  const t = theme(), a = Math.min(100, Math.max(15, +config.opacity || 100)) / 100, s = document.documentElement.style;
  for (const k of ['line', 'text', 'mute', 'acc', 'acc2']) s.setProperty('--' + k, t[k]);
  s.setProperty('--bg', rgba(t.bg, a));
  s.setProperty('--panel', rgba(t.panel, Math.min(1, a + .12)));
  document.body.classList.toggle('light', !!t.light);
  (config.blur ? win.setEffects({ effects: ['hudWindow'], state: 'active' }) : win.clearEffects()).catch(() => { });
  panes.forEach(p => { if (p.term) { p.term.options.theme = termTheme(); p.term.options.fontSize = +config.fontSize || 13; try { p.fit.fit(); } catch { } } });
  let st = $('#custom-css');
  if (!st) { st = Object.assign(document.createElement('style'), { id: 'custom-css' }); document.head.append(st); }
  st.textContent = cssText;
}
function setConfig(patch) {
  config = { ...config, ...patch };
  configText = JSON.stringify(config, null, 2);
  invoke('helm_write', { name: 'config.json', content: configText });
  applyConfig();
  if (!$('#settings').hidden) renderSettings();
}
// picks up edits from Claude (or a text editor) to ~/.helm without restarting
async function loadHelmFiles(first) {
  const f = await invoke('helm_read').catch(() => ({}));
  if (first && !f['CLAUDE.md']) invoke('helm_write', { name: 'CLAUDE.md', content: GUIDE });
  if (first && !f['config.json']) {
    f['config.json'] = JSON.stringify(DEFAULTS, null, 2);
    invoke('helm_write', { name: 'config.json', content: f['config.json'] });
  }
  const c = f['config.json'] || '', css = f['custom.css'] || '';
  if (c === configText && css === cssText) return;
  try { if (c) config = { ...DEFAULTS, ...JSON.parse(c) }; configText = c; } catch { }
  cssText = css;
  applyConfig();
  if (!first) toast('Helm look updated');
}

const GUIDE = `# Helm customization guide (read by Claude when the user types "/ <request>" in Helm)

You are restyling the Helm terminal command-center app. Helm reloads these files live (~2s). Only edit files in this folder.

## config.json  (JSON, keep valid)
- theme: one of ${Object.keys(THEMES).join(', ')}
- colors: optional overrides, any of {bg, panel, line, text, mute, acc, acc2} as #rrggbb hex
- opacity: 15-100 (window see-through; lower = more wallpaper)
- blur: true/false (frosted glass behind the window, macOS)
- fontSize: terminal font size (10-20)
- autoLayout: true/false (panes with live output grow automatically)
- autoPick: start new claude panes on the account with most room
- autoRotate: hand idle claude sessions to another account at rotateAt % (5h window)

## custom.css  (applied last, overrides everything)
CSS variables: --bg --panel --line --text --mute --acc --acc2 --warn --ok --bad --soft --soft2 --mono --sans
Selectors: body, #titlebar, .brand, #tagbar .chip, #launch button, #side (sidebar), .row (session row), .u-card (usage card), .bar i (usage bar fill),
#stage, .pane, .pane.focus, .pane header, .pane header .title, .pane header .tag, .gutter, #cmdbar, #cmd, .modal .card
Do not hide #cmdbar or #stage. Keep text readable.
`;

// ---------- layout tree (pure) ----------
const leaves = n => !n ? [] : 'id' in n ? [n.id] : [...leaves(n.a), ...leaves(n.b)];
function insert(n, target, id, side) {
  if (!n) return { id };
  if ('id' in n) {
    if (n.id !== target) return n;
    const first = side === 'left' || side === 'top';
    return { dir: side === 'left' || side === 'right' ? 'h' : 'v', r: .5, a: first ? { id } : n, b: first ? n : { id } };
  }
  return { ...n, a: insert(n.a, target, id, side), b: insert(n.b, target, id, side) };
}
function remove(n, id) {
  if (!n) return null;
  if ('id' in n) return n.id === id ? null : n;
  const a = remove(n.a, id), b = remove(n.b, id);
  return !a ? b : !b ? a : { ...n, a, b };
}
const swap = (n, x, y) => !n ? n : 'id' in n ? { id: n.id === x ? y : n.id === y ? x : n.id } : { ...n, a: swap(n.a, x, y), b: swap(n.b, x, y) };
const chain = (list, dir) => list.length === 1 ? list[0] : { dir, r: 1 / list.length, a: list[0], b: chain(list.slice(1), dir) };
function grid(ids, mode = 'grid') {
  if (!ids.length) return null;
  const nodes = ids.map(id => ({ id }));
  if (mode === 'cols') return chain(nodes, 'h');
  if (mode === 'rows') return chain(nodes, 'v');
  const cols = Math.ceil(Math.sqrt(ids.length)), rows = [];
  for (let i = 0; i < nodes.length; i += cols) rows.push(chain(nodes.slice(i, i + cols), 'h'));
  return chain(rows, 'v');
}

// ---------- panes ----------
const isClaude = p => p.kind === 'term' && /^claude\b/.test(p.cmd || '');

function makePane(o, id = ++seq) {
  seq = Math.max(seq, id);
  const el = document.createElement('div');
  el.className = 'pane' + (o.kind === 'web' ? ' web' : '');
  el.innerHTML = `<header draggable="true"><i class="dot"></i><span class="num"></span><span class="title" spellcheck="false"></span><span class="tag" spellcheck="false"></span><span class="acct"></span><span class="sp"></span>
    <button data-a="rotate" title="Hand this session to the account with most room (⇧⌘R)">⇄</button><button data-a="tag" title="Tag">#</button><button data-a="zoom" title="Zoom (⌘↩)">⤢</button><button data-a="close" title="Close (⌘W)">✕</button></header><div class="body"></div>`;
  const p = { id, el, body: el.querySelector('.body'), kind: 'term', title: o.cmd || 'shell', tag: '', cmd: '', cwd: '', url: '', account: '', ...o, alive: true, last: 0, bell: false };
  panes.set(id, p);
  const head = el.querySelector('header'), title = el.querySelector('.title'), tag = el.querySelector('.tag');
  paintHead(p);

  el.addEventListener('mousedown', () => focus(id));
  title.ondblclick = () => editable(title, v => { p.title = v || p.title; paintHead(p); renderSide(); save(); });
  tag.onclick = () => editable(tag, v => setTag(p, v));
  head.querySelector('[data-a=tag]').onclick = () => { tag.textContent ||= ' '; tag.style.display = 'inline'; editable(tag, v => { tag.style.display = ''; setTag(p, v); }); };
  head.querySelector('[data-a=zoom]').onclick = () => toggleZoom(id);
  head.querySelector('[data-a=close]').onclick = () => closePane(id);
  head.querySelector('[data-a=rotate]').onclick = () => rotate(p);

  head.addEventListener('dragstart', e => { e.dataTransfer.setData('helm/pane', String(id)); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging'); setOverlay(1); });
  head.addEventListener('dragend', () => { document.body.classList.remove('dragging'); setOverlay(-1); clearDrop(); });
  el.addEventListener('dragover', e => onDragOver(e, p));
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) clearDrop(); });
  el.addEventListener('drop', e => onDrop(e, p));
  return p;
}

const PALETTE = ['#a78bfa', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#a3e635'];
const tagColor = t => { let h = 0; for (const c of t || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return t ? PALETTE[h % PALETTE.length] : 'var(--mute)'; };

function paintHead(p) {
  const q = s => p.el.querySelector(s);
  q('.title').textContent = p.osc || p.title;
  q('.tag').textContent = p.tag ? '#' + p.tag : '';
  q('.tag').style.cssText = p.tag ? `color:${tagColor(p.tag)};background:${tagColor(p.tag)}1f` : '';
  q('.acct').textContent = isClaude(p) && accounts.length > 1 ? '@' + (p.account || 'default') : '';
  p.el.classList.toggle('agent-claude', isClaude(p));
}

function editable(el, done) {
  el.contentEditable = 'true'; el.focus();
  document.getSelection().selectAllChildren(el);
  const fin = save => { el.contentEditable = 'false'; el.onblur = el.onkeydown = null; done(save ? el.textContent.trim() : null); };
  el.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); fin(true); } if (e.key === 'Escape') fin(false); };
  el.onblur = () => fin(true);
}

function setTag(p, v) {
  if (v != null) p.tag = v.replace(/^#/, '').trim().replace(/\s+/g, '-');
  paintHead(p); renderSide(); save();
}

function startTerm(p) {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace', fontSize: +config.fontSize || 13, lineHeight: 1.15,
    cursorBlink: true, scrollback: 8000, allowProposedApi: true, allowTransparency: true, macOptionIsMeta: true, theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_, uri) => openWeb(uri, { near: p.id, tag: p.tag })));
  term.open(p.body);
  try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch { }
  p.term = term; p.fit = fit;
  try { fit.fit(); } catch { }
  term.attachCustomKeyEventHandler(e => !e.metaKey);
  term.onBell(() => { if (focused !== p.id) { p.bell = true; tick(); } });
  term.onTitleChange(t => { p.osc = t.trim(); paintHead(p); renderSide(); });
  term.textarea?.addEventListener('focus', () => focus(p.id, false));
  term.onData(data => p.pty && invoke('pty_write', { id: p.pty, data }));
  term.onResize(({ cols, rows }) => p.pty && invoke('pty_resize', { id: p.pty, cols, rows }));
  new ResizeObserver(() => requestAnimationFrame(() => { if (p.el.isConnected) try { fit.fit(); } catch { } })).observe(p.body);
  spawnPty(p);
}

async function spawnPty(p) {
  const ch = new Channel();
  ch.onmessage = d => { p.term.write(d); p.last = Date.now(); };
  const acct = accounts.find(a => a[0] === p.account);
  const env = acct?.[1] ? { CLAUDE_CONFIG_DIR: acct[1] } : null;
  try {
    p.pty = await invoke('pty_spawn', { onData: ch, cwd: p.cwd || null, env, cols: p.term.cols, rows: p.term.rows });
    p.alive = true;
  } catch (e) { p.term.write(`\x1b[31mspawn failed: ${e}\x1b[0m`); p.alive = false; return; }
  if (p.cmd) invoke('pty_write', { id: p.pty, data: p.cmd + '\r' });
  if (focused === p.id) p.term.focus();
}

const normUrl = u => /^[a-z]+:\/\//i.test(u) ? u : /^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(u) ? 'http://' + u : 'https://' + u;
const hostOf = u => { try { return new URL(u).host; } catch { return u; } };

function startWeb(p) {
  p.body.innerHTML = `<div class="urlbar"><button data-w="reload" title="Reload">↻</button><input spellcheck="false"><button data-w="ext" title="Open in system browser">↗</button></div><div class="wvhost">loading…</div>`;
  const input = p.body.querySelector('input');
  input.value = p.url;
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { p.url = normUrl(input.value.trim()); p.title = hostOf(p.url); paintHead(p); save(); makeWv(p); } };
  p.body.querySelector('[data-w=reload]').onclick = () => makeWv(p);
  p.body.querySelector('[data-w=ext]').onclick = () => invoke('open_external', { url: p.url }).catch(e => toast(String(e)));
  makeWv(p);
}

function makeWv(p) {
  p.wv?.close().catch(() => { });
  const r = p.body.querySelector('.wvhost').getBoundingClientRect();
  p.wv = new Webview(win, `w${p.id}_${Date.now()}`, { url: p.url, x: r.left, y: r.top, width: Math.max(r.width, 1), height: Math.max(r.height, 1) });
  p.wv.once('tauri://error', e => toast('browser pane failed: ' + JSON.stringify(e.payload)));
  p.shown = true;
  placeWv(p);
}

function placeWv(p) {
  if (!p.wv) return;
  const host = p.body.querySelector('.wvhost');
  if (overlay || !p.el.isConnected || !host) { if (p.shown) { p.wv.hide().catch(() => { }); p.shown = false; } return; }
  const r = host.getBoundingClientRect();
  p.wv.setPosition(new LogicalPosition(r.left, r.top)).catch(() => { });
  p.wv.setSize(new LogicalSize(Math.max(r.width, 1), Math.max(r.height, 1))).catch(() => { });
  if (!p.shown) { p.wv.show().catch(() => { }); p.shown = true; }
}
const syncWebviews = () => panes.forEach(p => p.kind === 'web' && placeWv(p));
// native webviews float above the DOM, so hide them while a DOM overlay (drag, modal) is up
function setOverlay(d) { overlay = Math.max(0, overlay + d); syncWebviews(); }

function addPane(o, target = focused, side) {
  if (isClaude(o) && !o.account) o.account = pickAccount();
  const p = makePane(o);
  if (!panes.has(target) || !leaves(tree).includes(target)) target = leaves(tree).at(-1);
  if (!side && target != null) {
    const r = panes.get(target).el.getBoundingClientRect();
    side = r.width > r.height * 1.3 ? 'right' : 'bottom';   // auto-tile along the longer axis
  }
  if (view?.zoom || (view?.tag && view.tag !== p.tag)) view = null;
  tree = insert(tree, target, p.id, side);
  focused = p.id;
  render();
  return p;
}

function closePane(id) {
  const p = panes.get(id);
  if (!p) return;
  if (p.pty) invoke('pty_kill', { id: p.pty });
  p.term?.dispose();
  p.wv?.close().catch(() => { });
  panes.delete(id);
  tree = remove(tree, id);
  if (view?.zoom === id) view = null;
  if (focused === id) focused = leaves(viewTree()).at(-1) ?? null;
  render();
  if (focused) focus(focused);
}

function focus(id, move = true) {
  const p = panes.get(id);
  if (!p) return;
  focused = id; p.bell = false;
  panes.forEach(q => q.el.classList.toggle('focus', q.id === id));
  if (move) { if (p.term) p.term.focus(); else p.wv?.setFocus().catch(() => { }); }
  tick();
}

function openWeb(url, { near, tag = '', side } = {}) {
  url = normUrl(url);
  return addPane({ kind: 'web', url, title: hostOf(url), tag }, near, side);
}

// ---------- render ----------
const splitEls = new WeakMap();   // split node -> [A, B] elements, for live ratio updates
function viewTree() {
  if (view?.zoom && panes.has(view.zoom)) return { id: view.zoom };
  if (view?.tag) return grid(leaves(tree).filter(id => panes.get(id).tag === view.tag));
  return tree;
}

function build(n) {
  if ('id' in n) return panes.get(n.id).el;
  const d = document.createElement('div');
  d.className = 'split ' + n.dir;
  const A = build(n.a), B = build(n.b), g = document.createElement('div');
  g.className = 'gutter';
  splitEls.set(n, [A, B]);
  A.style.flex = `${n.r} 1 0`; B.style.flex = `${1 - n.r} 1 0`;
  g.onmousedown = e => dragGutter(e, n, d, A, B, g);
  d.append(A, g, B);
  return d;
}

function dragGutter(e, n, d, A, B, g) {
  e.preventDefault(); g.classList.add('drag'); document.body.classList.add('dragging');
  const box = d.getBoundingClientRect(), h = n.dir === 'h';
  const move = ev => {
    n.r = Math.min(.9, Math.max(.1, h ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height));
    delete n._eff;
    A.style.flex = `${n.r} 1 0`; B.style.flex = `${1 - n.r} 1 0`;
    syncWebviews();
  };
  const up = () => { g.classList.remove('drag'); document.body.classList.remove('dragging'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); save(); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

function render() {
  const t = viewTree();
  stage.replaceChildren(t ? build(t) : emptyState());
  const shown = leaves(t);
  shown.forEach((id, i) => { panes.get(id).el.querySelector('.num').textContent = i < 9 ? `⌘${i + 1}` : ''; });
  requestAnimationFrame(() => {
    for (const id of shown) {
      const p = panes.get(id);
      if (!p.started) { p.started = true; p.kind === 'web' ? startWeb(p) : startTerm(p); }
      else try { p.fit?.fit(); } catch { }
    }
    syncWebviews();
    if (focused && shown.includes(focused)) focus(focused, document.activeElement !== cmd);
  });
  renderSide(); save();
}

function emptyState() {
  const d = document.createElement('div');
  d.className = 'empty';
  d.innerHTML = `<div class="card"><h1><b class="grad">◆</b> Helm</h1><p>One view for every terminal, agent, page and app. Type below, or pick one.</p><div class="btns"></div></div>`;
  const btns = d.querySelector('.btns');
  for (const a of [...agents, 'shell', 'web', 'adopt']) {
    const b = Object.assign(document.createElement('button'), { textContent: a === 'adopt' ? 'adopt open terminals' : a });
    b.onclick = () => run(a === 'web' ? 'web google.com' : a);
    btns.append(b);
  }
  return d;
}

function renderSide() {
  const ids = leaves(tree);
  const groups = {};
  ids.forEach(id => { const p = panes.get(id); (groups[p.tag] ||= []).push(p); });
  $('#list').innerHTML = Object.keys(groups).sort((a, b) => !a - !b || a.localeCompare(b)).map(tag => `
    <div class="grp"><div class="grp-h" data-tag="${esc(tag)}" style="color:${tagColor(tag)}">${tag ? '#' + esc(tag) : 'untagged'} <span class="muted">${groups[tag].length}</span></div>
    ${groups[tag].map(p => `<div class="row ${p.id === focused ? 'on' : ''}" data-id="${p.id}"><i class="dot" data-dot="${p.id}"></i><span class="t">${esc(p.osc || p.title)}</span><span class="k">${p.kind === 'web' ? 'web' : esc(p.cmd.split(' ')[0] || 'sh')}</span></div>`).join('')}</div>`).join('')
    || '<div class="muted" style="padding:6px">no panes yet</div>';
  const tags = [...new Set(ids.map(id => panes.get(id).tag).filter(Boolean))];
  $('#tagbar').innerHTML = tags.length ? `<button class="chip ${!view?.tag ? 'on' : ''}" data-tag="">all</button>` + tags.map(t => `<button class="chip ${view?.tag === t ? 'on' : ''}" data-tag="${esc(t)}" style="${view?.tag === t ? `color:${tagColor(t)}` : ''}">#${esc(t)}</button>`).join('') : '';
  tick();
}

$('#list').onclick = e => {
  const row = e.target.closest('.row'), grp = e.target.closest('.grp-h');
  if (row) { const id = +row.dataset.id; if (!leaves(viewTree()).includes(id)) { view = null; render(); } focus(id); }
  else if (grp && grp.dataset.tag) setView(grp.dataset.tag);
};
$('#tagbar').onclick = e => { const c = e.target.closest('.chip'); if (c) setView(c.dataset.tag); };
function setView(tag) { view = tag && view?.tag !== tag ? { tag } : null; render(); }
function toggleZoom(id = focused) { if (id == null) return; view = view?.zoom === id ? null : { zoom: id }; render(); }

const state = p => !p.alive ? 'dead' : p.bell ? 'bell' : Date.now() - p.last < 1500 ? 'busy' : 'live';
function tick() {
  let busy = 0, bell = 0, live = 0;
  panes.forEach(p => {
    const st = state(p);
    if (p.kind === 'term' && p.alive) live++;
    if (st === 'busy') busy++; if (st === 'bell') bell++;
    p.el.classList.toggle('bell', p.bell);
    for (const d of [p.el.querySelector('.dot'), document.querySelector(`[data-dot="${p.id}"]`)]) if (d) d.className = 'dot ' + st;
  });
  $('#stats').innerHTML = panes.size ? `<span><b>${live}</b> terminals</span><span><b>${busy}</b> active</span>${bell ? `<span class="att"><b>${bell}</b> need you</span>` : ''}` : '';
}
setInterval(() => { tick(); smartLayout(); }, 800);

// ---------- smart layout: rules, no model calls ----------
// Panes printing output, waiting on you, or focused get more room; idle ones shrink. User-set ratios stay the baseline.
function weight(p) {
  if (p.bell) return 1.9;
  if (Date.now() - p.last < 4000) return 1.7;
  if (p.id === focused) return 1.4;
  return p.alive ? 1 : .6;
}
function smartLayout() {
  if (!config.autoLayout || view?.zoom || overlay) return;
  let moved = false;
  const avg = n => { const ids = leaves(n); return ids.reduce((s, id) => s + weight(panes.get(id)), 0) / ids.length; };
  const walk = n => {
    if (!n || 'id' in n) return;
    const els = splitEls.get(n);
    if (els) {
      const wa = avg(n.a) * n.r, wb = avg(n.b) * (1 - n.r);
      const r = Math.min(.82, Math.max(.18, wa / (wa + wb)));
      if (Math.abs(r - (n._eff ?? n.r)) > .04) { n._eff = r; els[0].style.flex = `${r} 1 0`; els[1].style.flex = `${1 - r} 1 0`; moved = true; }
    }
    walk(n.a); walk(n.b);
  };
  walk(viewTree());
  if (moved) { syncWebviews(); setTimeout(syncWebviews, 380); }
}

// ---------- drag & drop ----------
let dropEl = null;
function zoneOf(e, el) {
  const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (x > .3 && x < .7 && y > .3 && y < .7) return 'center';
  return [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]].sort((a, b) => a[1] - b[1])[0][0];
}
function onDragOver(e, p) {
  const t = e.dataTransfer.types;
  const isPane = t.includes('helm/pane'), isLink = t.includes('text/uri-list') || t.includes('text/plain');
  if (!isPane && !isLink) return;
  e.preventDefault();
  let z = zoneOf(e, p.el);
  if (!isPane && z === 'center') z = 'right';
  dropEl ||= Object.assign(document.createElement('div'), { className: 'drop' });
  const r = p.el.getBoundingClientRect(), s = stage.getBoundingClientRect();
  const [l, tp, w, h] = { left: [0, 0, .5, 1], right: [.5, 0, .5, 1], top: [0, 0, 1, .5], bottom: [0, .5, 1, .5], center: [.25, .25, .5, .5] }[z];
  Object.assign(dropEl.style, { left: r.left - s.left + l * r.width + 'px', top: r.top - s.top + tp * r.height + 'px', width: w * r.width + 'px', height: h * r.height + 'px' });
  stage.append(dropEl);
}
function clearDrop() { dropEl?.remove(); }
function onDrop(e, p) {
  e.preventDefault(); clearDrop();
  const src = +e.dataTransfer.getData('helm/pane');
  const z = zoneOf(e, p.el);
  if (src) {
    if (src === p.id) return;
    view = null;
    tree = z === 'center' ? swap(tree, src, p.id) : insert(remove(tree, src), p.id, src, z);
    render(); focus(src);
  } else {
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').find(l => l && !l.startsWith('#'))?.trim();
    if (url) openWeb(url, { near: p.id, tag: p.tag, side: z === 'center' ? 'right' : z });
  }
}
stage.addEventListener('dragover', e => { if (!tree) e.preventDefault(); });
stage.addEventListener('drop', e => { if (!tree) { e.preventDefault(); const u = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'); if (u) openWeb(u.trim()); } });

// ---------- accounts, limits, rotation ----------
let accounts = [['default', '']];  // [name, CLAUDE_CONFIG_DIR]
const limits = {};                 // name -> usage response | {error}
const util = (name, key = 'five_hour') => limits[name]?.[key]?.utilization;

async function refreshAccounts() {
  accounts = await invoke('accounts').catch(() => accounts);
  panes.forEach(paintHead);
}
async function refreshLimits() {
  await Promise.all(accounts.map(async ([name, dir]) => {
    try { limits[name] = await invoke('claude_limits', { dir }); }
    catch (e) { limits[name] = { error: String(e) }; }
  }));
  renderUsage();
  if (!$('#settings').hidden) renderSettings();
  autoRotate();
}
// the account with the most 5h room; accounts whose limits are unknown are skipped
function pickAccount(except) {
  if (!config.autoPick || accounts.length < 2) return '';
  const best = accounts.filter(a => a[0] !== except && util(a[0]) != null).sort((a, b) => util(a[0]) - util(b[0]))[0]?.[0];
  return best && best !== 'default' ? best : '';
}
function rotate(p, to) {
  if (!p || !isClaude(p)) return toast('focus a Claude pane to rotate');
  const cur = p.account || 'default';
  const others = accounts.filter(a => a[0] !== cur && util(a[0]) != null).sort((a, b) => util(a[0]) - util(b[0]));
  const next = to ?? (others[0] ? (others[0][0] === 'default' ? '' : others[0][0]) : undefined);
  if (next === undefined) return toast('no other logged-in account — add one: account add <name>');
  if (p.pty) invoke('pty_kill', { id: p.pty });
  p.account = next;
  p.cmd = p.cmd.replace(/\s(--continue|-c)\b/g, '') + ' --continue';
  p.term.reset();
  p.term.write(`\x1b[2m⇄ continuing on account ${next || 'default'}…\x1b[0m\r\n`);
  paintHead(p); save();
  spawnPty(p);
  toast(`session moved to @${next || 'default'}`);
}
function autoRotate() {
  if (!config.autoRotate || accounts.length < 2) return;
  const limit = +config.rotateAt || 95;
  for (const p of panes.values()) {
    if (!isClaude(p) || !p.alive || Date.now() - p.last < 8000) continue;  // only hand off idle sessions
    const cur = p.account || 'default';
    if ((util(cur) ?? 0) < limit) continue;
    const best = accounts.filter(a => a[0] !== cur && util(a[0]) != null && util(a[0]) < limit).sort((a, b) => util(a[0]) - util(b[0]))[0];
    if (best) rotate(p, best[0] === 'default' ? '' : best[0]);
  }
}

// ---------- command bar ----------
function targets(sel) {
  const ids = leaves(tree);
  if (sel === '*') return ids;
  if (/^\d+$/.test(sel)) return [leaves(viewTree())[+sel - 1]].filter(Boolean);
  return ids.filter(id => panes.get(id).tag === sel.replace(/^#/, ''));
}
function sendTo(ids, text) {
  let n = 0;
  for (const id of ids) {
    const p = panes.get(id);
    if (p?.pty && p.alive) { invoke('pty_write', { id: p.pty, data: text }); setTimeout(() => invoke('pty_write', { id: p.pty, data: '\r' }), 60); n++; }
  }
  toast(`sent to ${n} pane${n === 1 ? '' : 's'}`);
}
const isUrl = s => /^(https?:\/\/|localhost|\d+\.\d+\.\d+\.\d+|[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/|$|:))/i.test(s);
const onOff = v => /^(on|true|yes|1)$/i.test(v);

async function adopt() {
  const tabs = await invoke('adopt_terminals');
  if (!tabs.length) return toast('no Terminal / iTerm tabs found (macOS asks for permission the first time)');
  for (const [cwd, fg] of tabs) {
    const c = /^claude\b/.test(fg) ? 'claude --continue' : /^codex\b/.test(fg) ? 'codex resume --last' : '';
    addPane({ kind: 'term', cmd: c, title: c || 'shell', tag: 'adopted', cwd });
  }
  toast(`adopted ${tabs.length} terminal${tabs.length === 1 ? '' : 's'} — close the originals when you're happy`);
}

function customize(req) {
  addPane({ kind: 'term', tag: 'helm', cwd: '~/.helm', title: 'customize Helm',
    cmd: `claude --permission-mode acceptEdits '${('Read CLAUDE.md, then: ' + req).replace(/'/g, `'\\''`)}'` });
}

async function run(line) {
  line = line.trim();
  if (!line) return;
  let m;
  if (line === 'help' || line === '?') return showModal('help', true);
  if (line === 'settings' || line === 'accounts') return showModal('settings', true);
  if ((m = line.match(/^(?:\/|ai\s+)\s*([\s\S]+)$/))) return customize(m[1]);
  if ((m = line.match(/^send\s+(\S+)\s+([\s\S]+)$/))) return sendTo(targets(m[1]), m[2]);
  if ((m = line.match(/^>\s*([\s\S]+)$/))) return sendTo([focused], m[1]);
  if ((m = line.match(/^layout\s+(grid|cols|rows)$/))) { view = null; tree = grid(leaves(tree), m[1]); return render(); }
  if ((m = line.match(/^(?:close|kill)(?:\s+(\S+))?$/))) { (m[1] ? targets(m[1]) : [focused]).forEach(closePane); return; }
  if ((m = line.match(/^tag\s+#?(\S+)$/))) { const p = panes.get(focused); return p && setTag(p, m[1]); }
  if ((m = line.match(/^view\s+#?(\S+)$/))) return setView(m[1] === 'all' ? '' : m[1]);
  if ((m = line.match(/^theme\s+(\S+)$/))) return THEMES[m[1]] ? setConfig({ theme: m[1], colors: undefined }) : toast('themes: ' + Object.keys(THEMES).join(', '));
  if ((m = line.match(/^(?:opacity|transparency)\s+(\d+)%?$/))) return setConfig({ opacity: +m[1] });
  if ((m = line.match(/^blur\s+(\S+)$/))) return setConfig({ blur: onOff(m[1]) });
  if ((m = line.match(/^font\s+(\d+)$/))) return setConfig({ fontSize: +m[1] });
  if ((m = line.match(/^auto\s+(\S+)$/))) { setConfig({ autoLayout: onOff(m[1]) }); if (!config.autoLayout) render(); return; }
  if (line === 'adopt') return adopt();
  if (line === 'web' || line === 'open' || line === 'browse') return openWeb('google.com');
  if (line === 'app') return toast('app <name>, e.g. app Slack');
  if (line === 'rotate') return rotate(panes.get(focused));
  if ((m = line.match(/^account\s+add\s+(\S+)$/))) {
    try { await invoke('account_add', { name: m[1] }); await refreshAccounts(); }
    catch (e) { return toast(String(e)); }
    addPane({ kind: 'term', cmd: 'claude', title: `login ${m[1]}`, tag: 'accounts', account: m[1] });
    return toast(`type /login in the new pane to sign in account "${m[1]}"`);
  }
  if ((m = line.match(/^(?:app|open|launch)\s+(.+)$/)) && !isUrl(m[1])) {
    return invoke('open_app', { name: m[1].trim() }).then(() => toast(`opened ${m[1]}`), e => toast(`couldn't open ${m[1]}: ${e}`));
  }

  let tag = '', cwd = '', count = 1, account = '', title = '';
  line = line.replace(/\s*\[([^\]]+)\]\s*$/, (_, t) => (title = t.trim(), '')).replace(/(^|\s)#([\w.-]+)/g, (_, s, t) => (tag = t, s))
    .replace(/(^|\s)@(\S+)/g, (_, s, d) => (cwd = d, s))
    .replace(/(^|\s)!([\w.-]+)/g, (_, s, a) => (account = a === 'default' ? '' : a, s))
    .replace(/^(\d+)\s*x\s+/i, (_, k) => (count = Math.min(+k, 12), ''))
    .trim();

  if ((m = line.match(/^(?:web|open|browse)\s+(\S+)$/)) || (isUrl(line) && !/\s/.test(line) && (m = [, line]))) {
    for (let i = 0; i < count; i++) openWeb(m[1], { tag });
    return;
  }
  if (/^(shell|term|sh|terminal)?$/.test(line)) line = '';
  line = line.replace(/^run\s+/, '');
  const first = line.split(/\s+/)[0];
  if (!tag && agents.includes(first)) tag = first;
  for (let i = 0; i < count; i++) addPane({ kind: 'term', cmd: line, title: title || line || 'shell', tag, cwd, account });
}

const HINTS = [
  [/^\/|^ai /, 'Claude edits ~/.helm to restyle Helm'], [/^send/, 'send #tag|*|N <text>'], [/^theme/, () => Object.keys(THEMES).join(' · ')],
  [/^(app|open|launch) /, 'any desktop app or URL'], [/^opacity/, '15-100'], [/^account/, 'account add <name>'], [/^adopt/, 'Terminal / iTerm tabs → Helm'],
  [/^\d+x/, 'N copies'], [/^layout/, 'grid · cols · rows'], [/!/, 'claude !account'],
];
cmd.addEventListener('input', () => {
  const h = HINTS.find(([re]) => re.test(cmd.value));
  $('#hint').textContent = h ? (typeof h[1] === 'function' ? h[1]() : h[1]) : '⌘K';
  $('#hint').className = h ? 'live' : '';
});
cmd.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = cmd.value; if (v.trim()) { history.push(v); hpos = history.length; } cmd.value = ''; cmd.dispatchEvent(new Event('input')); run(v); }
  else if (e.key === 'ArrowUp' && hpos > 0) { cmd.value = history[--hpos]; e.preventDefault(); }
  else if (e.key === 'ArrowDown') { cmd.value = history[++hpos] ?? ''; hpos = Math.min(hpos, history.length); e.preventDefault(); }
  else if (e.key === 'Escape') { cmd.blur(); focused && focus(focused); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const words = [...agents, 'shell', 'web ', 'app ', 'adopt', 'send #', 'layout grid', 'view #', 'close', 'tag #', ...Object.keys(THEMES).map(t => 'theme ' + t),
      'opacity ', 'blur on', 'blur off', 'auto on', 'auto off', 'account add ', 'rotate', 'settings', 'help'];
    const hit = words.find(w => w.startsWith(cmd.value) && w !== cmd.value);
    if (hit) { cmd.value = hit; cmd.dispatchEvent(new Event('input')); }
  }
});

// ---------- modals ----------
function showModal(name, on) {
  const el = $('#' + name);
  if (on === undefined) on = el.hidden;
  if (on === !el.hidden) return;
  el.hidden = !on; setOverlay(on ? 1 : -1);
  if (on && name === 'settings') { renderSettings(); refreshAccounts().then(refreshLimits); }
}
$('#help').onclick = () => showModal('help', false);
$('#settings').onclick = e => { if (e.target.id === 'settings') showModal('settings', false); };

const tog = (key, label, sub) => `<div class="set"><label>${label}<small>${sub}</small></label><button class="tog ${config[key] ? 'on' : ''}" data-tog="${key}"></button></div>`;
function renderSettings() {
  const pct = n => n == null ? '—' : Math.round(n) + '%';
  const ask = $('#ask')?.value || '', name = $('#acct-name')?.value || '';
  $('#settings-body').innerHTML = `
    <h3>Theme</h3>
    <div class="themes">${Object.entries(THEMES).map(([n, t]) => `<button class="${config.theme === n ? 'on' : ''}" data-theme="${n}"><div class="sw" style="background:${t.bg};border:1px solid ${t.line}"><i style="background:${t.acc}"></i><i style="background:${t.acc2}"></i><i style="background:${t.text}"></i></div>${n}</button>`).join('')}</div>
    <h3>Window</h3>
    <div class="set"><label>Transparency<small>lower shows your wallpaper through Helm</small></label><input type="range" min="15" max="100" value="${config.opacity}" data-range="opacity"><output>${config.opacity}%</output></div>
    ${tog('blur', 'Frosted glass', 'blur what is behind the window (macOS)')}
    <div class="set"><label>Font size</label><input type="range" min="10" max="20" value="${config.fontSize}" data-range="fontSize"><output>${config.fontSize}px</output></div>
    ${tog('autoLayout', 'Smart layout', 'panes with live output or waiting on you grow; idle ones shrink')}
    <h3>Claude accounts</h3>
    ${accounts.map(([n]) => `<div class="acct-row"><span class="n">${esc(n)}</span><span class="muted">${limits[n]?.error ? esc(limits[n].error) : `5h ${pct(util(n))} · week ${pct(util(n, 'seven_day'))}`}</span><button data-login="${esc(n)}">log in</button></div>`).join('')}
    <div class="row2"><input class="field" id="acct-name" placeholder="new account name, e.g. work" value="${esc(name)}"><button class="btn" id="acct-add">add account</button></div>
    ${tog('autoPick', 'Start on the freest account', 'new claude panes use the account with the most 5-hour room')}
    ${tog('autoRotate', 'Auto handover', `idle sessions move to another account (with --continue) once theirs passes ${config.rotateAt}%`)}
    <h3>Make it yours</h3>
    <div class="row2"><input class="field" id="ask" placeholder="tell Claude: e.g. neon pink accents, rounder panes, bigger tab bar" value="${esc(ask)}"><button class="btn" id="ask-go">customize</button></div>
    <p class="muted" style="font-size:11.5px">Claude edits ~/.helm/custom.css and config.json; Helm reloads them live.</p>`;
}
$('#settings-body').onclick = e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.theme) setConfig({ theme: t.dataset.theme, colors: undefined });
  if (t.dataset.tog) setConfig({ [t.dataset.tog]: !config[t.dataset.tog] });
  if (t.dataset.login) { showModal('settings', false); addPane({ kind: 'term', cmd: 'claude', title: 'login ' + t.dataset.login, tag: 'accounts', account: t.dataset.login === 'default' ? '' : t.dataset.login }); toast('type /login in the new pane'); }
  if (t.id === 'acct-add') { const n = $('#acct-name').value.trim(); if (n) { showModal('settings', false); run('account add ' + n); } }
  if (t.id === 'ask-go') { const q = $('#ask').value.trim(); if (q) { showModal('settings', false); customize(q); } }
};
$('#settings-body').oninput = e => {
  const k = e.target.dataset.range;
  if (!k) return;
  e.target.nextElementSibling.textContent = e.target.value + (k === 'opacity' ? '%' : 'px');
  config[k] = +e.target.value; applyConfig();
};
$('#settings-body').onchange = e => { const k = e.target.dataset.range; if (k) setConfig({ [k]: +e.target.value }); };

// ---------- hotkeys (native menu accelerators: fire even while a browser pane has focus) ----------
addEventListener('keydown', e => { if (e.key === 'Escape') { showModal('help', false); showModal('settings', false); } });
T.event.listen('hotkey', ({ payload: k }) => {
  const shown = leaves(viewTree()), i = shown.indexOf(focused);
  ({
    k: () => T.webview.getCurrentWebview().setFocus().finally(() => cmd.focus()),
    t: () => run('shell'),
    d: () => addPane({ kind: 'term', title: 'shell', tag: panes.get(focused)?.tag || '' }, focused, 'right'),
    D: () => addPane({ kind: 'term', title: 'shell', tag: panes.get(focused)?.tag || '' }, focused, 'bottom'),
    w: () => focused != null && closePane(focused),
    enter: () => toggleZoom(),
    b: () => { document.body.classList.toggle('noside'); requestAnimationFrame(syncWebviews); },
    '[': () => shown.length && focus(shown[(i - 1 + shown.length) % shown.length]),
    ']': () => shown.length && focus(shown[(i + 1) % shown.length]),
    '/': () => showModal('help'),
    ',': () => showModal('settings'),
    r: () => rotate(panes.get(focused)),
  }[k] || (() => shown[+k - 1] && focus(shown[+k - 1])))();
});

addEventListener('resize', () => requestAnimationFrame(syncWebviews));
new ResizeObserver(() => requestAnimationFrame(syncWebviews)).observe(stage);

T.event.listen('pty-exit', ({ payload }) => {
  for (const p of panes.values()) if (p.pty === payload) {
    p.alive = false;
    p.term?.write('\r\n\x1b[2m[process exited — ⌘W to close]\x1b[0m\r\n');
  }
});

// ---------- persistence ----------
function save() {
  const ps = [...panes.values()].map(({ id, kind, cmd, url, tag, cwd, title, account }) => ({ id, kind, cmd, url, tag, cwd, title, account }));
  localStorage.setItem('helm', JSON.stringify({ tree, panes: ps, focused }));
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('helm'));
    if (!s?.tree) return;
    s.panes.forEach(o => makePane(o, o.id));
    const ok = id => panes.has(id);
    tree = leaves(s.tree).every(ok) ? s.tree : grid([...panes.keys()]);
    focused = ok(s.focused) ? s.focused : leaves(tree)[0];
  } catch { tree = null; }
}

// ---------- usage monitor ----------
let usageCache = null;
const tok = r => r.input + r.output + r.cache_write;   // cache reads are ~free against limits
function bar(label, pct, right, warn = true) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return `<div class="u-row"><div class="l"><span>${label}</span><b>${right}</b></div><div class="bar ${warn && w > 80 ? 'hot' : ''}"><i style="width:${w}%"></i></div></div>`;
}
const LIMIT_NAMES = { five_hour: '5h session', seven_day: 'week', seven_day_opus: 'week · Opus', seven_day_sonnet: 'week · Sonnet', seven_day_oauth_apps: 'week · apps' };

async function refreshUsage() {
  try { usageCache = await invoke('usage'); } catch (e) { $('#usage').innerHTML = `<div class="muted">usage unavailable: ${esc(e)}</div>`; return; }
  renderUsage();
}
function renderUsage() {
  const u = usageCache;
  if (!u) return;
  const now = Date.now(), H = 36e5;
  const recs = u.records.map(r => ({ ...r, t: Date.parse(r.ts) })).filter(r => r.t).sort((a, b) => a.t - b.t);
  const html = [];

  for (const src of ['claude', 'codex']) {
    const rs = recs.filter(r => r.src === src);
    if (!rs.length && !(src === 'codex' && u.codex_limits)) continue;
    const week = rs.filter(r => r.t > now - 7 * 24 * H);
    const weekTok = week.reduce((s, r) => s + tok(r), 0);
    const byModel = {};
    week.forEach(r => byModel[r.model] = (byModel[r.model] || 0) + tok(r));
    const hours = Array.from({ length: 24 }, (_, i) => rs.filter(r => r.t > now - (24 - i) * H && r.t <= now - (23 - i) * H).reduce((s, r) => s + tok(r), 0));
    const hmax = Math.max(...hours, 1);

    let rows = '';
    if (src === 'claude') {
      for (const [name] of accounts) {
        const L = limits[name];
        const keys = L && !L.error ? Object.keys(L).filter(k => L[k] && typeof L[k].utilization === 'number') : [];
        if (accounts.length > 1 || !keys.length) rows += `<div class="u-acct"><span>@${esc(name)}</span><span class="muted">${L?.error ? esc(L.error) : L ? '' : 'loading…'}</span></div>`;
        for (const k of keys) {
          const reset = L[k].resets_at ? ' · resets ' + dur(Date.parse(L[k].resets_at) - now) : '';
          rows += bar((LIMIT_NAMES[k] || k.replace(/_/g, ' ')) + reset, L[k].utilization, Math.round(L[k].utilization) + '%');
        }
      }
      rows += bar('tokens · 7 days', 100, fmt(weekTok), false);
    } else {
      const L = u.codex_limits;
      for (const k of ['primary', 'secondary']) {
        const w = L?.[k];
        if (!w) continue;
        const name = w.window_minutes > 10080 ? 'month' : w.window_minutes === 10080 ? 'week' : `${Math.round(w.window_minutes / 60)}h`;
        rows += bar(`${name} · resets ${dur(w.resets_at * 1000 - now)}`, w.used_percent, Math.round(w.used_percent) + '%');
      }
      rows += bar('tokens · 7 days', 100, fmt(weekTok), false);
    }
    const models = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([m, n]) => `<div><span>${esc(m.replace(/^claude-/, ''))}</span><b>${fmt(n)}</b></div>`).join('');
    html.push(`<div class="u-card"><div class="u-h">${src === 'claude' ? 'Claude Code' : 'Codex'}<span>${src === 'codex' && u.codex_limits ? esc(u.codex_limits.plan_type || '') : ''}</span></div>
      ${rows}<div class="spark" title="tokens per hour, last 24h">${hours.map((h, i) => `<i class="${i === 23 ? 'n' : ''}" style="height:${Math.max(2, h / hmax * 28)}px"></i>`).join('')}</div>
      <div class="models">${models}</div></div>`);
  }
  $('#usage').innerHTML = html.join('') || '<div class="muted">no Claude Code / Codex logs in the last week</div>';
}
$('#usage-ts').onclick = () => { refreshUsage(); refreshLimits(); toast('refreshing usage…'); };

// ---------- boot ----------
function renderLaunch() {
  const l = $('#launch');
  l.innerHTML = '';
  for (const a of [...agents, 'shell', 'web', 'app', '⚙']) {
    const b = Object.assign(document.createElement('button'), { textContent: a === 'shell' ? '+ shell' : a === 'web' ? '+ web' : a === 'app' ? '+ app' : a, title: a === '⚙' ? 'Settings (⌘,)' : '' });
    b.onclick = () => a === '⚙' ? showModal('settings', true) : a === 'web' || a === 'app' ? (cmd.value = a + ' ', cmd.focus(), cmd.dispatchEvent(new Event('input'))) : run(a);
    l.append(b);
  }
}

(async () => {
  await loadHelmFiles(true);
  await refreshAccounts();
  restore();
  render();
  renderLaunch();
  invoke('detect_agents').then(a => { agents = a; renderLaunch(); if (!tree) render(); });
  refreshUsage(); refreshLimits();
  setInterval(refreshUsage, 60_000);
  setInterval(refreshLimits, 180_000);   // the limits endpoint is rate limited; 3 min is plenty
  setInterval(() => loadHelmFiles(false), 2000);
  if (!tree) cmd.focus();
})();
