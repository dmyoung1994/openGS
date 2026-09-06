// Launch-input lab plus the player-facing shot presentation. The development
// controls remain available without occupying the simulator view; address,
// flight, and result states all consume the same authoritative shot data.
import { DEVELOPMENT_LAUNCH_PRESETS } from '../input/DevelopmentLaunchMonitorAdapter.js';

const FIELDS = [
  { key: 'ballSpeed', label: 'Ball speed', unit: 'mph', min: 0.1, max: 200, step: 0.1 },
  { key: 'launchAngle', label: 'Launch angle', unit: '°', min: 0, max: 50, step: 0.1 },
  { key: 'launchDirection', label: 'Launch direction (L/R)', unit: '°', min: -30, max: 30, step: 0.5, directional: true },
  { key: 'spinRate', label: 'Spin rate', unit: 'rpm', min: 0, max: 12000, step: 50 },
  { key: 'spinAxis', label: 'Spin axis (L/R)', unit: '°', min: -60, max: 60, step: 0.5, directional: true },
];

const ENV_FIELDS = [
  { key: 'windSpeed', label: 'Wind', unit: 'mph', min: 0, max: 40, step: 1, def: 0 },
  { key: 'windDir', label: 'Wind toward', unit: '°', min: 0, max: 360, step: 5, def: 0 },
  { key: 'altitude', label: 'Altitude', unit: 'm', min: 0, max: 3000, step: 50, def: 0 },
  { key: 'temperatureC', label: 'Temp', unit: '°C', min: -5, max: 45, step: 1, def: 15 },
  { key: 'cloudCover', label: 'Cloud cover', unit: '%', min: 0, max: 70, step: 5, def: 38 },
];

const ENV_SELECTS = [
  { key: 'groundFirmness', label: 'Fairway', def: 'medium', options: [
    ['soft', 'Soft'], ['medium', 'Medium'], ['firm', 'Firm'],
  ] },
];

export class MetricsPanel {
  constructor({ onHit, onEnvironmentChange, onContinue }) {
    this.onHit = onHit;
    this.onContinue = onContinue;
    this.onEnvironmentChange = onEnvironmentChange;
    this.values = { ...DEVELOPMENT_LAUNCH_PRESETS['7-iron'] };
    this.env = Object.fromEntries([
      ...ENV_FIELDS.map((f) => [f.key, f.def]),
      ...ENV_SELECTS.map((f) => [f.key, f.def]),
    ]);
    this.shotParams = null;
    this._injectStyles();
    this._build();
    this.applyPreset('7-iron');
    this.showAddress();
  }

  getLaunchInput() {
    return {
      ...this.values,
      // This stays private development metadata. The player presentation has no
      // club field, and real providers may omit it until their SDK supplies one.
      optional: {
        clubSpeed: this.values.clubSpeed,
        ...(this.club ? { clubLabel: this.club } : {}),
      },
    };
  }

  getParams() {
    return {
      ballSpeed: this.values.ballSpeed,
      clubSpeed: this.values.clubSpeed,
      launchAngle: this.values.launchAngle,
      azimuth: this.values.launchDirection,
      spinRate: this.values.spinRate,
      spinAxis: this.values.spinAxis,
      club: this.club,
    };
  }
  getEnv() { return { ...this.env }; }

  setEnv(values, { notify = false } = {}) {
    for (const field of ENV_FIELDS) {
      if (values[field.key] === undefined) continue;
      const value = Math.min(field.max, Math.max(field.min, Number(values[field.key])));
      this.env[field.key] = value;
      const input = this._fieldEls?.[field.key];
      if (input) {
        input.value = value;
        const output = input.closest('.gs-field')?.querySelector('output');
        if (output) output.textContent = formatFieldValue(field, value);
      }
    }
    if (notify) this.onEnvironmentChange?.(this.getEnv());
    return this.getEnv();
  }

  applyPreset(name) {
    const preset = DEVELOPMENT_LAUNCH_PRESETS[name];
    if (!preset) return;
    // Retained only as simulation metadata for club-specific physical effects.
    // The player-facing UI intentionally has no club field until a real source
    // supplies one.
    this.club = name;
    Object.assign(this.values, preset);
    for (const field of FIELDS) this._setField(field.key, this.values[field.key] ?? 0);
  }

  beginShot(params = this.getParams()) {
    this.shotParams = Object.freeze({ ...params });
    this.setLive('');
    this._setState('flight');
    this.showFlight({ carryYards: 0, heightFeet: 0 });
  }

  showFlight({ carryYards, heightFeet, totalYards = 0, landed = false }) {
    this._setText('gs-flight-carry', `${Math.max(0, carryYards).toFixed(0)}`);
    this._setText('gs-flight-secondary-label', landed ? 'Total' : 'Height');
    this._setText('gs-flight-secondary', `${Math.max(0, landed ? totalYards : heightFeet).toFixed(0)}`);
    this._setText('gs-flight-secondary-unit', landed ? 'yd' : 'ft');
    this._setText('gs-flight-ball-speed', `${Math.max(0, this.shotParams?.ballSpeed ?? 0).toFixed(0)}`);
    if (this.state !== 'flight') this._setState('flight');
  }

  showResult(result) {
    const shot = this.shotParams ?? this.getParams();
    const offline = formatOffline(result.offlineYards);
    const rollout = Math.max(0, result.totalYards - result.carryYards);
    this._setText('gs-result-carry', result.carryYards.toFixed(1));
    this._setText('gs-result-total', result.totalYards.toFixed(1));
    this._setText('gs-result-offline', offline.value);
    this._setText('gs-result-offline-unit', offline.unit);

    const values = {
      speed: `${fmt(shot.ballSpeed)} mph`,
      launch: `${fmt(shot.launchAngle)}°`,
      spin: `${Math.round(shot.spinRate).toLocaleString('en-US')} rpm`,
      axis: formatDirectionalDegrees(shot.spinAxis),
      apex: `${(result.apexMeters * 3.28084).toFixed(0)} ft`,
      descent: `${result.descentDeg.toFixed(0)}°`,
      landing: `${result.landingSpeedMph.toFixed(0)} mph`,
      rollout: `${rollout.toFixed(1)} yd`,
    };
    for (const [key, value] of Object.entries(values)) this._setText(`gs-result-${key}`, value);
    this.setLive('');
    this._setState('results');
  }

  showAddress() {
    this.setLive('');
    this.setContinuation(null);
    this._setState('address');
  }

  setContinuation(label) {
    const button = this.root.querySelector('.gs-play-continue');
    button.hidden = !label;
    button.textContent = label ?? '';
  }

  setLive(text) {
    const clean = String(text ?? '').replace(/^\s*[—-]\s*|\s*[—-]\s*$/g, '');
    this.status.textContent = clean;
    this.root.classList.toggle('has-status', Boolean(clean));
  }

  _setState(state) {
    this.state = state;
    this.root.dataset.state = state;
  }

  _setText(id, value) {
    const element = this.root.querySelector(`#${id}`);
    if (element) element.textContent = value;
  }

  // ---- DOM ----------------------------------------------------------------

  _build() {
    const labToggle = document.createElement('button');
    labToggle.id = 'gs-lab-toggle';
    labToggle.type = 'button';
    labToggle.setAttribute('aria-controls', 'gs-launch-lab');
    labToggle.setAttribute('aria-expanded', 'false');
    labToggle.textContent = 'Lab';
    document.body.appendChild(labToggle);

    const panel = document.createElement('section');
    panel.id = 'gs-launch-lab';
    panel.className = 'gs-panel';
    panel.setAttribute('aria-label', 'Launch controls');
    panel.innerHTML = `
      <div class="gs-lab-head">
        <div><div class="gs-title">Shot Lab</div><div class="gs-lab-sub">Development inputs</div></div>
        <button class="gs-lab-close" type="button" aria-label="Close launch controls">×</button>
      </div>
      <label class="gs-preset">Test profile
        <select id="gs-preset"></select>
      </label>
      <div id="gs-fields"></div>
      <details class="gs-env">
        <summary>Conditions</summary>
        <div id="gs-env"></div>
      </details>
      <button id="gs-hit" type="button">Hit shot</button>
      <div class="gs-hint">Space to hit · R to reset view</div>
    `;
    document.body.appendChild(panel);

    const select = panel.querySelector('#gs-preset');
    for (const name of Object.keys(DEVELOPMENT_LAUNCH_PRESETS)) {
      const option = document.createElement('option');
      option.value = option.textContent = name;
      select.appendChild(option);
    }
    select.value = '7-iron';
    select.addEventListener('change', () => this.applyPreset(select.value));

    const fields = panel.querySelector('#gs-fields');
    for (const field of FIELDS) fields.appendChild(this._field(field, this.values, field.key));

    const environment = panel.querySelector('#gs-env');
    for (const field of ENV_FIELDS) {
      environment.appendChild(this._field(field, this.env, field.key, field.def, () => {
        this.onEnvironmentChange?.(this.getEnv());
      }));
    }
    for (const field of ENV_SELECTS) environment.appendChild(this._selectField(field));

    panel.querySelector('#gs-hit').addEventListener('click', () => this.onHit?.());
    const setLabOpen = (open) => {
      panel.classList.toggle('open', open);
      labToggle.setAttribute('aria-expanded', String(open));
    };
    labToggle.addEventListener('click', () => setLabOpen(!panel.classList.contains('open')));
    panel.querySelector('.gs-lab-close').addEventListener('click', () => setLabOpen(false));
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && panel.classList.contains('open')) setLabOpen(false);
    });

    const root = document.createElement('div');
    root.className = 'gs-shot-ui';
    root.dataset.state = 'address';
    root.innerHTML = `
      <button class="gs-ready gs-glass" data-shot-view="address" type="button">
        <span class="gs-ready-title">Ready to hit</span>
        <span class="gs-ready-sub">Hit shot</span>
        <span class="gs-ready-line" aria-hidden="true"></span>
      </button>

      <div class="gs-flight-strip gs-glass" data-shot-view="flight" aria-live="polite">
        ${liveMetric('Carry', 'gs-flight-carry', 'yd')}
        ${liveMetric('Height', 'gs-flight-secondary', 'ft', 'gs-flight-secondary-label', 'gs-flight-secondary-unit')}
        ${liveMetric('Ball speed', 'gs-flight-ball-speed', 'mph')}
      </div>

      <section class="gs-results gs-glass" data-shot-view="results" aria-label="Shot results">
        <div class="gs-result-hero">
          ${heroMetric('Carry', 'gs-result-carry', 'yd')}
          ${heroMetric('Total', 'gs-result-total', 'yd')}
          ${heroMetric('Offline', 'gs-result-offline', '', 'gs-result-offline-unit')}
        </div>
        <div class="gs-result-rule"></div>
        <div class="gs-result-data" aria-label="Shot data">
          ${resultMetric('Ball speed', 'gs-result-speed')}
          ${resultMetric('Launch', 'gs-result-launch')}
          ${resultMetric('Spin', 'gs-result-spin')}
          ${resultMetric('Spin axis', 'gs-result-axis')}
          ${resultMetric('Apex', 'gs-result-apex')}
          ${resultMetric('Descent', 'gs-result-descent')}
          ${resultMetric('Landing', 'gs-result-landing')}
          ${resultMetric('Rollout', 'gs-result-rollout')}
        </div>
        <button class="gs-play-continue" type="button" hidden></button>
      </section>

      <div class="gs-shot-status gs-glass" role="status"></div>
    `;
    document.body.appendChild(root);
    root.querySelector('.gs-ready').addEventListener('click', () => this.onHit?.());
    root.querySelector('.gs-play-continue').addEventListener('click', () => this.onContinue?.());

    this.root = root;
    this.status = root.querySelector('.gs-shot-status');
    this.panel = panel;
    this._fieldEls = {};
    panel.querySelectorAll('[data-key]').forEach((element) => {
      this._fieldEls[element.dataset.key] = element;
    });
  }

  _field(field, store, key, def, onInput) {
    const wrap = document.createElement('div');
    wrap.className = 'gs-field';
    const value = store[key] ?? def ?? 0;
    wrap.innerHTML = `
      <div class="gs-field-top"><span>${field.label}</span><output>${formatFieldValue(field, value)}</output></div>
      <input type="range" min="${field.min}" max="${field.max}" step="${field.step}" value="${value}" data-key="${key}">
    `;
    const input = wrap.querySelector('input');
    const output = wrap.querySelector('output');
    input.addEventListener('input', () => {
      const value = parseFloat(input.value);
      store[key] = value;
      output.textContent = formatFieldValue(field, value);
      onInput?.();
    });
    return wrap;
  }

  _selectField(field) {
    const wrap = document.createElement('label');
    wrap.className = 'gs-field gs-select-field';
    wrap.innerHTML = `<div class="gs-field-top"><span>${field.label}</span></div>
      <select data-key="${field.key}">${field.options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`;
    const select = wrap.querySelector('select');
    select.value = this.env[field.key];
    select.addEventListener('change', () => {
      this.env[field.key] = select.value;
      this.onEnvironmentChange?.(this.getEnv());
    });
    return wrap;
  }

  _setField(key, value) {
    const element = this._fieldEls?.[key];
    if (!element) return;
    element.value = value;
    element.dispatchEvent(new Event('input'));
  }

  _injectStyles() {
    if (document.getElementById('gs-style')) return;
    const style = document.createElement('style');
    style.id = 'gs-style';
    style.textContent = `
      :root {
        --shot-font: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --shot-white: rgba(255,255,255,.97);
        --shot-muted: rgba(255,255,255,.70);
        --shot-green: #a3e7b3;
        --shot-glass-border: rgba(255,255,255,.44);
        --shot-glass-top: rgba(255,255,255,.105);
        --shot-glass-middle: rgba(255,255,255,.018);
        --shot-glass-bottom: rgba(0,0,0,.055);
      }
      .gs-shot-ui { position: fixed; inset: 0; z-index: 55; pointer-events: none;
        color: var(--shot-white); font-family: var(--shot-font); font-variant-numeric: tabular-nums; }
      .gs-play-continue { grid-column: 1 / -1; justify-self: end; pointer-events: auto;
        padding: 10px 16px; border: 1px solid rgba(255,255,255,.4); border-radius: 10px;
        color: white; background: #244c32; font: inherit; cursor: pointer; }
      .gs-play-continue:focus-visible { outline: 2px solid white; outline-offset: 3px; }
      .gs-glass, #gs-lab-toggle { border: 1px solid var(--shot-glass-border);
        background:
          radial-gradient(120% 95% at 16% -14%, rgba(255,255,255,.16), transparent 52%),
          linear-gradient(180deg,var(--shot-glass-top),var(--shot-glass-middle) 47%,var(--shot-glass-bottom));
        -webkit-backdrop-filter: blur(12px) saturate(1.24) brightness(.90);
        backdrop-filter: blur(12px) saturate(1.24) brightness(.90);
        box-shadow: 0 18px 46px rgba(2,8,4,.16), inset 0 1px 0 rgba(255,255,255,.58),
          inset 0 -1px 0 rgba(0,0,0,.16), inset 1px 0 0 rgba(255,255,255,.10);
        text-shadow: 0 1px 3px rgba(0,0,0,.30); }
      .gs-shot-ui [data-shot-view] { position: absolute; opacity: 0; visibility: hidden;
        transform: translate(-50%,12px) scale(.985); transition: opacity .28s ease, transform .42s cubic-bezier(.2,.75,.25,1), visibility .28s; }
      .gs-shot-ui[data-state="address"] [data-shot-view="address"],
      .gs-shot-ui[data-state="flight"] [data-shot-view="flight"],
      .gs-shot-ui[data-state="results"] [data-shot-view="results"] {
        opacity: 1; visibility: visible; transform: translate(-50%,0) scale(1); }
      /* Rest is a hard telemetry ownership boundary. Retire the live strip in the
         same style update instead of leaving two backdrop-filtered panes stacked
         during a crossfade; Chromium can alternate their WebGPU backdrop captures
         while the result camera continues moving. */
      .gs-shot-ui[data-state="results"] [data-shot-view="flight"] {
        opacity: 0; visibility: hidden; transition: none; }

      #gs-lab-toggle { position: fixed; top: 16px; left: 16px; z-index: 61; min-width: 70px;
        padding: 10px 18px; border-radius: 999px; color: var(--shot-white); cursor: pointer;
        font: 600 14px/1 var(--shot-font); letter-spacing: .01em; opacity: .72;
        transition: opacity .2s, background .2s, transform .2s; }
      #gs-lab-toggle:hover, #gs-lab-toggle[aria-expanded="true"] { opacity: 1;
        background-color: rgba(255,255,255,.10); transform: translateY(-1px); }

      .gs-ready { left: 50%; bottom: 26px; width: min(360px,calc(100vw - 32px)); height: 98px;
        border-radius: 28px; color: var(--shot-white); cursor: pointer; pointer-events: auto;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
        font-family: var(--shot-font); }
      .gs-ready-title { font-size: 21px; line-height: 1.2; font-weight: 630; letter-spacing: -.015em; }
      .gs-ready-sub { font-size: 13px; color: var(--shot-muted); }
      .gs-ready-line { position: absolute; left: 46px; right: 46px; bottom: 8px; height: 2px;
        border-radius: 2px; background: var(--shot-green); opacity: .78; }

      .gs-flight-strip { left: 50%; bottom: 18px; width: min(570px,calc(100vw - 32px)); min-height: 82px;
        border-radius: 26px; display: grid; grid-template-columns: repeat(3,1fr);
        align-items: center; overflow: hidden; }
      .gs-live-metric { min-width: 0; padding: 14px 30px; position: relative; }
      .gs-live-metric + .gs-live-metric::before { content: ''; position: absolute; left: 0; top: 19px; bottom: 19px;
        width: 1px; background: rgba(255,255,255,.25); }
      .gs-live-label, .gs-result-label, .gs-data-label { display: block; font-size: 13px; line-height: 1.2;
        font-weight: 520; color: var(--shot-muted); }
      .gs-live-value { display: inline-block; margin-top: 4px; font-size: 31px; line-height: 1; font-weight: 650;
        letter-spacing: -.03em; color: var(--shot-white); }
      .gs-live-unit, .gs-result-unit { margin-left: 5px; font-size: 13px; color: var(--shot-muted); }

      .gs-results { left: 50%; bottom: 16px; width: min(1180px,calc(100vw - 32px));
        padding: 12px 20px; border-radius: 22px; display: grid;
        grid-template-columns: minmax(330px,3fr) minmax(0,8fr); gap: 20px; align-items: center;
        /* Keep the held data optically stable over the moving result orbit. The
           layered translucent fill retains the liquid-glass depth, but this one
           large surface does not repeatedly recapture/blur the WebGPU canvas. */
        background:
          radial-gradient(120% 95% at 16% -14%,rgba(255,255,255,.14),transparent 52%),
          linear-gradient(180deg,rgba(24,43,31,.86),rgba(8,20,13,.82));
        -webkit-backdrop-filter: none; backdrop-filter: none;
        transform: translate(-50%,0); transition: opacity .18s ease, visibility .18s; }
      .gs-result-hero { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); }
      .gs-hero-metric { min-width: 0; padding-right: 16px; }
      .gs-hero-metric + .gs-hero-metric { border-left: 1px solid rgba(255,255,255,.26); padding-left: 16px; }
      .gs-results .gs-result-label, .gs-results .gs-data-label { font-size: 11px; }
      .gs-result-value { display: inline-block; margin-top: 3px; font-size: clamp(24px,2.4vw,30px); line-height: 1;
        font-weight: 640; letter-spacing: -.04em; color: var(--shot-white); }
      .gs-hero-metric:last-child .gs-result-value { color: var(--shot-green); }
      .gs-result-rule { display: none; }
      .gs-result-data { display: grid; grid-template-columns: repeat(8,minmax(0,1fr)); gap: 12px; }
      .gs-data-value { display: block; margin-top: 3px; font-size: 14px; line-height: 1.1; font-weight: 590;
        color: var(--shot-white); white-space: nowrap; }

      .gs-shot-status { position: absolute; left: 50%; top: 92px; transform: translateX(-50%);
        padding: 8px 14px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; }
      .gs-shot-ui.has-status .gs-shot-status { opacity: 1; }

      .gs-panel { position: fixed; top: 68px; left: 16px; width: 292px; max-height: calc(100vh - 84px); overflow: auto;
        padding: 16px; z-index: 62; color: var(--shot-white); font: 500 14px/1.35 var(--shot-font);
        background: linear-gradient(180deg,rgba(22,37,29,.78),rgba(9,18,13,.74));
        border: 1px solid rgba(255,255,255,.24); border-radius: 22px;
        -webkit-backdrop-filter: blur(22px) saturate(1.1); backdrop-filter: blur(22px) saturate(1.1);
        box-shadow: 0 20px 60px rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.18);
        opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(-8px) scale(.98);
        transition: opacity .22s, transform .32s cubic-bezier(.2,.75,.25,1), visibility .22s; }
      .gs-panel.open { opacity: 1; visibility: visible; pointer-events: auto; transform: none; }
      .gs-lab-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
      .gs-title { font-weight: 680; font-size: 17px; letter-spacing: -.01em; }
      .gs-lab-sub { margin-top: 2px; color: var(--shot-muted); font-size: 11px; }
      .gs-lab-close { width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.18); border-radius: 50%;
        background: rgba(255,255,255,.07); color: var(--shot-white); cursor: pointer; font: 300 22px/1 var(--shot-font); }
      .gs-preset { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 14px;
        font-size: 12px; color: var(--shot-muted); }
      .gs-preset select, .gs-select-field select { min-width: 0; background: rgba(4,12,7,.38); color: var(--shot-white);
        border: 1px solid rgba(255,255,255,.17); border-radius: 9px; padding: 6px 8px; font: 500 12px var(--shot-font); }
      .gs-preset select { flex: 1; }
      .gs-field { margin-bottom: 10px; }
      .gs-field-top { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 3px; font-size: 11px; }
      .gs-field-top span { color: var(--shot-muted); }
      .gs-field-top output { color: var(--shot-white); font-weight: 650; font-variant-numeric: tabular-nums; }
      .gs-field input[type=range] { width: 100%; height: 15px; accent-color: var(--shot-green); }
      .gs-select-field { display: flex; align-items: center; justify-content: space-between; }
      .gs-select-field .gs-field-top { margin: 0; }
      .gs-env { margin: 7px 0 12px; }
      .gs-env summary { padding: 4px 0 8px; cursor: pointer; color: var(--shot-muted); font-size: 12px; }
      #gs-hit { width: 100%; padding: 11px; border: 1px solid rgba(255,255,255,.22); border-radius: 12px;
        background: rgba(126,226,154,.82); color: #092012; cursor: pointer; font: 700 13px var(--shot-font); }
      .gs-hint { margin-top: 9px; color: rgba(245,250,246,.48); text-align: center; font-size: 10px; }

      body:not([data-view="practice"]) .gs-shot-ui,
      body:not([data-view="practice"]) #gs-lab-toggle,
      body:not([data-view="practice"]) #gs-launch-lab { display: none !important; }
      @media (max-width: 900px) {
        .gs-results { padding: 10px 14px; grid-template-columns: 1fr; gap: 10px; }
        .gs-result-data { grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px 12px; }
      }
      @media (max-width: 620px) {
        #gs-lab-toggle { top: 10px; left: 10px; }
        .gs-panel { top: 58px; left: 10px; width: calc(100vw - 20px); }
        .gs-results { bottom: 10px; width: calc(100vw - 20px); padding: 10px 12px; border-radius: 18px; }
        .gs-result-hero { gap: 0; }
        .gs-hero-metric { padding-right: 12px; }
        .gs-hero-metric + .gs-hero-metric { padding-left: 12px; }
        .gs-result-value { font-size: clamp(22px,7vw,30px); }
        .gs-result-unit { margin-left: 3px; }
        .gs-data-value { font-size: 12px; }
        .gs-result-data { grid-template-columns: repeat(4,minmax(0,1fr)); }
        .gs-live-metric { padding: 13px 16px; }
        .gs-live-value { font-size: 26px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .gs-shot-ui [data-shot-view], .gs-panel, #gs-lab-toggle { transition-duration: .01ms; }
      }
      @media (prefers-reduced-transparency: reduce), (forced-colors: active) {
        .gs-glass, #gs-lab-toggle { background: rgba(18,25,21,.92); -webkit-backdrop-filter: none;
          backdrop-filter: none; text-shadow: none; }
      }
    `;
    document.head.appendChild(style);
  }
}

function liveMetric(label, id, unit, labelId = '', unitId = '') {
  const labelAttribute = labelId ? ` id="${labelId}"` : '';
  const unitAttribute = unitId ? ` id="${unitId}"` : '';
  return `<div class="gs-live-metric"><span${labelAttribute} class="gs-live-label">${label}</span><span id="${id}" class="gs-live-value">0</span><span${unitAttribute} class="gs-live-unit">${unit}</span></div>`;
}

function heroMetric(label, id, unit, unitId = '') {
  const idAttribute = unitId ? ` id="${unitId}"` : '';
  return `<div class="gs-hero-metric"><span class="gs-result-label">${label}</span><span id="${id}" class="gs-result-value">—</span><span${idAttribute} class="gs-result-unit">${unit}</span></div>`;
}

function resultMetric(label, id) {
  return `<div class="gs-data-metric"><span class="gs-data-label">${label}</span><span id="${id}" class="gs-data-value">—</span></div>`;
}

function formatOffline(value) {
  const direction = value >= 0 ? 'R' : 'L';
  return { value: Math.abs(value).toFixed(1), unit: Math.abs(value) < 0.05 ? 'yd' : `yd ${direction}` };
}

function fmt(value) {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(value % 1 ? 1 : 0);
}

export function formatDirectionalDegrees(value) {
  if (!Number.isFinite(value)) throw new TypeError('direction must be finite');
  if (value === 0) return '0°';
  return `${fmt(Math.abs(value))}° ${value < 0 ? 'L' : 'R'}`;
}

function formatFieldValue(field, value) {
  return field.directional ? formatDirectionalDegrees(value) : `${fmt(value)} ${field.unit}`;
}
