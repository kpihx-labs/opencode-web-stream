import type { LiveState } from "../shared/protocol.js";
import { phrase, pickLang } from "../shared/phrases.js";

/**
 * The cockpit's surface inside OpenCode Web.
 *
 * Two pieces: a control in the composer's action row whose colour and motion
 * carry the session state, and a transcript strip that shows what was heard,
 * what is being said, and any injection about to be sent — with a moment to
 * cancel it. Nothing here decides anything; it renders state and reports
 * clicks.
 */

export type UiCallbacks = {
  onToggleLive: () => void;
  onToggleMute: () => void;
  onCancelInject: (injectId: string) => void;
  onStop: () => void;
  onRepeat: () => void;
  onToggleDigest: () => void;
  onCycleLang: () => void;
  onToggleSttMode: () => void;
};

export type UiState = {
  live: boolean;
  connected: boolean;
  muted: boolean;
  digest: boolean;
  state: LiveState;
  serverVoice: boolean;
  serverEars: boolean;
  sttEngine: "browser" | "server" | "hex";
  /** "fr-FR", "en-US" or "auto": what the recognizer is asked to hear. */
  lang: string;
  /** True when live cannot start server-side: new session, no known directory. */
  noDir: boolean;
};

const STYLE_ID = "opencode-web-stream-style";
const COMPOSER_SELECTORS = [
  'form[data-component="composer"]',
  '[data-component="prompt-input-v2"]',
  '[data-component="session-composer"]',
  '[data-component="session-new-composer"]',
  '[data-component="session-prompt-dock"]',
  '[data-component="prompt-input"]',
].join(", ");

const SPEAKER_ON_SVG = `<svg data-slot="icon-svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6.2H5.2L8.7 3.2V12.8L5.2 9.8H2.5V6.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M11 5.6C11.75 6.3 12.15 7.15 12.15 8C12.15 8.85 11.75 9.7 11 10.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12.9 3.9C14.1 5.05 14.7 6.45 14.7 8C14.7 9.55 14.1 10.95 12.9 12.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const SPEAKER_OFF_SVG = `<svg data-slot="icon-svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6.2H5.2L8.7 3.2V12.8L5.2 9.8H2.5V6.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M11.2 5.8L14.4 10.2M14.4 5.8L11.2 10.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

export class Cockpit {
  private button?: HTMLButtonElement;
  private muteButton?: HTMLButtonElement;
  private strip?: HTMLElement;
  private feed?: HTMLElement;
  private statusLabel?: HTMLElement;
  private interimLine?: HTMLElement;
  private injectBox?: HTMLElement;
  private levelBar?: HTMLElement;
  private observer?: MutationObserver;
  private resizeHandler?: () => void;
  private composer?: HTMLElement;
  private mountParent?: HTMLElement;
  private injectTimer?: number;
  private expanded = false;
  /** True while paint() writes, so the observer ignores what those writes queue. */
  private painting = false;
  private attachScheduled = false;
  private state: UiState = {
    live: false,
    connected: false,
    muted: false,
    digest: false,
    state: "idle",
    serverVoice: false,
    serverEars: false,
    sttEngine: "hex",
    lang: "auto",
    noDir: false,
  };

  constructor(private readonly callbacks: UiCallbacks) {}

  mount() {
    injectStyle();
    this.ensureStrip();
    this.attach();
    // OpenCode Web is a single-page app: the composer is replaced on navigation,
    // so the whole document is watched. Painting also writes to the document,
    // and `setAttribute` queues a mutation record even when the value does not
    // change — so an unguarded observer would call itself forever and freeze the
    // tab. Three things prevent that: our own mutations are filtered out, a
    // paint in progress short-circuits the callback, and the work is coalesced
    // into one animation frame.
    this.observer = new MutationObserver((records) => {
      if (this.painting) return;
      if (records.every((record) => isOurs(record.target))) return;
      this.scheduleAttach();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.resizeHandler = () => this.scheduleAttach();
    window.addEventListener("resize", this.resizeHandler);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.scheduleAttach();
    });
  }

  /** One attach per frame, however many mutations arrived. */
  private scheduleAttach() {
    if (this.attachScheduled) return;
    this.attachScheduled = true;
    const run = () => {
      this.attachScheduled = false;
      this.attach();
    };
    if (!document.hidden && typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  private attach() {
    const composer = document.querySelector<HTMLElement>(COMPOSER_SELECTORS);
    const target = resolveVisibleMount(composer);
    if (!target) return;
    this.composer = composer ?? target.actions;

    // Re-mount cleanly when V2 switches between desktop composer-actions and mobile bottom bar.
    if (this.button?.isConnected && this.mountParent === target.actions && isVisibleElement(this.button)) {
      this.mountStripNear(this.composer);
      this.paint();
      return;
    }
    this.button?.remove();
    this.muteButton?.remove();

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.opencodeStream = "live";
    button.setAttribute("data-component", "icon-button-v2");
    button.setAttribute("data-size", "normal");
    button.setAttribute("data-variant", "ghost-muted");
    if (target.mobile) button.dataset.owsMobile = "1";
    button.className = "ows-button";
    button.innerHTML = `<span class="ows-sr">Mode live</span><span class="ows-waves">${"<i></i>".repeat(4)}</span>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      this.callbacks.onToggleLive();
    });

    const mute = document.createElement("button");
    mute.type = "button";
    mute.dataset.opencodeStream = "mute";
    mute.setAttribute("data-component", "icon-button-v2");
    mute.setAttribute("data-size", "normal");
    mute.setAttribute("data-variant", "ghost-muted");
    if (target.mobile) mute.dataset.owsMobile = "1";
    mute.className = "ows-mute";
    mute.innerHTML = SPEAKER_ON_SVG;
    mute.addEventListener("click", (event) => {
      event.preventDefault();
      this.callbacks.onToggleMute();
    });

    const anchor = target.anchor;
    if (anchor) {
      target.actions.insertBefore(button, anchor);
      target.actions.insertBefore(mute, anchor);
    } else {
      target.actions.append(button, mute);
    }
    this.mountParent = target.actions;
    this.mountStripNear(this.composer);
    this.button = button;
    this.muteButton = mute;
    this.paint();
  }

  private mountStripNear(composer: HTMLElement) {
    this.ensureStrip();
    if (!this.strip) return;
    const dock = composer.closest<HTMLElement>('[data-slot="composer-morph"], [data-component="session-composer-dock"]');
    if (dock) {
      if (getComputedStyle(dock).position === "static") dock.style.position = "relative";
      this.strip.classList.add("ows-strip-docked");
      if (this.strip.parentElement !== dock) dock.appendChild(this.strip);
    } else {
      this.strip.classList.remove("ows-strip-docked");
      if (this.strip.parentElement !== document.body) document.body.appendChild(this.strip);
    }
  }

  private ensureStrip() {
    if (this.strip?.isConnected) return;
    const strip = document.createElement("div");
    strip.className = "ows-strip";
    strip.dataset.opencodeStream = "strip";
    strip.innerHTML = `
      <div class="ows-header">
        <div class="ows-header-left">
          <div class="ows-meter"><span class="ows-meter-fill"></span></div>
          <span class="ows-status-dot"></span>
          <span class="ows-status-label">Live</span>
        </div>
        <div class="ows-actions">
          <button type="button" class="ows-chip ows-chip-stt" data-act="stt" title="Moteur STT : cliquer pour basculer Hex (local) ↔ Web (online)">stt:hex</button>
          <button type="button" class="ows-chip ows-chip-lang" data-act="lang" title="Langue écoutée : cliquer pour changer">auto</button>
          <button type="button" class="ows-chip" data-act="repeat" title="Répéter la dernière phrase">redire</button>
          <button type="button" class="ows-chip" data-act="digest" title="Lecture complète ou résumée">résumé</button>
          <button type="button" class="ows-chip ows-chip-stop" data-act="stop" title="Couper la voix">stop</button>
          <button type="button" class="ows-chip" data-act="clear" title="Vider l'historique streamer">effacer</button>
          <button type="button" class="ows-chip ows-chip-expand" data-act="expand" title="Agrandir / réduire l'historique">▴</button>
        </div>
      </div>
      <div class="ows-feed" hidden></div>
      <div class="ows-live-footer">
        <p class="ows-interim" hidden></p>
        <div class="ows-inject" hidden></div>
      </div>`;
    strip.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (action === "stop") this.callbacks.onStop();
      else if (action === "repeat") this.callbacks.onRepeat();
      else if (action === "digest") this.callbacks.onToggleDigest();
      else if (action === "lang") this.callbacks.onCycleLang();
      else if (action === "stt") this.callbacks.onToggleSttMode();
      else if (action === "clear") this.clearFeed();
      else if (action === "expand") this.toggleExpanded();
    });
    document.body.appendChild(strip);
    this.strip = strip;
    this.feed = strip.querySelector<HTMLElement>(".ows-feed")!;
    this.statusLabel = strip.querySelector<HTMLElement>(".ows-status-label")!;
    this.interimLine = strip.querySelector<HTMLElement>(".ows-interim")!;
    this.injectBox = strip.querySelector<HTMLElement>(".ows-inject")!;
    this.levelBar = strip.querySelector<HTMLElement>(".ows-meter-fill")!;
  }

  update(patch: Partial<UiState>) {
    Object.assign(this.state, patch);
    this.paint();
  }

  /**
   * Render the current state. Every write goes through a helper that reads
   * first, so a paint that changes nothing touches the DOM not at all — which
   * is what keeps the observer quiet in the common case.
   */
  private paint() {
    this.painting = true;
    try {
      this.ensureStrip();
      const { live, connected, muted, digest, state, noDir } = this.state;
      if (this.button) {
        const label = this.describe();
        setAttr(this.button, "data-state", live ? state : "off");
        this.button.classList.toggle("is-live", live);
        this.button.classList.toggle("is-offline", !connected);
        this.button.classList.toggle("is-nodir", noDir && !live);
        setAttr(this.button, "title", label);
        setAttr(this.button, "aria-pressed", String(live));
        setAttr(this.button, "aria-label", label);
      }
      if (this.muteButton) {
        const title = muted ? "Narration coupée" : "Narration active";
        this.muteButton.classList.toggle("is-muted", muted);
        this.muteButton.hidden = !live;
        setAttr(this.muteButton, "title", title);
        setAttr(this.muteButton, "aria-label", title);
        setAttr(this.muteButton, "aria-pressed", String(muted));
        const nextHtml = muted ? SPEAKER_OFF_SVG : SPEAKER_ON_SVG;
        if (this.muteButton.dataset.icon !== (muted ? "off" : "on")) {
          this.muteButton.dataset.icon = muted ? "off" : "on";
          this.muteButton.innerHTML = nextHtml;
        }
      }
      this.composer?.classList.toggle("ows-composer-live", live);
      this.strip?.classList.toggle("is-visible", live);
      this.strip?.classList.toggle("is-expanded", this.expanded);
      if (this.strip) setAttr(this.strip, "data-state", live ? state : "off");
      if (this.statusLabel) {
        const labels: Record<LiveState, string> = {
          idle: "repos",
          listening: "à l'écoute",
          thinking: "réflexion",
          speaking: "je parle",
          interrupted: "interrompu",
          waiting_user: "attente réponse",
          away: "veille",
        };
        setText(this.statusLabel, live ? labels[state] : "éteint");
      }
      const sttChip = this.strip?.querySelector<HTMLElement>('[data-act="stt"]');
      if (sttChip) {
        const label = this.state.sttEngine === "hex" ? "stt:hex" : this.state.sttEngine === "server" ? "stt:srv" : "stt:web";
        setText(sttChip, label);
        sttChip.classList.toggle("is-on", this.state.serverEars);
        setAttr(
          sttChip,
          "title",
          this.state.serverEars
            ? `STT local (${this.state.sttEngine}) — cliquer pour passer sur Edge Web Speech (online)`
            : "STT navigateur (online) — cliquer pour passer sur Hex local (Orukeet)",
        );
      }
      const expandChip = this.strip?.querySelector<HTMLElement>('[data-act="expand"]');
      if (expandChip) {
        setText(expandChip, this.expanded ? "▾" : "▴");
        expandChip.classList.toggle("is-on", this.expanded);
      }
      const digestChip = this.strip?.querySelector<HTMLElement>('[data-act="digest"]');
      digestChip?.classList.toggle("is-on", digest);
      const langChip = this.strip?.querySelector<HTMLElement>('[data-act="lang"]');
      if (langChip) {
        const lang = this.state.lang;
        setText(langChip, lang === "auto" ? "auto" : lang.split(/[-_]/)[0]);
        setAttr(langChip, "title", lang === "auto" ? "Langue écoutée : automatique (cliquer pour fixer)" : `Langue écoutée : ${lang} (cliquer pour changer)`);
        langChip.classList.toggle("is-on", lang !== "auto");
      }
    } finally {
      // Records queued by the writes above are delivered at the next microtask
      // checkpoint, so the flag has to outlive this call by one turn.
      queueMicrotask(() => {
        this.painting = false;
      });
    }
  }

  private describe(): string {
    if (!this.state.connected) return "Live : démon injoignable";
    if (!this.state.live && this.state.noDir) {
      // The selector value ("fr-FR", "en-US", "auto"); "auto" follows the browser.
      const tag = this.state.lang === "auto" ? navigator.language : this.state.lang;
      return phrase(pickLang(tag), "cockpit.liveButton.noDir");
    }
    if (!this.state.live) return "Live : éteint, cliquer pour activer";
    const map: Record<LiveState, string> = {
      idle: "Live : au repos",
      listening: "Live : je t'écoute",
      thinking: "Live : je travaille",
      speaking: "Live : je parle",
      interrupted: "Live : je t'écoute, vas-y",
      waiting_user: "Live : j'attends ta réponse",
      away: "Live : en veille",
    };
    const ears = this.state.serverEars ? "oreilles locales" : "oreilles navigateur";
    const voice = this.state.serverVoice ? "voix locale" : "voix navigateur";
    return `${map[this.state.state]} (${ears}, ${voice})`;
  }

  setLevel(level: number) {
    if (this.levelBar) this.levelBar.style.transform = `scaleY(${Math.max(0.08, Math.min(1, level)).toFixed(3)})`;
  }

  private appendEntry(kind: "heard" | "say" | "inject" | "note", html: string) {
    if (!this.feed) return;
    const nearBottom = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 28;
    const row = document.createElement("div");
    row.className = `ows-entry ows-entry-${kind}`;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    row.innerHTML = `<span class="ows-time">${time}</span><div class="ows-entry-body">${html}</div>`;
    this.painting = true;
    try {
      this.feed.hidden = false;
      this.feed.appendChild(row);
      while (this.feed.children.length > 60) this.feed.firstElementChild?.remove();
      if (nearBottom) this.feed.scrollTop = this.feed.scrollHeight;
    } finally {
      queueMicrotask(() => {
        this.painting = false;
      });
    }
  }

  private clearFeed() {
    if (!this.feed) return;
    this.painting = true;
    try {
      this.feed.innerHTML = "";
      this.feed.hidden = true;
    } finally {
      queueMicrotask(() => {
        this.painting = false;
      });
    }
  }

  private toggleExpanded() {
    this.expanded = !this.expanded;
    this.paint();
  }

  showHeard(raw: string, corrected: string, decision: string) {
    if (this.interimLine) this.interimLine.hidden = true;
    const changed = corrected && corrected.toLowerCase() !== raw.toLowerCase();
    const body = changed
      ? `<span class="ows-tag">entendu</span> <span class="ows-raw">${escapeHtml(raw)}</span> <span class="ows-arrow">→</span> ${escapeHtml(corrected)} <span class="ows-decision">${escapeHtml(decision)}</span>`
      : `<span class="ows-tag">entendu</span> ${escapeHtml(raw)} <span class="ows-decision">${escapeHtml(decision)}</span>`;
    this.appendEntry("heard", body);
  }

  showInterim(text: string) {
    if (!this.interimLine) return;
    this.interimLine.hidden = false;
    this.interimLine.innerHTML = `<span class="ows-tag">…</span> <span class="ows-raw">${escapeHtml(text)}</span>`;
  }

  showSaying(text: string | undefined) {
    if (!text) return;
    this.appendEntry("say", `<span class="ows-tag ows-tag-say">je dis</span> ${escapeHtml(text)}`);
  }

  /** Show an injection about to be sent, with a countdown and a way out. */
  showInject(injectId: string, text: string, mode: "queue" | "interrupt", executeAt: number) {
    if (!this.injectBox) return;
    this.injectBox.hidden = false;
    const label = mode === "interrupt" ? "j'interromps et j'envoie" : "j'envoie";
    this.injectBox.innerHTML = `
      <span class="ows-tag ows-tag-inject">${label}</span>
      <span class="ows-inject-text">${escapeHtml(text)}</span>
      <button type="button" class="ows-chip ows-chip-cancel">annuler <span class="ows-count"></span></button>`;
    this.appendEntry("inject", `<span class="ows-tag ows-tag-inject">${label}</span> ${escapeHtml(text)}`);
    const cancel = this.injectBox.querySelector<HTMLButtonElement>(".ows-chip-cancel")!;
    cancel.addEventListener("click", () => this.callbacks.onCancelInject(injectId));
    const count = cancel.querySelector<HTMLElement>(".ows-count")!;
    if (this.injectTimer) window.clearInterval(this.injectTimer);
    const tick = () => {
      const left = Math.max(0, executeAt - Date.now());
      count.textContent = left > 0 ? `${(left / 1000).toFixed(1)}s` : "";
      if (left <= 0 && this.injectTimer) {
        window.clearInterval(this.injectTimer);
        this.injectTimer = undefined;
      }
    };
    tick();
    this.injectTimer = window.setInterval(tick, 100);
  }

  hideInject(note?: string) {
    if (this.injectTimer) window.clearInterval(this.injectTimer);
    this.injectTimer = undefined;
    if (note) this.appendEntry("note", `<span class="ows-tag ows-tag-inject">${escapeHtml(note)}</span>`);
    else this.appendEntry("note", `<span class="ows-tag ows-tag-inject">envoyé ✓</span>`);
    if (!this.injectBox) return;
    this.injectBox.hidden = true;
  }

  destroy() {
    this.observer?.disconnect();
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    this.resizeHandler = undefined;
    this.attachScheduled = false;
    if (this.injectTimer) window.clearInterval(this.injectTimer);
    this.button?.remove();
    this.muteButton?.remove();
    this.strip?.remove();
    this.composer?.classList.remove("ows-composer-live");
    document.getElementById(STYLE_ID)?.remove();
  }
}

function isVisibleElement(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function resolveVisibleMount(composer: HTMLElement | null): { actions: HTMLElement; anchor: Element | null; mobile: boolean } | null {
  const submits = [...document.querySelectorAll<HTMLElement>('[data-action="composer-submit"]')].filter(isVisibleElement);
  for (const submit of submits) {
    const desktopSlot = submit.closest<HTMLElement>('[data-slot="composer-actions"]');
    if (desktopSlot && isVisibleElement(desktopSlot)) {
      let anchor: HTMLElement = submit;
      while (anchor.parentElement && anchor.parentElement !== desktopSlot) anchor = anchor.parentElement;
      return { actions: desktopSlot, anchor, mobile: false };
    }
    const parent = submit.parentElement;
    if (!parent) continue;
    const alt = parent.querySelector('[data-action="composer-alternate-delivery"]');
    return {
      actions: parent,
      anchor: alt && isVisibleElement(alt) ? alt : submit,
      mobile: true,
    };
  }
  if (!composer) return null;
  const actions =
    composer.querySelector<HTMLElement>('[data-slot="composer-actions"]') ??
    composer.querySelector<HTMLElement>('[data-action="prompt-attach"]')?.parentElement ??
    composer.querySelector<HTMLElement>('[data-component="prompt-agent-control"]')?.parentElement ??
    composer;
  if (!isVisibleElement(actions)) return null;
  return { actions, anchor: actions.querySelector('[data-action="composer-submit"]'), mobile: false };
}

/**
 * Is this node part of the cockpit's own UI? Tested by capability rather than
 * by `instanceof`, which fails across realms and would silently let every
 * mutation through.
 */
export function isOurs(node: unknown): boolean {
  let current = node as { hasAttribute?: (n: string) => boolean; closest?: (s: string) => unknown; parentNode?: unknown } | null;
  for (let depth = 0; current && depth < 12; depth++) {
    if (typeof current.hasAttribute === "function" && current.hasAttribute("data-opencode-stream")) return true;
    if (typeof current.closest === "function" && current.closest("[data-opencode-stream]")) return true;
    current = (current.parentNode ?? null) as typeof current;
  }
  return false;
}

/** Write an attribute only when it differs: an identical write still mutates. */
export function setAttr(element: Element, name: string, value: string) {
  if (element.getAttribute(name) === value) return;
  element.setAttribute(name, value);
}

/** Same idea for text: assigning textContent replaces every child node. */
export function setText(element: Element, value: string) {
  if (element.textContent === value) return;
  element.textContent = value;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .ows-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    .ows-button, .ows-mute {
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 auto; width: 28px; height: 28px; padding: 5px;
      background: transparent; border: 1px solid transparent; border-radius: 6px;
      cursor: pointer; color: var(--v2-text-text-muted, currentColor); opacity: .78;
      -webkit-tap-highlight-color: transparent;
      transition: color .16s ease, background .16s ease, border-color .16s ease, box-shadow .16s ease;
    }
    .ows-mute[hidden] { display: none; }
    .ows-button:hover, .ows-mute:hover { opacity: 1; color: var(--v2-text-text-base, currentColor); background: rgba(128, 128, 128, .14); }
    .ows-button:focus-visible, .ows-mute:focus-visible { outline: 2px solid #0ea5b7; outline-offset: 1px; opacity: 1; }
    .ows-mute.is-muted { opacity: .9; color: #f59e0b; background: rgba(245,158,11,.12); border-color: rgba(245,158,11,.35); }
    .ows-button.is-offline { opacity: .3; cursor: not-allowed; }
    .ows-button.is-nodir { opacity: .38; }
    .ows-button.is-nodir:hover { opacity: .65; }

    .ows-waves { display: flex; align-items: center; gap: 2px; height: 14px; }
    .ows-waves i { width: 2.5px; height: 5px; border-radius: 2px; background: currentColor; display: block; }
    .ows-button.is-live { opacity: 1; }

    .ows-button[data-state="listening"] { color: #0ea5b7; background: rgba(14,165,183,.12); border-color: rgba(14,165,183,.35); }
    .ows-button[data-state="listening"] .ows-waves i { animation: ows-listen 1.1s ease-in-out infinite alternate; }
    .ows-button[data-state="thinking"] { color: #d97706; background: rgba(217,119,6,.12); border-color: rgba(217,119,6,.32); }
    .ows-button[data-state="thinking"] .ows-waves i { animation: ows-think 1.6s ease-in-out infinite; }
    .ows-button[data-state="speaking"] { color: #7c3aed; background: rgba(124,58,237,.16); border-color: rgba(124,58,237,.4); }
    .ows-button[data-state="speaking"] .ows-waves i { animation: ows-speak .55s ease-in-out infinite alternate; }
    .ows-button[data-state="interrupted"] { color: #0ea5b7; background: rgba(14,165,183,.22); border-color: rgba(14,165,183,.5); }
    .ows-button[data-state="waiting_user"] { color: #dc2626; background: rgba(220,38,38,.14); border-color: rgba(220,38,38,.42); }
    .ows-button[data-state="waiting_user"] .ows-waves i { animation: ows-wait 1s steps(2, end) infinite; }

    .ows-waves i:nth-child(1) { animation-delay: 0s; }
    .ows-waves i:nth-child(2) { animation-delay: .12s; }
    .ows-waves i:nth-child(3) { animation-delay: .24s; }
    .ows-waves i:nth-child(4) { animation-delay: .36s; }

    @keyframes ows-listen { from { height: 4px; opacity: .55; } to { height: 13px; opacity: 1; } }
    @keyframes ows-speak { from { height: 3px; } to { height: 16px; } }
    @keyframes ows-think { 0%,100% { height: 5px; opacity: .5; } 50% { height: 9px; opacity: 1; } }
    @keyframes ows-wait { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

    .ows-button[data-ows-mobile="1"], .ows-mute[data-ows-mobile="1"] {
      width: 40px; height: 40px; padding: 8px; border-radius: 8px;
    }
    .ows-composer-live { box-shadow: 0 0 0 1px var(--v2-border-border-focus, rgba(14,165,183,.55)) !important; }

    .ows-strip {
      position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%) translateY(140%);
      z-index: 2147483000; max-width: min(760px, calc(100vw - 24px)); width: max-content;
      background: var(--v2-background-bg-layer-01, var(--v2-background-bg-base, Canvas));
      color: var(--v2-text-text-base, CanvasText);
      border: 1px solid var(--v2-border-border-base, var(--v2-border-border-muted, rgba(128,128,128,.22)));
      border-radius: 12px;
      box-shadow: var(--v2-elevation-raised, var(--v2-elevation-floating, 0 8px 24px rgba(0,0,0,.18)));
      opacity: 0; pointer-events: none;
      transition: transform .22s cubic-bezier(.2,.9,.3,1), opacity .18s ease;
      font: 400 12.5px/1.4 var(--font-family-text, ui-sans-serif, system-ui, sans-serif);
    }
    .ows-strip.ows-strip-docked {
      position: absolute; left: 0; right: 0; bottom: calc(100% + 8px);
      width: auto; max-width: none; transform: translateY(8px); z-index: 42;
    }
    .ows-strip.is-visible { transform: translateX(-50%) translateY(0); opacity: 1; pointer-events: auto; }
    .ows-strip.ows-strip-docked.is-visible { transform: translateY(0); }
    .ows-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px;
      border-bottom: 1px solid var(--v2-border-border-muted, rgba(128,128,128,.16)); }
    .ows-header-left { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .ows-status-dot { width: 7px; height: 7px; border-radius: 999px; background: #0ea5b7; flex: 0 0 auto; }
    .ows-strip[data-state="speaking"] .ows-status-dot { background: #7c3aed; }
    .ows-strip[data-state="thinking"] .ows-status-dot { background: #d97706; }
    .ows-strip[data-state="waiting_user"] .ows-status-dot { background: #dc2626; }
    .ows-status-label { font-size: 11px; font-weight: 500; color: var(--v2-text-text-muted, inherit); white-space: nowrap; }
    .ows-feed { max-height: 170px; overflow-y: auto; overscroll-behavior: contain; padding: 6px 10px; display: grid; gap: 5px;
      scrollbar-width: thin; }
    .ows-strip.is-expanded .ows-feed { max-height: 340px; }
    .ows-feed[hidden] { display: none; }
    .ows-entry { display: flex; align-items: baseline; gap: 7px; font-size: 12px; line-height: 1.42; }
    .ows-time { font-family: var(--font-family-mono, ui-monospace, monospace); font-size: 10px; opacity: .5; flex: 0 0 auto; }
    .ows-entry-body { min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
    .ows-live-footer { display: grid; gap: 4px; padding: 0 10px; }
    .ows-live-footer:has(> :not([hidden])) { padding: 6px 10px; border-top: 1px solid var(--v2-border-border-muted, rgba(128,128,128,.14)); }
    .ows-interim { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
    .ows-meter { width: 4px; height: 18px; border-radius: 2px; background: var(--v2-background-bg-layer-03, rgba(128,128,128,.16)); overflow: hidden; flex: 0 0 auto; }
    .ows-meter-fill { display: block; width: 100%; height: 100%; background: var(--v2-icon-icon-accent, #0ea5b7); transform-origin: bottom; transform: scaleY(.08); transition: transform .08s linear; }

    .ows-tag { display: inline-block; font-size: 10px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase;
      padding: 1px 6px; border-radius: 6px; margin-right: 6px; vertical-align: 1px;
      background: var(--v2-background-bg-layer-02, rgba(128,128,128,.14)); color: var(--v2-text-text-muted, inherit); }
    .ows-tag-say { background: rgba(124,58,237,.16); color: #a78bfa; }
    .ows-tag-inject { background: rgba(14,165,183,.16); color: #22d3ee; }
    .ows-raw { color: var(--v2-text-text-muted, inherit); opacity: .7; text-decoration: line-through dotted; }
    .ows-arrow { color: var(--v2-text-text-muted, inherit); opacity: .65; margin: 0 3px; }
    .ows-decision { color: var(--v2-text-text-muted, inherit); opacity: .72; font-size: 11px; margin-left: 6px; font-family: var(--font-family-mono, ui-monospace, monospace); }
    .ows-inject { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ows-inject-text { font-weight: 500; }

    .ows-actions { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .ows-chip { font: inherit; font-size: 11px; padding: 2px 7px; border-radius: 7px; cursor: pointer;
      background: var(--v2-background-bg-layer-02, transparent); color: var(--v2-text-text-muted, inherit);
      border: 1px solid var(--v2-border-border-muted, rgba(128,128,128,.22));
      transition: background .14s ease, color .14s ease, border-color .14s ease; }
    .ows-chip:hover { color: var(--v2-text-text-base, inherit); background: var(--v2-background-bg-layer-03, rgba(128,128,128,.12)); }
    .ows-chip.is-on { color: var(--v2-text-text-base, inherit); background: var(--v2-background-bg-layer-03, rgba(14,165,183,.14)); border-color: var(--v2-border-border-strong, rgba(14,165,183,.45)); }
    .ows-chip-stop:hover { border-color: rgba(220,38,38,.55); color: #dc2626; }
    .ows-chip-lang, .ows-chip-stt { font-family: var(--font-family-mono, ui-monospace, monospace); letter-spacing: .03em; }
    .ows-chip-cancel { border-color: rgba(220,38,38,.45); }

    @media (pointer: coarse), (max-width: 640px) {
      .ows-strip { left: 8px; right: 8px; transform: translateY(140%); width: auto; max-width: none; }
      .ows-strip.ows-strip-docked { left: 8px; right: 8px; bottom: calc(100% + 6px); }
      .ows-strip.is-visible { transform: translateY(0); }
      .ows-header { flex-wrap: wrap; gap: 6px; padding: 6px 8px; }
      .ows-actions { width: 100%; justify-content: flex-end; }
      .ows-feed { max-height: 140px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ows-strip { transition: opacity .2s ease; }
      .ows-waves i { animation: none !important; }
    }`;
  document.head.appendChild(style);
}
