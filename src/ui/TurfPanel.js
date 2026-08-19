// Live tuning panel for the turf shader (toggle with G).
//
// Turf look is a dozen coupled numbers — canopy depth, relief strength, the detail
// fade band, sheen, grade. Guessing them from source, reloading, and re-flying the
// camera to a fairway costs a minute per guess and you can't see two settings side by
// side. These bind straight to the material's uniforms, so a drag re-renders the next
// frame with no shader rebuild.
//
// "Copy values" prints the current set as source-ready defaults — the panel is for
// FINDING numbers, not for storing them; whatever you settle on belongs in Terrain.js.
const ROWS = [
  { key: 'uParallax', label: 'Canopy depth', min: 0, max: 3, step: 0.05,
    hint: 'x real mowing height (1 = true scale)' },
  { key: 'uDetailNormal', label: 'Blade relief', min: 0, max: 4, step: 0.05 },
  { key: 'uAO', label: 'Canopy AO', min: 0, max: 1, step: 0.02 },
  { key: 'uShadow', label: 'Self-shadow', min: 0, max: 1, step: 0.02 },
  { key: 'uNear0', label: 'Detail fade start', min: 0, max: 40, step: 0.5, unit: ' m' },
  { key: 'uNear1', label: 'Detail fade end', min: 1, max: 80, step: 0.5, unit: ' m' },
  { key: 'uRoughBase', label: 'Roughness base', min: 0.1, max: 1, step: 0.01 },
  { key: 'uRoughRange', label: 'Roughness range', min: 0, max: 0.6, step: 0.01 },
  { key: 'uSpecular', label: 'Specular', min: 0, max: 1, step: 0.02,
    hint: 'canopy specular reflectance — how much light the lobe carries at all' },
  { key: 'uGraze', label: 'Graze rough', min: 0, max: 1, step: 0.02,
    hint: 'extra roughening at grazing angles, as (1 - N.V)^5 x this' },
  { key: 'uSat', label: 'Saturation', min: 0, max: 2, step: 0.02 },
  { key: 'uVal', label: 'Value', min: 0.2, max: 2, step: 0.02 },
];

export class TurfPanel {
  constructor() {
    this.terrain = null;
    this.el = document.createElement('div');
    this.el.id = 'turf-panel';
    this.el.style.cssText = `
      position:fixed; top:12px; right:12px; width:250px; z-index:60; display:none;
      background:rgba(18,20,18,.88); color:#e8eee6; border-radius:10px; padding:12px 14px;
      font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; backdrop-filter:blur(8px);
      box-shadow:0 8px 30px rgba(0,0,0,.4);`;
    document.body.appendChild(this.el);
    this._rows = [];
    this._build();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyG' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) this.toggle();
    });
  }

  _build() {
    const title = document.createElement('div');
    title.textContent = 'TURF  ·  G to hide';
    title.style.cssText = 'letter-spacing:.12em; opacity:.55; margin-bottom:10px;';
    this.el.appendChild(title);

    for (const r of ROWS) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:7px;';
      const lab = document.createElement('div');
      lab.style.cssText = 'display:flex; justify-content:space-between; opacity:.8;';
      const name = document.createElement('span');
      name.textContent = r.label;
      if (r.hint) name.title = r.hint;
      const val = document.createElement('span');
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: r.min, max: r.max, step: r.step });
      input.style.cssText = 'width:100%; accent-color:#7fc96a; margin-top:2px;';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (this.terrain?.[r.key]) this.terrain[r.key].value = v;
        val.textContent = v.toFixed(2) + (r.unit || '');
      });
      lab.append(name, val);
      wrap.append(lab, input);
      this.el.appendChild(wrap);
      this._rows.push({ r, input, val });
    }

    const copy = document.createElement('button');
    copy.textContent = 'Copy values';
    copy.style.cssText = `width:100%; margin-top:6px; padding:5px; cursor:pointer;
      background:#2f4a2b; color:#dff0d8; border:0; border-radius:5px; font:inherit;`;
    copy.addEventListener('click', () => {
      const src = this._rows
        .map(({ r }) => `    this.${r.key} = uniform(${(+this.terrain[r.key].value).toFixed(2)});`)
        .join('\n');
      navigator.clipboard?.writeText(src);
      console.log('[turf]\n' + src);
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy values'; }, 1200);
    });
    this.el.appendChild(copy);
  }

  // Point the panel at a (re)built terrain and pull the sliders to its current values.
  attach(terrain) {
    this.terrain = terrain;
    for (const { r, input, val } of this._rows) {
      const u = terrain?.[r.key];
      if (!u) continue;
      input.value = u.value;
      val.textContent = (+u.value).toFixed(2) + (r.unit || '');
    }
  }

  toggle() { this.el.style.display = this.el.style.display === 'none' ? 'block' : 'none'; }
}
