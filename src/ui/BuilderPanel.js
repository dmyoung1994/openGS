import { TreeBuilderPanel } from './TreeBuilderPanel.js';
import { Raycaster, Vector2, Vector3 } from 'three';
import { selectCourseContext } from '../course/CourseSelection.js';

const ROUTE_EPSILON = 1e-6;

function routeSegments(points) {
  const segments = [];
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length <= ROUTE_EPSILON) continue;
    segments.push({ from, to, index, start: distance, end: distance + length, length, tangent: { x: dx / length, z: dz / length } });
    distance += length;
  }
  return { segments, length: distance };
}

function sampleRoute(metrics, requestedDistance) {
  const distance = Math.max(0, Math.min(metrics.length, requestedDistance));
  const segment = metrics.segments.find((entry) => distance <= entry.end + ROUTE_EPSILON) ?? metrics.segments.at(-1);
  if (!segment) return null;
  const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
  return {
    point: {
      x: segment.from.x + (segment.to.x - segment.from.x) * t,
      z: segment.from.z + (segment.to.z - segment.from.z) * t,
    },
    tangent: segment.tangent,
    distance,
  };
}

function routeDecision(metrics, par) {
  const fraction = par <= 3 ? 0.72 : par >= 5 ? 0.44 : 0.55;
  const nominalDistance = Math.min(metrics.length * fraction, par <= 3 ? metrics.length * 0.82 : 215);
  let best = null;
  for (let index = 1; index < metrics.segments.length; index += 1) {
    const incoming = metrics.segments[index - 1];
    const outgoing = metrics.segments[index];
    const distance = outgoing.start;
    if (distance < metrics.length * 0.18 || distance > metrics.length * 0.78) continue;
    const dot = Math.max(-1, Math.min(1, incoming.tangent.x * outgoing.tangent.x + incoming.tangent.z * outgoing.tangent.z));
    const turn = Math.acos(dot);
    if (turn < Math.PI / 24) continue;
    const proximityWindow = Math.max(90, metrics.length * 0.25);
    if (Math.abs(distance - nominalDistance) > proximityWindow) continue;
    const score = turn * 80 - Math.abs(distance - nominalDistance) * 0.35;
    if (!best || score > best.score) {
      const tx = incoming.tangent.x + outgoing.tangent.x;
      const tz = incoming.tangent.z + outgoing.tangent.z;
      const tangentLength = Math.hypot(tx, tz);
      const cross = incoming.tangent.x * outgoing.tangent.z - incoming.tangent.z * outgoing.tangent.x;
      best = {
        point: { x: outgoing.from.x, z: outgoing.from.z },
        tangent: tangentLength > ROUTE_EPSILON ? { x: tx / tangentLength, z: tz / tangentLength } : outgoing.tangent,
        distance,
        outside: cross < 0 ? -1 : 1,
        score,
      };
    }
  }
  return best ?? { ...sampleRoute(metrics, nominalDistance), outside: 1 };
}

// Pure route analysis kept separate from terrain sampling so dogleg/decision framing
// can be regression-tested without booting a renderer. Returned points remain in the
// compiled shared-site coordinate system.
export function deriveRouteReviewPlan(points, { par = 4 } = {}) {
  const clean = (points ?? []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z));
  const metrics = routeSegments(clean);
  if (!metrics.segments.length) return null;
  const decision = routeDecision(metrics, par);
  const tee = sampleRoute(metrics, 0);
  const teeTarget = sampleRoute(metrics, Math.min(metrics.length, Math.max(decision.distance + 35, metrics.length * 0.3)));
  // A review camera belongs before the decision it explains. Standing directly
  // inside the landing zone made a correctly placed drive bunker appear beside a
  // tee-like patch in the foreground and hid its carry relationship.
  const landingVantage = sampleRoute(metrics, Math.max(
    0,
    decision.distance - Math.max(38, Math.min(55, metrics.length * 0.1)),
  ));
  const landingTarget = sampleRoute(metrics, Math.min(metrics.length, decision.distance + Math.max(55, Math.min(110, metrics.length * 0.2))));
  const secondDecision = par >= 5
    ? sampleRoute(metrics, Math.min(metrics.length * 0.78, Math.max(decision.distance + 95, metrics.length * 0.66)))
    : null;
  const secondDecisionTarget = secondDecision
    ? sampleRoute(metrics, Math.min(metrics.length, secondDecision.distance + Math.max(50, metrics.length * 0.12)))
    : null;
  const approach = sampleRoute(metrics, Math.max(0, metrics.length - 48));
  const green = sampleRoute(metrics, metrics.length);
  const xs = clean.map((point) => point.x);
  const zs = clean.map((point) => point.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  return {
    length: metrics.length,
    tee,
    teeTarget,
    decision,
    landingVantage,
    landingTarget,
    secondDecision,
    secondDecisionTarget,
    approach,
    green,
    overview: {
      point: { x: (minX + maxX) * 0.5, z: (minZ + maxZ) * 0.5 },
      span: Math.max(maxX - minX, maxZ - minZ, 1),
    },
  };
}

// Course Creator chrome. The WebGPU world remains the primary surface; this class
// adds only translucent navigation, history, camera/context tools, and the prompt.
export class BuilderPanel {
  constructor({ getCourse, readOnlyReason = null } = {}) {
    this.getCourse = getCourse || (() => null);
    this.readOnlyReason = readOnlyReason;
    this.busy = false;
    this.proposal = null;
    this.state = null;
    this.selection = null;
    this.selecting = false;
    this.revisingItem = null;
    this.liveBuildId = null;
    this.liveRevision = null;
    this.liveRenderRevision = null;
    this.liveObservationReady = false;
    this.liveObservationSequence = 0;
    this.liveRenderGeneration = 0;
    this.liveObservationQueue = Promise.resolve();
    this.liveBrowserErrors = [];
    this.pendingQuestion = null;
    this.questionSelectedOptionId = null;
    this.questionPresentationRestore = null;
    this.treePresentationFrame = null;
    this.treePresentationPoint = new Vector3();
    this.raycaster = new Raycaster();
    this.pointer = new Vector2();
    window.addEventListener('error', (event) => this._rememberBrowserError(event.message || 'Browser error'));
    window.addEventListener('unhandledrejection', (event) => this._rememberBrowserError(event.reason?.message || String(event.reason || 'Unhandled rejection')));
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
          <a href="/range.html"><span class="gb-destination-number">01</span><span><strong>Practice</strong><small>Practice and tune your game</small></span>${icon('arrow')}</a>
          <a href="/play.html"><span class="gb-destination-number">02</span><span><strong>Play</strong><small>Choose a course from your catalog</small></span>${icon('arrow')}</a>
          <a href="/creator.html" aria-current="page"><span class="gb-destination-number">03</span><span><strong>Create</strong><small>Build a course from an idea</small></span>${icon('arrow')}</a>
        </nav>
        <p class="gb-menu-foot">Choose where you want to go</p>
      </div>
      <div class="gb-tree-labels" id="gb-tree-labels" aria-label="Tree comparison options"></div>
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
        <div class="gb-build-progress glass" id="gb-build-progress" aria-hidden="true"><div><span id="gb-build-stage">Preparing build…</span><strong id="gb-build-count"></strong></div><div class="gb-build-track"><i></i></div></div>
        <div class="gb-proposal glass" id="gb-proposal"><p class="gb-summary" id="gb-summary"></p><div id="gb-cards"></div><div class="gb-proposal-footer"><button class="gb-primary" id="gb-apply">Apply selected</button></div></div>
      </section>
      <div class="gb-compose-wrap">
        <section class="gb-status-panel glass" id="gb-status-panel" aria-label="Course Creator status and prompt">
          <button type="button" class="gb-status" id="gb-status" aria-expanded="false" aria-controls="gb-status-details" aria-label="Show recent Course Creator activity"><span class="gb-state-dot"></span><span class="gb-status-copy">A fresh green is ready to shape.</span><span class="gb-status-chevron">${icon('chevron')}</span></button>
          <div class="gb-status-details" id="gb-status-details" aria-hidden="true"><ol class="gb-update-timeline" id="gb-update-timeline"></ol><div class="gb-question" id="gb-question"></div></div>
          <div class="gb-context" id="gb-context"><span></span><button aria-label="Clear selected context">${icon('close')}</button></div>
          <div class="gb-composer"><textarea id="gb-prompt" rows="1" placeholder="Ask for anything you can imagine…" aria-label="Course design prompt"></textarea><button class="gb-send" id="gb-build" aria-label="Send prompt">${icon('send')}</button></div>
        </section>
        <div class="gb-hint">Current view is attached automatically · ⌘ Enter to send</div>
      </div>
      <div class="gb-camera glass" aria-label="Camera and selection controls">
        <div class="gb-holes" id="gb-holes" aria-label="Active course hole"></div>
        <button id="gb-select" title="Select an object in the course">${icon('cursor')}<span>Select</span></button><span class="gb-tool-rule"></span>
        <button id="gb-fly" title="Fly with WASD, drag to look">${icon('move')}<span>Fly</span></button>
        <button data-view="tee">Tee</button><button data-view="landing">Landing</button><button data-view="approach">Approach</button><button data-view="overview">Overview</button>
        <button data-view="address" title="Return to address">${icon('home')}<span>Address</span></button>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.plantBuilder = new TreeBuilderPanel(this);
    this.promptEl = el.querySelector('#gb-prompt');
    this.buildBtn = el.querySelector('#gb-build');
    this.statusEl = el.querySelector('#gb-status');
    this.statusCopyEl = el.querySelector('.gb-status-copy');
    this.proposalEl = el.querySelector('#gb-proposal');
    this.progressEl = el.querySelector('#gb-build-progress');
    this.progressStageEl = el.querySelector('#gb-build-stage');
    this.progressCountEl = el.querySelector('#gb-build-count');
    this.cardsEl = el.querySelector('#gb-cards');
    this.summaryEl = el.querySelector('#gb-summary');
    this.undoBtn = el.querySelector('#gb-undo');
    this.redoBtn = el.querySelector('#gb-redo');
    this.contextEl = el.querySelector('#gb-context');
    this.selectBtn = el.querySelector('#gb-select');
    this.flyBtn = el.querySelector('#gb-fly');
    this.chatHistoryEl = el.querySelector('#gb-chat-history');
    this.actionHistoryEl = el.querySelector('#gb-action-history');
    this.holesEl = el.querySelector('#gb-holes');
    this.statusPanelEl = el.querySelector('#gb-status-panel');
    this.statusDetailsEl = el.querySelector('#gb-status-details');
    this.updateTimelineEl = el.querySelector('#gb-update-timeline');
    this.questionEl = el.querySelector('#gb-question');
    this.treeLabelsEl = el.querySelector('#gb-tree-labels');
    this.buildBtn.addEventListener('click', () => this._submit());
    this.statusEl.addEventListener('click', () => this._setStatusOpen(!this.statusPanelEl.classList.contains('open')));
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
    queueMicrotask(() => {
      window.golf?.sm?.renderer?.domElement?.addEventListener('click', this._canvasClick);
      this._syncHoleButtons();
    });
    if (this.readOnlyReason) {
      for (const region of el.querySelectorAll('.gb-sidebar, .gb-thread, .gb-composer, #gb-question')) region.inert = true;
      el.querySelector('#gb-side-tab').hidden = true;
      el.querySelector('.gb-hint').textContent = this.readOnlyReason;
      this.promptEl.placeholder = 'Read-only photo study';
      this.promptEl.disabled = this.buildBtn.disabled = true;
    }
  }

  async _loadState() {
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
    try {
      this.state = await api('/api/course-agent/state');
      this.proposal = [...(this.state.state?.proposals ?? [])].reverse().find((proposal) => proposal.items.some((item) => item.status === 'proposed')) ?? null;
      if (this.proposal) this._renderProposal();
      this._renderHistory();
      this._syncHistoryButtons();
      if (this.state.pendingLiveBuild) {
        this._renderQuestion(this.state.pendingLiveBuild);
        this._status('Codex is waiting for your design decision.', 'ok');
      } else this._status('A fresh green is ready to shape.', 'ok');
    } catch (error) { this._status(`Course Creator is unavailable: ${error.message}`, 'err'); }
  }

  async _submit() {
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
    if (this.busy) return;
    if (this.pendingQuestion) {
      this._setStatusOpen(true);
      return this._status('Choose one of the pending design options, or use Other, to continue this build.', 'err');
    }
    const prompt = this.promptEl.value.trim();
    if (!prompt) return this._status('Describe what you would like to change.', 'err');
    if (this.revisingItem) return this._submitRevision(prompt);
    this.liveBuildId = `course-live-${crypto.randomUUID()}`;
    this.liveRevision = null;
    this.liveRenderRevision = null;
    this.liveObservationReady = false;
    this.liveObservationSequence = 0;
    this.liveRenderGeneration = 0;
    this.liveObservationQueue = Promise.resolve();
    this.liveBrowserErrors = [];
    this._setBusy(true);
    this._status('Capturing the current course and review views…', 'working');
    try {
      const captures = await this._captureReviewViews();
      this.promptEl.value = '';
      this._resizePrompt();
      this.proposal = null;
      this.proposalEl.classList.remove('visible');
      window.golf?.beginCreatorApply?.();
      await window.golf?.showAuthoredCreatorCourse?.();
      this._liveProgress('Codex is entering the live workspace…', 'working');
      const result = await streamApi('/api/course-agent/build/live', {
        prompt, captures, selection: this.selection, clientBuildId: this.liveBuildId,
      }, (event) => this._liveEvent(event));
      this._liveProgress('Live build complete', 'complete');
      if (result.state) {
        this.state = result.state;
        this._renderHistory();
        this._syncHistoryButtons();
      }
      if (result.awaitingInput && result.question) this._renderQuestion(result.question);
      this._status(result.message || 'The live course build is complete.', 'ok');
    } catch (error) {
      this._liveProgress('Live build stopped', 'error');
      this._status(error.message, 'err');
    } finally {
      await this.liveObservationQueue.catch(() => {});
      if (!this.pendingQuestion) {
        this.liveBuildId = null;
        this.liveObservationReady = false;
      }
      this._setBusy(false);
    }
  }

  _liveEvent(event) {
    if (event?.type === 'observation') {
      if (event.clientBuildId !== this.liveBuildId) return;
      this.liveObservationReady = true;
      this.liveRevision = event.revision ?? this.liveRevision;
      this.liveRenderRevision = event.renderRevision ?? this.liveRenderRevision;
    }
    if (event?.type === 'review-request' && event.clientBuildId === this.liveBuildId) {
      this._queueLiveObservation({
        revision: event.revision ?? this.liveRevision,
        renderRevision: event.renderRevision ?? this.liveRenderRevision,
        phase: 'final-review',
        summary: 'Complete final tee, decision, approach, and overview tour.',
        full: true,
      });
    }
    if (event?.type === 'control-request' && event.clientBuildId === this.liveBuildId) {
      this._queueAgentControl(event);
    }
    if (event?.type === 'question') this._renderQuestion(event);
    if (!event?.message) return;
    const isProblem = event.type === 'fatal' || event.type === 'warning';
    const kind = isProblem ? 'err' : event.type === 'done' ? 'ok' : 'working';
    this._status(event.message, kind);
    this._liveProgress(event.message, event.type === 'fatal' ? 'error' : event.type === 'done' ? 'complete' : 'working');
  }

  _setStatusOpen(open) {
    const expanded = this.pendingQuestion ? true : open;
    this.statusPanelEl.classList.toggle('open', expanded);
    this.statusEl.setAttribute('aria-expanded', String(expanded));
    this.statusDetailsEl.setAttribute('aria-hidden', String(!expanded));
    if (expanded) this.updateTimelineEl.scrollTop = this.updateTimelineEl.scrollHeight;
  }

  _appendUpdate(message, kind = '') {
    if (!this.updateTimelineEl || !message) return;
    const item = document.createElement('li');
    item.className = kind || 'ok';
    const copy = document.createElement('span');
    copy.textContent = sentence(message);
    const time = document.createElement('time');
    time.dateTime = new Date().toISOString();
    time.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    item.append(copy, time);
    this.updateTimelineEl.appendChild(item);
    while (this.updateTimelineEl.children.length > 80) this.updateTimelineEl.firstElementChild.remove();
    if (this.statusPanelEl.classList.contains('open')) this.updateTimelineEl.scrollTop = this.updateTimelineEl.scrollHeight;
  }

  _renderQuestion(pending) {
    this.pendingQuestion = pending || null;
    this.questionSelectedOptionId = null;
    this.questionEl.replaceChildren();
    if (!pending) {
      this._clearQuestionPresentation();
      this.questionEl.classList.remove('visible');
      this._setStatusOpen(false);
      return;
    }
    const question = pending.question;
    this.liveBuildId = pending.clientBuildId;
    this.liveRevision = pending.revision;
    this.liveObservationReady = false;
    const heading = document.createElement('h3');
    heading.textContent = question.prompt;
    const recommendation = document.createElement('p');
    recommendation.className = 'gb-question-recommendation';
    recommendation.textContent = `Recommended · ${question.recommendation.reason}`;
    const options = document.createElement('div');
    options.className = 'gb-question-options';
    for (const option of question.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gb-question-option';
      if (option.id === question.recommendation.optionId) button.classList.add('recommended');
      button.innerHTML = `<span><strong>${escapeHtml(option.label)}</strong>${option.id === question.recommendation.optionId ? '<em>Recommended</em>' : ''}</span><small>${escapeHtml(option.description)}</small>`;
      button.dataset.optionId = option.id;
      button.addEventListener('click', () => this._selectQuestionOption(option.id));
      options.appendChild(button);
    }
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'gb-question-confirm';
    confirm.textContent = 'Continue';
    confirm.disabled = true;
    confirm.addEventListener('click', () => this._submitQuestionAnswer(this.questionSelectedOptionId));
    const other = document.createElement('div');
    other.className = 'gb-question-other';
    other.innerHTML = '<label for="gb-question-other-copy">Other</label><div><textarea id="gb-question-other-copy" rows="2" maxlength="2000" placeholder="Describe the direction you want…"></textarea><button type="button">Continue</button></div>';
    other.querySelector('button').addEventListener('click', () => this._submitQuestionAnswer('other', other.querySelector('textarea').value));
    this.questionEl.append(heading, recommendation, options, confirm, other);
    this.questionEl.classList.add('visible');
    this._setStatusOpen(true);
    if (question.presentation) this._stageQuestionPresentation(question.presentation);
  }

  _selectQuestionOption(optionId) {
    if (!this.pendingQuestion?.question.options.some((option) => option.id === optionId)) return;
    this.questionSelectedOptionId = optionId;
    for (const button of this.questionEl.querySelectorAll('.gb-question-option')) {
      button.classList.toggle('selected', button.dataset.optionId === optionId);
    }
    const confirm = this.questionEl.querySelector('.gb-question-confirm');
    if (confirm) confirm.disabled = false;
    for (const label of this.treeLabelsEl.querySelectorAll('button')) {
      label.classList.toggle('selected', label.dataset.optionId === optionId);
    }
  }

  async _submitQuestionAnswer(optionId, answer = null) {
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
    if (this.busy || !this.pendingQuestion) return;
    if (!optionId) return this._status('Select an option before continuing.', 'err');
    if (optionId === 'other' && !String(answer ?? '').trim()) return this._status('Describe the other direction before continuing.', 'err');
    const pending = this.pendingQuestion;
    this.liveBuildId = pending.clientBuildId;
    this.liveRevision = pending.revision;
    this.liveRenderRevision = null;
    this.liveObservationReady = false;
    this.liveObservationSequence = 0;
    this.liveRenderGeneration = 0;
    this.liveObservationQueue = Promise.resolve();
    this._setBusy(true);
    this._status('Sending your design decision back to the same Codex build…', 'working');
    try {
      await this._clearQuestionPresentation();
      window.golf?.beginCreatorApply?.();
      await window.golf?.showAuthoredCreatorCourse?.();
      const result = await streamApi('/api/course-agent/build/answer', {
        clientBuildId: pending.clientBuildId,
        questionId: pending.questionId,
        revision: pending.revision,
        optionId,
        ...(optionId === 'other' ? { answer: String(answer).trim() } : {}),
      }, (event) => this._liveEvent(event));
      if (result.state) {
        this.state = result.state;
        this._renderHistory();
        this._syncHistoryButtons();
      }
      if (result.awaitingInput && result.question) this._renderQuestion(result.question);
      else this._renderQuestion(null);
      this._liveProgress(result.awaitingInput ? 'Waiting for your answer' : 'Live build complete', result.awaitingInput ? 'working' : 'complete');
      this._status(result.message || (result.awaitingInput ? 'Codex needs another design decision.' : 'The live course build is complete.'), 'ok');
    } catch (error) {
      this._liveProgress('Live build stopped', 'error');
      this._status(error.message, 'err');
    } finally {
      await this.liveObservationQueue.catch(() => {});
      if (!this.pendingQuestion) {
        this.liveBuildId = null;
        this.liveObservationReady = false;
      }
      this._setBusy(false);
    }
  }

  async _submitRevision(prompt) {
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
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
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
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
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
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
      this._progress({ label: 'Applied to course', index: 1, total: 1, state: 'complete' });
      this._status(`${data.applied.length} course object${data.applied.length === 1 ? '' : 's'} applied successfully.`, 'ok');
    } catch (error) {
      if (wasCanvas) await window.golf?.showCreatorCanvas?.();
      this._status(error.message, 'err');
    }
    finally { this._setBusy(false); }
  }

  async _historyAction(action) {
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
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
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
    this.proposal = null;
    this.revisingItem = null;
    this.promptEl.value = '';
    this.promptEl.placeholder = 'Ask for anything you can imagine…';
    this.proposalEl.classList.remove('visible');
    this.el.classList.remove('sidebar-open');
    this._setSelection(null);
    this._status('Generating a fresh green…', 'working');
    try {
      await api('/api/course-agent/build/reset', {});
      this._renderQuestion(null);
      this.liveBuildId = null;
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

  _reviewPoses(hole = window.golf?.range?.activeHole?.()) {
    const golf = window.golf;
    const course = this.getCourse();
    const tee = hole?.tees?.[0] ?? course?.tee;
    const green = hole
      ? course?.greens?.[hole.greenStart]
      : course?.greens?.at(-1);
    if (!golf?.range?.terrain) return [];
    const ground = (x, z, lift) => [x, golf.range.terrain.heightAt(x, z) + lift, z];
    if (golf.creatorCanvasActive && green) {
      const outline = golf.range.creatorCanvasOutline || green.shape;
      const span = Math.max(18, ...outline.map((point) => Math.hypot(point.x - green.x, point.z - green.z) * 2));
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
    const routePoints = hole?.route?.points?.length >= 2 ? hole.route.points : [tee, green];
    const route = deriveRouteReviewPlan(routePoints, { par: hole?.par ?? 4 });
    if (!route) return [];
    const teeTangent = route.tee.tangent;
    const decisionSide = { x: -route.decision.tangent.z * route.decision.outside, z: route.decision.tangent.x * route.decision.outside };
    const approachSide = { x: -route.approach.tangent.z, z: route.approach.tangent.x };
    const activePoses = [
      ['tee', ground(tee.x - teeTangent.x * 6, tee.z - teeTangent.z * 6, 2.1), ground(route.teeTarget.point.x, route.teeTarget.point.z, 1), 48],
      ['landing', ground(route.landingVantage.point.x + decisionSide.x * 8, route.landingVantage.point.z + decisionSide.z * 8, 4.2), ground(route.landingTarget.point.x, route.landingTarget.point.z, 1), 48],
      ['approach', ground(route.approach.point.x + approachSide.x * 4, route.approach.point.z + approachSide.z * 4, 3.2), ground(green.x, green.z, .4), 48],
    ];
    if (route.secondDecision && route.secondDecisionTarget) {
      const layupSide = { x: -route.secondDecision.tangent.z, z: route.secondDecision.tangent.x };
      activePoses.splice(2, 0, [
        'layup',
        ground(route.secondDecision.point.x + layupSide.x * 10, route.secondDecision.point.z + layupSide.z * 10, 4.2),
        ground(route.secondDecisionTarget.point.x, route.secondDecisionTarget.point.z, 1),
        48,
      ]);
    }
    const overviewLift = Math.max(70, route.overview.span * .72, route.length * .26);
    activePoses.push(['overview', ground(route.overview.point.x, route.overview.point.z, overviewLift), ground(route.overview.point.x, route.overview.point.z, 0), course.routing ? 52 : 58]);
    return activePoses;
  }

  _captureAgentSceneState() {
    const golf = window.golf;
    const evaluator = golf?.evaluatorCamera;
    return {
      holeId: golf?.range?.activeHoleId ?? null,
      evaluatorActive: evaluator?.active === true,
      evaluatorFrozen: evaluator?.simulationFrozen === true,
      camera: evaluator?.getState?.() ?? null,
    };
  }

  async _restoreAgentSceneState(state) {
    const golf = window.golf;
    const evaluator = golf?.evaluatorCamera;
    if (!golf || !evaluator || !state) return;
    if (state.holeId && golf.range?.routing && golf.range.activeHoleId !== state.holeId) golf.selectHole(state.holeId);
    if (state.evaluatorActive && state.camera) {
      if (!evaluator.active) evaluator.enter();
      evaluator.setPose({ position: state.camera.position, quaternion: state.camera.quaternion, fov: state.camera.fov });
      evaluator.setSimulationFrozen(state.evaluatorFrozen);
      await evaluator.settle(2);
    } else if (evaluator.active) evaluator.exit();
  }

  async _loadTreePresentation(presentation) {
    const candidates = await Promise.all(presentation.candidates.map(async (candidate) => candidate.source === 'procedural'
      ? { ...candidate, definition: await fetch(candidate.definitionUrl).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${candidate.definitionUrl} (${response.status}).`);
        return response.json();
      }) }
      : candidate));
    return window.golf?.range?.presentTreeCandidates?.(candidates, { anchor: presentation.anchor });
  }

  async _stageQuestionPresentation(presentation) {
    await this._clearQuestionPresentation();
    const golf = window.golf;
    if (!golf?.range?.presentTreeCandidates || !golf?.evaluatorCamera) {
      this._status('The tree comparison could not open because the production scene is not ready.', 'err');
      return;
    }
    const restore = this._captureAgentSceneState();
    this.questionPresentationRestore = restore;
    try {
      if (presentation.holeId && golf.range?.routing && golf.range.activeHoleId !== presentation.holeId) golf.selectHole(presentation.holeId);
      const layout = await this._loadTreePresentation(presentation);
      if (!layout) throw new Error('The production tree renderer returned no comparison layout.');
      const evaluator = golf.evaluatorCamera;
      if (!evaluator.active) evaluator.enter();
      evaluator.freeze();
      const ground = golf.range.terrain.heightAt(layout.center.x, layout.center.z);
      evaluator.setPose({
        position: [layout.center.x + layout.span * 0.9, ground + Math.max(9, layout.span * 0.55), layout.center.z + layout.span * 1.25],
        lookAt: [layout.center.x, ground + Math.max(4, layout.height * 0.42), layout.center.z],
        fov: 42,
      });
      await evaluator.settle(5);
      this._showTreePresentationLabels(layout.anchors);
      this._status('Tree options are staged in the course. Click a scene label or option, then Continue.', 'ok');
    } catch (error) {
      await this._clearQuestionPresentation();
      this._status(`Tree comparison failed closed: ${error.message}`, 'err');
    }
  }

  async _clearQuestionPresentation() {
    const restore = this.questionPresentationRestore;
    this.questionPresentationRestore = null;
    this._hideTreePresentationLabels();
    await window.golf?.range?.clearTreeCandidates?.();
    if (restore) await this._restoreAgentSceneState(restore);
  }

  _showTreePresentationLabels(anchors = []) {
    this._hideTreePresentationLabels();
    for (const anchor of anchors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.optionId = anchor.optionId;
      button.setAttribute('aria-label', `Select ${anchor.label}`);
      button.innerHTML = `<strong>${escapeHtml(anchor.letter)}</strong><span>${escapeHtml(anchor.label)}</span>`;
      button.addEventListener('click', () => this._selectQuestionOption(anchor.optionId));
      button._worldPosition = anchor.worldPosition;
      this.treeLabelsEl.appendChild(button);
    }
    const update = () => {
      const golf = window.golf;
      const canvas = golf?.sm?.renderer?.domElement;
      const camera = golf?.sm?.camera;
      if (!this.treeLabelsEl.childElementCount || !canvas || !camera) {
        this.treePresentationFrame = null;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      for (const button of this.treeLabelsEl.children) {
        const point = button._worldPosition;
        this.treePresentationPoint.set(point.x, point.y, point.z).project(camera);
        const visible = this.treePresentationPoint.z >= -1 && this.treePresentationPoint.z <= 1
          && Math.abs(this.treePresentationPoint.x) <= 1.15 && Math.abs(this.treePresentationPoint.y) <= 1.15;
        button.hidden = !visible;
        if (!visible) continue;
        button.style.left = `${Math.round(rect.left + (this.treePresentationPoint.x * 0.5 + 0.5) * rect.width)}px`;
        button.style.top = `${Math.round(rect.top + (-this.treePresentationPoint.y * 0.5 + 0.5) * rect.height)}px`;
      }
      this.treePresentationFrame = requestAnimationFrame(update);
    };
    update();
  }

  _hideTreePresentationLabels() {
    if (this.treePresentationFrame !== null) cancelAnimationFrame(this.treePresentationFrame);
    this.treePresentationFrame = null;
    this.treeLabelsEl?.replaceChildren();
  }

  _queueAgentControl(event) {
    this.liveObservationQueue = this.liveObservationQueue.catch(() => {}).then(() => this._executeAgentControl(event)).catch((error) => {
      this._status(`Scene control failed: ${error.message}`, 'err');
      return null;
    });
  }

  async _executeAgentControl(event) {
    if (this.readOnlyReason) return this._status(this.readOnlyReason);
    const golf = window.golf;
    if (!golf?.evaluatorCamera || !golf?.range) throw new Error('The production course scene is not ready.');
    const restore = this._captureAgentSceneState();
    let captureMode = 'none';
    try {
      for (const action of event.control.actions) {
        if (action.type === 'select-hole' && action.holeId !== golf.range.activeHoleId) golf.selectHole(action.holeId);
        if (action.type === 'clear-preview') await golf.range.clearTreeCandidates?.();
        if (action.type === 'present-trees') await this._loadTreePresentation(action.presentation);
        if (action.type === 'set-view') await this._setAgentView(action);
        if (action.capture === 'review' || (action.capture === 'current' && captureMode === 'none')) captureMode = action.capture;
      }
      const captures = captureMode === 'review' ? await this._captureReviewViews({ checkpoint: true })
        : captureMode === 'current' ? [this._captureCurrentView('agent-control')] : [];
      const sequence = ++this.liveObservationSequence;
      const renderGeneration = ++this.liveRenderGeneration;
      return await api('/api/course-agent/build/observation', {
        clientBuildId: this.liveBuildId,
        controlRequestId: event.control.id,
        sequence,
        renderGeneration,
        revision: event.revision ?? this.liveRevision,
        renderRevision: event.renderRevision ?? this.liveRenderRevision,
        phase: 'agent-control',
        summary: event.message || 'Agent-requested production scene evidence.',
        activeHoleId: golf.range.activeHoleId ?? null,
        diagnostics: this._liveDiagnostics(),
        captures: captures.slice(0, 8),
      });
    } finally {
      await golf.range.clearTreeCandidates?.();
      await this._restoreAgentSceneState(restore);
    }
  }

  async _setAgentView(action) {
    if (action.view === 'current') return;
    const golf = window.golf;
    const evaluator = golf.evaluatorCamera;
    if (golf.freeCam?.active) golf.freeCam.exit();
    if (!evaluator.active) evaluator.enter();
    evaluator.freeze();
    if (action.view === 'point') {
      const y = golf.range.terrain.heightAt(action.point.x, action.point.z);
      evaluator.setPose({ position: [action.point.x + 20, y + 13, action.point.z + 20], lookAt: [action.point.x, y + 1, action.point.z], fov: 42 });
    } else {
      const pose = this._reviewPoses().find(([label]) => label === action.view);
      if (!pose) throw new Error(`No ${action.view} view exists for the active hole.`);
      evaluator.setPose({ position: pose[1], lookAt: pose[2], fov: pose[3] });
    }
    await evaluator.settle(5);
  }

  _captureCurrentView(label = 'current') {
    const golf = window.golf;
    const canvas = golf?.sm?.renderer?.domElement;
    if (!canvas) throw new Error('The WebGPU canvas is not ready.');
    return {
      label,
      holeId: golf.range?.activeHoleId ?? null,
      dataUrl: canvas.toDataURL('image/webp', 0.7),
      camera: golf.evaluatorCamera?.getState?.() ?? null,
    };
  }

  async _captureReviewViews({ compact = false, checkpoint = false } = {}) {
    const golf = window.golf;
    const canvas = golf?.sm?.renderer?.domElement;
    const evaluator = golf?.evaluatorCamera;
    if (!canvas || !evaluator) throw new Error('The WebGPU review camera is not ready.');
    const capture = (label) => {
      const activeHoleId = golf.range?.activeHoleId ?? null;
      return {
        label, holeId: activeHoleId, activeHoleId,
        dataUrl: canvas.toDataURL('image/webp', compact || checkpoint ? 0.66 : 0.78),
        camera: evaluator.getState(),
      };
    };
    const captures = [capture('current')];
    if (compact) return captures;
    let poses = this._reviewPoses();
    if (!poses.length) return captures;
    const routedHoles = golf.range?.routingHoles ?? [];
    const startingHoleId = golf.range?.activeHoleId ?? null;
    if (routedHoles.length > 1) {
      poses = routedHoles.flatMap((hole) => this._reviewPoses(hole)
          .filter(([label]) => checkpoint
            ? label === (hole.par <= 3 ? 'tee' : 'landing') || (label === 'overview' && hole.holeId === startingHoleId)
            : label !== 'overview' || hole.holeId === startingHoleId)
          .map(([label, ...pose]) => [`hole-${hole.number}-${label}`, ...pose, { holeId: hole.holeId }]));
    } else if (checkpoint) {
      poses = poses.filter(([label]) => label === 'landing' || label === 'overview');
    }
    const alreadyActive = evaluator.active;
    const startingState = evaluator.getState();
    evaluator.enter();
    const wasFrozen = evaluator.simulationFrozen;
    evaluator.freeze();
    try {
      for (const [label, position, lookAt, fov, context] of poses) {
        if (captures.length >= 8) break;
        if (context?.holeId) golf.selectHole(context.holeId);
        evaluator.setPose({ position, lookAt, fov });
        await evaluator.settle(5);
        captures.push(capture(label));
      }
    } finally {
      let restoreError = null;
      try {
        if (startingHoleId && golf.range?.routing && golf.range.activeHoleId !== startingHoleId) golf.selectHole(startingHoleId);
      } catch (error) { restoreError = error; }
      try {
        if (alreadyActive) {
          evaluator.setPose({ position: startingState.position, quaternion: startingState.quaternion, fov: startingState.fov });
          evaluator.setSimulationFrozen(wasFrozen);
        } else evaluator.exit();
      } catch (error) { restoreError ??= error; }
      if (restoreError) throw restoreError;
    }
    return captures;
  }

  _rememberBrowserError(message) {
    const text = sentence(message).slice(0, 240);
    if (!text) return;
    this.liveBrowserErrors.push({ at: new Date().toISOString(), message: text });
    if (this.liveBrowserErrors.length > 8) this.liveBrowserErrors.shift();
  }

  _liveDiagnostics() {
    const golf = window.golf;
    const bootstrap = window.golfBootstrap;
    const renderer = golf?.sm?.renderer;
    const backend = renderer?.backend;
    const canvas = renderer?.domElement;
    const course = this.getCourse();
    return {
      page: {
        pathname: location.pathname, title: document.title,
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      },
      bootstrap: {
        ready: bootstrap?.ready === true, stage: bootstrap?.stage ?? null,
        error: bootstrap?.diagnostics?.error ?? null,
      },
      renderer: {
        webgpuRenderer: renderer?.isWebGPURenderer === true,
        webgpuBackend: backend?.isWebGPUBackend === true,
        webglBackend: backend?.isWebGLBackend === true,
        fallbackAdapter: backend?.isFallbackAdapter === true,
      },
      scene: {
        course: course?.meta?.name ?? null,
        activeHoleId: golf?.range?.activeHoleId ?? null,
        holeCount: golf?.range?.routingHoles?.length ?? 1,
        environmentObjects: countEnvironmentObjects(course?.environment),
      },
      browser: { errorCount: this.liveBrowserErrors.length, recentErrors: this.liveBrowserErrors },
    };
  }

  _queueLiveObservation({
    revision = null, renderRevision = null, phase = 'runtime', summary = 'Rendered the latest course checkpoint.',
    compact = false, full = false, problem = false,
  } = {}) {
    if (!this.busy || !this.liveBuildId || !this.liveObservationReady) return Promise.resolve(null);
    if (revision) this.liveRevision = revision;
    const sequence = ++this.liveObservationSequence;
    const renderGeneration = ++this.liveRenderGeneration;
    const checkpoint = {
      sequence, renderGeneration, revision: revision ?? this.liveRevision,
      renderRevision, phase, summary, compact, full, problem,
    };
    this.liveObservationQueue = this.liveObservationQueue.catch(() => {}).then(async () => {
      if (!this.liveBuildId || !this.liveObservationReady) return null;
      this._status(`Capturing live render checkpoint ${sequence}…`, 'working');
      const captures = await this._captureReviewViews(compact ? { compact: true } : full ? {} : { checkpoint: true });
      const observation = await api('/api/course-agent/build/observation', {
        clientBuildId: this.liveBuildId,
        sequence,
        renderGeneration,
        ...(checkpoint.revision ? { revision: checkpoint.revision } : {}),
        ...(checkpoint.renderRevision ? { renderRevision: checkpoint.renderRevision } : {}),
        phase,
        summary,
        activeHoleId: window.golf?.range?.activeHoleId ?? null,
        diagnostics: this._liveDiagnostics(),
        captures,
      });
      this.liveRevision = observation.revision;
      this.liveRenderRevision = observation.renderRevision;
      this._status(problem ? summary : observation.message, problem ? 'err' : 'working');
      this._liveProgress(problem ? summary : observation.message, problem ? 'error' : 'working');
      return observation;
    }).catch((error) => {
      this._status(`Live visual checkpoint ${sequence} was not published: ${error.message}`, 'err');
      return null;
    });
    return this.liveObservationQueue;
  }

  onCourseReloaded(_course, checkpoint = {}) {
    this._syncHoleButtons();
    if (this.busy) {
      const revision = checkpoint?.projectRevision ?? checkpoint?.revision ?? null;
      const renderRevision = checkpoint?.renderRevision ?? null;
      if (!revision || !renderRevision) {
        this._status('The scene rebuilt, but its project/runtime revision could not be verified; the visual checkpoint was skipped.', 'err');
        return;
      }
      this._queueLiveObservation({
        revision,
        renderRevision,
        phase: 'course-runtime',
        summary: 'Compiled course geometry is live in the persistent WebGPU scene.',
      });
    } else this._status('The course rebuilt from your accepted changes.', 'ok');
  }

  onSceneCheckpoint(checkpoint = {}) {
    return this._queueLiveObservation({
      revision: checkpoint?.revision ?? this.liveRevision,
      phase: checkpoint?.kind ?? 'asset',
      summary: checkpoint?.summary ?? `Authored asset ${checkpoint?.path || 'update'} is live in the persistent WebGPU scene.`,
    });
  }
  onActiveHoleChanged(hole) {
    this._syncHoleButtons();
    if (hole) this._status(`Hole ${hole.number} · ${hole.name} is active.`, 'ok');
  }

  _syncHoleButtons() {
    if (!this.holesEl) return;
    const golf = window.golf;
    const holes = golf?.range?.routingHoles ?? [];
    this.holesEl.replaceChildren();
    this.holesEl.hidden = holes.length < 2;
    for (const hole of holes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `H${hole.number}`;
      button.title = `${hole.name} · Par ${hole.par}`;
      button.classList.toggle('active', hole.holeId === golf.range.activeHoleId);
      button.addEventListener('click', () => {
        try { golf.selectHole(hole.holeId); }
        catch (error) { this._status(error.message, 'err'); }
      });
      this.holesEl.appendChild(button);
    }
  }
  onCourseReloadFailed(error, checkpoint = {}) {
    const message = `The course could not be rebuilt: ${error?.message || error}`;
    this._rememberBrowserError(message);
    if (this.busy) {
      const revision = checkpoint?.projectRevision ?? checkpoint?.revision ?? this.liveRevision;
      this._queueLiveObservation({
        revision,
        renderRevision: checkpoint?.renderRevision ?? null,
        phase: 'render-failed',
        summary: message,
        compact: true,
        problem: true,
      });
      this._status(message, 'err');
      this._liveProgress(message, 'error');
      return;
    }
    this._setBusy(false);
    this._status(message, 'err');
  }
  _resizePrompt() { this.promptEl.style.height = 'auto'; this.promptEl.style.height = `${Math.min(150, this.promptEl.scrollHeight)}px`; }
  _progress({ label, index, total, state }) {
    const progress = Math.max(0, Math.min(1, total > 0 ? index / total : 0));
    this.progressEl.classList.add('visible');
    this.progressEl.dataset.state = state;
    this.progressEl.setAttribute('aria-hidden', 'false');
    this.progressStageEl.textContent = label;
    this.progressCountEl.textContent = `${Math.min(index + (state === 'building' ? 1 : 0), total)} / ${total}`;
    this.progressEl.querySelector('i').style.transform = `scaleX(${progress})`;
  }
  _liveProgress(label, state) {
    this.progressEl.classList.add('visible');
    this.progressEl.dataset.state = state;
    this.progressEl.setAttribute('aria-hidden', 'false');
    this.progressStageEl.textContent = label;
    this.progressCountEl.textContent = state === 'complete' ? 'DONE' : 'LIVE';
    this.progressEl.querySelector('i').style.transform = state === 'complete' ? 'scaleX(1)' : 'scaleX(.22)';
  }
  onAgentStatus({ message, kind } = {}) {
    if (!message) return;
    this._status(message, kind === 'error' || kind === 'warning' ? 'err' : this.busy ? 'working' : 'ok');
    if (this.busy) this._liveProgress(message, kind === 'error' ? 'error' : 'working');
  }
  _setBusy(value) {
    this.busy = value;
    this.el.classList.toggle('busy', value);
    this.buildBtn.disabled = value || Boolean(this.readOnlyReason);
    for (const button of this.el.querySelectorAll('.gb-card-actions button, #gb-apply, .gb-question button')) button.disabled = value || Boolean(this.readOnlyReason);
  }
  _status(message, kind = '') {
    const copy = sentence(message);
    this.statusEl.className = `gb-status ${kind}`;
    this.statusCopyEl.textContent = copy;
    this._appendUpdate(copy, kind);
  }
  _syncHistoryButtons() {
    const state = this.state?.state ?? this.state ?? {};
    this.undoBtn.disabled = Boolean(this.readOnlyReason) || !(state.history ?? []).some((event) => event.kind === 'apply' && !event.undoneAt);
    this.redoBtn.disabled = Boolean(this.readOnlyReason) || !(state.redo ?? []).length;
  }
}

function countEnvironmentObjects(environment) {
  if (!environment || typeof environment !== 'object') return 0;
  if (Number.isSafeInteger(environment.objectCount)) return environment.objectCount;
  return ['placements', 'scatter', 'assembly', 'edgeDressing']
    .reduce((total, key) => total + (Array.isArray(environment[key]) ? environment[key].length : 0), 0);
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Creator request failed (${response.status})`);
  return data;
}

async function streamApi(url, body, onEvent) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Creator stream failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', result = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      onEvent?.(event);
      if (event.type === 'fatal') throw new Error(event.message || 'Live course build failed');
      if (event.type === 'done') result = event;
    }
    if (done) break;
  }
  if (!result) throw new Error('Live course build ended without a completion event');
  return result;
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
  .gb-tree-labels{position:fixed;inset:0;z-index:8;pointer-events:none}.gb-tree-labels button{position:fixed;transform:translate(-50%,-100%);display:flex;align-items:center;gap:8px;min-height:34px;padding:6px 11px 6px 7px;border:1px solid rgba(240,210,147,.82);border-radius:9px;background:rgba(12,18,16,.92);box-shadow:0 5px 18px rgba(0,0,0,.3);color:#fff;text-shadow:none;white-space:nowrap;pointer-events:auto}.gb-tree-labels button strong{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:#d6bb83;color:#16130d;font-size:11px}.gb-tree-labels button span{font-size:11px;font-weight:650}.gb-tree-labels button:hover,.gb-tree-labels button.selected{border-color:#fff;background:rgba(48,57,34,.97);box-shadow:0 0 0 2px rgba(240,210,147,.35),0 7px 20px rgba(0,0,0,.34)}
  .gb-menu-trigger{position:absolute;top:16px;right:16px;width:44px;height:44px;padding:0;border-radius:14px;display:grid;place-items:center;color:#fff}.gb-menu-trigger:hover,.gb-menu-trigger[aria-expanded="true"]{background:rgba(255,255,255,.19)}
  .gb-destination-menu{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;padding:clamp(22px,4vw,58px);background:linear-gradient(145deg,rgba(7,13,11,.76),rgba(10,16,14,.58));backdrop-filter:blur(32px) saturate(.9);-webkit-backdrop-filter:blur(32px) saturate(.9);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .24s ease,visibility .24s}.menu-open .gb-destination-menu{opacity:1;visibility:visible;pointer-events:auto}.gb-menu-head{display:flex;align-items:center;justify-content:space-between}.gb-menu-brand{color:#fff;text-decoration:none;font:700 12px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase}.gb-menu-close{width:46px;height:46px;border:1px solid rgba(255,255,255,.2);border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.08)}.gb-menu-close:hover{background:rgba(255,255,255,.16)}.gb-destination-list{width:min(920px,88vw);margin:auto;display:flex;flex-direction:column}.gb-destination-list>a{display:grid;grid-template-columns:54px 1fr 42px;align-items:center;gap:16px;padding:clamp(18px,3vh,31px) 4px;border-bottom:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.7);text-decoration:none;transition:color .18s,padding .18s}.gb-destination-list>a:first-child{border-top:1px solid rgba(255,255,255,.18)}.gb-destination-list>a:hover,.gb-destination-list>a[aria-current="page"]{color:#fff;padding-left:14px}.gb-destination-list>a>span:nth-child(2){display:flex;align-items:baseline;justify-content:space-between;gap:28px}.gb-destination-list strong{font:500 clamp(30px,5vw,64px)/1 var(--serif)}.gb-destination-list small{color:rgba(255,255,255,.5);font-size:12px}.gb-destination-number{font-size:10px;letter-spacing:.15em;color:var(--accent)}.gb-destination-list svg{justify-self:end;width:24px!important;height:24px!important}.gb-menu-foot{margin:0;text-align:center;color:rgba(255,255,255,.46);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
  .gb-side-tab{position:absolute;left:0;top:82px;width:44px;height:52px;border-left:0;border-radius:0 15px 15px 0;display:grid;place-items:center;transition:opacity .2s,transform .28s cubic-bezier(.2,.7,.2,1)}.gb-side-tab:hover{background:rgba(255,255,255,.18)}.sidebar-open .gb-side-tab{opacity:0;transform:translateX(-100%);pointer-events:none}
  .gb-sidebar{position:absolute;left:14px;top:14px;bottom:14px;width:292px;border-radius:20px;display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateX(calc(-100% - 24px));transition:opacity .22s,transform .28s cubic-bezier(.2,.7,.2,1)}.sidebar-open .gb-sidebar{opacity:1;transform:translateX(0)}.gb-side-head{height:52px;display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid rgba(255,255,255,.1)}.gb-side-title{font:650 13px/1 var(--sans);white-space:nowrap}.gb-icon{width:36px;height:36px;border:0;border-radius:10px;display:grid;place-items:center;background:transparent}.gb-icon:hover{background:rgba(255,255,255,.1)}.gb-new{margin-left:auto}.gb-side-content{flex:1;overflow:auto;padding:12px 10px}.gb-side-content details+details{margin-top:10px}.gb-side-content summary{list-style:none;display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:9px;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.04em}.gb-side-content summary::-webkit-details-marker{display:none}.gb-side-content summary svg{width:14px;height:14px;transition:transform .2s}.gb-side-content details[open] summary svg{transform:rotate(90deg)}.gb-history-list{padding:3px}.gb-history-list>button{display:block;width:100%;border:0;background:transparent;text-align:left;border-radius:10px;padding:9px;color:var(--text)}.gb-history-list>button:hover{background:rgba(255,255,255,.09)}.gb-history-list strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550}.gb-history-list span,.gb-history-list small{display:block;color:var(--muted);font-size:10px;margin-top:4px}.gb-empty{color:var(--muted);font-size:11px;padding:4px 9px}.gb-action-row{display:flex;gap:8px;padding:8px 7px}.gb-action-row>span{color:#b8d8ad}.gb-action-row>span svg{width:14px;height:14px}.gb-action-row>div{min-width:0}.gb-action-row.undone{opacity:.45}.gb-side-footer{padding:8px;border-top:1px solid rgba(255,255,255,.1)}.gb-history-action{display:flex;align-items:center;gap:10px;width:100%;padding:9px;border:0;border-radius:9px;background:transparent;text-align:left;font-size:11px}.gb-history-action:hover{background:rgba(255,255,255,.09)}.gb-history-action:disabled{opacity:.3;cursor:default}.gb-history-action svg{width:15px;height:15px}
  .gb-thread{position:absolute;left:50%;bottom:151px;transform:translateX(-50%);width:min(720px,calc(100vw - 260px));max-height:calc(100vh - 245px);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;pointer-events:none}.gb-build-progress{display:none;width:100%;padding:10px 13px;border-radius:14px;pointer-events:none}.gb-build-progress.visible{display:block}.gb-build-progress>div:first-child{display:flex;justify-content:space-between;gap:16px;font-size:11px}.gb-build-progress strong{color:var(--accent);font-size:10px}.gb-build-track{height:3px;margin-top:8px;overflow:hidden;border-radius:99px;background:rgba(255,255,255,.13)}.gb-build-track i{display:block;width:100%;height:100%;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,#88ae79,var(--accent));transition:transform .45s ease}.gb-build-progress[data-state="building"] .gb-build-track i,.gb-build-progress[data-state="working"] .gb-build-track i{box-shadow:0 0 12px rgba(214,187,131,.65)}.gb-build-progress[data-state="working"] .gb-build-track i{animation:gbLiveBuild 1.5s ease-in-out infinite alternate}.gb-build-progress[data-state="error"] .gb-build-track i{background:#ef8d76}.gb-proposal{display:none;width:100%;max-height:44vh;padding:14px;border-radius:20px;overflow:auto;pointer-events:auto}.gb-proposal.visible{display:block}.gb-summary{margin:2px 4px 12px;font-size:14px;line-height:1.45}.gb-card{border-top:1px solid rgba(255,255,255,.13);padding:13px 4px 11px}.gb-card-head{display:flex;gap:10px;align-items:flex-start}.gb-card input{margin-top:3px;accent-color:var(--accent)}.gb-card h3{margin:0;font-size:13px;font-weight:650}.gb-card h3+span{display:block;margin-top:4px;color:var(--accent);font-size:9px;letter-spacing:.08em;text-transform:uppercase}.gb-card>p{margin:8px 0 0 24px;color:var(--muted);font-size:11.5px;line-height:1.4}.gb-card.rejected{opacity:.42}.gb-card.applied{opacity:.72}.gb-deps{color:var(--accent)!important}.gb-card-actions{display:flex;gap:4px;margin:9px 0 0 20px}.gb-card-actions button{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);border-radius:8px;padding:6px 9px;font-size:10px}.gb-card-actions button:hover{background:rgba(255,255,255,.13)}.gb-proposal-footer{position:sticky;bottom:-14px;margin:10px -14px -14px;padding:10px 14px 14px;background:linear-gradient(transparent,rgba(10,16,15,.84) 34%)}.gb-primary{width:100%;border:0;border-radius:11px;padding:11px;background:rgba(214,187,131,.92);color:#1f1a10!important;font-size:12px;font-weight:700}
  .gb-compose-wrap{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:min(720px,calc(100vw - 260px));pointer-events:none}.gb-status-panel{pointer-events:auto;display:flex;flex-direction:column;max-height:calc(100vh - 112px);overflow:hidden;border-radius:20px}.gb-status{flex:0 0 auto;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:8px 13px;border:0;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(8,13,12,.12);color:rgba(255,255,255,.82);font-size:11px;line-height:1.3;text-align:left}.gb-state-dot{flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:#9bc58d;box-shadow:0 0 9px rgba(155,197,141,.7)}.gb-status.working .gb-state-dot{background:var(--accent);animation:gbPulse 1s infinite alternate}.gb-status.err .gb-state-dot{background:#ef8d76}.gb-status-copy{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gb-status-chevron{display:grid;place-items:center;color:var(--muted)}.gb-status-chevron svg{width:13px!important;height:13px!important;transform:rotate(-90deg);transition:transform .2s}.gb-status-panel.open .gb-status-chevron svg{transform:rotate(90deg)}.gb-status-details{display:none;max-height:min(58vh,430px);overflow:auto;border-bottom:1px solid rgba(255,255,255,.1);background:rgba(8,13,12,.2)}.gb-status-panel.open .gb-status-details{display:block}.gb-update-timeline{max-height:118px;overflow:auto;list-style:none;margin:0;padding:7px 13px}.gb-status-panel:has(.gb-question.visible) .gb-update-timeline{max-height:74px}.gb-update-timeline li{position:relative;display:grid;grid-template-columns:1fr auto;gap:12px;padding:6px 0 6px 14px;color:var(--muted);font-size:10.5px;line-height:1.35;border-left:1px solid rgba(255,255,255,.13)}.gb-update-timeline li::before{content:'';position:absolute;left:-3px;top:10px;width:5px;height:5px;border-radius:50%;background:#9bc58d}.gb-update-timeline li.working::before{background:var(--accent)}.gb-update-timeline li.err::before{background:#ef8d76}.gb-update-timeline time{color:rgba(255,255,255,.36);font-size:9px;white-space:nowrap}.gb-question{display:none;padding:12px 14px 14px;border-top:1px solid rgba(255,255,255,.1)}.gb-question.visible{display:block}.gb-question h3{margin:0;font:500 17px/1.28 var(--serif)}.gb-question-recommendation{margin:6px 0 10px;color:var(--accent);font-size:10px;line-height:1.35}.gb-question-options{display:grid;gap:6px}.gb-question-option{width:100%;padding:9px 10px;border:1px solid rgba(255,255,255,.13);border-radius:10px;background:rgba(255,255,255,.055);text-align:left}.gb-question-option:hover,.gb-question-option.recommended{border-color:rgba(214,187,131,.55);background:rgba(214,187,131,.1)}.gb-question-option>span{display:flex;align-items:center;justify-content:space-between;gap:12px}.gb-question-option strong{font-size:11.5px}.gb-question-option em{color:var(--accent);font-size:8px;font-style:normal;letter-spacing:.08em;text-transform:uppercase}.gb-question-option small{display:block;margin-top:4px;color:var(--muted);font-size:10px;line-height:1.3}.gb-question-other{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.09)}.gb-question-other label{display:block;margin-bottom:6px;font-size:10px;font-weight:650}.gb-question-other>div{display:flex;align-items:flex-end;gap:7px}.gb-question-other textarea{flex:1;min-height:46px;padding:8px;border:1px solid rgba(255,255,255,.13);border-radius:9px;outline:0;resize:vertical;background:rgba(0,0,0,.16);font-size:10.5px}.gb-question-other button{padding:9px 11px;border:0;border-radius:9px;background:rgba(214,187,131,.9);color:#1f1a10!important;font-size:10px;font-weight:700}.gb-question button:disabled{opacity:.48;cursor:default}.gb-context{display:none;pointer-events:auto;width:max-content;max-width:calc(100% - 24px);margin:7px 12px 0;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.17);background:rgba(15,23,20,.42);border-radius:10px;padding:6px 7px 6px 10px;font-size:10px}.gb-context.visible{display:flex}.gb-context span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gb-context button{border:0;background:transparent;display:grid;place-items:center;padding:1px}.gb-context svg{width:13px!important;height:13px!important}.gb-composer{pointer-events:auto;flex:0 0 auto;padding:7px 8px 8px 16px;display:flex;align-items:flex-end;gap:8px}.gb-composer textarea{min-width:0;flex:1;min-height:40px;max-height:150px;resize:none;border:0;outline:0;background:transparent;padding:10px 0;font:450 15px/20px var(--sans);text-shadow:none}.gb-composer textarea::placeholder{color:rgba(255,255,255,.55)}.gb-send{flex:0 0 42px;width:42px;height:42px;border:0;border-radius:14px;display:grid;place-items:center;background:rgba(244,245,238,.91);color:#162019!important;box-shadow:0 7px 20px rgba(0,0,0,.2)}.gb-send:hover{transform:translateY(-1px)}.gb-send:disabled{opacity:.5}.busy .gb-send svg{animation:gbSpin 1s linear infinite}.gb-hint{text-align:center;margin-top:7px;color:rgba(255,255,255,.5);font-size:9px;letter-spacing:.02em}
  .gb-question-option.selected{border-color:#f0d293;background:rgba(214,187,131,.2);box-shadow:0 0 0 1px rgba(240,210,147,.34)}.gb-question-confirm{width:100%;margin-top:8px;padding:9px 11px;border:0;border-radius:9px;background:rgba(214,187,131,.9);color:#1f1a10!important;font-size:10px;font-weight:700}
  .gb-camera{position:absolute;right:14px;bottom:18px;max-height:calc(100dvh - 90px);overflow:auto;width:106px;padding:6px;border-radius:17px;display:flex;flex-direction:column;gap:2px}.gb-camera button{min-height:34px;border:0;border-radius:10px;background:transparent;color:var(--muted);font-size:10px;font-weight:600}.gb-camera button:hover,.gb-camera button.active{background:rgba(255,255,255,.13);color:#fff}.gb-camera button:has(svg){display:flex;align-items:center;justify-content:center;gap:6px}.gb-camera svg{width:14px!important;height:14px!important}.gb-tool-rule{height:1px;background:rgba(255,255,255,.12);margin:3px 5px}.gb-holes{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.12)}.gb-holes[hidden]{display:none}.gb-holes button{min-height:28px;padding:0}
  @keyframes gbPulse{to{opacity:.35}}@keyframes gbSpin{to{transform:rotate(360deg)}}@keyframes gbLiveBuild{from{opacity:.55}to{opacity:1;filter:saturate(1.35)}}
  @media(max-width:900px){.gb-thread,.gb-compose-wrap{width:calc(100vw - 146px);left:16px;transform:none}.gb-sidebar{right:14px;width:auto;max-width:292px}.gb-camera{width:92px}.gb-hint{display:none}.gb-destination-list>a>span:nth-child(2){display:block}.gb-destination-list small{display:block;margin-top:7px}}
  @media(prefers-reduced-motion:reduce){#gb-panel *,#gb-panel *::before,#gb-panel *::after{animation:none!important;transition:none!important}}
`;
