// The Course Builder — the ONLY course-authoring surface in the app (no terrain
// tools, ever). A tall frosted-glass command panel matching docs/ui-concepts/
// course-creator.png: an elegant serif header, a prompt field, suggestion pills, a
// champagne "Build with agent" button, and a status row. It hands natural language
// to the local design agent via /api/build; the agent edits course.json and the sim
// live-rebuilds.
export class BuilderPanel {
  constructor({ getCourse } = {}) {
    this.getCourse = getCourse || (() => null);
    this.busy = false;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'gb-panel';
    el.innerHTML = `
      <style>
        #gb-panel { position: fixed; left: 18px; top: 18px; bottom: 18px; width: 420px; z-index: 45;
          display: flex; flex-direction: column; padding: 26px 26px 22px; box-sizing: border-box;
          color: var(--ink); font-family: var(--sans);
          background: linear-gradient(180deg, rgba(255,255,255,.20), rgba(255,255,255,.12));
          border: 1px solid rgba(255,255,255,.4); border-radius: 20px;
          backdrop-filter: blur(20px) saturate(1.1);
          box-shadow: 0 24px 70px rgba(30,26,18,.28), inset 0 1px 0 rgba(255,255,255,.55); }
        #gb-panel .gb-h { font-family: var(--serif); font-weight: 500; font-size: 30px; letter-spacing: .06em;
          text-transform: uppercase; color: var(--ink); margin: 26px 0 0; }
        #gb-panel .gb-div { display: flex; align-items: center; gap: 10px; margin: 14px 0 20px; opacity: .8; }
        #gb-panel .gb-div .gb-line { flex: 1; height: 1px; background: linear-gradient(90deg, rgba(28,28,30,.28), rgba(28,28,30,0)); }
        #gb-panel .gb-div .gb-dia { width: 5px; height: 5px; transform: rotate(45deg); background: var(--champ); }
        #gb-panel textarea { width: 100%; box-sizing: border-box; resize: none; height: 92px;
          background: rgba(255,255,255,.34); color: var(--ink); border: 1px solid rgba(255,255,255,.5);
          border-radius: 12px; padding: 14px 15px; font: 400 16px/1.4 var(--sans); outline: none; }
        #gb-panel textarea::placeholder { color: rgba(28,28,30,.42); }
        #gb-panel textarea:focus { border-color: rgba(184,162,122,.85); background: rgba(255,255,255,.44); }
        #gb-panel .gb-chips { display: flex; flex-direction: column; gap: 9px; margin: 16px 0 0; }
        #gb-panel .gb-chip { align-self: flex-start; font-size: 13px; padding: 8px 14px; border-radius: 999px; cursor: pointer;
          color: var(--ink); background: rgba(255,255,255,.26); border: 1px solid rgba(255,255,255,.42);
          transition: background .2s, transform .2s; }
        #gb-panel .gb-chip:hover { background: rgba(255,255,255,.42); transform: translateX(2px); }
        #gb-panel .gb-build { margin-top: auto; display: flex; align-items: center; justify-content: center; gap: 12px;
          width: 100%; padding: 16px; border: 0; border-radius: 13px; cursor: pointer;
          font: 600 16px/1 var(--sans); color: #241c0a;
          background: linear-gradient(180deg, #c8b184, #b09461);
          box-shadow: 0 10px 26px rgba(150,120,60,.32), inset 0 1px 0 rgba(255,255,255,.5); transition: filter .2s, transform .15s; }
        #gb-panel .gb-build:hover { filter: brightness(1.05); transform: translateY(-1px); }
        #gb-panel .gb-build:disabled { filter: saturate(.6) brightness(.98); cursor: default; transform: none; }
        #gb-panel .gb-build .gb-arrow { font-size: 18px; }
        #gb-panel .gb-foot { margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(28,28,30,.14); }
        #gb-panel .gb-status { display: flex; align-items: center; gap: 9px; min-height: 16px;
          font: 600 11px/1.4 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--slate); }
        #gb-panel .gb-status.err { color: #b4523f; }
        #gb-panel .gb-status.ok { color: #6f8f5a; }
        #gb-panel .gb-spin { width: 12px; height: 12px; flex: none; border: 2px solid rgba(99,99,102,.35);
          border-top-color: var(--champ); border-radius: 50%; animation: gbspin .8s linear infinite; }
        @keyframes gbspin { to { transform: rotate(360deg); } }
        #gb-panel .gb-log { margin-top: 10px; max-height: 130px; overflow: auto; white-space: pre-wrap; display: none;
          font: 400 11px/1.45 ui-monospace, SFMono-Regular, monospace; color: var(--slate);
          background: rgba(0,0,0,.06); border-radius: 9px; padding: 9px 11px; }
        #gb-panel .gb-note { margin-top: 12px; font-size: 11.5px; color: var(--slate); opacity: .72; }
      </style>
      <div class="gb-h">Course Builder</div>
      <div class="gb-div"><span class="gb-line"></span><span class="gb-dia"></span><span class="gb-line"></span></div>
      <textarea id="gb-prompt" placeholder="Shape a dramatic links hole…"></textarea>
      <div class="gb-chips" id="gb-chips"></div>
      <button class="gb-build" id="gb-build">Build with agent <span class="gb-arrow">→</span></button>
      <div class="gb-foot">
        <div class="gb-status" id="gb-status"></div>
        <div class="gb-log" id="gb-log"></div>
        <div class="gb-note">The agent designs from your description. No manual terrain editing.</div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.$ = (id) => el.querySelector(id);
    this.promptEl = this.$('#gb-prompt');
    this.buildBtn = this.$('#gb-build');
    this.statusEl = this.$('#gb-status');
    this.logEl = this.$('#gb-log');

    for (const c of ['Add a fairway bunker at 220', 'Deep punchbowl green', 'Lateral water hazard']) {
      const b = document.createElement('span');
      b.className = 'gb-chip'; b.textContent = c;
      b.addEventListener('click', () => { this.promptEl.value = c; this.promptEl.focus(); });
      this.$('#gb-chips').appendChild(b);
    }

    this.buildBtn.addEventListener('click', () => this._submit());
    this.promptEl.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') this._submit(); });
    this._idleStatus();
  }

  _idleStatus() {
    const c = this.getCourse();
    if (!c) return this._status('');
    const name = c.meta?.name || 'Course';
    this._status(`${name} · ${c.greens.length} greens · ${c.bunkers.length} bunkers · ${c.ponds.length} water`);
  }

  async _submit() {
    if (this.busy) return;
    const prompt = this.promptEl.value.trim();
    if (!prompt) { this._status('Type what you want to build', 'err'); return; }
    this._setBusy(true);
    this._status('<span class="gb-spin"></span>Agent building…');
    this.logEl.style.display = 'none'; this.logEl.textContent = '';
    try {
      const res = await fetch('/api/build', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (res.status === 404) { this._status('Builder sidecar not running — start the dev server', 'err'); return this._setBusy(false); }
      const data = await res.json().catch(() => ({}));
      if (data.log) { this.logEl.textContent = data.log; this.logEl.style.display = 'block'; }
      if (!res.ok || data.ok === false) { this._status(data.error || `Build failed (${res.status})`, 'err'); return this._setBusy(false); }
      this._status('<span class="gb-spin"></span>Applying course…');
    } catch (err) {
      this._status(`Could not reach the builder: ${err.message}`, 'err'); this._setBusy(false);
    }
  }

  // main.js calls this after the course finished rebuilding from a fresh spec.
  onCourseReloaded() {
    this._setBusy(false);
    const c = this.getCourse();
    const name = c?.meta?.name || 'Course';
    this._status(`Updated · ${name} · ${c ? c.greens.length : 0} greens · ${c ? c.bunkers.length : 0} bunkers`, 'ok');
  }

  _setBusy(b) { this.busy = b; this.buildBtn.disabled = b; }
  _status(html, kind = '') { this.statusEl.className = `gb-status ${kind}`; this.statusEl.innerHTML = html; }
}
