// Live preview panel for the persisted course surface-material contract (toggle G).
// The panel never reaches into shader uniforms: Terrain owns the semantic snapshot /
// apply boundary, while the host scene decides whether a preview should be persisted.
const ROWS = Object.freeze([
  { path: ['turf', 'parallax'], label: 'Turf parallax', min: 0, max: 3, step: 0.05, hint: 'Multiplier on physical mowing height' },
  { path: ['turf', 'detailNormal'], label: 'Turf relief', min: 0, max: 4, step: 0.05 },
  { path: ['turf', 'ao'], label: 'Turf AO', min: 0, max: 1, step: 0.02 },
  { path: ['turf', 'selfShadow'], label: 'Turf self-shadow', min: 0, max: 1, step: 0.02 },
  { path: ['turf', 'roughnessBase'], label: 'Roughness base', min: 0.1, max: 1, step: 0.01 },
  { path: ['turf', 'roughnessRange'], label: 'Roughness range', min: 0, max: 0.6, step: 0.01 },
  { path: ['turf', 'specular'], label: 'Specular', min: 0, max: 1, step: 0.02 },
  { path: ['turf', 'grazingRoughness'], label: 'Grazing roughness', min: 0, max: 1, step: 0.02 },
  { path: ['turf', 'saturation'], label: 'Turf saturation', min: 0, max: 2, step: 0.02 },
  { path: ['turf', 'value'], label: 'Turf value', min: 0.2, max: 2, step: 0.02 },
  { path: ['forestFloor', 'reliefDepthMeters'], label: 'Needle relief', min: 0, max: 0.05, step: 0.001, unit: ' m' },
  { path: ['forestFloor', 'normalStrength'], label: 'Needle normal', min: 0, max: 2, step: 0.02 },
  { path: ['forestFloor', 'sourceColorStrength'], label: 'Needle source color', min: 0, max: 2, step: 0.02 },
  { path: ['forestFloor', 'macroVariation'], label: 'Needle macro variation', min: 0, max: 0.5, step: 0.01 },
  { path: ['forestFloor', 'canopyAffinity'], label: 'Canopy affinity', min: 0, max: 1, step: 0.02 },
  { path: ['forestFloor', 'crownFeatherMeters'], label: 'Crown feather', min: 0.25, max: 12, step: 0.25, unit: ' m' },
]);

function valueAt(value, path) { return path.reduce((current, key) => current?.[key], value); }
function setValue(value, path, next) { value[path[0]][path[1]] = next; }

export class TurfPanel {
  constructor({ onApply = null, onRevert = null } = {}) {
    this.terrain = null;
    this.baseline = null;
    this.onApply = onApply;
    this.onRevert = onRevert;
    this.el = document.createElement('div');
    this.el.id = 'turf-panel';
    this.el.style.cssText = `
      position:fixed; top:12px; right:12px; width:270px; z-index:60; display:none;
      max-height:calc(100vh - 24px); overflow:auto;
      background:rgba(18,20,18,.88); color:#e8eee6; border-radius:10px; padding:12px 14px;
      font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; backdrop-filter:blur(8px);
      box-shadow:0 8px 30px rgba(0,0,0,.4);`;
    document.body.appendChild(this.el);
    this._rows = [];
    this._build();
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyG' && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)) this.toggle();
    });
  }

  _build() {
    const title = document.createElement('div');
    title.textContent = 'SURFACES  ·  G to hide';
    title.style.cssText = 'letter-spacing:.12em; opacity:.55; margin-bottom:10px;';
    this.el.appendChild(title);

    for (const row of ROWS) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:7px;';
      const label = document.createElement('div');
      label.style.cssText = 'display:flex; justify-content:space-between; opacity:.8;';
      const name = document.createElement('span');
      name.textContent = row.label;
      if (row.hint) name.title = row.hint;
      const displayed = document.createElement('span');
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: row.min, max: row.max, step: row.step });
      input.style.cssText = 'width:100%; accent-color:#7fc96a; margin-top:2px;';
      input.addEventListener('input', () => {
        const snapshot = this.snapshot();
        if (!snapshot) return;
        setValue(snapshot, row.path, Number(input.value));
        this.apply(snapshot);
      });
      label.append(name, displayed);
      wrap.append(label, input);
      this.el.appendChild(wrap);
      this._rows.push({ row, input, displayed });
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px;';
    const revert = this._button('Revert preview', () => this.revert());
    const copy = this._button('Copy JSON', async () => {
      const snapshot = this.snapshot();
      const source = JSON.stringify(snapshot, null, 2);
      await navigator.clipboard?.writeText(source);
      console.log('[surface-materials]\n' + source);
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1200);
    });
    actions.append(revert, copy);
    this.el.appendChild(actions);
  }

  _button(label, onClick) {
    const button = document.createElement('button');
    button.textContent = label;
    button.style.cssText = 'padding:6px; cursor:pointer; background:#2f4a2b; color:#dff0d8; border:0; border-radius:5px; font:inherit;';
    button.addEventListener('click', onClick);
    return button;
  }

  attach(terrain, { resetBaseline = true } = {}) {
    this.terrain = terrain;
    const snapshot = this.snapshot();
    if (resetBaseline && snapshot) this.baseline = structuredClone(snapshot);
    this.sync(snapshot);
  }

  snapshot() {
    const snapshot = this.terrain?.snapshotSurfaceMaterials?.();
    return snapshot ? structuredClone(snapshot) : null;
  }

  apply(surfaceMaterials) {
    if (!this.terrain) throw new Error('Surface material preview requires an attached terrain.');
    const applied = this.onApply
      ? this.onApply(structuredClone(surfaceMaterials))
      : this.terrain.applySurfaceMaterials(surfaceMaterials);
    this.sync(applied ?? this.snapshot());
    return applied;
  }

  sync(surfaceMaterials = this.snapshot()) {
    if (!surfaceMaterials) return;
    for (const { row, input, displayed } of this._rows) {
      const value = Number(valueAt(surfaceMaterials, row.path));
      input.value = String(value);
      displayed.textContent = value.toFixed(row.step < 0.01 ? 3 : 2) + (row.unit || '');
    }
  }

  revert() {
    if (this.onRevert) {
      const reverted = this.onRevert();
      this.sync(reverted);
      return reverted;
    }
    if (!this.baseline) return null;
    const reverted = this.terrain.applySurfaceMaterials(structuredClone(this.baseline));
    this.sync(reverted);
    return reverted;
  }

  toggle() { this.el.style.display = this.el.style.display === 'none' ? 'block' : 'none'; }
}
