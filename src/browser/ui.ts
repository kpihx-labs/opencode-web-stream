import type { LiveState } from "../shared/protocol.js";

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
};

export type UiState = {
  live: boolean;
  connected: boolean;
  muted: boolean;
  digest: boolean;
  state: LiveState;
  serverVoice: boolean;
  serverEars: boolean;
  /** "fr-FR", "en-US" or "auto": what the recognizer is asked to hear. */
  lang: string;
};

const STYLE_ID = "opencode-web-stream-style";
const COMPOSER_SELECTORS = [
  '[data-component="prompt-input-v2"]',
  '[data-component="session-composer"]',
  '[data-component="session-new-composer"]',
  '[data-component="session-prompt-dock"]',
  '[data-component="prompt-input"]',
].join(", ");

export class Cockpit {
  private button?: HTMLButtonElement;
  private muteButton?: HTMLButtonElement;
  private strip?: HTMLElement;
  private heardLine?: HTMLElement;
  private sayingLine?: HTMLElement;
  private injectBox?: HTMLElement;
  private levelBar?: HTMLElement;
  private observer?: MutationObserver;
  private composer?: HTMLElement;
  private injectTimer?: number;
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
    lang: "auto",
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
  }

  /** One attach per frame, however many mutations arrived. */
  private scheduleAttach() {
    if (this.attachScheduled) return;
    this.attachScheduled = true;
    const run = () => {
      this.attachScheduled = false;
      this.attach();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  private attach() {
    const composer = document.querySelector<HTMLElement>(COMPOSER_SELECTORS);
    if (!composer) return;
    this.composer = composer;
    if (composer.querySelector("[data-opencode-stream]")) {
      this.paint();
      return;
    }
    const actions =
      composer.querySelector<HTMLElement>('[data-action="prompt-attach"]')?.parentElement ??
      composer.querySelector<HTMLElement>('[data-component="prompt-agent-control"]')?.parentElement ??
      composer;

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.opencodeStream = "live";
    button.className = "ows-button";
    button.innerHTML = `<span class="ows-sr">Mode live</span><span class="ows-waves">${"<i></i>".repeat(4)}</span>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      this.callbacks.onToggleLive();
    });

    const mute = document.createElement("button");
    mute.type = "button";
    mute.dataset.opencodeStream = "mute";
    mute.className = "ows-mute";
    mute.addEventListener("click", (event) => {
      event.preventDefault();
      this.callbacks.onToggleMute();
    });

    actions.append(button, mute);
    this.button = button;
    this.muteButton = mute;
    this.paint();
  }

  private ensureStrip() {
    if (this.strip?.isConnected) return;
    const strip = document.createElement("div");
    strip.className = "ows-strip";
    strip.dataset.opencodeStream = "strip";
    strip.innerHTML = `
      <div class="ows-strip-inner">
        <div class="ows-meter"><span class="ows-meter-fill"></span></div>
        <div class="ows-lines">
          <p class="ows-heard" hidden></p>
          <p class="ows-saying" hidden></p>
          <div class="ows-inject" hidden></div>
        </div>
        <div class="ows-actions">
          <button type="button" class="ows-chip ows-chip-lang" data-act="lang" title="Langue écoutée : cliquer pour changer">auto</button>
          <button type="button" class="ows-chip" data-act="repeat" title="Répéter la dernière phrase">redire</button>
          <button type="button" class="ows-chip" data-act="digest" title="Lecture complète ou résumée">résumé</button>
          <button type="button" class="ows-chip ows-chip-stop" data-act="stop" title="Couper la voix">stop</button>
        </div>
      </div>`;
    strip.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (action === "stop") this.callbacks.onStop();
      else if (action === "repeat") this.callbacks.onRepeat();
      else if (action === "digest") this.callbacks.onToggleDigest();
      else if (action === "lang") this.callbacks.onCycleLang();
    });
    document.body.appendChild(strip);
    this.strip = strip;
    this.heardLine = strip.querySelector<HTMLElement>(".ows-heard")!;
    this.sayingLine = strip.querySelector<HTMLElement>(".ows-saying")!;
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
      const { live, connected, muted, digest, state } = this.state;
      if (this.button) {
        const label = this.describe();
        setAttr(this.button, "data-state", live ? state : "off");
        this.button.classList.toggle("is-live", live);
        this.button.classList.toggle("is-offline", !connected);
        setAttr(this.button, "title", label);
        setAttr(this.button, "aria-pressed", String(live));
        setAttr(this.button, "aria-label", label);
      }
      if (this.muteButton) {
        const title = muted ? "Narration coupée" : "Narration active";
        this.muteButton.classList.toggle("is-muted", muted);
        setAttr(this.muteButton, "title", title);
        setAttr(this.muteButton, "aria-label", title);
        setText(this.muteButton, muted ? "🔇" : "🔊");
      }
      this.composer?.classList.toggle("ows-composer-live", live);
      this.strip?.classList.toggle("is-visible", live);
      if (this.strip) setAttr(this.strip, "data-state", live ? state : "off");
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
    if (this.levelBar) this.levelBar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, level)).toFixed(3)})`;
  }

  showHeard(raw: string, corrected: string, decision: string) {
    if (!this.heardLine) return;
    const changed = corrected && corrected.toLowerCase() !== raw.toLowerCase();
    this.heardLine.hidden = false;
    this.heardLine.innerHTML = changed
      ? `<span class="ows-tag">entendu</span> <span class="ows-raw">${escapeHtml(raw)}</span> <span class="ows-arrow">→</span> ${escapeHtml(corrected)} <span class="ows-decision">${escapeHtml(decision)}</span>`
      : `<span class="ows-tag">entendu</span> ${escapeHtml(raw)} <span class="ows-decision">${escapeHtml(decision)}</span>`;
  }

  showInterim(text: string) {
    if (!this.heardLine) return;
    this.heardLine.hidden = false;
    this.heardLine.innerHTML = `<span class="ows-tag">…</span> <span class="ows-raw">${escapeHtml(text)}</span>`;
  }

  showSaying(text: string | undefined) {
    if (!this.sayingLine) return;
    if (!text) {
      this.sayingLine.hidden = true;
      return;
    }
    this.sayingLine.hidden = false;
    this.sayingLine.innerHTML = `<span class="ows-tag ows-tag-say">je dis</span> ${escapeHtml(text)}`;
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
    if (!this.injectBox) return;
    if (note) {
      this.injectBox.innerHTML = `<span class="ows-tag ows-tag-inject">${escapeHtml(note)}</span>`;
      window.setTimeout(() => {
        if (this.injectBox) this.injectBox.hidden = true;
      }, 2500);
      return;
    }
    this.injectBox.hidden = true;
  }

  destroy() {
    this.observer?.disconnect();
    this.attachScheduled = false;
    if (this.injectTimer) window.clearInterval(this.injectTimer);
    this.button?.remove();
    this.muteButton?.remove();
    this.strip?.remove();
    this.composer?.classList.remove("ows-composer-live");
    document.getElementById(STYLE_ID)?.remove();
  }
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
      background: transparent; border: 1px solid transparent; border-radius: 8px;
      cursor: pointer; color: currentColor; flex: 0 0 auto;
      transition: color .2s ease, background .2s ease, border-color .2s ease, box-shadow .2s ease;
    }
    .ows-button { width: 32px; height: 32px; margin-left: .25rem; opacity: .6; }
    .ows-mute { width: 28px; height: 28px; margin-left: .15rem; opacity: .5; font-size: 13px; line-height: 1; }
    .ows-button:hover, .ows-mute:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
    .ows-button:focus-visible, .ows-mute:focus-visible { outline: 2px solid #0ea5b7; outline-offset: 2px; opacity: 1; }
    .ows-mute.is-muted { opacity: .85; }
    .ows-button.is-offline { opacity: .3; cursor: not-allowed; }

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

    .ows-composer-live { box-shadow: 0 0 0 1.5px rgba(14,165,183,.45), 0 0 16px rgba(14,165,183,.15) !important; }

    .ows-strip {
      position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%) translateY(140%);
      z-index: 2147483000; max-width: min(760px, calc(100vw - 24px)); width: max-content;
      background: color-mix(in srgb, Canvas 86%, #0ea5b7 4%); color: CanvasText;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.28);
      backdrop-filter: blur(10px); opacity: 0; pointer-events: none;
      transition: transform .28s cubic-bezier(.2,.9,.3,1), opacity .2s ease;
      font: 400 13px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .ows-strip.is-visible { transform: translateX(-50%) translateY(0); opacity: 1; pointer-events: auto; }
    .ows-strip-inner { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; }
    .ows-lines { display: grid; gap: 4px; min-width: 0; flex: 1 1 auto; }
    .ows-lines p { margin: 0; overflow-wrap: anywhere; }
    .ows-meter { width: 3px; align-self: stretch; min-height: 26px; border-radius: 2px; background: color-mix(in srgb, CanvasText 12%, transparent); overflow: hidden; }
    .ows-meter-fill { display: block; width: 100%; height: 100%; background: #0ea5b7; transform-origin: bottom; transform: scaleX(.02); transition: transform .08s linear; }

    .ows-tag { display: inline-block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
      padding: 1px 6px; border-radius: 999px; margin-right: 6px; vertical-align: 1px;
      background: color-mix(in srgb, CanvasText 12%, transparent); opacity: .85; }
    .ows-tag-say { background: rgba(124,58,237,.2); color: #7c3aed; }
    .ows-tag-inject { background: rgba(14,165,183,.2); color: #0e7490; }
    .ows-raw { opacity: .6; text-decoration: line-through dotted; }
    .ows-arrow { opacity: .55; margin: 0 3px; }
    .ows-decision { opacity: .45; font-size: 11px; margin-left: 6px; }
    .ows-saying { opacity: .95; }
    .ows-inject { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ows-inject-text { font-weight: 500; }

    .ows-actions { display: flex; gap: 4px; align-self: center; flex: 0 0 auto; }
    .ows-chip { font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 999px; cursor: pointer;
      background: transparent; color: inherit; opacity: .7;
      border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); }
    .ows-chip:hover { opacity: 1; background: color-mix(in srgb, CanvasText 8%, transparent); }
    .ows-chip.is-on { background: rgba(14,165,183,.18); border-color: rgba(14,165,183,.5); opacity: 1; }
    .ows-chip-stop:hover { border-color: rgba(220,38,38,.6); color: #dc2626; }
    .ows-chip-lang { font-family: ui-monospace, monospace; letter-spacing: .04em; min-width: 3.4em; text-align: center; }
    .ows-chip-cancel { border-color: rgba(220,38,38,.45); }

    @media (max-width: 520px) {
      .ows-strip { left: 8px; right: 8px; transform: translateY(140%); width: auto; max-width: none; }
      .ows-strip.is-visible { transform: translateY(0); }
      .ows-actions { flex-wrap: wrap; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ows-strip { transition: opacity .2s ease; }
      .ows-waves i { animation: none !important; }
    }`;
  document.head.appendChild(style);
}
