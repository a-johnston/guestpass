import { readShareFromHash, normalizeBaseUrl, buildShareLink } from './config.js';
import { listModels, streamChat, contextLengthFromProps } from './api.js';
import { TOOL_DEFS, TOOL_SYSTEM_HINT, RENDER_TOOLS, omittedHtml, runTool, sanitizeId } from './tools.js';
import { createFrame, removeFrame, getFrame } from './frames.js';
import { createPaneManager } from './panes.js';
import { renderMarkdown } from './markdown.js';
import { sessionToMarkdown, formatDuration, formatSeconds } from './session.js';

const MAX_TOOL_ROUNDS = 25; // granular tools (edit/read) take more rounds; Continue resumes past it

/** One-click prompts on the empty chat; each exercises a different part of the tool set. */
const STARTER_PROMPTS = [
  'Generate an SVG of a pelican riding a bicycle',
  'Plot a sine wave with sliders for amplitude and frequency',
  'Build a small snake game in a side pane',
  'Make a color picker widget that changes the background of a second widget',
];
const PROMPT_MAX_PX = 240;
const $ = (id) => document.getElementById(id);

// The page has two faces: without a `#<payload>` link it is a link builder; with one it is the chat.
// All state lives in memory only. Nothing is written to localStorage/sessionStorage/cookies,
// and the address bar only changes when the user presses Connect. Reloading is "clear chat".
const state = {
  cfg: { baseUrl: '', apiKey: '', model: '', system: '' },
  // Optional request features. Each is on until the server rejects a request because of it;
  // then it is dropped for the rest of the session (see FALLBACKS).
  toolsSupported: true,
  sendReasoning: true, // reasoning_content on assistant messages (see thinkingMode)
  thinkingMode: 'all', // 'turn': current turn only; 'all': every turn (options popover)
  requestUsage: true, // stream_options.include_usage, for the context counter
  context: { used: null, max: null },
  conn: 'pending', // model list: 'pending' (messages queue) | 'ok' | 'failed'
  charsPerToken: 4, // streamed chars per output token, calibrated from usage; for live estimates
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
  ctx: $('ctx'),
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
  wireOptions();
  connect();
  el.prompt.focus();
}

const CONNECT_TIMEOUT_MS = 10000;

/**
 * Fetches the model list. Messages typed meanwhile are queued (state.conn === 'pending') and sent
 * once it succeeds, since most servers need the model field. On failure the queue is kept: the
 * notice offers a retry, and a queued message's "Send now" tries without a model anyway.
 */
async function connect() {
  state.conn = 'pending';
  setStatus('pending', 'Connecting…');
  updatePlaceholder();
  const { baseUrl, apiKey } = state.cfg;
  try {
    const models = await listModels({ baseUrl, apiKey, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    // Links don't carry a model (it made them long); use the server's first one. If the server
    // lists none, the field is omitted and the server picks.
    state.cfg.model = models[0]?.id || '';
    state.conn = 'ok';
    setStatus('ok', `Connected${state.cfg.model ? ` · ${state.cfg.model}` : ''}`);
    updatePlaceholder();
    if (state.queue.length && !state.busy) runTurn();
    state.context.max = models[0]?.contextLength || (await contextLengthFromProps({ baseUrl, apiKey }));
    updateContext();
  } catch (e) {
    state.conn = 'failed';
    updatePlaceholder();
    const why = e.name === 'TimeoutError' ? `No response after ${CONNECT_TIMEOUT_MS / 1000} s.` : e.message;
    const reason = `Couldn't connect. ${why}${/[.!?]$/.test(why) ? '' : '.'}`;
    setStatus('warn', reason);
    const waiting = state.queue.length ? ' Your queued message is waiting: retry, or use its "Send now" to try without a model.' : '';
    const n = notice(`${reason}${waiting}`, 'warn');
    const retry = h('button', 'ghost small', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => { n.remove(); connect(); });
    n.append(' ', retry);
  }
}

function setStatus(kind, text) {
  el.status.dataset.state = kind;
  el.status.setAttribute('aria-label', text);
}

/**
 * Top-bar counter: tokens in the latest request (prompt + reply), out of the window if known.
 * While generating, `live` adds an estimate of the reply so far ("~") and the current speed;
 * the exact count replaces it when the server's usage report arrives.
 */
function updateContext(live = null) {
  const { max } = state.context;
  const used = live ? (state.context.used ?? 0) + live.tokens : state.context.used;
  el.ctx.hidden = used == null && max == null;
  if (el.ctx.hidden) return;
  const count = used == null ? '–' : `${live ? '~' : ''}${formatTokens(used)}`;
  const speed = live?.tps ? ` · ${Math.round(live.tps)} tok/s` : '';
  el.ctx.textContent = `${count}${max ? ` / ${formatTokens(max)}` : ''}${speed}`;
  el.ctx.setAttribute('aria-label', `Context: ${used ?? 'unknown'} of ${max ?? 'unknown'} tokens`);
  el.ctx.dataset.level = max && used != null ? (used / max >= 0.9 ? 'high' : used / max >= 0.75 ? 'mid' : '') : '';
}

const streamedChars = (p) => p.content.length + p.reasoning.length + p.toolCalls.reduce((n, c) => n + (c.function.arguments?.length || 0), 0);

let lastLiveUpdate = 0;
/** Throttled live estimate while a reply streams (servers only report usage at the end). */
function showLiveContext(p, firstToken) {
  const now = performance.now();
  if (now - lastLiveUpdate < 250) return;
  lastLiveUpdate = now;
  const tokens = Math.round(streamedChars(p) / state.charsPerToken);
  const secs = firstToken ? (now - firstToken) / 1000 : 0;
  updateContext({ tokens, tps: secs > 0.5 ? tokens / secs : null });
}

/** Learns this server/model's chars-per-token from a finished reply, for the next live estimate. */
function calibrateCharsPerToken(p, usage) {
  const out = usage?.completion_tokens;
  if (!out || out < 20) return;
  const ratio = streamedChars(p) / out;
  if (ratio > 0.5 && ratio < 12) state.charsPerToken = state.charsPerToken * 0.5 + ratio * 0.5;
}

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
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
    const using = models.length ? ` Chats will use ${models[0].id}${models.length > 1 ? ' (the first listed)' : ''}.` : '';
    showSetupStatus('ok', `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.${using}`);
  } catch (e) {
    if (req !== modelsRequest) return;
    showSetupStatus('error', e.message);
  }
  updateShareLink();
}

/** The link for the form as filled in, or '' while the URL is still incomplete (e.g. mid-typing). */
function currentLink() {
  const cfg = readSetupForm();
  if (!cfg.baseUrl) return '';
  try {
    return buildShareLink(location.href, cfg);
  } catch {
    return '';
  }
}

function updateShareLink() {
  $('share-link').value = currentLink();
}

function wireSetup() {
  const form = $('setup-form');
  form.addEventListener('input', updateShareLink);
  // Checked automatically: `change` fires on blur/commit, so typing a URL doesn't spam requests.
  $('cfg-baseurl').addEventListener('change', refreshModels);
  $('cfg-apikey').addEventListener('change', refreshModels);

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

const IDLE_PLACEHOLDER = 'Message';
const BUSY_PLACEHOLDER = 'Queue Message';
const CONNECTING_PLACEHOLDER = 'Queue Message';

function updatePlaceholder() {
  el.prompt.placeholder = state.busy ? BUSY_PLACEHOLDER : state.conn === 'pending' ? CONNECTING_PLACEHOLDER : IDLE_PLACEHOLDER;
}

function wireComposer() {
  const form = $('composer');
  updatePlaceholder();
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
    if (state.busy || state.conn === 'pending') {
      enqueue(text); // during a run: steering; while connecting: sent once the model is known
    } else {
      pushUser(text);
      runTurn();
    }
  });
  autosize();

  // Starter prompts go through the normal submit path (so they queue while connecting).
  for (const text of STARTER_PROMPTS) {
    const b = h('button', 'starter', text);
    b.type = 'button';
    b.addEventListener('click', () => {
      el.prompt.value = text;
      form.requestSubmit();
    });
    $('starters').append(b);
  }
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
  updatePlaceholder();
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
    if (!state.busy) return runTurn(); // still connecting, or it failed: send now regardless
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
  // Thinking: assistant messages keep it locally (for the transcript). It goes back to the server
  // only for the current turn (after the last user message), so the model keeps its plan across a
  // tool loop; earlier turns' thinking is dropped, the usual practice for reasoning models.
  const lastUser = state.messages.findLastIndex((m) => m.role === 'user');
  let history = state.messages.map(({ reasoning, thinkingMs, ...m }, i) => {
    if (m.tool_calls) m.tool_calls = m.tool_calls.map(forServer);
    if (reasoning && state.sendReasoning && (state.thinkingMode === 'all' || i > lastUser)) m.reasoning_content = reasoning;
    return m;
  });
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
  if (state.requestUsage) body.stream_options = { include_usage: true };
  return body;
}

/**
 * A tool call as sent to the server. Once a widget/pane has been re-rendered under the same id,
 * the older call's HTML is replaced by a stub: the newer version is in context, and page HTML is
 * by far the largest thing in a widget-heavy history. The local copy (and session.md) keep it all.
 */
function forServer({ superseded, ...call }) {
  if (!superseded) return call;
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { return call; }
  args.html = omittedHtml(args.id);
  return { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
}

/** Marks earlier renders of `id` as superseded by `latest` (see forServer). */
function markSuperseded(id, latest) {
  for (const m of state.messages) {
    for (const c of m.tool_calls || []) {
      if (c === latest || c.superseded || !RENDER_TOOLS.has(c.function?.name)) continue;
      try { if (sanitizeId(JSON.parse(c.function.arguments).id) === id) c.superseded = true; } catch {}
    }
  }
}

/**
 * Optional request features the server may reject. If a request fails with an error mentioning
 * one that's still on, it's switched off for the session and the request retried without it.
 */
const FALLBACKS = [
  { key: 'toolsSupported', match: /tool|jinja|function.?call/i, notice: 'This server doesn’t accept tool calls, so widgets and panes are off for this session.' },
  { key: 'sendReasoning', match: /reasoning/i },
  { key: 'requestUsage', match: /stream_options|include_usage/i },
];

function fallbackFor(err) {
  if (!(err.status >= 400 && err.status < 600)) return null;
  return FALLBACKS.find((f) => state[f.key] && f.match.test(err.message)) || null;
}

/** Attaches a reply's thinking (text + duration) for the transcript; buildRequest strips it. */
function withThinking(msg, reasoning, view) {
  if (reasoning) {
    msg.reasoning = reasoning;
    msg.thinkingMs = view.thinkingMs();
  }
  return msg;
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
        const n = notice(`Paused after ${MAX_TOOL_ROUNDS} tool rounds in a row. `, 'warn');
        const more = h('button', 'ghost small', 'Continue');
        more.type = 'button';
        more.addEventListener('click', () => {
          if (state.busy) return;
          more.remove();
          runTurn(); // history ends with the last tool results, so this just takes the next step
        });
        n.append(more);
        return;
      }

      const ctrl = new AbortController();
      state.stream = ctrl;
      state.interrupt = false;
      const view = createAssistantView();
      let partial = null;
      let result;
      const started = performance.now();
      let firstToken = 0; // first real output (role-only / empty chunks don't count)
      try {
        result = await streamChat({
          baseUrl: state.cfg.baseUrl,
          apiKey: state.cfg.apiKey,
          body: buildRequest(),
          signal: ctrl.signal,
          onUpdate: (p) => {
            if (!firstToken && (p.content || p.reasoning || p.toolCalls.length)) firstToken = performance.now();
            partial = p;
            view.update(p);
            showLiveContext(p, firstToken);
          },
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
        const fallback = fallbackFor(e);
        if (fallback) {
          state[fallback.key] = false;
          view.remove();
          if (fallback.notice) notice(fallback.notice, 'warn');
          rounds--;
          continue;
        }
        view.fail(e, () => { view.remove(); runTurn(); });
        return;
      }
      state.stream = null;
      if (result.usage) {
        const u = result.usage;
        state.context.used = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
        calibrateCharsPerToken(result, u);
      }
      updateContext(); // exact figure replaces the live estimate (or clears it if usage wasn't sent)

      const ended = performance.now();
      view.finish(result, {
        stats: computeStats({ started, firstToken, ended, usage: result.usage, timings: result.timings }),
      });
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
            canRerender: (id) => state.inline.has(id) || panes.has(id),
            rerender: rerenderPage,
            listPages,
            panes,
          });
        } catch (e) {
          output = `Error: ${e.message}`;
        }
        chip.done(output);
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        if (RENDER_TOOLS.has(call.function.name) && !output.startsWith('Error:')) {
          try {
            const id = sanitizeId(JSON.parse(call.function.arguments).id);
            if (id) markSuperseded(id, call);
          } catch {}
        }
      }
      if (state.stopRequested) return;
    }
  } finally {
    state.stream = null;
    updateContext(); // drop any live estimate left by an interrupted or failed stream
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
  state.inline.set(widget.id, { card, chip, widget });
  followScroll();
}

/** Open pages for read() without an id: widgets, then panes, with their current size. */
function listPages() {
  const lines = (id) => (getFrame(id)?.html || '').split('\n').length;
  return [
    ...[...state.inline].map(([id, e]) => ({ id, kind: 'inline', title: e.widget?.title || '', lines: lines(id) })),
    ...panes.ids().map((id) => ({ id, kind: 'pane', title: panes.titleOf(id) || '', lines: lines(id) })),
  ];
}

/** Reloads a page with edited source where it already is: a widget keeps its place in the chat. */
function rerenderPage(id, html) {
  const entry = state.inline.get(id);
  if (entry) {
    entry.widget = { ...entry.widget, html };
    const card = widgetCard(entry.widget);
    entry.card.replaceWith(card);
    entry.card = card;
  } else if (panes.has(id)) {
    panes.open(id, panes.titleOf(id), html);
  }
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
  return append(h('div', `notice ${kind}`, text));
}


let codeRunCounter = 0;

/**
 * Always-visible row under a response: Copy (raw markdown) and a stats summary that expands into
 * a detail line. Rounds that only called tools get stats but no Copy. Returns null if empty.
 */
function buildFooter(content, stats) {
  if (!content && !stats) return null;
  const row = h('div', 'msg-actions');
  if (content) {
    const copy = h('button', 'msg-btn', '⧉ Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => flash(copy, (await copyText(content)) ? 'Copied' : 'Copy failed'));
    row.append(copy);
  }
  if (stats) {
    const summary = [stats.output != null && `${stats.output.toLocaleString()} tok`, stats.tps && `${stats.tps.toFixed(1)} tok/s`]
      .filter(Boolean).join(' · ') || `${(stats.total / 1000).toFixed(1)} s`;
    const btn = h('button', 'msg-btn stats-btn', `ⓘ ${summary}`);
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    const detail = h('div', 'stats-detail');
    detail.hidden = true;
    detail.textContent = [
      stats.prompt != null && `Prompt ${stats.prompt.toLocaleString()} tok`,
      stats.output != null && `Output ${stats.output.toLocaleString()} tok`,
      stats.ttft != null && `First token ${(stats.ttft / 1000).toFixed(2)} s`,
      stats.tps && `${stats.tps.toFixed(1)} tok/s${stats.tpsSource === 'server' ? ' (server)' : ''}`,
      stats.thinking && `Thought ${formatDuration(stats.thinking)}`,
      `Total ${(stats.total / 1000).toFixed(1)} s`,
    ].filter(Boolean).join(' · ');
    btn.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      btn.setAttribute('aria-expanded', String(!detail.hidden));
    });
    row.append(btn, detail);
  }
  return row;
}

/**
 * Timing + token stats for one completion. Token counts come from the server's usage report;
 * speed prefers the server's own decode rate (llama.cpp-style `timings`), else output tokens over
 * the time from first token to end as measured here (which includes network jitter).
 */
function computeStats({ started, firstToken, ended, usage, timings }) {
  const output = usage?.completion_tokens ?? null;
  const serverTps = timings?.predicted_per_second;
  let tps = null;
  let tpsSource = null;
  if (Number.isFinite(serverTps) && serverTps > 0) { tps = serverTps; tpsSource = 'server'; }
  else if (output && firstToken && ended - firstToken > 50) { tps = output / ((ended - firstToken) / 1000); tpsSource = 'client'; }
  return {
    prompt: usage?.prompt_tokens ?? null,
    output,
    ttft: firstToken ? firstToken - started : null,
    tps,
    tpsSource,
    thinking: 0, // filled in by the view, which knows when thinking ended
    total: ended - started,
  };
}

/** Wraps a finished code block in a card with a header: language, Copy, and Run/Open for HTML. */
function decorateCode(pre, code, { lang, runnable }, host) {
  const card = h('div', 'code-block');
  const head = h('div', 'code-head');
  head.append(h('span', 'code-lang', lang));
  const button = (label, onClick) => {
    const b = h('button', 'code-btn', label);
    b.type = 'button';
    b.addEventListener('click', () => onClick(b));
    head.append(b);
  };
  if (runnable) {
    button('▶ Run', () => host.append(widgetCard({ id: `code-${++codeRunCounter}`, title: 'Code preview', html: code })));
    button('⧉ Open in pane', () => { const id = `code-${++codeRunCounter}`; panes.open(id, `Preview ${codeRunCounter}`, code); });
  }
  button('Copy', async (b) => flash(b, (await copyText(code)) ? 'Copied' : 'Copy failed'));
  pre.replaceWith(card);
  card.append(head, pre);
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
    finish(p, { stopped = false, stats = null } = {}) {
      latest = p;
      trackThinking(p);
      endThinking();
      if (stats) stats.thinking = thinkStart ? thinkEnd - thinkStart : 0; // exact now that thinking has ended
      render();
      finished = true; // a still-queued animation-frame render must not overwrite the final one
      root.classList.remove('pending');
      root.dataset.calling = '';
      updateThinkingSummary();
      renderMarkdown(body, p.content, { final: true, decorate: (pre, code, info) => decorateCode(pre, code, info, extras) });
      if (!p.content && !p.reasoning && !p.toolCalls.length) body.append(h('em', 'muted', '(empty response)'));
      if (stopped) body.append(h('div', 'muted small', '— interrupted'));
      if (p.finishReason === 'length') body.append(h('div', 'muted small', '— cut off (max tokens reached)'));
      const footer = buildFooter(p.content, stats);
      if (footer) root.append(footer);
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

// ---------------------------------------------------------------- options popover (⚙)

function wireOptions() {
  const btn = $('opts-btn');
  const pop = $('opts');
  const setOpen = (open) => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(pop.hidden); });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); btn.focus(); } });
  pop.addEventListener('change', (e) => {
    if (e.target.name === 'think-mode') state.thinkingMode = e.target.value;
  });
}

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
