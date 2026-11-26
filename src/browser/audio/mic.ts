import { log } from "../log.js";

/**
 * Microphone capture, voice activity detection and utterance segmentation.
 *
 * Three problems are solved here.
 *
 * **Echo.** A browser only cancels audio it believes is remote, so playing
 * synthesized speech through an `AudioContext` leaves it audible to the
 * microphone and the agent interrupts itself. Routing the player's output
 * through a loopback `RTCPeerConnection` makes it remote as far as the audio
 * stack is concerned, and the canceller removes it.
 *
 * **Detection.** The speech threshold is not a constant. The noise floor is
 * estimated continuously from the quietest recent frames, and speech is
 * energy that stands a margin above that floor for long enough to not be a
 * keyboard click. A loud room and a silent one therefore behave the same.
 *
 * **Segmentation.** Recording runs continuously with a small pre-roll buffer,
 * so the first syllable is never clipped, and an utterance is closed after a
 * hangover of silence rather than at a fixed interval.
 */

export type MicEvents = {
  /** Enough energy to suspect speech: used to duck, not to act. */
  onSpeechStart: () => void;
  /** Speech confirmed by duration: this is what triggers a barge-in. */
  onSpeechConfirmed: () => void;
  /** An utterance closed; the blob holds the audio including pre-roll. */
  onUtterance: (blob: Blob, meta: { durationMs: number; startedDuringPlayback: boolean }) => void;
  onSilence: () => void;
  onLevel: (level: number) => void;
  onError: (error: unknown) => void;
  onLoopback?: (active: boolean) => void;
};

export type MicOptions = {
  /** Reference stream (the player's output) for echo cancellation. */
  referenceStream?: MediaStream;
  /** Sustained energy above the floor before speech is confirmed. */
  confirmMs?: number;
  /** Sustained energy required during agent playback to trigger barge-in. */
  duckedConfirmMs?: number;
  /** Silence before an utterance is considered finished. */
  hangoverMs?: number;
  /** Audio kept before speech onset. */
  prerollMs?: number;
  /** Utterances shorter than this are discarded as noise. */
  minUtteranceMs?: number;
  /** Hard cap so a stuck detector cannot record forever. */
  maxUtteranceMs?: number;
  /** Margin in decibels above the estimated noise floor to start speech. */
  marginDb?: number;
  /** Lower margin while speech is already active (hysteresis hold). */
  holdMarginDb?: number;
  /** Extra margin while the agent is speaking, so only real speech cuts in. */
  duckedMarginDb?: number;
  /** Lower margin while speech is active during agent playback. */
  duckedHoldMarginDb?: number;
};

const FRAME_MS = 32;
const FLOOR_WINDOW = 120; // ~4 s of frames
const WORKLET_CODE = `
class OwsVadMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = 0;
    this._n = 0;
    this._target = Math.max(128, Math.round((sampleRate || 48000) * 0.032));
    this._buf = new Float32Array(this._target);
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      let off = 0;
      while (off < ch.length) {
        const take = Math.min(ch.length - off, this._target - this._n);
        for (let i = 0; i < take; i++) {
          const v = ch[off + i];
          this._acc += v * v;
          this._buf[this._n + i] = v;
        }
        this._n += take;
        off += take;
        if (this._n >= this._target) {
          const rms = Math.sqrt(this._acc / this._n);
          const frame = this._buf.slice(0, this._n);
          this.port.postMessage({ rms, pcm: frame }, [frame.buffer]);
          this._acc = 0;
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("ows-vad-meter", OwsVadMeter);
`;

export class Microphone {
  private stream?: MediaStream;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private worklet?: AudioWorkletNode;
  private workletUrl?: string;
  private source?: MediaStreamAudioSourceNode;
  private loopback?: { local: RTCPeerConnection; remote: RTCPeerConnection; audio?: HTMLAudioElement };
  private recorder?: MediaRecorder;
  private timer?: number;
  private buffer?: Float32Array<ArrayBuffer>;
  private readonly energies: number[] = [];
  private speaking = false;
  private confirmed = false;
  private speechStartedAt = 0;
  private lastVoiceAt = 0;
  private chunks: Blob[] = [];
  private preroll: Blob[] = [];
  private headerChunk?: Blob;
  private pcmChunks: Float32Array[] = [];
  private pcmPreroll: Float32Array[] = [];
  private useWorkletPcm = false;
  private ducked = false;
  private duckedUntil = 0;
  private startedDuringPlayback = false;
  private running = false;
  private readonly opts: Required<Omit<MicOptions, "referenceStream">>;

  constructor(
    opts: MicOptions,
    private readonly events: MicEvents,
  ) {
    this.opts = {
      confirmMs: opts.confirmMs ?? 220,
      duckedConfirmMs: opts.duckedConfirmMs ?? 450,
      hangoverMs: opts.hangoverMs ?? 550,
      prerollMs: opts.prerollMs ?? 400,
      minUtteranceMs: opts.minUtteranceMs ?? 380,
      maxUtteranceMs: opts.maxUtteranceMs ?? 0,
      marginDb: opts.marginDb ?? 13,
      holdMarginDb: opts.holdMarginDb ?? 8,
      duckedMarginDb: opts.duckedMarginDb ?? 26,
      duckedHoldMarginDb: opts.duckedHoldMarginDb ?? 15,
    };
    this.referenceStream = opts.referenceStream;
  }

  private referenceStream?: MediaStream;

  get active(): boolean {
    return this.running;
  }

  setReferenceStream(stream: MediaStream | undefined) {
    this.referenceStream = stream;
  }

  /** Raise the bar while the agent speaks (+900ms tail) so speaker echo never self-triggers. */
  setDucked(ducked: boolean) {
    if (ducked) {
      this.ducked = true;
      this.duckedUntil = Date.now() + 900;
    } else {
      this.ducked = false;
      this.duckedUntil = Date.now() + 900;
    }
  }

  private get isDucked(): boolean {
    return this.ducked || Date.now() < this.duckedUntil;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      // The loopback must exist before capture so the canceller knows the reference.
      const loopbackOk = await this.setupLoopback();
      this.events.onLoopback?.(loopbackOk);
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctor();
      if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.startRecorder();
      this.running = true;
      const startedWorklet = await this.startWorklet();
      if (!startedWorklet) {
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.2;
        this.source.connect(this.analyser);
        this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
        this.timer = window.setInterval(() => this.tick(), FRAME_MS);
      }
      log.info("microphone started", { worklet: startedWorklet });
    } catch (err) {
      log.error("microphone start failed", err);
      this.events.onError(err);
      await this.stop();
      throw err;
    }
  }

  /**
   * A peer connection whose only job is to make the player's audio count as
   * remote, which is the condition for the browser's canceller to remove it.
   */
  private async setupLoopback(): Promise<boolean> {
    if (!this.referenceStream) return false;
    if (this.loopback) return true;
    try {
      const local = new RTCPeerConnection();
      const remote = new RTCPeerConnection();
      const audio = new Audio();
      (audio as unknown as { playsInline?: boolean }).playsInline = true;
      audio.autoplay = true;
      audio.muted = false;
      audio.volume = 1.0;
      local.onicecandidate = (e) => e.candidate && remote.addIceCandidate(e.candidate).catch(() => undefined);
      remote.onicecandidate = (e) => e.candidate && local.addIceCandidate(e.candidate).catch(() => undefined);
      for (const track of this.referenceStream.getAudioTracks()) local.addTrack(track, this.referenceStream);
      remote.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => undefined);
      };
      const offer = await local.createOffer();
      await local.setLocalDescription(offer);
      await remote.setRemoteDescription(offer);
      const answer = await remote.createAnswer();
      await remote.setLocalDescription(answer);
      await local.setRemoteDescription(answer);
      this.loopback = { local, remote, audio };
      log.debug("echo cancellation loopback established");
      return true;
    } catch (err) {
      // Without the loopback, echo suppression falls back to ducking alone.
      log.warn("loopback setup failed, relying on ducking", err);
      return false;
    }
  }

  private startRecorder() {
    if (!this.stream) return;
    const mimeType = pickMimeType();
    try {
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      log.warn("MediaRecorder unavailable", err);
      return;
    }
    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      if (!this.headerChunk) this.headerChunk = event.data;
      if (this.speaking) {
        this.chunks.push(event.data);
      } else {
        this.preroll.push(event.data);
        const maxChunks = Math.ceil(this.opts.prerollMs / 250) + 1;
        while (this.preroll.length > maxChunks) this.preroll.shift();
      }
    };
    this.recorder.onerror = (event) => this.events.onError(event);
    try {
      this.recorder.start(250);
    } catch (err) {
      log.warn("recorder start failed", err);
    }
  }

  private async startWorklet(): Promise<boolean> {
    if (!this.context?.audioWorklet || !this.source || typeof AudioWorkletNode === "undefined") return false;
    try {
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      this.workletUrl = URL.createObjectURL(blob);
      await this.context.audioWorklet.addModule(this.workletUrl);
      if (!this.running || !this.context || !this.source) return false;
      this.worklet = new AudioWorkletNode(this.context, "ows-vad-meter");
      this.useWorkletPcm = true;
      this.worklet.port.onmessage = (event) => {
        const payload = event.data as number | { rms?: number; pcm?: Float32Array };
        if (typeof payload === "number") {
          this.processRms(payload);
          return;
        }
        if (payload && typeof payload.rms === "number") {
          if (payload.pcm instanceof Float32Array) {
            if (this.speaking) {
              this.pcmChunks.push(payload.pcm);
            } else {
              this.pcmPreroll.push(payload.pcm);
              const maxFrames = Math.max(2, Math.ceil(this.opts.prerollMs / FRAME_MS));
              while (this.pcmPreroll.length > maxFrames) this.pcmPreroll.shift();
            }
          }
          this.processRms(payload.rms);
        }
      };
      this.source.connect(this.worklet);
      return true;
    } catch (err) {
      log.debug("AudioWorklet unavailable, using AnalyserNode", err);
      this.cleanupWorklet();
      return false;
    }
  }

  private cleanupWorklet() {
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = undefined;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = undefined;
    }
  }

  private tick() {
    if (!this.analyser || !this.buffer) return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    this.processRms(Math.sqrt(sum / this.buffer.length));
  }

  private processRms(rms: number) {
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    this.events.onLevel(Math.min(1, Math.max(0, (db + 60) / 60)));

    this.energies.push(db);
    if (this.energies.length > FLOOR_WINDOW) this.energies.shift();
    const floor = noiseFloor(this.energies);
    const duckedNow = this.isDucked;
    const margin = this.speaking
      ? (duckedNow ? this.opts.duckedHoldMarginDb : this.opts.holdMarginDb)
      : (duckedNow ? this.opts.duckedMarginDb : this.opts.marginDb);
    const isVoice = db > floor + margin;
    const now = Date.now();
    const confirmNeeded = duckedNow ? this.opts.duckedConfirmMs : this.opts.confirmMs;

    if (isVoice) {
      this.lastVoiceAt = now;
      if (!this.speaking) {
        this.speaking = true;
        this.confirmed = false;
        this.speechStartedAt = now;
        this.startedDuringPlayback = duckedNow;
        this.chunks = this.preroll.splice(0, this.preroll.length);
        this.pcmChunks = this.pcmPreroll.splice(0, this.pcmPreroll.length);
        this.events.onSpeechStart();
      } else if (!this.confirmed && now - this.speechStartedAt >= confirmNeeded) {
        this.confirmed = true;
        this.events.onSpeechConfirmed();
      }
      if (this.opts.maxUtteranceMs > 0 && now - this.speechStartedAt > this.opts.maxUtteranceMs) this.closeUtterance(now);
      return;
    }

    if (this.speaking && now - this.lastVoiceAt >= this.opts.hangoverMs) this.closeUtterance(now);
  }

  private closeUtterance(now: number) {
    const durationMs = this.lastVoiceAt - this.speechStartedAt;
    const wasConfirmed = this.confirmed;
    const startedDuringPlayback = this.startedDuringPlayback;
    this.speaking = false;
    this.confirmed = false;
    const chunks = this.chunks;
    this.chunks = [];
    const pcmFrames = this.pcmChunks;
    this.pcmChunks = [];
    this.events.onSilence();
    if (!wasConfirmed || durationMs < this.opts.minUtteranceMs || (pcmFrames.length === 0 && chunks.length === 0)) {
      log.debug("utterance discarded", { durationMs, confirmed: wasConfirmed });
      return;
    }
    if (this.useWorkletPcm && pcmFrames.length > 0 && this.context) {
      const wavBlob = encodeWav16k(pcmFrames, this.context.sampleRate || 48000);
      this.events.onUtterance(wavBlob, { durationMs: now - this.speechStartedAt, startedDuringPlayback });
      return;
    }
    // Fallback MediaRecorder path: ensure container EBML header chunk #0 is preserved.
    const emit = () => {
      const out = this.headerChunk && chunks[0] !== this.headerChunk ? [this.headerChunk, ...chunks] : chunks;
      const blob = new Blob(out, { type: out[0]?.type || "audio/webm" });
      this.events.onUtterance(blob, { durationMs: now - this.speechStartedAt, startedDuringPlayback });
    };
    if (this.recorder && this.recorder.state === "recording") {
      const onNext = (event: BlobEvent) => {
        this.recorder?.removeEventListener("dataavailable", onNext as EventListener);
        if (event.data && event.data.size) chunks.push(event.data);
        emit();
      };
      this.recorder.addEventListener("dataavailable", onNext as EventListener, { once: true });
      try {
        this.recorder.requestData();
      } catch {
        this.recorder.removeEventListener("dataavailable", onNext as EventListener);
        emit();
      }
    } else {
      emit();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = undefined;
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // already stopped
      }
    }
    this.recorder = undefined;
    this.chunks = [];
    this.preroll = [];
    this.headerChunk = undefined;
    this.pcmChunks = [];
    this.pcmPreroll = [];
    this.useWorkletPcm = false;
    this.energies.length = 0;
    this.speaking = false;
    this.confirmed = false;
    this.cleanupWorklet();
    this.source?.disconnect();
    this.source = undefined;
    this.analyser = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = undefined;
    }
    if (this.loopback) {
      if (this.loopback.audio) {
        try {
          this.loopback.audio.pause();
          this.loopback.audio.srcObject = null;
        } catch {
          // ignore
        }
      }
      this.loopback.local.close();
      this.loopback.remote.close();
      this.loopback = undefined;
    }
    this.events.onLoopback?.(false);
  }
}

/**
 * The noise floor is the low quantile of recent frame energies: quiet frames
 * dominate any recording, so the 20th percentile tracks the room and ignores
 * speech. With too little history, assume a quiet room rather than deafness.
 */
export function noiseFloor(energies: number[], quantile = 0.2): number {
  if (energies.length < 8) return -55;
  const sorted = [...energies].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * quantile));
  return sorted[index];
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

/** Downsample PCM float frames to a standard 16 kHz mono 16-bit RIFF WAV Blob. */
export function encodeWav16k(frames: Float32Array[], sourceRate: number): Blob {
  let total = 0;
  for (const f of frames) total += f.length;
  const targetRate = 16000;
  const ratio = sourceRate > 0 ? sourceRate / targetRate : 3;
  const outLen = Math.max(1, Math.floor(total / ratio));
  const buf = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + outLen * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, outLen * 2, true);
  // Flatten once for fast linear-interpolated resampling.
  const mono = new Float32Array(total);
  let pos = 0;
  for (const f of frames) {
    mono.set(f, pos);
    pos += f.length;
  }
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.min(total - 1, Math.floor(srcIdx));
    const i1 = Math.min(total - 1, i0 + 1);
    const frac = srcIdx - i0;
    const sample = mono[i0] * (1 - frac) + mono[i1] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
