type SpeechRecognitionEventLike = Event & {
  results: SpeechRecognitionResultList;
  resultIndex: number;
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const STATE_KEY = "__opencodeWebStreamPlugin";

type StreamWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  [STATE_KEY]?: { cleanup: () => void };
};

const streamWindow = window as StreamWindow;

type ProgressStep = {
  step_id: string;
  title: string;
  tool?: string;
  summary: string;
  full_detail?: string;
  status: "running" | "completed" | "error";
  speech_text?: string;
};

type ResolveResponse = {
  query: string;
  resolved: string;
  needs_clarification: boolean;
  unknown_terms: string[];
  confidence: number;
  candidates: Array<{ name: string; score: number; confidence: number }>;
};

type StreamState = {
  activeLive: boolean;
  wsConnected: boolean;
  isSpeaking: boolean;
  ws?: WebSocket;
  wsReconnectTimer?: any;
  recognition?: SpeechRecognitionLike;
  liveButton?: HTMLButtonElement;
  muteButton?: HTMLButtonElement;
  composerEl?: HTMLElement;
  style?: HTMLStyleElement;
  observer?: MutationObserver;
  ttsEnabled: boolean;
  langSelectAttached?: HTMLSelectElement;
  debounceTimer?: any;
  accumulatedTranscript: string;
  lastSentTranscript: string;
  audioUnlocked: boolean;
  cachedVoices: SpeechSynthesisVoice[];
};

const state: StreamState = {
  activeLive: false,
  wsConnected: false,
  isSpeaking: false,
  ttsEnabled: localStorage.getItem("opencodeWebStreamMute") !== "true",
  accumulatedTranscript: "",
  lastSentTranscript: "",
  audioUnlocked: false,
  cachedVoices: [],
};

/** Reject STT echoes of the purged clarification heuristic (and any residue left in the composer). */
function looksLikeClarificationEcho(text: string): boolean {
  const t = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return (
    t.includes("peux-tu me preciser") ||
    t.includes("m'epeler") ||
    t.includes("m epeler") ||
    /je n['']?ai pas.*preciser/.test(t) ||
    /je n['']?ai pas trouve/.test(t)
  );
}

function resolveRecognitionLanguage(): string {
  // 1. Explicit preference from storage
  const saved = localStorage.getItem("opencodeWebVoiceLang");
  if (saved && saved !== "auto") {
    return saved;
  }

  // 2. DOM selector value if non-auto
  const select = document.querySelector<HTMLSelectElement>("select.opencode-web-voice-plugin-lang-select");
  if (select && select.value && select.value !== "auto") {
    return select.value;
  }

  // 3. Auto mode: detect from browser / system navigator language
  const navLang = (navigator.language || "").toLowerCase();
  if (navLang.startsWith("fr")) {
    return "fr-FR";
  }
  if (navLang.startsWith("en")) {
    return "en-US";
  }

  // Fallback to fr-FR
  return "fr-FR";
}

function hookLangSelectorListener() {
  const select = document.querySelector<HTMLSelectElement>("select.opencode-web-voice-plugin-lang-select");
  if (!select || select === state.langSelectAttached) return;

  state.langSelectAttached = select;
  select.addEventListener("change", () => {
    const newLang = resolveRecognitionLanguage();
    console.log(`[opencode-web-stream] Language changed to: ${newLang}`);
    if (state.recognition) {
      state.recognition.lang = newLang;
      // If actively listening, restart recognition to apply language change immediately
      if (state.activeLive) {
        try {
          state.recognition.stop();
        } catch {}
      }
    }
  });
}

function getWsUrl(): string {
  if (typeof window === "undefined") return "ws://127.0.0.1:8765/ws/stream";
  const isSecure = window.location.protocol === "https:";
  const wsProto = isSecure ? "wss:" : "ws:";
  
  // Use reverse-proxied /ws/stream on the current origin to support local, LAN, and Tailscale Serve HTTPS
  const host = window.location.host;
  return `${wsProto}//${host}/ws/stream`;
}

function getApiBaseUrl(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:8765";
  // Route through Lens reverse proxy to prevent Mixed Content issues
  return "/__stream__";
}

function main() {
  streamWindow[STATE_KEY]?.cleanup();

  injectStyle();
  initVoicesCache();
  initWebSocket();
  attachWhenReady();

  // Auto-unlock audio context on first click or touch
  window.addEventListener("click", unlockAudioContextOnGesture, { once: true, capture: true });
  window.addEventListener("touchstart", unlockAudioContextOnGesture, { once: true, capture: true });

  state.observer = new MutationObserver(attachWhenReady);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });

  streamWindow[STATE_KEY] = { cleanup };
}

function initWebSocket() {
  if (typeof WebSocket === "undefined") return;

  try {
    if (state.ws) {
      state.ws.onopen = null;
      state.ws.onmessage = null;
      state.ws.onclose = null;
      state.ws.onerror = null;
      try {
        state.ws.close();
      } catch {}
      state.ws = undefined;
    }

    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[opencode-web-stream] WebSocket connected to ${wsUrl}`);
      state.wsConnected = true;
      updateLiveButtonUI();
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerMessage(payload);
      } catch (e) {
        console.error("[opencode-web-stream] Error parsing message:", e);
      }
    };

    ws.onclose = () => {
      state.wsConnected = false;
      updateLiveButtonUI();
      scheduleReconnect();
    };

    ws.onerror = () => {
      state.wsConnected = false;
      updateLiveButtonUI();
    };

    state.ws = ws;
  } catch (e) {
    state.wsConnected = false;
    updateLiveButtonUI();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.wsReconnectTimer) return;
  state.wsReconnectTimer = setTimeout(() => {
    state.wsReconnectTimer = undefined;
    initWebSocket();
  }, 4000);
}

function handleServerMessage(msg: { type: string; data?: any }) {
  if (msg.type === "agent_progress" && msg.data) {
    const step = msg.data as ProgressStep;

    // Pulse button in speaking/executing mode
    setSpeakingState(true);

    if (state.ttsEnabled && step.speech_text) {
      speakConcise(step.speech_text, () => {
        setSpeakingState(false);
      });
    } else {
      setTimeout(() => {
        setSpeakingState(false);
      }, 2500);
    }
  } else if (msg.type === "agent_final_summary" && msg.data) {
    // Structured spoken wrap-up summary delivered by the co-speaker
    const summaryText = msg.data.summary_text || msg.data.text;
    if (summaryText) {
      setSpeakingState(true);
      if (state.ttsEnabled) {
        speakConcise(summaryText, () => {
          setSpeakingState(false);
        });
      } else {
        setTimeout(() => {
          setSpeakingState(false);
        }, 3000);
      }
    }
  } else if (msg.type === "trajectory_redirect" && msg.data) {
    // Always forward the spoken instruction: a low phonetic score is never a
    // reason to drop what KπX said.
    const text = msg.data.normalized_instruction || msg.data.original_instruction;
    if (text && !looksLikeClarificationEcho(text)) {
      injectAndSendToComposer(text);
    }
  }
}

function setSpeakingState(speaking: boolean) {
  if (speaking) {
    if ((state as any).speakingGraceTimer) {
      clearTimeout((state as any).speakingGraceTimer);
      (state as any).speakingGraceTimer = undefined;
    }
    state.isSpeaking = true;
    updateLiveButtonUI();
  } else {
    // Add a 1000ms grace period after speaking ends before re-enabling the microphone
    // This prevents the STT from picking up room echo or TTS buffer tails.
    (state as any).speakingGraceTimer = setTimeout(() => {
      state.isSpeaking = false;
      updateLiveButtonUI();
    }, 1000);
  }
}

function unlockAudioContextOnGesture() {
  if (state.audioUnlocked) return;
  state.audioUnlocked = true;

  try {
    // 1. Unlock AudioContext
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(0);
      osc.stop(0.01);
    }

    // 2. Unlock SpeechSynthesis with a near-silent micro utterance
    if ("speechSynthesis" in window) {
      const silent = new SpeechSynthesisUtterance(" ");
      silent.volume = 0.01;
      silent.rate = 2.0;
      window.speechSynthesis.speak(silent);
    }
  } catch (e) {
    console.warn("[opencode-web-stream] Audio unlock failed:", e);
  }
}

function initVoicesCache() {
  if (!("speechSynthesis" in window)) return;

  const update = () => {
    try {
      const list = window.speechSynthesis.getVoices();
      if (list && list.length > 0) {
        state.cachedVoices = list;
      }
    } catch {}
  };

  update();
  if (typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
    window.speechSynthesis.onvoiceschanged = update;
  }
}

function speakConcise(text: string, onEnd?: () => void) {
  if (!("speechSynthesis" in window)) {
    if (onEnd) onEnd();
    return;
  }

  // Temporarily pause speech recognition while the agent speaks to prevent acoustic feedback loop
  const wasListening = Boolean(state.activeLive && state.recognition);
  if (wasListening && state.recognition) {
    try {
      state.recognition.stop();
    } catch {}
  }

  try {
    // Unblock audio state if paused
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch {}

  const utterance = new SpeechSynthesisUtterance(text);
  const targetLang = resolveRecognitionLanguage();
  utterance.lang = targetLang;
  utterance.rate = 1.15;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  // Select matching voice for current language
  const voices = state.cachedVoices.length > 0 ? state.cachedVoices : window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    const langPrefix = targetLang.slice(0, 2).toLowerCase();
    const matchingVoice =
      voices.find((v) => v.lang === targetLang) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) ||
      voices.find((v) => v.lang.toLowerCase().includes(langPrefix));
    if (matchingVoice) {
      utterance.voice = matchingVoice;
    }
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    
    // Resume speech recognition after a short silence delay (300ms) to prevent catching residual echo
    setTimeout(() => {
      if (state.activeLive && !state.recognition) {
        startContinuousListening();
      }
    }, 300);

    if (onEnd) onEnd();
  };

  utterance.onend = finish;
  utterance.onerror = finish;

  // Chromium anti-freeze safety timeout
  setTimeout(() => {
    if (!finished && window.speechSynthesis.speaking) {
      try {
        window.speechSynthesis.resume();
      } catch {}
    }
  }, 1000);

  window.speechSynthesis.speak(utterance);
}

function getComposerForm(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-component="prompt-input-v2"], [data-component="session-composer"], [data-component="session-new-composer"], [data-component="session-prompt-dock"]',
  );
}

function attachWhenReady() {
  hookLangSelectorListener();

  const form = getComposerForm();
  if (!form) return;

  state.composerEl = form;

  if (form.querySelector("[data-opencode-stream-live]")) {
    updateComposerGlow();
    return;
  }

  const v2Actions = form.matches('[data-component="prompt-input-v2"]')
    ? form
        .querySelector<HTMLElement>('[data-action="prompt-attach"]')
        ?.closest<HTMLElement>("div.flex.min-w-0.flex-1.items-center.gap-1")
    : undefined;
  const actions =
    v2Actions ?? form.querySelector<HTMLElement>('[data-action="prompt-attach"]')?.parentElement;

  if (!actions) return;

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.opencodeStreamLive = "true";
  button.className = "opencode-web-stream-button";

  button.innerHTML = `
    <span class="opencode-web-stream-sr-only">Toggle Live Stream</span>
    <div class="opencode-web-stream-waves">
      <span class="wave-bar bar-1"></span>
      <span class="wave-bar bar-2"></span>
      <span class="wave-bar bar-3"></span>
      <span class="wave-bar bar-4"></span>
    </div>
  `;

  button.addEventListener("click", toggleLiveMode);

  const voiceBtn = actions.querySelector(".opencode-web-voice-plugin-button");
  if (voiceBtn && voiceBtn.nextSibling) {
    actions.insertBefore(button, voiceBtn.nextSibling);
  } else {
    actions.appendChild(button);
  }

  // Co-Speaker Narrator button (voice narration toggle)
  const narratorBtn = document.createElement("button");
  narratorBtn.type = "button";
  narratorBtn.dataset.opencodeStreamNarrator = "true";
  narratorBtn.className = "opencode-web-stream-narrator-button";
  updateNarratorButtonUI(narratorBtn);

  narratorBtn.addEventListener("click", () => {
    unlockAudioContextOnGesture();
    state.ttsEnabled = !state.ttsEnabled;
    localStorage.setItem("opencodeWebStreamMute", state.ttsEnabled ? "false" : "true");
    // Silent toggle: the narrator only ever speaks text authored by the
    // narrator sub-agent, never a UI-generated confirmation phrase.
    if (!state.ttsEnabled && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    updateNarratorButtonUI(narratorBtn);
  });

  actions.insertBefore(narratorBtn, button.nextSibling);

  state.liveButton = button;
  state.muteButton = narratorBtn;
  updateLiveButtonUI();
  updateComposerGlow();
}

function updateNarratorButtonUI(btn?: HTMLButtonElement) {
  const target = btn || state.muteButton;
  if (!target) return;
  target.classList.toggle("is-active", state.ttsEnabled);
  target.title = state.ttsEnabled
    ? "Live spoken narrator : ACTIVE (click to mute)"
    : "Live spoken narrator : MUTED (click to enable voice)";
  target.setAttribute("aria-label", target.title);
  target.innerHTML = state.ttsEnabled
    ? `<svg viewBox="0 0 20 20" fill="none" class="stream-narrator-icon" width="16" height="16"><path d="M10 2C5.58 2 2 5.58 2 10C2 14.42 5.58 18 10 18C14.42 18 18 14.42 18 10C18 5.58 14.42 2 10 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M7 10C7 8.34 8.34 7 10 7C11.66 7 13 8.34 13 10C13 11.66 11.66 13 10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="10" r="1" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 20 20" fill="none" class="stream-narrator-icon" width="16" height="16"><path d="M10 2C5.58 2 2 5.58 2 10C2 14.42 5.58 18 10 18C14.42 18 18 14.42 18 10C18 5.58 14.42 2 10 2Z" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/><path d="M4 4L16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

function toggleLiveMode() {
  unlockAudioContextOnGesture();
  state.activeLive = !state.activeLive;
  updateLiveButtonUI();
  updateComposerGlow();

  if (state.activeLive) {
    // Drop any leftover clarification residue before the mic opens, so a new
    // voice turn never re-injects the purged phonetic-clarification prefix.
    scrubComposerClarificationResidue();
    state.accumulatedTranscript = "";
    state.lastSentTranscript = "";
    startContinuousListening();
  } else {
    stopContinuousListening();
  }
}

function updateLiveButtonUI() {
  const btn = state.liveButton;
  if (!btn) return;

  btn.classList.toggle("is-active", state.activeLive);
  btn.classList.toggle("is-speaking", state.isSpeaking);
  btn.classList.remove("is-clarification");

  let statusLabel = state.wsConnected ? "Connected" : "Offline";
  if (state.activeLive) {
    if (state.isSpeaking) {
      btn.title = `Live Stream: Agent Speaking (${statusLabel})`;
      btn.setAttribute("aria-label", "Live Stream: Agent Speaking");
    } else {
      btn.title = `Live Stream: Active & Listening (${statusLabel})`;
      btn.setAttribute("aria-label", "Live Stream: Active & Listening");
    }
  } else {
    btn.title = `Live Stream: Inactive (${statusLabel}) - Click to toggle`;
    btn.setAttribute("aria-label", `Live Stream: Inactive (${statusLabel})`);
  }
  btn.setAttribute("aria-pressed", String(state.activeLive));
}

function updateComposerGlow() {
  const form = state.composerEl ?? getComposerForm();
  if (!form) return;
  form.classList.toggle("opencode-live-stream-composer-active", state.activeLive);
}

async function resolvePhoneticText(rawText: string): Promise<ResolveResponse> {
  const clean = rawText.trim();
  const fallback: ResolveResponse = {
    query: clean,
    resolved: clean,
    needs_clarification: false,
    unknown_terms: [],
    confidence: 1.0,
    candidates: [],
  };

  if (clean.length < 3) return fallback;

  // Ignore noise composed exclusively of punctuation or strange repetitions
  if (!/[a-zA-Z0-9àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]/.test(clean)) {
    return fallback;
  }

  try {
    const resolveUrl = `${getApiBaseUrl()}/api/resolve?q=${encodeURIComponent(clean)}`;
    const resp = await fetch(resolveUrl, { method: "GET" });
    if (resp.ok) {
      const data = await resp.json();
      return {
        query: clean,
        resolved: data.resolved || data.normalized || clean,
        needs_clarification: Boolean(data.needs_clarification),
        unknown_terms: Array.isArray(data.unknown_terms) ? data.unknown_terms : [],
        confidence: typeof data.confidence === "number" ? data.confidence : 1.0,
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
      };
    }
  } catch (err) {
    console.warn("[opencode-web-stream] /api/resolve call failed, falling back to raw transcript:", err);
  }

  return fallback;
}

async function sendLearnAlias(phraseHeard: string, canonicalTarget: string): Promise<boolean> {
  try {
    const resp = await fetch(`${getApiBaseUrl()}/api/learn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase_heard: phraseHeard.trim(),
        canonical_target: canonicalTarget.trim(),
        confidence: 1.0,
      }),
    });
    return resp.ok;
  } catch (err) {
    console.error("[opencode-web-stream] Failed to learn alias:", err);
    return false;
  }
}

function startContinuousListening() {
  const Recognition = streamWindow.SpeechRecognition || streamWindow.webkitSpeechRecognition;
  if (!Recognition) {
    console.warn("[opencode-web-stream] Speech Recognition not supported directly in browser.");
    return;
  }

  if (state.recognition) {
    try {
      state.recognition.stop();
    } catch {}
  }

  const rec = new Recognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = resolveRecognitionLanguage();

  rec.onresult = async (event: SpeechRecognitionEventLike) => {
    // Prevent STT from picking up the TTS output (Echo Cancellation/Mute while speaking)
    if (state.isSpeaking) {
      return;
    }

    let finalStr = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalStr += event.results[i][0].transcript;
      }
    }

    const rawCandidate = finalStr.trim();
    if (!rawCandidate || rawCandidate.length < 2) {
      return;
    }

    // Mobile stabilization: debounce to prevent choppy audio segments
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.accumulatedTranscript = rawCandidate;

    state.debounceTimer = setTimeout(async () => {
      const candidateToProcess = state.accumulatedTranscript.trim();
      state.accumulatedTranscript = "";

      if (!candidateToProcess || candidateToProcess.length < 2) {
        return;
      }

      // Deduplication: do not send identical consecutive segments
      if (candidateToProcess === state.lastSentTranscript) {
        return;
      }

      // Normal phonetic resolution via /api/resolve
      const resolution = await resolvePhoneticText(candidateToProcess);

      // Clean pass-through: NEVER block user input and NEVER inject clarification prompts into composer
      const resolvedText = resolution.resolved || candidateToProcess;
      if (!resolvedText || resolvedText.length < 2) {
        return;
      }

      // Drop STT echoes of the purged clarification heuristic (mic hearing TTS residue)
      if (looksLikeClarificationEcho(resolvedText)) {
        console.warn("[opencode-web-stream] Dropped clarification-echo transcript:", resolvedText);
        return;
      }

      state.lastSentTranscript = resolvedText;

      const currentSessionId = window.location.pathname.split('/').pop() || "";

      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          type: "voice_transcript",
          text: candidateToProcess, // Use the fully accumulated transcript, not the stale rawCandidate!
          is_final: true,
          barge_in: true,
          session_id: currentSessionId
        }));
      }

      // Do NOT inject directly. Wait for the Streamer's <INJECT> command via WebSocket.
    }, 1200);
  };

  rec.onend = () => {
    if (state.activeLive) {
      try {
        rec.lang = resolveRecognitionLanguage();
        rec.start();
      } catch {}
    }
  };

  rec.onerror = (err) => {
    console.warn("[opencode-web-stream] Speech recognition error:", err);
  };

  state.recognition = rec;
  try {
    rec.start();
  } catch (e) {
    console.error("[opencode-web-stream] Failed to start speech recognition:", e);
  }
}

function stopContinuousListening() {
  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.onerror = null;
    state.recognition.onresult = null;
    try {
      state.recognition.stop();
    } catch {}
    state.recognition = undefined;
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  setSpeakingState(false);
}

function getComposerEditor(): HTMLElement | null {
  const form = state.composerEl ?? getComposerForm();
  if (!form) return null;
  return form.querySelector<HTMLElement>(
    'textarea, [contenteditable="true"], [data-component="prompt-input"]',
  );
}

function readComposerText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    return editor.value || "";
  }
  return editor.textContent?.replace(/\u200B/g, "") ?? "";
}

function writeComposerText(editor: HTMLElement, text: string) {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  editor.textContent = text;
  editor.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
  );
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Clear composer when it still holds the purged clarification prefix from older builds. */
function scrubComposerClarificationResidue() {
  const editor = getComposerEditor();
  if (!editor) return;
  const existing = readComposerText(editor);
  if (!existing.trim()) return;
  if (!looksLikeClarificationEcho(existing)) return;
  writeComposerText(editor, "");
  console.warn("[opencode-web-stream] Scrubbed clarification residue from composer");
}

function injectAndSendToComposer(text: string) {
  const form = state.composerEl ?? getComposerForm();
  if (!form) return;

  const editor = getComposerEditor();
  if (!editor) return;

  editor.focus();
  // REPLACE, never append: appending was concatenating leftover clarification
  // prefixes with the real spoken instruction on every voice relaunch.
  writeComposerText(editor, text);

  setTimeout(() => {
    // Attempt to find a true Send button, explicitly avoiding Stop/Cancel buttons
    const selectors = 'button[type="submit"], [data-action="prompt-submit"], button[aria-label*="send" i], button[title*="send" i], button[aria-label*="Send"], button[title*="Send"]';
    const candidates = form.querySelectorAll<HTMLElement>(selectors);
    let submitBtn: HTMLElement | null = null;
    
    for (const btn of Array.from(candidates)) {
      const outerHtml = btn.outerHTML.toLowerCase();
      // If the button explicitly mentions stop or cancel, DO NOT treat it as a submit button.
      if (outerHtml.includes("stop") || outerHtml.includes("cancel") || outerHtml.includes("arrêter") || outerHtml.includes("annuler")) {
        continue;
      }
      submitBtn = btn;
      break;
    }

    if (submitBtn && !(submitBtn as HTMLButtonElement).disabled) {
      submitBtn.click();
    } else {
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(enterEvent);
    }
  }, 100);
}

function injectStyle() {
  if (document.getElementById("opencode-web-stream-style")) return;

  const style = document.createElement("style");
  style.id = "opencode-web-stream-style";
  style.textContent = `
    .opencode-web-stream-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* Live Stream Button */
    .opencode-web-stream-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border-radius: 8px;
      background: transparent;
      color: currentColor;
      opacity: 0.6;
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      margin-left: 0.25rem;
      flex: 0 0 auto;
    }
    .opencode-web-stream-button:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
    }

    /* Narrator Co-Speaker Button */
    .opencode-web-stream-narrator-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 6px;
      background: transparent;
      color: currentColor;
      opacity: 0.5;
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      margin-left: 0.2rem;
      flex: 0 0 auto;
    }
    .opencode-web-stream-narrator-button:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
    }
    .opencode-web-stream-narrator-button.is-active {
      color: #10b981; /* emerald-500 */
      opacity: 0.9;
    }

    /* Animated Soundwaves */
    .opencode-web-stream-waves {
      display: flex;
      align-items: center;
      gap: 2px;
      height: 14px;
    }
    .opencode-web-stream-waves .wave-bar {
      width: 2.5px;
      height: 6px;
      background-color: currentColor;
      border-radius: 2px;
      transition: all 0.25s ease;
    }

    /* INACTIVE: Greyed / static */
    .opencode-web-stream-button:not(.is-active) .wave-bar {
      opacity: 0.45;
      height: 5px;
      animation: none !important;
    }

    /* ACTIVE (Listening): Cyan / Turquoise waves */
    .opencode-web-stream-button.is-active {
      opacity: 1;
      color: #06b6d4; /* cyan-500 */
      background: rgba(6, 182, 212, 0.12);
      border-color: rgba(6, 182, 212, 0.35);
      box-shadow: 0 0 10px rgba(6, 182, 212, 0.25);
    }
    .opencode-web-stream-button.is-active .wave-bar {
      animation: soundwave-listen 1.2s ease-in-out infinite alternate;
    }

    /* SPEAKING / PROGRESS: Violet / Magenta pulse */
    .opencode-web-stream-button.is-speaking {
      color: #c084fc !important; /* purple-400 */
      background: rgba(192, 132, 252, 0.2) !important;
      border-color: rgba(192, 132, 252, 0.5) !important;
      box-shadow: 0 0 14px rgba(192, 132, 252, 0.4) !important;
    }
    .opencode-web-stream-button.is-speaking .wave-bar {
      animation: soundwave-speak 0.6s ease-in-out infinite alternate !important;
    }

    .wave-bar.bar-1 { animation-delay: 0.0s; }
    .wave-bar.bar-2 { animation-delay: 0.2s; }
    .wave-bar.bar-3 { animation-delay: 0.4s; }
    .wave-bar.bar-4 { animation-delay: 0.1s; }

    @keyframes soundwave-listen {
      0% { height: 4px; opacity: 0.5; }
      100% { height: 13px; opacity: 1; }
    }

    @keyframes soundwave-speak {
      0% { height: 3px; transform: scaleY(0.4); opacity: 0.6; }
      100% { height: 16px; transform: scaleY(1.2); opacity: 1; }
    }

    /* Subtle turquoise / cyan border glow on native composer when Live is active */
    .opencode-live-stream-composer-active {
      box-shadow: 0 0 0 1.5px rgba(6, 182, 212, 0.45), 0 0 14px rgba(6, 182, 212, 0.15) !important;
      transition: box-shadow 0.3s ease !important;
    }
  `;

  document.head.appendChild(style);
  state.style = style;
}

function cleanup() {
  state.observer?.disconnect();
  stopContinuousListening();
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = undefined;
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
    state.ws = undefined;
  }
  state.liveButton?.remove();
  const form = state.composerEl ?? getComposerForm();
  form?.classList.remove("opencode-live-stream-composer-active");
  state.style?.remove();
}

main();
