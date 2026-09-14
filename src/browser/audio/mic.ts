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
};

export type MicOptions = {
  /** Reference stream (the player's output) for echo cancellation. */
  referenceStream?: MediaStream;
  /** Sustained energy above the floor before speech is confirmed. */
  confirmMs?: number;
  /** Silence before an utterance is considered finished. */
  hangoverMs?: number;
  /** Audio kept before speech onset. */
  prerollMs?: number;
  /** Utterances shorter than this are discarded as noise. */
  minUtteranceMs?: number;
  /** Hard cap so a stuck detector cannot record forever. */
  maxUtteranceMs?: number;
  /** Margin in decibels above the estimated noise floor. */
  marginDb?: number;
  /** Extra margin while the agent is speaking, so only real speech cuts in. */
  duckedMarginDb?: number;
};

const FRAME_MS = 32;
const FLOOR_WINDOW = 120; // ~4 s of frames

export class Microphone {
  private stream?: MediaStream;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private source?: MediaStreamAudioSourceNode;
  private loopback?: { local: RTCPeerConnection; remote: RTCPeerConnection };
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
  private ducked = false;
  private startedDuringPlayback = false;
  private running = false;
  private readonly opts: Required<Omit<MicOptions, "referenceStream">>;

  constructor(
    opts: MicOptions,
    private readonly events: MicEvents,
  ) {
    this.opts = {
      confirmMs: opts.confirmMs ?? 320,
      hangoverMs: opts.hangoverMs ?? 850,
      prerollMs: opts.prerollMs ?? 400,
      minUtteranceMs: opts.minUtteranceMs ?? 450,
      maxUtteranceMs: opts.maxUtteranceMs ?? 30000,
      marginDb: opts.marginDb ?? 9,
      duckedMarginDb: opts.duckedMarginDb ?? 16,
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

  /** Raise the bar while the agent speaks, so only deliberate speech cuts in. */
  setDucked(ducked: boolean) {
    this.ducked = ducked;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      // The loopback must exist before capture so the canceller knows the reference.
      await this.setupLoopback();
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
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.2;
      this.source.connect(this.analyser);
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
      this.startRecorder();
      this.running = true;
      this.timer = window.setInterval(() => this.tick(), FRAME_MS);
      log.info("microphone started");
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
  private async setupLoopback(): Promise<void> {
    if (!this.referenceStream || this.loopback) return;
    try {
      const local = new RTCPeerConnection();
      const remote = new RTCPeerConnection();
      local.onicecandidate = (e) => e.candidate && remote.addIceCandidate(e.candidate).catch(() => undefined);
      remote.onicecandidate = (e) => e.candidate && local.addIceCandidate(e.candidate).catch(() => undefined);
      for (const track of this.referenceStream.getAudioTracks()) local.addTrack(track, this.referenceStream);
      remote.ontrack = (event) => {
        const audio = new Audio();
        audio.srcObject = event.streams[0];
        audio.autoplay = true;
        void audio.play().catch(() => undefined);
      };
      const offer = await local.createOffer();
      await local.setLocalDescription(offer);
      await remote.setRemoteDescription(offer);
      const answer = await remote.createAnswer();
      await remote.setLocalDescription(answer);
      await local.setRemoteDescription(answer);
      this.loopback = { local, remote };
      log.debug("echo cancellation loopback established");
    } catch (err) {
      // Without the loopback, echo suppression falls back to ducking alone.
      log.warn("loopback setup failed, relying on ducking", err);
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

  private tick() {
    if (!this.analyser || !this.buffer) return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sum / this.buffer.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    this.events.onLevel(Math.min(1, Math.max(0, (db + 60) / 60)));

    this.energies.push(db);
    if (this.energies.length > FLOOR_WINDOW) this.energies.shift();
    const floor = noiseFloor(this.energies);
    const margin = this.ducked ? this.opts.duckedMarginDb : this.opts.marginDb;
    const isVoice = db > floor + margin;
    const now = Date.now();

    if (isVoice) {
      this.lastVoiceAt = now;
      if (!this.speaking) {
        this.speaking = true;
        this.confirmed = false;
        this.speechStartedAt = now;
        this.startedDuringPlayback = this.ducked;
        this.chunks = this.preroll.splice(0, this.preroll.length);
        this.events.onSpeechStart();
      } else if (!this.confirmed && now - this.speechStartedAt >= this.opts.confirmMs) {
        this.confirmed = true;
        this.events.onSpeechConfirmed();
      }
      if (now - this.speechStartedAt > this.opts.maxUtteranceMs) this.closeUtterance(now);
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
    this.events.onSilence();
    if (!wasConfirmed || durationMs < this.opts.minUtteranceMs || chunks.length === 0) {
      log.debug("utterance discarded", { durationMs, confirmed: wasConfirmed });
      return;
    }
    // Flush the recorder so the closing chunk is included before emitting.
    const emit = () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
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
    this.energies.length = 0;
    this.speaking = false;
    this.confirmed = false;
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
      this.loopback.local.close();
      this.loopback.remote.close();
      this.loopback = undefined;
    }
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
