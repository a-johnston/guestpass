// Side panel with tabbed panes, each one a sandboxed frame.
import { createFrame, removeFrame } from './frames.js';

export function createPaneManager({ aside, tabs, body, onChange }) {
  /** @type {Map<string, {tab:HTMLElement, view:HTMLElement, title:string, html:string}>} */
  const panes = new Map();
  let active = null;

  function activate(id) {
    active = id;
    for (const [pid, p] of panes) {
      const on = pid === id;
      p.tab.classList.toggle('active', on);
      p.tab.setAttribute('aria-selected', String(on));
      p.view.hidden = !on;
    }
  }

  function setVisible(v) {
    aside.hidden = !v || panes.size === 0;
    onChange?.();
  }

  function open(id, title, html) {
    let p = panes.get(id);
    if (!p) {
      const tab = document.createElement('div');
      tab.className = 'pane-tab';
      tab.setAttribute('role', 'tab');
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'pane-tab-label';
      label.addEventListener('click', () => activate(id));
      const reload = iconButton('↻', 'Reload', () => open(id, panes.get(id).title, panes.get(id).html));
      const close = iconButton('×', 'Close', () => closePane(id));
      tab.append(label, reload, close);
      tabs.append(tab);
      const view = document.createElement('div');
      view.className = 'pane-view';
      body.append(view);
      p = { tab, view, title, html };
      panes.set(id, p);
    }
    p.title = title;
    p.html = html;
    p.tab.querySelector('.pane-tab-label').textContent = title;
    p.tab.title = title;
    p.view.replaceChildren(createFrame(id, html, { title }));
    activate(id);
    setVisible(true);
  }

  function closePane(id) {
    const p = panes.get(id);
    if (!p) return;
    removeFrame(id);
    p.tab.remove();
    p.view.remove();
    panes.delete(id);
    if (active === id) {
      const next = [...panes.keys()].pop();
      if (next) activate(next);
      else active = null;
    }
    setVisible(!aside.hidden);
  }

  function clear() {
    [...panes.keys()].forEach(closePane);
  }

  return {
    open,
    close: closePane,
    clear,
    has: (id) => panes.has(id),
    ids: () => [...panes.keys()],
    get count() { return panes.size; },
    get visible() { return !aside.hidden; },
    show: () => setVisible(true),
    hide: () => setVisible(false),
    toggle: () => setVisible(aside.hidden),
  };
}

function iconButton(text, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.textContent = text;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
