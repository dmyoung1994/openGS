import { Raycaster, Vector2 } from 'three';
import { selectCourseContext } from '../course/CourseSelection.js';

// Course Creator chrome. The WebGPU world remains the primary surface; this class
// adds only translucent navigation, history, camera/context tools, and the prompt.
export class BuilderPanel {
  constructor({ getCourse } = {}) {
    this.getCourse = getCourse || (() => null);
    this.busy = false;
    this.proposal = null;
    this.state = null;
    this.selection = null;
    this.selecting = false;
    this.revisingItem = null;
    this.raycaster = new Raycaster();
    this.pointer = new Vector2();
    this._build();
    this._loadState();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'gb-panel';
    el.innerHTML = `
      <style>${styles}</style>
      <button class="gb-menu-trigger glass" id="gb-menu-trigger" aria-label="Open main menu" aria-expanded="false" title="Menu">${icon('menu')}</button>
      <div class="gb-destination-menu" id="gb-destination-menu" aria-hidden="true">
        <div class="gb-menu-head"><a href="/" class="gb-menu-brand">Rangeform</a><button class="gb-menu-close" id="gb-menu-close" aria-label="Close main menu">${icon('close')}</button></div>
        <nav class="gb-destination-list" aria-label="Main menu">
          <a href="/range.html"><span class="gb-destination-number">01</span><span><strong>Range</strong><small>Practice and tune your game</small></span>${icon('arrow')}</a>
          <a href="/creator.html" aria-current="page"><span class="gb-destination-number">02</span><span><strong>Course Creator</strong><small>Build a course from an idea</small></span>${icon('arrow')}</a>
          <a href="/play.html"><span class="gb-destination-number">03</span><span><strong>Play</strong><small>Choose a course from your catalog</small></span>${icon('arrow')}</a>
        </nav>
        <p class="gb-menu-foot">Choose where you want to go</p>
      </div>
      <button class="gb-side-tab glass" id="gb-side-tab" aria-label="Open course creator history" aria-expanded="false" title="Course creator history">${icon('history')}</button>
      <aside class="gb-sidebar glass" aria-label="Course creator history" aria-hidden="true">
        <div class="gb-side-head">
          <button class="gb-icon" id="gb-side-toggle" aria-label="Close history" title="Close history">${icon('close')}</button>
          <span class="gb-side-title">Course Creator</span>
          <button class="gb-icon gb-new" id="gb-new" aria-label="New conversation" title="New conversation">${icon('plus')}</button>
        </div>
        <div class="gb-side-content">
          <details open><summary>Chat history ${icon('chevron')}</summary><div id="gb-chat-history" class="gb-history-list"></div></details>
          <details open><summary>Action history ${icon('chevron')}</summary><div id="gb-action-history" class="gb-history-list"></div></details>
        </div>
        <div class="gb-side-footer"><button class="gb-history-action" id="gb-undo">${icon('undo')}<span>Undo last change</span></button><button class="gb-history-action" id="gb-redo">${icon('redo')}<span>Redo change</span></button></div>
      </aside>
      <section class="gb-thread" aria-live="polite">
        <div class="gb-proposal glass" id="gb-proposal"><p class="gb-summary" id="gb-summary"></p><div id="gb-cards"></div><div class="gb-proposal-footer"><button class="gb-primary" id="gb-apply">Apply selected</button></div></div>
      </section>
      <div class="gb-compose-wrap">
        <div class="gb-status" id="gb-status"><span class="gb-state-dot"></span><span class="gb-status-copy">A fresh green is ready to shape.</span></div>
        <div class="gb-context" id="gb-context"><span></span><button aria-label="Clear selected context">${icon('close')}</button></div>
        <div class="gb-composer glass"><textarea id="gb-prompt" rows="1" placeholder="Ask for anything you can imagine…" aria-label="Course design prompt"></textarea><button class="gb-send" id="gb-build" aria-label="Send prompt">${icon('send')}</button></div>
        <div class="gb-hint">Current view is attached automatically · ⌘ Enter to send</div>
      </div>
      <div class="gb-camera glass" aria-label="Camera and selection controls">
        <button id="gb-select" title="Select an object in the course">${icon('cursor')}<span>Select</span></button><span class="gb-tool-rule"></span>
        <button id="gb-fly" title="Fly with WASD, drag to look">${icon('move')}<span>Fly</span></button>
        <button data-view="tee">Tee</button><button data-view="landing">Landing</button><button data-view="approach">Approach</button><button data-view="overview">Overview</button>
        <button data-view="address" title="Return to address">${icon('home')}<span>Address</span></button>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.promptEl = el.querySelector('#gb-prompt');
    this.buildBtn = el.querySelector('#gb-build');
    this.statusEl = el.querySelector('#gb-status');
    this.statusCopyEl = el.querySelector('.gb-status-copy');
    this.proposalEl = el.querySelector('#gb-proposal');
    this.cardsEl = el.querySelector('#gb-cards');
    this.summaryEl = el.querySelector('#gb-summary');
    this.undoBtn = el.querySelector('#gb-undo');
    this.redoBtn = el.querySelector('#gb-redo');
    this.contextEl = el.querySelector('#gb-context');
    this.selectBtn = el.querySelector('#gb-select');
    this.flyBtn = el.querySelector('#gb-fly');
    this.chatHistoryEl = el.querySelector('#gb-chat-history');
    this.actionHistoryEl = el.querySelector('#gb-action-history');
    this.buildBtn.addEventListener('click', () => this._submit());
    el.querySelector('#gb-apply').addEventListener('click', () => this._applySelected());
    this.undoBtn.addEventListener('click', () => this._historyAction('undo'));
    this.redoBtn.addEventListener('click', () => this._historyAction('redo'));
    const setSidebarOpen = (open) => {
      el.classList.toggle('sidebar-open', open);
      el.querySelector('#gb-side-tab').setAttribute('aria-expanded', String(open));
      el.querySelector('.gb-sidebar').setAttribute('aria-hidden', String(!open));
    };
    el.querySelector('#gb-side-tab').addEventListener('click', () => setSidebarOpen(true));
    el.querySelector('#gb-side-toggle').addEventListener('click', () => setSidebarOpen(false));
    const setMenuOpen = (open) => {
      el.classList.toggle('menu-open', open);
      el.querySelector('#gb-menu-trigger').setAttribute('aria-expanded', String(open));
      el.querySelector('#gb-destination-menu').setAttribute('aria-hidden', String(!open));
    };
    el.querySelector('#gb-menu-trigger').addEventListener('click', () => setMenuOpen(true));
    el.querySelector('#gb-menu-close').addEventListener('click', () => setMenuOpen(false));
    el.querySelector('#gb-destination-menu').addEventListener('click', (event) => { if (event.target.id === 'gb-destination-menu') setMenuOpen(false); });
    window.addEventListener('keydown', (event) => { if (event.code === 'Escape' && el.classList.contains('menu-open')) setMenuOpen(false); }, true);
    el.querySelector('#gb-new').addEventListener('click', () => this._newConversation());
    this.contextEl.querySelector('button').addEventListener('click', () => this._setSelection(null));
    this.selectBtn.addEventListener('click', () => this._toggleSelection());
    this.flyBtn.addEventListener('click', () => this._toggleFly());
    for (const button of el.querySelectorAll('[data-view]')) button.addEventListener('click', () => this._cameraView(button.dataset.view));
    this.promptEl.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') this._submit(); });
    this.promptEl.addEventListener('input', () => this._resizePrompt());
    this._canvasClick = (event) => this._selectAt(event);
    queueMicrotask(() => window.golf?.sm?.renderer?.domElement?.addEventListener('click', this._canvasClick));
  }

  async _loadState() {
    try {
      this.state = await api('/api/course-agent/state');
      this.proposal = [...(this.state.state?.proposals ?? [])].reverse().find((proposal) => proposal.items.some((item) => item.status === 'proposed')) ?? null;
      if (this.proposal) this._renderProposal();
      this._renderHistory();
      this._syncHistoryButtons();
      this._status('A fresh green is ready to shape.', 'ok');
    } catch (error) { this._status(`Course Creator is unavailable: ${error.message}`, 'err'); }
  }

  async _submit() {
    if (this.busy) return;
    const prompt = this.promptEl.value.trim();
    if (!prompt) return this._status('Describe what you would like to change.', 'err');
    if (this.revisingItem) return this._submitRevision(prompt);
    this._setBusy(true);
    this._status('Capturing the current course and review views…', 'working');
    try {
      const captures = await this._captureReviewViews();
      this._status('Designing individual course changes from your prompt…', 'working');
      const first = await api('/api/course-agent/propose', { prompt, captures, selection: this.selection });
      this.promptEl.value = '';
      this._resizePrompt();
      this.proposal = first.proposal;
      this.state = first.state;
      this._renderProposal();
      if (first.reviewRequested) {
        this._status('Rendering the proposal from the important playing angles…', 'working');
        const itemIds = this.proposal.items.map((item) => item.id);
        const preview = await api('/api/course-agent/preview', { proposalId: this.proposal.id, itemIds });
        await window.golf.previewCourse(preview.runtime);
        const reviewCaptures = await this._captureReviewViews();
        this._status('Reviewing the proposal for composition and playability…', 'working');
        const reviewed = await api('/api/course-agent/review', { proposalId: this.proposal.id, captures: reviewCaptures, selection: this.selection });
        this.proposal = reviewed.proposal;
        this.state = reviewed.state;
        this._renderProposal();
        await window.golf.clearCoursePreview();
      }
      this._status(`${this.proposal.items.length} course changes are ready for your review.`, 'ok');
    } catch (error) {
      try { await window.golf?.clearCoursePreview?.(); } catch { /* retain the original error */ }
      this._status(error.message, 'err');
    } finally { this._setBusy(false); }
  }

  async _submitRevision(prompt) {
    const item = this.revisingItem;
    this._setBusy(true);
    this._status(`Revising ${item.title} with the current view…`, 'working');
    try {
      const captures = await this._captureReviewViews({ compact: true });
      const data = await api('/api/course-agent/revise', { proposalId: this.proposal.id, itemId: item.id, prompt, captures, selection: this.selection });
      Object.assign(item, data.item);
      this.state = data.state;
      this.revisingItem = null;
      this.promptEl.value = '';
      this.promptEl.placeholder = 'Ask for anything you can imagine…';
      this._resizePrompt();
      this._renderProposal();
      this._status(`${item.title} has a new revision ready to preview.`, 'ok');
    } catch (error) { this._status(error.message, 'err'); }
    finally { this._setBusy(false); }
  }

  _renderProposal() {
    if (!this.proposal) return;
    this.summaryEl.textContent = this.proposal.summary;
    this.cardsEl.replaceChildren();
    for (const item of this.proposal.items) {
      const card = document.createElement('article');
      card.className = `gb-card ${item.status}`;
      card.dataset.itemId = item.id;
      const dependencies = item.dependencies.length ? `<p class="gb-deps">Includes ${item.dependencies.map(escapeHtml).join(', ')}</p>` : '';
      card.innerHTML = `<div class="gb-card-head"><input type="checkbox" ${item.status === 'proposed' ? 'checked' : 'disabled'} aria-label="Select ${escapeHtml(item.title)}"><div><h3>${escapeHtml(item.title)}</h3><span>${escapeHtml(item.mutation.entityType)} · ${escapeHtml(item.mutation.entityId)}</span></div></div><p>${escapeHtml(item.rationale)}</p>${dependencies}<div class="gb-card-actions"><button data-action="isolate">Preview</button><button data-action="revise">Revise</button><button data-action="reject">Reject</button></div>`;
      card.addEventListener('click', (event) => this._cardAction(event, item));
      this.cardsEl.appendChild(card);
    }
    this.proposalEl.classList.add('visible');
    this._renderHistory();
    this._syncHistoryButtons();
  }

  async _cardAction(event, item) {
    const action = event.target.closest('button')?.dataset.action;
    if (!action || this.busy) return;
    try {
      if (action === 'isolate') {
        this._status(`Previewing ${item.title} in the live course…`, 'working');
        const preview = await api('/api/course-agent/preview', { proposalId: this.proposal.id, itemIds: [item.id] });
        await window.golf.previewCourse(preview.runtime);
        this._status(`${item.title} is now isolated in the live preview.`, 'ok');
      } else if (action === 'reject') {
        const data = await api('/api/course-agent/reject', { proposalId: this.proposal.id, itemId: item.id });
        this.state = data.state;
        item.status = 'rejected';
        this._renderProposal();
        this._status(`${item.title} was removed from this proposal.`, 'ok');
      } else {
        this.revisingItem = item;
        this.promptEl.value = '';
        this.promptEl.placeholder = `How should ${item.title} change?`;
        this.promptEl.focus();
        this._status(`Describe the revision you want for ${item.title}.`, 'ok');
      }
    } catch (error) { this._status(error.message, 'err'); }
  }

  async _applySelected() {
    const itemIds = [...this.cardsEl.querySelectorAll('.gb-card input:checked')].map((input) => input.closest('.gb-card').dataset.itemId);
    if (!itemIds.length) return this._status('Select at least one proposed course object.', 'err');
    this._setBusy(true);
    this._status('Validating and applying the selected course objects…', 'working');
    const wasCanvas = window.golf?.creatorCanvasActive === true;
    try {
      window.golf?.beginCreatorApply?.();
      const data = await api('/api/course-agent/apply', { proposalId: this.proposal.id, itemIds });
      this.state = data.state;
      for (const { item } of data.applied) { const local = this.proposal.items.find((entry) => entry.id === item.id); if (local) local.status = 'applied'; }
      this._renderProposal();
      this._status(`${data.applied.length} course object${data.applied.length === 1 ? '' : 's'} applied successfully.`, 'ok');
    } catch (error) {
      if (wasCanvas) await window.golf?.showCreatorCanvas?.();
      this._status(error.message, 'err');
    }
    finally { this._setBusy(false); }
  }

  async _historyAction(action) {
    if (this.busy) return;
    this._setBusy(true);
    try {
      this.state = await api(`/api/course-agent/${action}`, {});
      this._renderHistory();
      this._status(action === 'undo' ? 'The last course change was undone.' : 'The course change was restored.', 'ok');
    } catch (error) { this._status(error.message, 'err'); }
    finally { this._setBusy(false); this._syncHistoryButtons(); }
  }

  _renderHistory() {
    const state = this.state?.state ?? this.state ?? {};
    const proposals = [...(state.proposals ?? [])].reverse();
    this.chatHistoryEl.innerHTML = proposals.length ? proposals.map((proposal) => `<button data-proposal="${escapeHtml(proposal.id)}"><strong>${escapeHtml(proposal.summary)}</strong><span>${formatDate(proposal.createdAt)}</span></button>`).join('') : '<p class="gb-empty">No conversations yet.</p>';
    this.chatHistoryEl.querySelectorAll('[data-proposal]').forEach((button) => button.addEventListener('click', () => {
      this.proposal = state.proposals.find((proposal) => proposal.id === button.dataset.proposal);
      this._renderProposal();
    }));
    const items = new Map((state.proposals ?? []).flatMap((proposal) => proposal.items.map((item) => [item.id, item])));
    const history = [...(state.history ?? [])].reverse();
    this.actionHistoryEl.innerHTML = history.length ? history.map((event) => {
      const item = items.get(event.itemId);
      const label = item?.title || event.itemId;
      return `<div class="gb-action-row ${event.undoneAt ? 'undone' : ''}"><span>${icon(event.kind === 'apply' ? 'check' : 'close')}</span><div><strong>${escapeHtml(label)}</strong><small>${event.kind === 'apply' ? (event.undoneAt ? 'Undone' : 'Applied') : 'Rejected'} · ${formatDate(event.createdAt)}</small></div></div>`;
    }).join('') : '<p class="gb-empty">Applied changes will appear here.</p>';
  }

  async _newConversation() {
    this.proposal = null;
    this.revisingItem = null;
    this.promptEl.value = '';
    this.promptEl.placeholder = 'Ask for anything you can imagine…';
    this.proposalEl.classList.remove('visible');
    this.el.classList.remove('sidebar-open');
    this._setSelection(null);
    this._status('Generating a fresh green…', 'working');
    try {
      await window.golf?.showCreatorCanvas?.({ reroll: true });
      this._status('A fresh green is ready to shape.', 'ok');
    } catch (error) { this._status(error.message, 'err'); }
  }

  _toggleSelection() {
    this.selecting = !this.selecting;
    const golf = window.golf;
    if (this.selecting) {
      if (golf?.evaluatorCamera?.active) golf.evaluatorCamera.exit({ restore: false });
      if (golf?.freeCam?.active) golf.freeCam.exit();
    }
    this.selectBtn.classList.toggle('active', this.selecting);
    this.selectBtn.querySelector('span').textContent = this.selecting ? 'Pick object' : 'Select';
    const canvas = golf?.sm?.renderer?.domElement;
    if (canvas) canvas.style.cursor = this.selecting ? 'crosshair' : '';
    this._status(this.selecting ? 'Click an object or surface in the course to attach it.' : 'Object selection is off.', 'ok');
  }

  _selectAt(event) {
    if (!this.selecting || document.body.dataset.view !== 'creator') return;
    const golf = window.golf;
    const canvas = golf?.sm?.renderer?.domElement;
    const terrain = golf?.range?.terrain;
    if (!canvas || !terrain?.mesh) return;
    const rect = canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, golf.sm.camera);
    // Terrain is a nested GPU clipmap Group. Recurse into its static ring meshes;
    // the resulting x/z is then resolved against the authoritative CPU heightfield.
    const hit = this.raycaster.intersectObject(terrain.mesh, true)[0];
    if (!hit) return this._status('Nothing editable was found at that point.', 'err');
    const x = hit.point.x, z = hit.point.z;
    const surface = terrain.surfaceAt(x, z);
    const selected = golf.creatorCanvasActive
      ? { entityType: 'terrain', entityId: `creator-showcase-${surface}`, label: surface === 'green' ? 'Generated green' : 'Generated fringe', point: { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }, surface, biome: 'temperate-maritime' }
      : selectCourseContext(this.state?.project, x, z, { surface, biome: terrain.classifyBiomeAt(x, z) });
    this._setSelection(selected);
    this.selecting = false;
    this.selectBtn.classList.remove('active');
    this.selectBtn.querySelector('span').textContent = 'Select';
    canvas.style.cursor = '';
    this._status(`${selected.label} is attached to your next prompt.`, 'ok');
  }

  _setSelection(selection) {
    this.selection = selection;
    this.contextEl.classList.toggle('visible', Boolean(selection));
    this.contextEl.querySelector('span').textContent = selection ? `${selection.label} · ${selection.point.x}, ${selection.point.z}` : '';
  }

  _toggleFly() {
    const golf = window.golf;
    if (!golf?.freeCam) return;
    if (golf.evaluatorCamera?.active) golf.evaluatorCamera.exit({ restore: false });
    golf.freeCam.toggle();
    this.flyBtn.classList.toggle('active', golf.freeCam.active);
    this._status(golf.freeCam.active ? 'Fly mode is active: use WASD, drag to look, Space to rise, and Control to descend.' : 'Fly mode is off.', 'ok');
  }

  async _cameraView(view) {
    const golf = window.golf;
    if (!golf) return;
    if (view === 'address') {
      if (golf.creatorCanvasActive) return this._cameraView('overview');
      if (golf.evaluatorCamera?.active) golf.evaluatorCamera.exit({ restore: false });
      if (golf.freeCam?.active) golf.freeCam.exit();
      golf.toAddress?.();
      this.flyBtn.classList.remove('active');
      return this._status('The camera is back at address.', 'ok');
    }
    const pose = this._reviewPoses().find(([label]) => label === view);
    if (!pose) return;
    if (golf.freeCam?.active) golf.freeCam.exit();
    if (golf.evaluatorCamera.active) golf.evaluatorCamera.exit({ restore: false });
    golf.evaluatorCamera.enter();
    golf.evaluatorCamera.unfreeze();
    golf.evaluatorCamera.setPose({ position: pose[1], lookAt: pose[2], fov: pose[3] });
    await golf.evaluatorCamera.settle(2);
    this.flyBtn.classList.remove('active');
    this._status(`Showing the ${view} view of the active hole.`, 'ok');
  }

  _reviewPoses() {
    const golf = window.golf;
    const course = this.getCourse();
    const tee = course?.tee;
    const green = course?.greens?.at(-1);
    if (!golf?.range?.terrain) return [];
    const ground = (x, z, lift) => [x, golf.range.terrain.heightAt(x, z) + lift, z];
    if (golf.creatorCanvasActive && green) {
      const outline = golf.range.creatorCanvasOutline || green.shape;
      const span = Math.max(18, ...outline.map((point) => Math.hypot(point.x - green.x, point.z - green.z)) * 2);
      const target = ground(green.x, green.z, 0.2);
      const overview = golf.creatorCanvasPose?.();
      return [
        ['tee', ground(green.x, green.z + span * 1.1, 5.6), target, 38],
        ['landing', ground(green.x + span * 1.1, green.z, 8), target, 38],
        ['approach', ground(green.x, green.z - span * 1.1, 5.6), target, 38],
        ['overview', overview?.position || ground(green.x + span, green.z + span, span * .75), overview?.lookAt || target, overview?.fov || 24],
      ];
    }
    if (!tee || !green) return [];
    const dx = green.x - tee.x, dz = green.z - tee.z;
    const length = Math.max(1, Math.hypot(dx, dz));
    const ux = dx / length, uz = dz / length;
    return [
      ['tee', ground(tee.x - ux * 6, tee.z - uz * 6, 2.1), ground(green.x, green.z, 1), 48],
      ['landing', ground(tee.x + dx * .55 - uz * 12, tee.z + dz * .55 + ux * 12, 5), ground(green.x, green.z, 1), 48],
      ['approach', ground(green.x - ux * 48, green.z - uz * 48, 3.2), ground(green.x, green.z, .4), 48],
      ['overview', ground((tee.x + green.x) * .5, (tee.z + green.z) * .5, Math.max(70, length * .34)), ground((tee.x + green.x) * .5, (tee.z + green.z) * .5, 0), 58],
    ];
  }

  async _captureReviewViews({ compact = false } = {}) {
    const golf = window.golf;
    const canvas = golf?.sm?.renderer?.domElement;
    const evaluator = golf?.evaluatorCamera;
    if (!canvas || !evaluator) throw new Error('The WebGPU review camera is not ready.');
    const capture = (label) => ({ label, dataUrl: canvas.toDataURL('image/webp', compact ? 0.66 : 0.78), camera: evaluator.getState() });
    const captures = [capture('current')];
    if (compact) return captures;
    const poses = this._reviewPoses();
    if (!poses.length) return captures;
    const alreadyActive = evaluator.active;
    const startingState = evaluator.getState();
    evaluator.enter();
    const wasFrozen = evaluator.simulationFrozen;
    evaluator.freeze();
    try {
      for (const [label, position, lookAt, fov] of poses) {
        evaluator.setPose({ position, lookAt, fov });
        await evaluator.settle(5);
        captures.push(capture(label));
      }
    } finally {
      if (alreadyActive) {
        evaluator.setPose({ position: startingState.position, quaternion: startingState.quaternion, fov: startingState.fov });
        evaluator.setSimulationFrozen(wasFrozen);
      } else evaluator.exit();
    }
    return captures;
  }

  onCourseReloaded() { if (!this.busy) this._status('The course rebuilt from your accepted changes.', 'ok'); }
  onCourseReloadFailed(error) { this._setBusy(false); this._status(`The course could not be rebuilt: ${error?.message || error}`, 'err'); }
  _resizePrompt() { this.promptEl.style.height = 'auto'; this.promptEl.style.height = `${Math.min(150, this.promptEl.scrollHeight)}px`; }
  _setBusy(value) {
    this.busy = value;
    this.el.classList.toggle('busy', value);
    this.buildBtn.disabled = value;
    for (const button of this.el.querySelectorAll('.gb-card-actions button, #gb-apply')) button.disabled = value;
  }
  _status(message, kind = '') { this.statusEl.className = `gb-status ${kind}`; this.statusCopyEl.textContent = sentence(message); }
  _syncHistoryButtons() {
    const state = this.state?.state ?? this.state ?? {};
    this.undoBtn.disabled = !(state.history ?? []).some((event) => event.kind === 'apply' && !event.undoneAt);
    this.redoBtn.disabled = !(state.redo ?? []).length;
  }
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Creator request failed (${response.status})`);
  return data;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function sentence(value) { const text = String(value || '').trim(); return text && !/[.!?…]$/.test(text) ? `${text}.` : text; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }

function icon(name) {
  const paths = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>', arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    sidebar: '<path d="M4 5h16v14H4zM9 5v14"/>', plus: '<path d="M12 5v14M5 12h14"/>', chevron: '<path d="m9 7 5 5-5 5"/>',
    undo: '<path d="M9 7 4 12l5 5M5 12h7a6 6 0 0 1 6 6"/>', redo: '<path d="m15 7 5 5-5 5M19 12h-7a6 6 0 0 0-6 6"/>',
    send: '<path d="m5 12 14-7-4 14-3-6-7-1Z"/><path d="m12 13 7-8"/>', close: '<path d="m7 7 10 10M17 7 7 17"/>',
    cursor: '<path d="m6 3 12 10-6 1-3 6L6 3Z"/>', move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M18 9l3 3-3 3M9 18l3 3 3-3M6 9l-3 3 3 3"/>',
    home: '<path d="m4 11 8-7 8 7v9h-6v-6h-4v6H4v-9Z"/>', check: '<path d="m5 12 4 4L19 6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
}

const styles = `
  #gb-panel{--glass:rgba(18,24,22,.43);--glass-hi:rgba(255,255,255,.12);--line:rgba(255,255,255,.19);--text:#f7f8f4;--muted:rgba(240,244,238,.66);--accent:#d6bb83;position:fixed;inset:0;z-index:45;display:none;pointer-events:none;color:var(--text);font-family:var(--sans);text-shadow:0 1px 16px rgba(0,0,0,.28)}
  body[data-view="creator"] #gb-panel{display:block}#gb-panel *{box-sizing:border-box}#gb-panel button,#gb-panel a,#gb-panel textarea,#gb-panel summary{pointer-events:auto}#gb-panel button,#gb-panel textarea{font-family:inherit;color:inherit}#gb-panel button{cursor:pointer}.glass{background:linear-gradient(145deg,rgba(255,255,255,.13),rgba(14,22,20,.36) 48%,rgba(8,14,13,.52));border:1px solid var(--line);box-shadow:0 18px 55px rgba(0,0,0,.22),inset 0 1px 0 var(--glass-hi);backdrop-filter:blur(22px) saturate(1.28);-webkit-backdrop-filter:blur(22px) saturate(1.28)}
  #gb-panel svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  .gb-menu-trigger{position:absolute;top:16px;right:16px;width:44px;height:44px;padding:0;border-radius:14px;display:grid;place-items:center;color:#fff}.gb-menu-trigger:hover,.gb-menu-trigger[aria-expanded="true"]{background:rgba(255,255,255,.19)}
  .gb-destination-menu{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;padding:clamp(22px,4vw,58px);background:linear-gradient(145deg,rgba(7,13,11,.76),rgba(10,16,14,.58));backdrop-filter:blur(32px) saturate(.9);-webkit-backdrop-filter:blur(32px) saturate(.9);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .24s ease,visibility .24s}.menu-open .gb-destination-menu{opacity:1;visibility:visible;pointer-events:auto}.gb-menu-head{display:flex;align-items:center;justify-content:space-between}.gb-menu-brand{color:#fff;text-decoration:none;font:700 12px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase}.gb-menu-close{width:46px;height:46px;border:1px solid rgba(255,255,255,.2);border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.08)}.gb-menu-close:hover{background:rgba(255,255,255,.16)}.gb-destination-list{width:min(920px,88vw);margin:auto;display:flex;flex-direction:column}.gb-destination-list>a{display:grid;grid-template-columns:54px 1fr 42px;align-items:center;gap:16px;padding:clamp(18px,3vh,31px) 4px;border-bottom:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.7);text-decoration:none;transition:color .18s,padding .18s}.gb-destination-list>a:first-child{border-top:1px solid rgba(255,255,255,.18)}.gb-destination-list>a:hover,.gb-destination-list>a[aria-current="page"]{color:#fff;padding-left:14px}.gb-destination-list>a>span:nth-child(2){display:flex;align-items:baseline;justify-content:space-between;gap:28px}.gb-destination-list strong{font:500 clamp(30px,5vw,64px)/1 var(--serif)}.gb-destination-list small{color:rgba(255,255,255,.5);font-size:12px}.gb-destination-number{font-size:10px;letter-spacing:.15em;color:var(--accent)}.gb-destination-list svg{justify-self:end;width:24px!important;height:24px!important}.gb-menu-foot{margin:0;text-align:center;color:rgba(255,255,255,.46);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
  .gb-side-tab{position:absolute;left:0;top:82px;width:44px;height:52px;border-left:0;border-radius:0 15px 15px 0;display:grid;place-items:center;transition:opacity .2s,transform .28s cubic-bezier(.2,.7,.2,1)}.gb-side-tab:hover{background:rgba(255,255,255,.18)}.sidebar-open .gb-side-tab{opacity:0;transform:translateX(-100%);pointer-events:none}
  .gb-sidebar{position:absolute;left:14px;top:14px;bottom:14px;width:292px;border-radius:20px;display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateX(calc(-100% - 24px));transition:opacity .22s,transform .28s cubic-bezier(.2,.7,.2,1)}.sidebar-open .gb-sidebar{opacity:1;transform:translateX(0)}.gb-side-head{height:52px;display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid rgba(255,255,255,.1)}.gb-side-title{font:650 13px/1 var(--sans);white-space:nowrap}.gb-icon{width:36px;height:36px;border:0;border-radius:10px;display:grid;place-items:center;background:transparent}.gb-icon:hover{background:rgba(255,255,255,.1)}.gb-new{margin-left:auto}.gb-side-content{flex:1;overflow:auto;padding:12px 10px}.gb-side-content details+details{margin-top:10px}.gb-side-content summary{list-style:none;display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:9px;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.04em}.gb-side-content summary::-webkit-details-marker{display:none}.gb-side-content summary svg{width:14px;height:14px;transition:transform .2s}.gb-side-content details[open] summary svg{transform:rotate(90deg)}.gb-history-list{padding:3px}.gb-history-list>button{display:block;width:100%;border:0;background:transparent;text-align:left;border-radius:10px;padding:9px;color:var(--text)}.gb-history-list>button:hover{background:rgba(255,255,255,.09)}.gb-history-list strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550}.gb-history-list span,.gb-history-list small{display:block;color:var(--muted);font-size:10px;margin-top:4px}.gb-empty{color:var(--muted);font-size:11px;padding:4px 9px}.gb-action-row{display:flex;gap:8px;padding:8px 7px}.gb-action-row>span{color:#b8d8ad}.gb-action-row>span svg{width:14px;height:14px}.gb-action-row>div{min-width:0}.gb-action-row.undone{opacity:.45}.gb-side-footer{padding:8px;border-top:1px solid rgba(255,255,255,.1)}.gb-history-action{display:flex;align-items:center;gap:10px;width:100%;padding:9px;border:0;border-radius:9px;background:transparent;text-align:left;font-size:11px}.gb-history-action:hover{background:rgba(255,255,255,.09)}.gb-history-action:disabled{opacity:.3;cursor:default}.gb-history-action svg{width:15px;height:15px}
  .gb-thread{position:absolute;left:50%;bottom:151px;transform:translateX(-50%);width:min(720px,calc(100vw - 260px));max-height:calc(100vh - 245px);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;pointer-events:none}.gb-proposal{display:none;width:100%;max-height:44vh;padding:14px;border-radius:20px;overflow:auto;pointer-events:auto}.gb-proposal.visible{display:block}.gb-summary{margin:2px 4px 12px;font-size:14px;line-height:1.45}.gb-card{border-top:1px solid rgba(255,255,255,.13);padding:13px 4px 11px}.gb-card-head{display:flex;gap:10px;align-items:flex-start}.gb-card input{margin-top:3px;accent-color:var(--accent)}.gb-card h3{margin:0;font-size:13px;font-weight:650}.gb-card h3+span{display:block;margin-top:4px;color:var(--accent);font-size:9px;letter-spacing:.08em;text-transform:uppercase}.gb-card>p{margin:8px 0 0 24px;color:var(--muted);font-size:11.5px;line-height:1.4}.gb-card.rejected{opacity:.42}.gb-card.applied{opacity:.72}.gb-deps{color:var(--accent)!important}.gb-card-actions{display:flex;gap:4px;margin:9px 0 0 20px}.gb-card-actions button{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);border-radius:8px;padding:6px 9px;font-size:10px}.gb-card-actions button:hover{background:rgba(255,255,255,.13)}.gb-proposal-footer{position:sticky;bottom:-14px;margin:10px -14px -14px;padding:10px 14px 14px;background:linear-gradient(transparent,rgba(10,16,15,.84) 34%)}.gb-primary{width:100%;border:0;border-radius:11px;padding:11px;background:rgba(214,187,131,.92);color:#1f1a10!important;font-size:12px;font-weight:700}
  .gb-compose-wrap{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:min(720px,calc(100vw - 260px));pointer-events:none}.gb-status{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 auto 8px;width:max-content;max-width:100%;padding:6px 11px;border-radius:999px;background:rgba(8,13,12,.34);backdrop-filter:blur(12px);color:rgba(255,255,255,.82);font-size:11px;line-height:1.3}.gb-state-dot{width:6px;height:6px;border-radius:50%;background:#9bc58d;box-shadow:0 0 9px rgba(155,197,141,.7)}.gb-status.working .gb-state-dot{background:var(--accent);animation:gbPulse 1s infinite alternate}.gb-status.err .gb-state-dot{background:#ef8d76}.gb-status-copy{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gb-context{display:none;pointer-events:auto;width:max-content;max-width:100%;margin:0 0 7px 12px;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.17);background:rgba(15,23,20,.56);border-radius:10px;padding:6px 7px 6px 10px;font-size:10px}.gb-context.visible{display:flex}.gb-context span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gb-context button{border:0;background:transparent;display:grid;place-items:center;padding:1px}.gb-context svg{width:13px!important;height:13px!important}.gb-composer{pointer-events:auto;border-radius:20px;padding:8px 8px 8px 16px;display:flex;align-items:flex-end;gap:8px}.gb-composer textarea{flex:1;min-height:40px;max-height:150px;resize:none;border:0;outline:0;background:transparent;padding:10px 0;font:450 15px/20px var(--sans);text-shadow:none}.gb-composer textarea::placeholder{color:rgba(255,255,255,.55)}.gb-send{flex:0 0 42px;width:42px;height:42px;border:0;border-radius:14px;display:grid;place-items:center;background:rgba(244,245,238,.91);color:#162019!important;box-shadow:0 7px 20px rgba(0,0,0,.2)}.gb-send:hover{transform:translateY(-1px)}.gb-send:disabled{opacity:.5}.busy .gb-send svg{animation:gbSpin 1s linear infinite}.gb-hint{text-align:center;margin-top:7px;color:rgba(255,255,255,.5);font-size:9px;letter-spacing:.02em}
  .gb-camera{position:absolute;right:14px;bottom:18px;width:106px;padding:6px;border-radius:17px;display:flex;flex-direction:column;gap:2px}.gb-camera button{min-height:34px;border:0;border-radius:10px;background:transparent;color:var(--muted);font-size:10px;font-weight:600}.gb-camera button:hover,.gb-camera button.active{background:rgba(255,255,255,.13);color:#fff}.gb-camera button:has(svg){display:flex;align-items:center;justify-content:center;gap:6px}.gb-camera svg{width:14px!important;height:14px!important}.gb-tool-rule{height:1px;background:rgba(255,255,255,.12);margin:3px 5px}
  @keyframes gbPulse{to{opacity:.35}}@keyframes gbSpin{to{transform:rotate(360deg)}}
  @media(max-width:900px){.gb-thread,.gb-compose-wrap{width:calc(100vw - 146px);left:16px;transform:none}.gb-sidebar{right:14px;width:auto;max-width:292px}.gb-camera{width:92px}.gb-hint{display:none}.gb-destination-list>a>span:nth-child(2){display:block}.gb-destination-list small{display:block;margin-top:7px}}
  @media(prefers-reduced-motion:reduce){#gb-panel *,#gb-panel *::before,#gb-panel *::after{animation:none!important;transition:none!important}}
`;
