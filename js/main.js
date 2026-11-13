import { readShareFromHash, normalizeBaseUrl, buildShareLink } from './config.js';
import { listModels, streamChat } from './api.js';
import { TOOL_DEFS, TOOL_SYSTEM_HINT, runTool } from './tools.js';
import { createFrame, removeFrame } from './frames.js';
import { createPaneManager } from './panes.js';
import { renderMarkdown } from './markdown.js';
import { sessionToMarkdown, formatDuration, formatSeconds } from './session.js';

const MAX_TOOL_ROUNDS = 10;
const PROMPT_MAX_PX = 240;
const $ = (id) => document.getElementById(id);

// The page has two faces: without a `#<payload>` link it is a link builder; with one it is the chat.
// All state lives in memory only. Nothing is written to localStorage/sessionStorage/cookies,
// and the address bar only changes when the user presses Connect. Reloading is "clear chat".
const state = {
  cfg: { baseUrl: '', apiKey: '', model: '', system: '' },
  // Tools are always offered; if the server rejects them we fall back for the rest of the session.
  toolsSupported: true,
  messages: [],
  busy: false,
  stream: null, // AbortController of the in-flight completion request
  stopRequested: false, // Stop: end the run
  interrupt: false, // Send now: end the current stream, then continue with the queue
  /** Messages typed during a run; delivered at the next model call. @type {{text:string, el:HTMLElement}[]} */
  queue: [],
  /** Inline widgets by id, so re-rendering an id replaces the old one. @type {Map<string, {card:HTMLElement, chip:{note:Function}|null}>} */
  inline: new Map(),
};

const el = {
  messages: $('messages'),
  empty: $('empty'),
  prompt: $('prompt'),
  send: $('send-btn'),
  stop: $('stop-btn'),
  queue: $('queue'),
  status: $('status'),
  panesShow: $('panes-show'),
  cfgStatus: $('cfg-status'),
  resizer: $('resizer'),
  aside: $('panes'),
};

const panes = createPaneManager({
  aside: el.aside,
  tabs: $('pane-tabs'),
  body: $('pane-body'),
  onChange: () => {
    el.panesShow.hidden = panes.count === 0 || panes.visible;
    el.resizer.hidden = !panes.visible;
  },
});

// ---------------------------------------------------------------- startup

function init() {
  // Connect, Back/Forward, or pasting another link into this tab: start over with the new hash.
  window.addEventListener('hashchange', () => location.reload());

  let shared = null;
  let linkError = null;
  try {
    shared = readShareFromHash(location.hash);
  } catch (e) {
    linkError = e;
  }

  if (!shared) {
    $('setup').hidden = false;
    wireSetup();
    if (linkError) showSetupStatus('error', linkError.message);
    $('cfg-baseurl').focus();
    return;
  }

  $('app').hidden = false;
  state.cfg = { ...state.cfg, ...shared, baseUrl: normalizeBaseUrl(shared.baseUrl) };
  wireComposer();
  wireLayout();
  wireScrollFollow();
  wireSaveShortcut();
  connect();
  el.prompt.focus();
}

async function connect() {
  setStatus('pending', 'Connecting…');
  const { baseUrl, apiKey } = state.cfg;
  try {
    const models = await listModels({ baseUrl, apiKey });
    // Links don't carry a model (it made them long); use the server's first one. If the server
    // lists none, the field is omitted and the server picks.
    state.cfg.model = models[0] || '';
    setStatus('ok', `Connected${state.cfg.model ? ` · ${state.cfg.model}` : ''}`);
  } catch (e) {
    // Some servers have no /models endpoint; chat may still work, so don't block.
    setStatus('warn', `Model list unavailable: ${e.message}`);
    notice(`Couldn't list models: ${e.message}`, 'warn');
  }
}

function setStatus(kind, text) {
  el.status.dataset.state = kind;
  el.status.setAttribute('aria-label', text);
}

// ---------------------------------------------------------------- setup (link builder)

function readSetupForm() {
  return {
    baseUrl: normalizeBaseUrl($('cfg-baseurl').value),
    apiKey: $('cfg-apikey').value.trim(),
    system: $('cfg-system').value,
  };
}

function showSetupStatus(kind, text) {
  el.cfgStatus.dataset.kind = kind;
  el.cfgStatus.textContent = text;
}

let modelsRequest = 0;
async function refreshModels() {
  const cfg = readSetupForm();
  if (!cfg.baseUrl) return;
  const req = ++modelsRequest;
  showSetupStatus('', 'Connecting…');
  try {
    const models = await listModels(cfg);
    if (req !== modelsRequest) return;
    const using = models.length ? ` Chats will use ${models[0]}${models.length > 1 ? ' (the first listed)' : ''}.` : '';
    showSetupStatus('ok', `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.${using}`);
  } catch (e) {
    if (req !== modelsRequest) return;
    showSetupStatus('error', e.message);
  }
  updateShareLink();
}

function currentLink() {
  const cfg = readSetupForm();
  return cfg.baseUrl ? buildShareLink(location.href, cfg) : '';
}

function updateShareLink() {
  $('share-link').value = currentLink();
}

function wireSetup() {
  const form = $('setup-form');
  form.addEventListener('input', updateShareLink);
  // `change` fires on blur/commit, so typing a URL doesn't spam requests.
  $('cfg-baseurl').addEventListener('change', refreshModels);
  $('cfg-apikey').addEventListener('change', refreshModels);
  $('cfg-test').addEventListener('click', refreshModels);

  $('copy-share').addEventListener('click', async () => {
    const input = $('share-link');
    if (!input.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      flash($('copy-share'), 'Copied');
    } catch {
      input.select();
      flash($('copy-share'), 'Press ⌘/Ctrl+C');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const link = currentLink();
    if (link) location.href = link; // the hashchange handler reloads into chat mode
  });
}

/** Copies text, falling back to execCommand where the async clipboard API is unavailable (non-HTTPS). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------------------------------------------------------------- composer + queue

const IDLE_PLACEHOLDER = 'Message…  (Enter to send, Shift+Enter for newline)';
const BUSY_PLACEHOLDER = 'Queue a message… it is sent at the next step (Esc stops)';

function wireComposer() {
  const form = $('composer');
  el.prompt.placeholder = IDLE_PLACEHOLDER;
  el.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Escape' && state.busy) {
      stop();
    }
  });
  el.prompt.addEventListener('input', autosize);
  el.stop.addEventListener('click', stop);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.prompt.value.trim();
    if (!text) return;
    el.prompt.value = '';
    autosize();
    following = true; // sending is a clear "take me to the latest"
    if (state.busy) {
      enqueue(text);
    } else {
      pushUser(text);
      runTurn();
    }
  });
  autosize();
}

function autosize() {
  const p = el.prompt;
  p.style.height = 'auto';
  // scrollHeight excludes the border; with border-box sizing, leaving it out makes the box
  // 2px short, so the textarea overflows and flashes a scrollbar on every keystroke.
  const full = p.scrollHeight + (p.offsetHeight - p.clientHeight);
  p.style.height = `${Math.min(full, PROMPT_MAX_PX)}px`;
  p.style.overflowY = full > PROMPT_MAX_PX ? 'auto' : 'hidden';
}

function setBusy(busy) {
  state.busy = busy;
  el.stop.hidden = !busy;
  el.prompt.placeholder = busy ? BUSY_PLACEHOLDER : IDLE_PLACEHOLDER;
  if (!busy) el.prompt.focus();
}

function stop() {
  state.stopRequested = true;
  state.stream?.abort();
}

function enqueue(text) {
  const item = { text, el: h('div', 'queued') };
  const now = h('button', 'ghost small', 'Send now');
  now.type = 'button';
  now.title = 'Interrupt the current response and send queued messages';
  now.addEventListener('click', () => {
    state.interrupt = true;
    state.stream?.abort(); // if tools are running instead, the queue goes out right after them
  });
  const del = h('button', 'icon-btn', '×');
  del.type = 'button';
  del.title = 'Remove from queue';
  del.setAttribute('aria-label', 'Remove from queue');
  del.addEventListener('click', () => {
    state.queue = state.queue.filter((q) => q !== item);
    item.el.remove();
    el.queue.hidden = state.queue.length === 0;
  });
  item.el.append(h('span', 'queued-label', 'Queued'), h('div', 'queued-text', text), now, del);
  state.queue.push(item);
  el.queue.append(item.el);
  el.queue.hidden = false;
}

function takeQueue() {
  const items = state.queue.splice(0);
  items.forEach((i) => i.el.remove());
  el.queue.hidden = true;
  return items.map((i) => i.text);
}

/** Adds a user message; consecutive user messages are merged in the API history (some chat templates require alternation). */
function pushUser(text) {
  addUserMessage(text);
  const last = state.messages.at(-1);
  if (last?.role === 'user') last.content += `\n\n${text}`;
  else state.messages.push({ role: 'user', content: text });
}

// ---------------------------------------------------------------- conversation

function buildRequest() {
  const toolsOn = state.toolsSupported;
  const system = [state.cfg.system, toolsOn && TOOL_SYSTEM_HINT].filter(Boolean).join('\n\n');
  // Assistant messages keep their thinking locally (for the transcript); it is never sent back.
  let history = state.messages.map(({ reasoning, thinkingMs, ...m }) => m);
  if (!toolsOn) {
    // Servers reject tool messages when no tools are declared; strip them from the history.
    history = history
      .filter((m) => m.role !== 'tool')
      .map((m) => (m.tool_calls ? { role: m.role, content: m.content } : m))
      .filter((m) => m.role !== 'assistant' || m.content);
  }
  const body = { messages: system ? [{ role: 'system', content: system }, ...history] : history };
  if (state.cfg.model) body.model = state.cfg.model;
  if (toolsOn) body.tools = TOOL_DEFS;
  return body;
}

/** Attaches a reply's thinking (text + duration) for the transcript; buildRequest strips it. */
function withThinking(msg, reasoning, view) {
  if (reasoning) {
    msg.reasoning = reasoning;
    msg.thinkingMs = view.thinkingMs();
  }
  return msg;
}

/** Does this error look like the server refusing the `tools` parameter? */
function isToolRejection(err) {
  return state.toolsSupported && err.status >= 400 && err.status < 600 && /tool|jinja|function.?call/i.test(err.message);
}

/**
 * Runs model calls until the model answers without tool calls and nothing is queued.
 * Queued messages are added to the history before each call, so they steer the next step.
 */
async function runTurn() {
  setBusy(true);
  state.stopRequested = false;
  let rounds = 0;
  try {
    for (;;) {
      const queued = takeQueue();
      if (queued.length) {
        queued.forEach(pushUser);
        rounds = 0;
      }
      if (rounds++ >= MAX_TOOL_ROUNDS) {
        notice(`Stopped after ${MAX_TOOL_ROUNDS} consecutive tool rounds. Send a message to continue.`, 'warn');
        return;
      }

      const ctrl = new AbortController();
      state.stream = ctrl;
      state.interrupt = false;
      const view = createAssistantView();
      let partial = null;
      let result;
      try {
        result = await streamChat({
          baseUrl: state.cfg.baseUrl,
          apiKey: state.cfg.apiKey,
          body: buildRequest(),
          signal: ctrl.signal,
          onUpdate: (p) => { partial = p; view.update(p); },
        });
      } catch (e) {
        state.stream = null;
        if (e.name === 'AbortError') {
          // Keep what was said so far; half-streamed tool calls are dropped.
          const kept = { content: partial?.content || '', reasoning: partial?.reasoning || '', toolCalls: [], finishReason: null };
          if (kept.content || kept.reasoning) view.finish(kept, { stopped: true });
          else view.remove();
          if (kept.content) state.messages.push(withThinking({ role: 'assistant', content: kept.content }, kept.reasoning, view));
          if (state.interrupt && !state.stopRequested) continue;
          return;
        }
        if (isToolRejection(e)) {
          state.toolsSupported = false;
          view.remove();
          notice('This server doesn’t accept tool calls, so widgets and panes are off for this session.', 'warn');
          rounds--;
          continue;
        }
        view.fail(e, () => { view.remove(); runTurn(); });
        return;
      }
      state.stream = null;

      view.finish(result);
      const msg = withThinking({ role: 'assistant', content: result.content }, result.reasoning, view);
      if (result.toolCalls.length) msg.tool_calls = result.toolCalls;
      state.messages.push(msg);
      if (!result.toolCalls.length) {
        if (state.queue.length && !state.stopRequested) continue;
        return;
      }

      for (const call of result.toolCalls) {
        const chip = view.addToolCall(call);
        let output;
        try {
          output = await runTool(call.function.name, call.function.arguments, {
            mountInline: (w) => mountInlineWidget(view, chip, w),
            inline: { has: (id) => state.inline.has(id), remove: (id) => removeInlineWidget(id, 'removed') },
            panes,
          });
        } catch (e) {
          output = `Error: ${e.message}`;
        }
        chip.done(output);
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
      if (state.stopRequested) return;
    }
  } finally {
    state.stream = null;
    if (state.stopRequested && state.queue.length) {
      // Stop means stop: hand queued text back for editing instead of sending it.
      el.prompt.value = [...takeQueue(), el.prompt.value].filter(Boolean).join('\n\n');
      autosize();
    }
    setBusy(false);
  }
}

function mountInlineWidget(view, chip, widget) {
  if (state.inline.has(widget.id)) removeInlineWidget(widget.id, 'replaced');
  const card = widgetCard(widget);
  view.extras.append(card);
  state.inline.set(widget.id, { card, chip });
  followScroll();
}

/** Removes a live inline widget; its tool-call line stays, marked with `reason`. */
function removeInlineWidget(id, reason) {
  const entry = state.inline.get(id);
  if (!entry) return;
  removeFrame(id);
  entry.card.remove();
  entry.chip?.note(reason);
  state.inline.delete(id);
}

// ---------------------------------------------------------------- message views

// Auto-follow is a sticky mode rather than "near the bottom": any upward scroll by the user
// (wheel, keys, touch, scrollbar drag) turns it off, and reaching the bottom turns it back on.
// A proximity rule kept yanking the view back whenever you'd scrolled up only a little.
let following = true;

function wireScrollFollow() {
  const m = el.messages;
  let lastTop = m.scrollTop;
  const atBottom = () => m.scrollHeight - m.scrollTop - m.clientHeight <= 8;
  m.addEventListener('wheel', (e) => { if (e.deltaY < 0) following = false; }, { passive: true });
  m.addEventListener('scroll', () => {
    if (atBottom()) following = true;
    else if (m.scrollTop < lastTop - 1) following = false; // moved up; content shrinking keeps us at the bottom instead
    lastTop = m.scrollTop;
  }, { passive: true });
}

function followScroll() {
  if (following) el.messages.scrollTop = el.messages.scrollHeight;
}

function append(node) {
  el.empty.hidden = true;
  el.messages.append(node);
  followScroll();
  return node;
}

function h(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function addUserMessage(text) {
  append(h('div', 'msg user', text));
}

function notice(text, kind = 'info') {
  append(h('div', `notice ${kind}`, text));
}


let codeRunCounter = 0;

function decorateCode(pre, code, host) {
  const bar = h('div', 'code-actions');
  const run = h('button', 'ghost small', '▶ Run');
  run.type = 'button';
  run.addEventListener('click', () => host.append(widgetCard({ id: `code-${++codeRunCounter}`, title: 'Code preview', html: code })));
  const pane = h('button', 'ghost small', '⧉ Open in pane');
  pane.type = 'button';
  pane.addEventListener('click', () => { const id = `code-${++codeRunCounter}`; panes.open(id, `Preview ${codeRunCounter}`, code); });
  bar.append(run, pane);
  pre.before(bar);
}

function createAssistantView() {
  const root = append(h('div', 'msg assistant pending'));
  const thinking = h('details', 'reasoning'); // starts collapsed; only the user opens it
  thinking.hidden = true;
  const thinkingSummary = h('summary', null, 'Thinking…');
  const thinkingText = h('div', 'reasoning-text');
  thinking.append(thinkingSummary, thinkingText);
  const body = h('div', 'md');
  const extras = h('div', 'extras');
  root.append(thinking, body, extras);

  let latest = null;
  let scheduled = false;
  let finished = false;
  let thinkStart = 0;
  let thinkEnd = 0;
  let ticker = null; // refreshes the live "Thinking for N seconds…" header

  const endThinking = () => {
    if (thinkStart && !thinkEnd) thinkEnd = performance.now();
    clearInterval(ticker);
    ticker = null;
  };
  const trackThinking = (p) => {
    if (p.reasoning && !thinkStart) {
      thinkStart = performance.now();
      ticker = setInterval(updateThinkingSummary, 1000);
    }
    if (thinkStart && !thinkEnd && (p.content || p.toolCalls.length)) endThinking();
  };
  const updateThinkingSummary = () => {
    if (thinkEnd) {
      thinkingSummary.textContent = `Thought for ${formatDuration(thinkEnd - thinkStart)}`;
    } else {
      const s = Math.floor((performance.now() - thinkStart) / 1000);
      thinkingSummary.textContent = s < 1 ? 'Thinking…' : `Thinking for ${formatSeconds(s)}…`;
    }
  };

  const render = () => {
    scheduled = false;
    if (!latest || finished) return;
    if (latest.reasoning) {
      thinking.hidden = false;
      thinkingText.textContent = latest.reasoning;
      updateThinkingSummary();
    }
    renderMarkdown(body, latest.content);
    const pendingCalls = latest.toolCalls.map((c) => c.function.name).filter(Boolean);
    root.dataset.calling = pendingCalls.length ? `Preparing ${pendingCalls.join(', ')}…` : '';
    if (latest.content || latest.reasoning || pendingCalls.length) root.classList.remove('pending');
    followScroll();
  };

  return {
    extras,
    update(p) {
      latest = p;
      trackThinking(p);
      if (!scheduled) { scheduled = true; requestAnimationFrame(render); }
    },
    finish(p, { stopped = false } = {}) {
      latest = p;
      trackThinking(p);
      endThinking();
      render();
      finished = true; // a still-queued animation-frame render must not overwrite the final one
      root.classList.remove('pending');
      root.dataset.calling = '';
      updateThinkingSummary();
      renderMarkdown(body, p.content, { final: true, decorate: (pre, code) => decorateCode(pre, code, extras) });
      if (!p.content && !p.reasoning && !p.toolCalls.length) body.append(h('em', 'muted', '(empty response)'));
      if (stopped) body.append(h('div', 'muted small', '— interrupted'));
      if (p.finishReason === 'length') body.append(h('div', 'muted small', '— cut off (max tokens reached)'));
      if (p.content) {
        const actions = h('div', 'msg-actions');
        const copy = h('button', 'ghost small', 'Copy');
        copy.type = 'button';
        copy.title = 'Copy this message as markdown';
        copy.addEventListener('click', async () => flash(copy, (await copyText(p.content)) ? 'Copied' : 'Copy failed'));
        actions.append(copy);
        root.append(actions);
      }
    },
    addToolCall(call) {
      root.classList.remove('pending');
      const d = h('details', 'tool-call running');
      const sum = h('summary');
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const status = h('span', 'tool-status', 'running…');
      sum.append(h('span', 'tool-name', call.function.name), h('span', 'tool-target', args.title || args.id || ''), status);
      const argPre = h('pre', 'tool-args', truncate(call.function.arguments, 4000));
      const outPre = h('pre', 'tool-output');
      d.append(sum, argPre, outPre);
      extras.append(d);
      followScroll();
      let base = '';
      return {
        done(output) {
          d.classList.remove('running');
          const failed = /^Error:|\[error\]/m.test(output);
          d.classList.toggle('has-errors', failed);
          base = failed ? 'done · errors' : 'done';
          status.textContent = base;
          outPre.textContent = output;
        },
        /** Marks the call's widget as gone (replaced/removed) while keeping the line. */
        note(text) {
          d.classList.add('superseded');
          status.textContent = `${base || 'done'} · ${text}`;
        },
      };
    },
    fail(err, retry) {
      endThinking();
      root.classList.remove('pending');
      root.classList.add('error');
      body.textContent = err.message;
      const row = h('div', 'retry-row');
      const b = h('button', 'ghost small', 'Retry');
      b.type = 'button';
      b.addEventListener('click', retry);
      row.append(b);
      body.append(row);
    },
    thinkingMs: () => (thinkStart && thinkEnd ? thinkEnd - thinkStart : 0),
    remove: () => { endThinking(); root.remove(); },
  };
}

function widgetCard({ id, title, html, height }) {
  const maxH = Math.max(80, Math.min(Number(height) || 480, 2000));
  const fig = h('figure', 'widget');
  const cap = h('figcaption');
  cap.append(h('span', 'widget-title', title || 'Widget'));
  const pop = h('button', 'icon-btn', '⧉');
  pop.type = 'button';
  pop.title = 'Open in side pane';
  pop.addEventListener('click', () => panes.open(`${id}-pane`, title || id, html));
  cap.append(pop);
  const frame = createFrame(id, html, {
    title: title || id,
    onResize: (px) => { frame.style.height = `${Math.min(Math.max(px, 40), maxH)}px`; },
  });
  frame.style.height = `${Math.min(160, maxH)}px`;
  fig.append(cap, frame);
  return fig;
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

// ---------------------------------------------------------------- save (Cmd/Ctrl+S)

function wireSaveShortcut() {
  // Only reaches us when focus is in this page; keys pressed inside a widget or pane frame stay there.
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
    e.preventDefault(); // never fall through to the browser's "Save Page As"
    if (state.messages.length) saveSession();
  });
}

function saveSession() {
  const md = sessionToMarkdown(state.messages, { model: state.cfg.model, system: state.cfg.system });
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'session.md' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- layout: panes + resizer

function wireLayout() {
  el.panesShow.addEventListener('click', () => panes.show());
  $('panes-hide').addEventListener('click', () => panes.hide());

  el.resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 280), window.innerWidth - 320);
      document.documentElement.style.setProperty('--pane-width', `${w}px`);
    };
    const up = () => {
      document.body.classList.remove('resizing');
      el.resizer.removeEventListener('pointermove', move);
      el.resizer.removeEventListener('pointerup', up);
    };
    el.resizer.addEventListener('pointermove', move);
    el.resizer.addEventListener('pointerup', up);
  });
}

init();
