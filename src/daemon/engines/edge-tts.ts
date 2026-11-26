import { randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { Agent as HttpsAgent } from "node:https";
import WebSocket from "ws";

/**
 * Built-in Microsoft Edge Read Aloud WebSocket TTS client.
 *
 * Implements Edge's v2 `Sec-MS-GEC` DRM token (`CS64-SHA256`), streams
 * `audio-24khz-48kbitrate-mono-mp3` audio chunks, and captures exact
 * `WordBoundary` timings (`offsetMs`, `durationMs`, `text`) so barge-in can
 * recover the exact word the user heard before interrupting.
 */

const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH_SEC = 11644473600n;
const TICKS_PER_SEC = 10_000_000n;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];

const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: Array<[number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

export type WordBoundary = {
  offsetMs: number;
  durationMs: number;
  text: string;
};

export type EdgeTtsOutput = {
  bytes: Buffer;
  contentType: string;
  boundaries: WordBoundary[];
};

let clockSkewSec = 0;

const edgeHttpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 6,
  keepAliveMsecs: 30_000,
});

// Pre-warm IPv4 DNS lookup once at daemon startup so first TTS avoids DNS stall.
lookup("speech.platform.bing.com", { family: 4 }, () => undefined);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function rol16(x: number): number {
  return ((x << 16) | (x >>> 16)) >>> 0;
}

function sigma0(x: number): number {
  return (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
}

function sigma1(x: number): number {
  return (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
}

function expandSha256Schedule(words: number[], firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
  }
}

function sha256Rounds(state: number[], words: number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + s1 + ch + constants[i] + words[i]) >>> 0;
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (s0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function sha256Init(data7: Buffer): number[] {
  const words = new Array<number>(64).fill(0);
  words[14] = (data7[0] << 16) | (data7[1] << 8) | data7[2];
  words[15] = data7.readUInt32BE(3);
  for (let i = 16; i < 30; i++) {
    let val = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      val += i === 16 ? (sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : sigma1(words[i - 2]);
    }
    if (i - 7 >= 14) val += words[i - 7];
    if (i - 15 >= 14) {
      val += i === 29 ? (sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : sigma0(words[i - 15]);
    }
    words[i] = val >>> 0;
  }
  words[30] =
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0;
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function customSha256Digest(data: Buffer): Buffer {
  const length = 57 + data.length;
  const tail = data.subarray(7);
  const padZeroCount = (55 - (length % 64) + 64) % 64;
  const padded = Buffer.alloc(tail.length + 1 + padZeroCount + 8);
  tail.copy(padded, 0);
  padded[tail.length] = 0x80;
  padded.writeBigUInt64BE(BigInt(length) * 8n, padded.length - 8);

  let state = sha256Init(data.subarray(0, 7));
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = padded.readUInt32BE(offset + i * 4);
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }
  const out = Buffer.alloc(32);
  state.forEach((v, idx) => out.writeUInt32BE(v, idx * 4));
  return out;
}

function wordsLe4Even(data: Buffer): number[] {
  const pad = (-data.length % 4 + 4) % 4;
  const padded = pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data;
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 4) out.push(padded.readUInt32LE(i));
  if (out.length % 2 === 1) out.push(0);
  return out;
}

function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factorA = Math.imul(keyA, CS64_FACTOR) >>> 0;
  const factorB = Math.imul(keyB, CS64_FACTOR) >>> 0;

  const terms: number[] = [];
  const offsets: number[] = [];
  CS64_COEFFICIENTS.forEach(([coeff, off], idx) => {
    terms.push(Math.imul(coeff, idx % 2 === 0 ? factorA : factorB) >>> 0);
    offsets.push(off >>> 0);
  });

  const extra = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]));
  extra.forEach((word, idx) => {
    let term = Math.imul(word, idx % 2 === 0 ? keyA : keyB) >>> 0;
    let offset = Math.imul(rol16(word), idx % 2 === 0 ? 0xef0569fb : 0xc31713db) >>> 0;
    if (idx === 0) {
      term = (term + Math.imul(CS64_ADJUSTMENT0, factorA)) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  });

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;
    let tb = (Math.imul(state, keyB) + y) >>> 0;
    tb = Math.imul(rol16(tb), 0xa27416f5) >>> 0;
    tb = Math.imul(rol16(tb), 0xd38396ff) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(tb), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

export function generateSecMsGecV2(unixTimestampSec?: number): string {
  const unixSec = unixTimestampSec !== undefined ? Math.floor(unixTimestampSec) : Math.floor(Date.now() / 1000) + clockSkewSec;
  let ticks = BigInt(unixSec) + WIN_EPOCH_SEC;
  ticks -= ticks % 300n;
  ticks *= TICKS_PER_SEC;
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const digest = customSha256Digest(data);
  const [cs0, cs1] = cs64Digest(data, digest);
  const csBuf = Buffer.alloc(8);
  csBuf.writeUInt32LE(cs0, 0);
  csBuf.writeUInt32LE(cs1, 4);
  return `${csBuf.toString("hex").toUpperCase()}-${digest.toString("hex").toUpperCase()}`;
}

function generateMuid(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

function dateToString(): string {
  return new Date().toUTCString().replace("GMT", "UTC");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

function speedToRate(speed: number): string {
  const pct = Math.round((speed - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function buildSsml(text: string, voice: string, rate: string): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    escapeXml(text) +
    "</prosody></voice></speak>"
  );
}

function parseHeaders(headerText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

export function adjustClockSkewFromDateHeader(dateHeader: string | undefined, nowMs = Date.now()): boolean {
  if (!dateHeader) return false;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return false;
  clockSkewSec = Math.round((serverMs - nowMs) / 1000);
  return true;
}

export function normalizeEdgeVoice(voice: string | undefined, lang?: string): string {
  if (voice && /^[a-z]{2,3}-[A-Z]{2}-.*Neural$/i.test(voice)) return voice;
  const code = (lang ?? "").toLowerCase().split(/[-_]/)[0];
  if (code === "en") return "en-US-EmmaMultilingualNeural";
  return "fr-FR-VivienneMultilingualNeural";
}

export async function synthesizeEdgeTts(
  text: string,
  opts: { voice?: string; lang?: string; speed?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<EdgeTtsOutput> {
  const voice = normalizeEdgeVoice(opts.voice, opts.lang);
  const rate = speedToRate(opts.speed ?? 1.0);
  const timeoutMs = opts.timeoutMs ?? 20000;

  try {
    return await runEdgeWs(text, voice, rate, timeoutMs, opts.signal);
  } catch (err) {
    if (err instanceof Edge403Error && adjustClockSkewFromDateHeader(err.serverDate)) {
      return await runEdgeWs(text, voice, rate, timeoutMs, opts.signal);
    }
    throw err;
  }
}

class Edge403Error extends Error {
  constructor(readonly serverDate?: string) {
    super("edge-tts HTTP 403");
  }
}

function runEdgeWs(
  text: string,
  voice: string,
  rate: string,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<EdgeTtsOutput> {
  return new Promise((resolve, reject) => {
    const connId = randomUUID().replace(/-/g, "");
    const url =
      `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connId}` +
      `&Sec-MS-GEC=${generateSecMsGecV2()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const ws = new WebSocket(url, {
      agent: edgeHttpsAgent,
      family: 4,
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`,
        Cookie: `muid=${generateMuid()};`,
      },
    });

    const audioChunks: Buffer[] = [];
    const boundaries: WordBoundary[] = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (audioChunks.length === 0) {
        reject(new Error("edge-tts returned no audio"));
        return;
      }
      resolve({
        bytes: Buffer.concat(audioChunks),
        contentType: "audio/mpeg",
        boundaries,
      });
    };

    const onAbort = () => fail(outerSignal?.reason ?? new Error("edge-tts aborted"));
    if (outerSignal?.aborted) {
      onAbort();
      return;
    }
    outerSignal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => fail(new Error("edge-tts timeout")), timeoutMs);

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 403) {
        fail(new Edge403Error(typeof res.headers.date === "string" ? res.headers.date : undefined));
      } else {
        fail(new Error(`edge-tts HTTP ${res.statusCode ?? "unknown"}`));
      }
    });

    ws.on("open", () => {
      const cfgMsg =
        `X-Timestamp:${dateToString()}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
      ws.send(cfgMsg);

      const ssml = buildSsml(text, voice, rate);
      const ssmlMsg =
        `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${dateToString()}Z\r\n` +
        "Path:ssml\r\n\r\n" +
        ssml;
      ws.send(ssmlMsg);
    });

    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      if (!isBinary) {
        const textData = buf.toString("utf8");
        const sep = textData.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const headers = parseHeaders(textData.slice(0, sep));
        const body = textData.slice(sep + 4);
        if (headers.path === "audio.metadata") {
          try {
            const parsed = JSON.parse(body) as { Metadata?: Array<{ Type?: string; Data?: { Offset?: number; Duration?: number; text?: { Text?: string } } }> };
            for (const item of parsed.Metadata ?? []) {
              if (item.Type === "WordBoundary" && item.Data?.text?.Text) {
                boundaries.push({
                  offsetMs: Math.round((item.Data.Offset ?? 0) / 10_000),
                  durationMs: Math.round((item.Data.Duration ?? 0) / 10_000),
                  text: item.Data.text.Text,
                });
              }
            }
          } catch {
            // malformed metadata frame
          }
        } else if (headers.path === "turn.end") {
          succeed();
        }
        return;
      }

      if (buf.length < 2) return;
      const headerLen = buf.readUInt16BE(0);
      if (2 + headerLen > buf.length) return;
      const headers = parseHeaders(buf.subarray(2, 2 + headerLen).toString("utf8"));
      if (headers.path !== "audio") return;
      const payload = buf.subarray(2 + headerLen);
      if (payload.length > 0) audioChunks.push(payload);
    });

    ws.on("error", (err) => fail(err));
    ws.on("close", () => {
      if (!settled) succeed();
    });
  });
}
