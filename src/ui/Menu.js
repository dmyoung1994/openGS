import { loadCourseLibrary } from '../course/CourseLibrary.js';
// The app shell + premium landing menu — "The Links". A light, airy, warm design
// (frosted glass over a soft hazy backdrop, high-contrast Didone serif, champagne
// gold accents) rebuilt to match the generated UI concepts in docs/ui-concepts/.
//
// Routes by setting document.body's `data-view` (menu|practice|creator|play); CSS
// shows/hides the right panels. The live 3D course renders behind and slowly orbits
// as the backdrop (see menuCinematic in main.js), softened here by a warm glass wash.
export class Menu {
  constructor({ onView, getStats } = {}) {
    this.onView = onView || (() => {});
    this.getStats = getStats || (() => ({}));
    this.view = 'menu';
    this._injectCSS();
    this._build();
    // ?view=practice (or creator / play) opens straight into that view instead of the
    // landing menu. Mainly so an offline capture can shoot the real course without
    // driving the shell — `node scripts/shot.mjs --game` relies on it — but it is also
    // just useful when you are iterating on the range and reloading all day.
    const wanted = new URL(window.location).searchParams.get('view');
    const routeView = ({ '/range.html': 'practice', '/creator.html': 'creator', '/play.html': 'play' })[window.location.pathname];
    const startPlay = routeView === 'play' && new URL(window.location).searchParams.get('start') === '1';
    this.setView(startPlay ? 'practice' : routeView ?? (['practice', 'creator', 'play'].includes(wanted) ? wanted : 'menu'));
    // Refresh the creator stats HUD a couple times a second while it's visible.
    setInterval(() => { if (this.view === 'creator') this._renderStats(); }, 500);
  }

  setView(v) {
    this.view = v;
    document.body.dataset.view = v;
    if (v === 'creator') this._renderStats();
    this.onView(v);
  }

  _build() {
    const menu = document.createElement('div');
    menu.id = 'gs-menu';
    menu.innerHTML = `
      <div class="gm-inner">
        <header class="gm-brand">
          <div class="gm-kicker">Rangeform</div>
          <h1 class="gm-title">The Links</h1>
          <p class="gm-tag">A quieter way to play.</p>
        </header>
        <nav class="gm-cards">
          ${this._card('practice', '01', 'Practice', 'Hit the range')}
          ${this._card('play', '02', 'Play', 'Choose a course')}
          ${this._card('creator', '03', 'Create', 'Design a course')}
        </nav>
        <footer class="gm-foot">Select an experience</footer>
      </div>`;
    document.body.appendChild(menu);
    menu.querySelectorAll('.gm-card').forEach((c) => c.addEventListener('click', () => this._navigate(c.dataset.go)));

    // Course-select (Play).
    const play = document.createElement('div');
    play.id = 'gs-play';
    play.innerHTML = `
      <button class="gm-back" data-back>‹ Menu</button>
      <div class="gp-inner">
        <div class="gp-kicker">Play</div>
        <h2 class="gp-title">Select a Course</h2>
        <div class="gp-grid" aria-live="polite">Loading saved courses…</div>
      </div>`;
    document.body.appendChild(play);
    // /play.html already owns the isolated PlayScene and loaded routed course. Enter
    // that live scene in place instead of navigating to the Range composition.
    this._loadCourses(play.querySelector('.gp-grid'));

    // Top-right utility stack. A flex column so in-scene chrome (Menu button, LIVE
    // PREVIEW tag, FPS meter) always stacks with even gaps and pushes down instead of
    // overlapping the left-hand Launch Monitor / Course Builder panels. main.js drops
    // the FPS meter in here too.
    const tr = document.createElement('div');
    tr.id = 'gs-topright';
    tr.innerHTML = `
      <button id="gs-menu-btn"><span class="gm-hb">≡</span> Menu</button>
      <div class="gc-live"><span class="gc-dot"></span>Live preview</div>`;
    document.body.appendChild(tr);
    this.topRight = tr;
    tr.querySelector('#gs-menu-btn').addEventListener('click', () => this._navigate('menu'));

    // Creator stats HUD (bottom-right).
    const hud = document.createElement('div');
    hud.id = 'gs-creator-hud';
    hud.innerHTML = `
      <div class="gc-stats">
        <div class="gc-stat"><span class="gc-sl">Objects</span><span class="gc-sv" id="gc-obj">—</span></div>
        <div class="gc-stat"><span class="gc-sl">FPS</span><span class="gc-sv" id="gc-fps">—</span></div>
        <div class="gc-stat"><span class="gc-sl">Status</span><span class="gc-sv" id="gc-status">Ready</span></div>
      </div>`;
    document.body.appendChild(hud);

    for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => this._navigate('menu'));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.view !== 'menu' && !e.target?.closest?.('textarea,input') && !document.querySelector('#gb-panel.menu-open')) this._navigate('menu');
    });
  }

  _navigate(view) {
    if (view === 'play') { this.setView('play'); return; }
    const path = { menu: '/', practice: '/range.html', creator: '/creator.html', play: '/play.html' }[view] ?? '/';
    window.location.assign(path);
  }

  async _loadCourses(grid) {
    try {
      const courses = await loadCourseLibrary();
      grid.replaceChildren();
      for (const course of courses) {
        const card = document.createElement('button');
        card.className = 'gp-card';
        card.dataset.course = course.id;
        card.innerHTML = '<div class="gp-body"><div class="gp-cname"></div><div class="gp-hr"></div><div class="gp-row"><span class="gp-cmeta"></span><span class="gp-play">Play ▸</span></div></div>';
        card.querySelector('.gp-cname').textContent = course.name;
        card.querySelector('.gp-cmeta').textContent = `${course.holes} ${course.holes === 1 ? 'hole' : 'holes'}`;
        card.addEventListener('click', () => {
          const current = new URL(window.location).searchParams.get('course') || 'current';
          if (window.location.pathname === '/play.html' && current === course.id) this.setView('practice');
          else window.location.assign(`/play.html?course=${encodeURIComponent(course.id)}&start=1`);
        });
        grid.appendChild(card);
      }
      if (!courses.length) grid.textContent = 'No saved courses yet. Create a course to get started.';
    } catch (error) {
      grid.textContent = error.message;
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => this._loadCourses(grid));
      grid.appendChild(retry);
    }
  }

  _card(go, num, title, sub) {
    return `
      <button class="gm-card" data-go="${go}">
        <span class="gm-num">${num}</span>
        <span class="gm-ct">${title}</span>
        <span class="gm-cs">${sub}</span>
        <span class="gm-go">Enter →</span>
      </button>`;
  }

  // Set the selected course card thumbnail to a live render of the actual course.
  setCourseThumb(url) {
    if (this.thumbEl && url) this.thumbEl.style.setProperty('--img', `url(${url})`);
  }

  _renderStats() {
    const s = this.getStats() || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = v; };
    set('gc-obj', s.objects);
    set('gc-fps', s.fps);
    if (s.status) set('gc-status', s.status);
  }

  _injectCSS() {
    const s = document.createElement('style');
    s.textContent = `
      :root {
        --paper: #f5f5f7; --ink: #1c1c1e; --slate: #636366; --champ: #b8a27a; --mist: #d1d1d6;
        --serif: 'Playfair Display', 'Didot', 'Bodoni 72', 'Hoefler Text', Georgia, 'Times New Roman', serif;
        --sans: 'Inter', ui-sans-serif, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif;
        --glass: rgba(255,255,255,.16); --glass-brd: rgba(255,255,255,.42);
      }
      /* view-driven visibility */
      #gs-menu, #gs-play, #gs-creator-hud { display: none; }
      body[data-view="menu"] #gs-menu { display: block; }
      body[data-view="play"] #gs-play { display: block; }
      body[data-view="creator"] #gs-creator-hud { display: block; }
      body[data-view="menu"] .gs-panel, body[data-view="menu"] #gb-panel,
      body[data-view="play"] .gs-panel, body[data-view="play"] #gb-panel,
      body[data-view="menu"] #gs-fps, body[data-view="play"] #gs-fps,
      body[data-view="menu"] #gs-menu-btn, body[data-view="play"] #gs-menu-btn { display: none; }
      body[data-view="practice"] #gb-panel { display: none; }
      body[data-view="creator"] .gs-panel, body[data-view="creator"] #gs-fps { display: none; }
      body[data-view="creator"] #gs-topright, body[data-view="creator"] #gs-creator-hud { display: none; }
      #gs-menu-btn { display: flex; }

      /* ---------- full-screen overlays: soft, warm, airy glass over the live scene ---------- */
      #gs-menu, #gs-play { position: fixed; inset: 0; z-index: 100; overflow: hidden;
        font-family: var(--sans); animation: gmFade .7s ease both; }
      #gs-menu { background: linear-gradient(180deg, rgba(246,245,243,.50) 0%, rgba(233,227,216,.56) 100%);
        backdrop-filter: blur(26px) saturate(1.05) brightness(1.06); color: var(--ink); }
      #gs-play { background: linear-gradient(180deg, rgba(8,16,13,.05) 0%, rgba(8,14,12,.20) 100%);
        backdrop-filter: none; color: #f4f1ea; }
      #gs-menu::after, #gs-play::after { content:''; position:absolute; inset:0; pointer-events:none;
        box-shadow: inset 0 0 200px 30px rgba(0,0,0,.14); }
      @keyframes gmFade { from { opacity: 0; } to { opacity: 1; } }

      .gm-inner { position: relative; height: 100%; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 46px; padding: 40px; }

      /* brand */
      .gm-brand { text-align: center; }
      .gm-kicker { font: 600 12px/1 var(--sans); letter-spacing: .42em; text-transform: uppercase;
        color: var(--ink); opacity: .62; margin-left: .42em; }
      .gm-title { margin: 14px 0 0; font-family: var(--serif); font-weight: 500;
        font-size: clamp(52px, 8vw, 104px); line-height: .92; letter-spacing: .005em; color: var(--ink); }
      .gm-tag { margin: 18px 0 0; font-size: 17px; letter-spacing: .01em; color: var(--slate); }

      /* menu cards — milky frosted glass */
      .gm-cards { display: flex; gap: 22px; flex-wrap: wrap; justify-content: center; }
      .gm-card { position: relative; width: 250px; height: 330px; cursor: pointer; text-align: left;
        display: flex; flex-direction: column; padding: 26px; border-radius: 16px; color: var(--ink);
        background: var(--glass); border: 1px solid var(--glass-brd);
        box-shadow: 0 16px 44px rgba(60,50,30,.16), inset 0 1px 0 rgba(255,255,255,.5);
        backdrop-filter: blur(14px) saturate(1.1);
        transition: transform .4s cubic-bezier(.2,.7,.2,1), box-shadow .4s, border-color .4s, background .4s;
        opacity: 0; animation: gmRise .7s cubic-bezier(.2,.7,.2,1) forwards; }
      .gm-cards .gm-card:nth-child(1) { animation-delay: .05s; }
      .gm-cards .gm-card:nth-child(2) { animation-delay: .14s; }
      .gm-cards .gm-card:nth-child(3) { animation-delay: .23s; }
      @keyframes gmRise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
      .gm-num { font-family: var(--serif); font-size: 18px; color: var(--champ); }
      .gm-ct { font-family: var(--serif); font-weight: 500; font-size: 34px; line-height: 1.04; margin-top: auto; color: var(--ink); }
      .gm-cs { font-size: 14px; color: var(--slate); margin-top: 8px; }
      .gm-go { font-size: 13px; letter-spacing: .04em; color: var(--champ); margin-top: 22px;
        opacity: .5; transform: translateY(2px); transition: opacity .35s, transform .35s; }
      .gm-card:hover { transform: translateY(-8px);
        background: rgba(255,255,255,.26); border-color: rgba(184,162,122,.75);
        box-shadow: 0 26px 60px rgba(60,50,30,.22), inset 0 1px 0 rgba(255,255,255,.7); }
      .gm-card:hover .gm-go { opacity: 1; transform: none; }
      .gm-foot { font-size: 11px; letter-spacing: .34em; text-transform: uppercase; color: var(--slate); opacity: .7; }

      /* ---------- top-right utility stack (never overlaps left panels) ---------- */
      #gs-topright { position: fixed; top: 14px; right: 14px; z-index: 60;
        display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
      #gs-menu-btn { display: flex; align-items: center; gap: 8px;
        padding: 10px 17px 10px 14px; cursor: pointer; color: rgba(255,255,255,.96);
        font: 600 14px/1 var(--sans); letter-spacing: .01em; text-shadow: 0 1px 7px rgba(0,0,0,.26);
        background: linear-gradient(180deg,rgba(247,252,255,.17),rgba(31,54,39,.18));
        border: 1px solid rgba(255,255,255,.42); border-radius: 999px;
        backdrop-filter: blur(16px) saturate(1.12); box-shadow: 0 12px 34px rgba(4,17,9,.17), inset 0 1px 0 rgba(255,255,255,.3);
        transition: background .25s, transform .2s; }
      #gs-menu-btn .gm-hb { font-size: 15px; color: rgba(255,255,255,.82); }
      #gs-menu-btn:hover { background: linear-gradient(180deg,rgba(255,255,255,.25),rgba(42,74,51,.22)); transform: translateY(-1px); }
      body[data-view="creator"] #gs-menu-btn { color: #f2efe8; background: rgba(255,255,255,.14);
        border-color: rgba(255,255,255,.32); }

      /* LIVE PREVIEW tag lives in the stack; only shown in the creator. */
      #gs-topright .gc-live { display: none; }
      body[data-view="creator"] #gs-topright .gc-live { display: flex; align-items: center; gap: 8px;
        font: 600 11px/1 var(--sans); letter-spacing: .22em; text-transform: uppercase; color: #f2efe8;
        text-shadow: 0 1px 8px rgba(0,0,0,.4); }
      .gc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--champ); box-shadow: 0 0 0 0 rgba(184,162,122,.6); animation: gcPulse 2s infinite; }
      @keyframes gcPulse { 0% { box-shadow: 0 0 0 0 rgba(184,162,122,.6); } 70% { box-shadow: 0 0 0 7px rgba(184,162,122,0); } 100% { box-shadow: 0 0 0 0 rgba(184,162,122,0); } }

      /* ---------- creator stats HUD (bottom-right) ---------- */
      #gs-creator-hud { position: fixed; inset: 0; z-index: 55; pointer-events: none; font-family: var(--sans); }
      .gc-stats { position: absolute; right: 24px; bottom: 22px; display: flex;
        background: rgba(20,24,24,.42); border: 1px solid rgba(255,255,255,.18); border-radius: 12px;
        backdrop-filter: blur(14px); overflow: hidden; }
      .gc-stat { display: flex; flex-direction: column; gap: 3px; padding: 11px 18px; min-width: 74px;
        border-left: 1px solid rgba(255,255,255,.12); }
      .gc-stat:first-child { border-left: 0; }
      .gc-sl { font-size: 9.5px; letter-spacing: .18em; text-transform: uppercase; color: rgba(244,241,234,.6); }
      .gc-sv { font-family: var(--serif); font-size: 22px; color: #f6f2ea; }

      /* ---------- course select ---------- */
      .gm-back { position: fixed; top: 20px; left: 22px; z-index: 62; background: none; border: 0; cursor: pointer;
        color: #f4f1ea; font: 600 14px/1 var(--sans); letter-spacing: .04em; opacity: .85; }
      .gm-back:hover { color: #fff; }
      .gp-inner { position: relative; height: 100%; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 6px; padding: 40px; }
      .gp-kicker { font: 600 12px/1 var(--sans); letter-spacing: .42em; text-transform: uppercase; color: #f4f1ea; opacity: .8; }
      .gp-title { margin: 10px 0 30px; font-family: var(--serif); font-weight: 500; font-size: clamp(40px, 6vw, 74px); color: #fbf8f2; }
      .gp-grid { display: flex; gap: 22px; flex-wrap: wrap; justify-content: center; }
      .gp-card { width: min(46vw, 500px); border-radius: 16px; overflow: hidden; text-align: left; cursor: pointer;
        background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.3);
        backdrop-filter: blur(12px) saturate(1.05); box-shadow: 0 18px 50px rgba(0,0,0,.32);
        transition: transform .35s, border-color .35s, box-shadow .35s; padding: 0; color: #f6f3ec; }
      .gp-thumb { height: 200px; background-image: var(--img), linear-gradient(150deg, #7fa07f, #3f5a44 60%, #26382b);
        background-size: cover; background-position: center; }
      .gp-body { padding: 18px 22px 20px; }
      .gp-cname { font-family: var(--serif); font-weight: 500; font-size: 30px; color: #fbf8f2; }
      .gp-hr { height: 1px; margin: 12px 0; background: linear-gradient(90deg, rgba(255,255,255,.4), rgba(255,255,255,0)); }
      .gp-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .gp-cmeta { font-size: 13.5px; color: rgba(244,241,234,.74); }
      .gp-play { font-size: 16px; color: var(--champ); white-space: nowrap; }
      .gp-card.gp-selected { border-color: rgba(184,162,122,.85); box-shadow: 0 20px 56px rgba(0,0,0,.36), 0 0 0 1px rgba(184,162,122,.5), 0 0 40px rgba(184,162,122,.25); }
      .gp-card:hover { transform: translateY(-6px); border-color: rgba(200,178,138,.95); }

      @media (max-width: 760px) { .gm-cards { gap: 14px; } .gm-card { width: 80vw; height: 190px; } .gp-card { width: 88vw; } }
    `;
    document.head.appendChild(s);
  }
}
