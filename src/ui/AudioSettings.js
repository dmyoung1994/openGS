export class AudioSettings {
  constructor(audio, { mount = document.getElementById('gs-topright') || document.body } = {}) {
    if (!audio) throw new TypeError('AudioSettings requires a GolfAudio instance.');
    this.audio = audio;
    this._injectStyles();
    this._build(mount);
    this.render();
  }

  _build(mount) {
    const root = document.createElement('div');
    root.id = 'gs-audio';
    root.innerHTML = `
      <button class="ga-toggle" type="button" aria-label="Audio settings" aria-expanded="false" aria-controls="ga-panel">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.3-.8a5.4 5.4 0 0 1 0 7.6M18.7 5.7a9 9 0 0 1 0 12.6"/></svg>
        <span>Audio</span>
      </button>
      <section id="ga-panel" class="ga-panel" aria-label="Audio settings" hidden>
        <div class="ga-head"><strong>Sound</strong><button class="ga-mute" type="button"></button></div>
        ${this._slider('master', 'Master')}
        ${this._slider('ambience', 'Ambience')}
        ${this._slider('effects', 'Effects')}
        <div class="ga-state" role="status">Loading recordings…</div>
      </section>`;
    mount.appendChild(root);
    this.root = root;
    this.toggle = root.querySelector('.ga-toggle');
    this.panel = root.querySelector('.ga-panel');
    this.mute = root.querySelector('.ga-mute');
    this.state = root.querySelector('.ga-state');

    this.toggle.addEventListener('click', async () => {
      await this.audio.unlock();
      const open = this.panel.hidden;
      this.panel.hidden = !open;
      this.toggle.setAttribute('aria-expanded', String(open));
      this.render();
    });
    this.mute.addEventListener('click', () => {
      this.audio.setMuted(!this.audio.snapshot().settings.muted);
      this.render();
    });
    for (const input of root.querySelectorAll('input[type="range"]')) {
      input.addEventListener('input', () => {
        this.audio.setVolume(input.dataset.category, Number(input.value) / 100);
        this.render();
      });
    }
    document.addEventListener('pointerdown', (event) => {
      if (!this.panel.hidden && !root.contains(event.target)) {
        this.panel.hidden = true;
        this.toggle.setAttribute('aria-expanded', 'false');
      }
    });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !this.panel.hidden) {
        this.panel.hidden = true;
        this.toggle.setAttribute('aria-expanded', 'false');
      }
    });
    this.audio.ready.then(() => this.render());
  }

  _slider(category, label) {
    return `<label class="ga-row"><span>${label}</span><output data-output="${category}">0%</output>
      <input type="range" min="0" max="100" step="1" data-category="${category}" aria-label="${label} volume">
    </label>`;
  }

  render() {
    const snapshot = this.audio.snapshot();
    const { settings } = snapshot;
    this.root.classList.toggle('muted', settings.muted);
    this.mute.textContent = settings.muted ? 'Unmute' : 'Mute';
    this.toggle.setAttribute('aria-label', settings.muted ? 'Audio settings, muted' : 'Audio settings');
    for (const category of ['master', 'ambience', 'effects']) {
      const percent = Math.round(settings[category] * 100);
      const input = this.root.querySelector(`[data-category="${category}"]`);
      const output = this.root.querySelector(`[data-output="${category}"]`);
      input.value = String(percent);
      output.textContent = `${percent}%`;
    }
    if (!snapshot.supported) this.state.textContent = 'Audio is unavailable in this browser.';
    else if (snapshot.failedAssets.length) this.state.textContent = `${snapshot.failedAssets.length} recording${snapshot.failedAssets.length === 1 ? '' : 's'} unavailable`;
    else if (snapshot.totalAssets && snapshot.decodedAssets === snapshot.totalAssets) this.state.textContent = snapshot.unlocked ? 'Spatial audio active' : 'Ready · click anywhere to enable';
    else this.state.textContent = `Loading recordings · ${snapshot.decodedAssets}/${snapshot.totalAssets || '…'}`;
  }

  _injectStyles() {
    if (document.getElementById('ga-styles')) return;
    const style = document.createElement('style');
    style.id = 'ga-styles';
    style.textContent = `
      #gs-audio{position:relative;color:#f7f8f4;font-family:var(--sans,Inter,system-ui,sans-serif);pointer-events:auto}
      .ga-toggle{display:flex;align-items:center;gap:8px;padding:9px 14px;border:1px solid rgba(255,255,255,.34);border-radius:999px;color:inherit;background:linear-gradient(180deg,rgba(247,252,255,.16),rgba(31,54,39,.19));backdrop-filter:blur(16px) saturate(1.12);box-shadow:0 10px 28px rgba(4,17,9,.16);font:600 12px/1 var(--sans,Inter,system-ui,sans-serif);cursor:pointer}
      .ga-toggle:hover,.ga-toggle[aria-expanded="true"]{background:rgba(255,255,255,.2)}
      .ga-toggle svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.muted .ga-toggle svg{opacity:.45}
      .ga-panel{position:absolute;right:0;top:calc(100% + 9px);width:248px;padding:14px;border:1px solid rgba(255,255,255,.24);border-radius:15px;background:rgba(17,25,22,.78);backdrop-filter:blur(22px) saturate(1.1);box-shadow:0 20px 50px rgba(0,0,0,.3)}
      .ga-panel[hidden]{display:none}.ga-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.ga-head strong{font-size:13px;letter-spacing:.02em}.ga-mute{padding:6px 9px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.07);color:inherit;font-size:10px;cursor:pointer}.muted .ga-mute{color:#d6bb83;border-color:rgba(214,187,131,.45)}
      .ga-row{display:grid;grid-template-columns:1fr auto;gap:7px 10px;padding:8px 0;color:rgba(247,248,244,.78);font-size:11px}.ga-row output{font-variant-numeric:tabular-nums;color:#fff}.ga-row input{grid-column:1/-1;width:100%;accent-color:#d6bb83}.ga-state{margin-top:7px;padding-top:10px;border-top:1px solid rgba(255,255,255,.11);color:rgba(247,248,244,.55);font-size:9.5px;letter-spacing:.03em}
      body[data-view="creator"] #gs-audio{display:none}
    `;
    document.head.appendChild(style);
  }
}
