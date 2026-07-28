// Club/ball launch-metric input panel plus the results HUD. Pure DOM overlay;
// it hands a plain params object to the sim on "Hit" and renders shot results.

// Tour/robot launch data, roughly TrackMan averages. These double as the
// calibration reference for the physics (a "Driver" hit should carry ~275 yds).
const PRESETS = {
  'Driver (tour)':   { ballSpeed: 167, launchAngle: 10.9, spinRate: 2686, spinAxis: -2, azimuth: 0 },
  'Driver (amateur)':{ ballSpeed: 133, launchAngle: 12.5, spinRate: 3200, spinAxis: 3, azimuth: 0 },
  '3-wood':          { ballSpeed: 158, launchAngle: 9.2,  spinRate: 3655, spinAxis: -1, azimuth: 0 },
  '5-iron':          { ballSpeed: 132, launchAngle: 14.3, spinRate: 5361, spinAxis: 0, azimuth: 0 },
  '7-iron':          { ballSpeed: 120, launchAngle: 16.3, spinRate: 7097, spinAxis: 0, azimuth: 0 },
  '9-iron':          { ballSpeed: 108, launchAngle: 20.4, spinRate: 8647, spinAxis: 0, azimuth: 0 },
  'Pitching wedge':  { ballSpeed: 102, launchAngle: 24.2, spinRate: 9304, spinAxis: 0, azimuth: 0 },
  'Big slice':       { ballSpeed: 150, launchAngle: 13,   spinRate: 3400, spinAxis: 14, azimuth: -3 },
  'Towering draw':   { ballSpeed: 160, launchAngle: 12,   spinRate: 2900, spinAxis: -9, azimuth: 2 },
};

const FIELDS = [
  { key: 'ballSpeed', label: 'Ball speed', unit: 'mph', min: 40, max: 200, step: 1 },
  { key: 'launchAngle', label: 'Launch angle', unit: '°', min: 0, max: 50, step: 0.1 },
  { key: 'azimuth', label: 'Launch direction', unit: '°', min: -20, max: 20, step: 0.5 },
  { key: 'spinRate', label: 'Spin rate', unit: 'rpm', min: 0, max: 12000, step: 50 },
  { key: 'spinAxis', label: 'Spin axis (tilt)', unit: '°', min: -30, max: 30, step: 0.5 },
];

const ENV_FIELDS = [
  { key: 'windSpeed', label: 'Wind', unit: 'mph', min: 0, max: 40, step: 1, def: 0 },
  { key: 'windDir', label: 'Wind from', unit: '°', min: 0, max: 360, step: 5, def: 0 },
  { key: 'altitude', label: 'Altitude', unit: 'm', min: 0, max: 3000, step: 50, def: 0 },
  { key: 'temperatureC', label: 'Temp', unit: '°C', min: -5, max: 45, step: 1, def: 15 },
];

export class MetricsPanel {
  constructor({ onHit }) {
    this.onHit = onHit;
    this.values = { ...PRESETS['7-iron'] };
    this.env = Object.fromEntries(ENV_FIELDS.map((f) => [f.key, f.def]));
    this._injectStyles();
    this._build();
    this.applyPreset('7-iron');
  }

  getParams() { return { ...this.values }; }
  getEnv() { return { ...this.env }; }

  applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    Object.assign(this.values, p);
    for (const f of FIELDS) this._setField(f.key, this.values[f.key] ?? 0);
  }

  showResult(r) {
    const rows = [
      ['Carry', `${r.carryYards.toFixed(1)} yds`],
      ['Total', `${r.totalYards.toFixed(1)} yds`],
      ['Apex', `${(r.apexMeters * 3.28084).toFixed(0)} ft`],
      ['Offline', `${(r.offlineYards >= 0 ? 'R ' : 'L ') + Math.abs(r.offlineYards).toFixed(1)} yds`],
      ['Descent', `${r.descentDeg.toFixed(0)}°`],
      ['Lie', r.surface],
    ];
    this.hud.innerHTML = rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`)
      .join('');
    this.hud.classList.add('show');
  }

  setLive(text) {
    this.live.textContent = text;
  }

  // ---- DOM ----------------------------------------------------------------

  _build() {
    const panel = document.createElement('div');
    panel.className = 'gs-panel';
    panel.innerHTML = `
      <div class="gs-title">Launch Monitor</div>
      <label class="gs-preset">Club
        <select id="gs-preset"></select>
      </label>
      <div id="gs-fields"></div>
      <details class="gs-env">
        <summary>Conditions</summary>
        <div id="gs-env"></div>
      </details>
      <button id="gs-hit">Hit &nbsp;▸</button>
      <div class="gs-hint">Space to hit · R to reset view</div>
    `;
    document.body.appendChild(panel);

    const sel = panel.querySelector('#gs-preset');
    for (const name of Object.keys(PRESETS)) {
      const o = document.createElement('option');
      o.value = o.textContent = name;
      sel.appendChild(o);
    }
    sel.value = '7-iron';
    sel.addEventListener('change', () => this.applyPreset(sel.value));

    const fieldsEl = panel.querySelector('#gs-fields');
    for (const f of FIELDS) fieldsEl.appendChild(this._field(f, this.values, f.key));

    const envEl = panel.querySelector('#gs-env');
    for (const f of ENV_FIELDS) envEl.appendChild(this._field(f, this.env, f.key, f.def));

    panel.querySelector('#gs-hit').addEventListener('click', () => this.onHit?.());

    // Results HUD.
    const hud = document.createElement('div');
    hud.className = 'gs-hud';
    document.body.appendChild(hud);
    this.hud = hud;

    // Live tracer readout (top center).
    const live = document.createElement('div');
    live.className = 'gs-live';
    document.body.appendChild(live);
    this.live = live;

    this._fieldEls = {};
    panel.querySelectorAll('[data-key]').forEach((el) => {
      this._fieldEls[el.dataset.key] = el;
    });
  }

  _field(f, store, key, def) {
    const wrap = document.createElement('div');
    wrap.className = 'gs-field';
    const val = store[key] ?? def ?? 0;
    wrap.innerHTML = `
      <div class="gs-field-top"><span>${f.label}</span><output>${fmt(val)} ${f.unit}</output></div>
      <input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}" data-key="${key}">
    `;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      store[key] = v;
      out.textContent = `${fmt(v)} ${f.unit}`;
    });
    return wrap;
  }

  _setField(key, v) {
    const el = this._fieldEls?.[key];
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input'));
  }

  _injectStyles() {
    if (document.getElementById('gs-style')) return;
    const s = document.createElement('style');
    s.id = 'gs-style';
    s.textContent = `
      .gs-panel{position:fixed;top:16px;left:16px;width:280px;padding:16px;z-index:20;
        background:rgba(14,20,26,.82);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);
        border-radius:14px;color:#dbe7e0;font:13px/1.3 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.4)}
      .gs-title{font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:11px;opacity:.65;margin-bottom:12px}
      .gs-preset{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;opacity:.9}
      .gs-preset select{flex:1;background:#0d151b;color:#dbe7e0;border:1px solid rgba(255,255,255,.12);
        border-radius:8px;padding:6px 8px;font:12px system-ui}
      .gs-field{margin-bottom:11px}
      .gs-field-top{display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px}
      .gs-field-top span{opacity:.7}.gs-field-top output{font-variant-numeric:tabular-nums;font-weight:600;color:#8fe0a6}
      .gs-field input[type=range]{width:100%;accent-color:#4caf72;height:16px}
      .gs-env{margin:6px 0 12px}.gs-env summary{cursor:pointer;font-size:11px;opacity:.7;padding:4px 0}
      #gs-hit{width:100%;padding:11px;border:0;border-radius:10px;cursor:pointer;
        background:linear-gradient(180deg,#39b56a,#2b8a50);color:#04160c;font-weight:800;font-size:14px;letter-spacing:.03em}
      #gs-hit:hover{filter:brightness(1.08)}#gs-hit:active{transform:translateY(1px)}
      .gs-hint{margin-top:9px;font-size:10px;opacity:.45;text-align:center}
      .gs-hud{position:fixed;top:16px;right:16px;width:190px;z-index:20;padding:14px 16px;
        background:rgba(14,20,26,.82);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);
        border-radius:14px;color:#dbe7e0;font:13px system-ui;opacity:0;transform:translateY(-6px);
        transition:opacity .4s,transform .4s}
      .gs-hud.show{opacity:1;transform:none}
      .gs-hud .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)}
      .gs-hud .row:last-child{border:0}.gs-hud .row span{opacity:.6}.gs-hud .row b{color:#8fe0a6;font-variant-numeric:tabular-nums}
      .gs-live{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:20;
        font:600 15px system-ui;color:#eafff0;text-shadow:0 2px 8px rgba(0,0,0,.6);
        font-variant-numeric:tabular-nums;pointer-events:none}
    `;
    document.head.appendChild(s);
  }
}

function fmt(v) {
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(v % 1 ? 1 : 0);
}
