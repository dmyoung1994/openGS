import { TREE_PRESETS, createTreePreset } from '../trees/TreePresets.js';
import { normalizeTreeDefinition } from '../trees/TreeDefinition.js';
import { PLANT_CONTROLS, normalizePlantControls } from '../trees/PlantControls.js';

const label = text => text.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ');
const choices = {
  shape: ['conical', 'spherical', 'hemispherical', 'cylindrical', 'tapered-cylindrical', 'flame', 'inverse-conical', 'tend-flame', 'custom'],
  leafShape: ['oval', 'lanceolate', 'fan', 'needle', 'cluster', 'compound', 'spray', 'pinnate', 'flower'],
  branchPattern: ['alternate', 'opposite', 'whorled'],
};
export class TreeBuilderPanel {
  constructor(builder) {
    this.builder = builder; this.definition = createTreePreset(); this.undo = []; this.redo = []; this.revision = 0; this.previewQueue = Promise.resolve();
    const button = document.createElement('button'); button.textContent = 'Plants'; button.id = 'gb-plants'; button.onclick = () => this.open();
    builder.el.querySelector('.gb-camera').append(button);
    this.panel = document.createElement('section'); this.panel.className = 'plant-builder'; this.panel.hidden = true; this.panel.setAttribute('aria-label', 'Procedural plant builder');
    document.body.append(this.panel); this.render();
  }
  async open() {
    if (!this.panel.hidden) return;
    this.restore = this.builder._captureAgentSceneState(); this.wasCanvas = window.golf.creatorCanvasActive; this.panel.hidden = false;
    if (this.wasCanvas) await window.golf.showAuthoredCreatorCourse();
    this.schedulePreview(true);
  }
  async close() {
    this.panel.hidden = true; this.revision++; clearTimeout(this.timer); this.abort?.abort();
    await this.previewQueue;
    await window.golf?.range?.clearTreeCandidates();
    if (this.wasCanvas) await window.golf.showCreatorCanvas();
    await this.builder._restoreAgentSceneState(this.restore);
  }
  commit(next) {
    try {
      const normalized = normalizeTreeDefinition(next);
      this.undo.push(this.definition); if (this.undo.length > 80) this.undo.shift();
      this.redo = []; this.definition = normalized; this.render(); this.schedulePreview();
    } catch (error) { this.status.textContent = error.message; }
  }
  render() {
    const open = new Set([...this.panel.querySelectorAll('details[open]')].map(el => el.dataset.path));
    this.panel.replaceChildren();
    const heading = document.createElement('header');
    const title = document.createElement('h2'); title.textContent = 'Plant studio';
    const close = this.button('Close', () => this.close()); heading.append(title, close); this.panel.append(heading);
    const intro = document.createElement('p'); intro.textContent = 'Shape the rules. Grow a unique tree or shrub.'; this.panel.append(intro);
    const presets = document.createElement('select'); presets.setAttribute('aria-label', 'Plant preset');
    for (const name of TREE_PRESETS) presets.add(new Option(label(name), name, false, name === this.definition.id));
    presets.onchange = () => this.commit(createTreePreset(presets.value, this.definition.seed)); this.panel.append(presets);
    const toolbar = document.createElement('div'); toolbar.className = 'plant-actions';
    toolbar.append(this.button('Undo', () => this.travel(this.undo, this.redo)), this.button('Redo', () => this.travel(this.redo, this.undo)), this.button('New seed', () => this.commit({ ...this.definition, seed: (this.definition.seed + 1) >>> 0 })), this.button('Reset', () => this.commit(createTreePreset(presets.value)))); this.panel.append(toolbar);
    if (!this.definition.plant) toolbar.append(this.button('Upgrade controls', () => this.commit({ ...this.definition, version: 2, plant: normalizePlantControls() })));
    const controls = document.createElement('div'); controls.className = 'plant-controls';
    this.fields(controls, this.definition, []); this.panel.append(controls);
    const actions = document.createElement('div'); actions.className = 'plant-actions';
    actions.append(this.button('Export JSON', () => this.download()), this.button('Import JSON', () => this.import()), this.button('Save to library', () => this.save()), this.button('Place in course', () => this.place()));
    this.panel.append(actions);
    this.status = document.createElement('output'); this.status.setAttribute('aria-live', 'polite'); this.status.textContent = 'Ready'; this.panel.append(this.status);
    for (const detail of this.panel.querySelectorAll('details')) detail.open = open.has(detail.dataset.path);
  }
  button(text, action) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.onclick = async () => { try { await action(); } catch (error) { this.status.textContent = error.message; } }; return button;
  }
  fields(parent, object, path) {
    if (path[0] === 'materials' && path.length === 2) object = { textureUrl: '', normalUrl: '', roughnessUrl: '', aoUrl: '', textureScale: 1, translucency: 0.2, ...object };
    for (const [key, value] of Object.entries(object)) {
      if (['version', 'generator', 'source'].includes(key)) continue;
      const next = [...path, key];
      if (value && typeof value === 'object') {
        const group = document.createElement('details'), title = document.createElement('summary'); group.dataset.path = next.join('.'); title.textContent = path.at(-1) === 'levelsParameters' ? `Branch level ${Number(key) + 1}` : label(key); group.append(title);
        if (key === 'profiles') for (const [name, points] of Object.entries(value)) this.profile(group, name, points);
        else this.fields(group, value, next);
        parent.append(group); continue;
      }
      const row = document.createElement('label'), name = document.createElement('span'); name.textContent = label(key); row.append(name);
      let input;
      const spec = path[0] === 'plant' ? PLANT_CONTROLS[path[1]]?.[key] : null;
      const options = spec && typeof spec[0] === 'string' ? spec : key === 'shape' ? (path.includes('leaves') || path.includes('blossoms') ? choices.leafShape : choices.shape) : choices[key];
      if (options) { input = document.createElement('select'); for (const option of options) input.add(new Option(label(option), option, false, option === value)); }
      else { input = document.createElement('input'); input.type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'checkbox' : key === 'color' ? 'color' : 'text'; input.value = String(value); input.checked = value === true; }
      input.setAttribute('aria-label', next.join(' '));
      if (typeof value === 'number') { input.step = ['seed', 'variantCount', 'count', 'levels'].includes(key) ? '1' : 'any'; if (spec) { input.min = spec[1]; input.max = spec[2]; } }
      input.onchange = () => {
        const copy = structuredClone(this.definition), owner = next.slice(0, -1).reduce((o, k) => o[k], copy);
        owner[key] = typeof value === 'number' ? Number(input.value) : typeof value === 'boolean' ? input.checked : input.value;
        if (key.endsWith('Url') && input.value === '') delete owner[key];
        this.commit(copy);
      };
      row.append(input);
      if (spec && typeof value === 'number') { const slider = document.createElement('input'); slider.type = 'range'; slider.min = spec[1]; slider.max = spec[2]; slider.step = (spec[2] - spec[1]) / 100; slider.value = value; slider.setAttribute('aria-label', `${next.join(' ')} slider`); slider.onchange = () => { input.value = slider.value; input.onchange(); }; row.append(slider); }
      parent.append(row);
    }
  }
  profile(parent, name, points) {
    const box = document.createElement('details'), title = document.createElement('summary'); box.dataset.path = `plant.profiles.${name}`; title.textContent = label(name); box.append(title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 240 90'); svg.setAttribute('aria-label', `${name} profile`);
    const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', points.map(([x, y]) => `${x * 240},${90 - y * 30}`).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#bad49d'); line.setAttribute('stroke-width', '2'); svg.append(line); box.append(svg);
    const edit = document.createElement('textarea'); edit.value = JSON.stringify(points); edit.setAttribute('aria-label', `${name} profile points`);
    edit.onchange = () => { try { const copy = structuredClone(this.definition); copy.plant.profiles[name] = JSON.parse(edit.value); this.commit(copy); } catch (error) { this.status.textContent = error.message; } };
    svg.ondblclick = event => {
      const bounds = svg.getBoundingClientRect(), x = Math.round((event.clientX - bounds.left) / bounds.width * 100) / 100, y = Math.max(0, Math.min(3, (1 - (event.clientY - bounds.top) / bounds.height) * 3));
      const copy = structuredClone(this.definition), curve = copy.plant.profiles[name];
      if (x > 0 && x < 1 && !curve.some(p => p[0] === x)) { curve.push([x, Math.round(y * 100) / 100]); curve.sort((a, b) => a[0] - b[0]); this.commit(copy); }
    };
    box.append(edit); parent.append(box);
  }
  travel(from, to) { if (!from.length) return; to.push(this.definition); this.definition = from.pop(); this.render(); this.schedulePreview(); }
  schedulePreview(frame = false) {
    clearTimeout(this.timer); this.abort?.abort(); this.abort = new AbortController(); const signal = this.abort.signal; const revision = ++this.revision;
    this.timer = setTimeout(() => {
      this.previewQueue = this.previewQueue.catch(() => {}).then(async () => {
        if (revision !== this.revision || this.panel.hidden) return;
        this.status.textContent = 'Growing…';
        const range = window.golf?.range;
        if (!range?.presentTreeCandidates) throw new Error('The production scene is not ready');
        const layout = await range.presentTreeCandidates([{ source: 'procedural', optionId: 'plant', label: this.definition.id, definition: this.definition }], { anchor: this.layout?.center, reuseLayout: true, signal, isCurrent: () => revision === this.revision && !this.panel.hidden });
        if (!layout || revision !== this.revision || this.panel.hidden) return;
        const moved = this.layout && (this.layout.center.x !== layout.center.x || this.layout.center.z !== layout.center.z);
        this.layout = layout; this.renderedDefinition = this.definition;
        if (frame || !this.framed || moved) {
          const camera = window.golf.evaluatorCamera, y = range.terrain.heightAt(layout.center.x, layout.center.z), distance = Math.max(5, layout.height * 1.8);
          if (!camera.active) camera.enter(); camera.setSimulationFrozen(false);
          camera.setPose({ position: [layout.center.x + distance, y + layout.height * 0.7, layout.center.z + distance], lookAt: [layout.center.x, y + layout.height * 0.4, layout.center.z], fov: 42 }); this.framed = true;
        }
        const forest = range._treePresentation.line.treeBeauties[0], stats = forest.workloadDiagnostics();
        this.status.textContent = `${stats.branches} segments · ${stats.leaves} leaves · ${(stats.bufferBytes / 1048576).toFixed(1)} MB · ${Math.round(stats.generationMs)} ms generation${stats.limitsReached.length ? ' · Generation limit reached' : ''}`;
      }).catch(error => { if (revision === this.revision && !signal.aborted) this.status.textContent = error.message; });
    }, 180);
  }
  download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.definition, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${this.definition.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  import() { const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'; input.onchange = async () => { try { this.commit(JSON.parse(await input.files[0].text())); } catch (error) { this.status.textContent = error.message; } }; input.click(); }
  async save() {
    clearTimeout(this.timer); this.schedulePreview();
    await new Promise(resolve => setTimeout(resolve, 200));
    await this.previewQueue;
    if (this.definition !== this.renderedDefinition) throw new Error('Resolve the preview error before saving this plant');
    const canvas = window.golf?.sm?.renderer?.domElement;
    if (!canvas || !this.layout) throw new Error('A rendered production preview is required before saving');
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (this.builder.readOnlyReason) throw new Error(this.builder.readOnlyReason);
    await this.request('save', { definition: this.definition, thumbnail: canvas.toDataURL('image/png') });
    this.status.textContent = 'Saved to procedural plant library';
  }
  async place() {
    if (this.builder.readOnlyReason) throw new Error(this.builder.readOnlyReason);
    if (!this.layout) throw new Error('Preview the plant before placing it');
    if (this.definition !== this.renderedDefinition) throw new Error('Wait for a valid preview before placing this plant');
    const state = await fetch('/api/course-agent/state').then(r => r.json());
    await this.request('place', { definition: this.definition, x: this.layout.center.x, z: this.layout.center.z, baseRevision: state.revision });
    this.wasCanvas = false;
    this.status.textContent = 'Placed in the course; course Undo can remove it';
  }
  async request(action, body) {
    if (this.builder.busy) throw new Error('Wait for the current course operation to finish');
    this.builder._setBusy(true);
    try {
      const response = await fetch(`/api/course-agent/plants/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    } finally { this.builder._setBusy(false); }
  }
}
