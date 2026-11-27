/**
 * Low-level voice transport.
 *
 * Owns the streaming handshake, request framing and audio response parsing for
 * the upstream speech service. Callers depend only on synthesizeVoice(), so the
 * transport can be replaced without touching chat logic or UI code.
 *
 * The module deliberately keeps protocol details isolated and never logs text
 * content, request identifiers or service credentials.
 */

import { connect } from "cloudflare:sockets";

const HOST = "speech.platform.bing.com";
const PORT = 443;
const PATH = "/consumer/speech/synthesize/readaloud/edge/v1";
const WS_HOST_HEADER = "speech.platform.bing.com";
const SERVICE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const TOKEN_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const TIMEOUT_MS = 12000;
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;

const PREFIX = Uint8Array.from(
  atob("Q29weXJpZ2h0IChDKSBNaWNyb3NvZnQgQ29ycG9yYXRpb24uIEFsbCByaWdodHMgcmVzZXJ2ZWQu"),
  (char) => char.charCodeAt(0),
);

const COEFFICIENTS = [
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

const mul = Math.imul;
const rol16 = (value) => ((value << 16) | (value >>> 16)) >>> 0;

function toHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function randomHex(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function randomBase64(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function cs64Digest(data, shaDigest) {
  const keyA = (readUint32LE(shaDigest, 0) | 1) >>> 0;
  const keyB = (readUint32LE(shaDigest, 4) | 1) >>> 0;
  const factors = [
    mul(keyA, 0x82893933) >>> 0,
    mul(keyB, 0x82893933) >>> 0,
  ];

  const terms = COEFFICIENTS.map(([coefficient], index) =>
    mul(coefficient, factors[index % 2]) >>> 0
  );
  const offsets = COEFFICIENTS.map(([, offset]) => offset);
  const padded = new Uint8Array(Math.ceil((data.length + 1) / 8) * 8);
  padded.set(data, 1);

  for (let index = 0; index < padded.length / 4; index += 1) {
    const word = readUint32LE(padded, index * 4);
    const even = index % 2 === 0;
    let term = mul(word, even ? keyA : keyB);
    let offset = mul(rol16(word), even ? 0xef0569fb : 0xc31713db);

    if (index === 0) {
      term = (term + mul(0xf2f90b1a, factors[0])) >>> 0;
      offset = (offset + 0x0b1a0000) >>> 0;
    }

    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;

  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16((offsets[index] + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc = (swapAcc + mul(rol16(q), 0xc3efea97) + q) >>> 0;

    t = rol16((offsets[index + 1] + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    for (const constant of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = mul(rol16(state), constant) >>> 0;
    }
    acc = (acc + state) >>> 0;

    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5) >>> 0;
    t = mul(rol16(t), 0xd38396ff) >>> 0;
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  const result = new Uint8Array(8);
  writeUint32LE(result, 0, (swapLast ^ state) >>> 0);
  writeUint32LE(result, 4, (swapAcc ^ acc) >>> 0);
  return result;
}

/** Build the short-lived access token required by the upstream handshake. */
export async function generateAccessToken(unixSeconds = Date.now() / 1000) {
  if (!Number.isFinite(unixSeconds)) throw new TypeError("unixSeconds must be finite");

  const epoch = BigInt(Math.floor(unixSeconds)) + WINDOWS_FILE_TIME_EPOCH;
  const rounded = epoch - (epoch % 300n);
  const ticks = rounded * 10000000n;
  const payload = new TextEncoder().encode(`${ticks}${SERVICE_TOKEN}`);

  const message = new Uint8Array(PREFIX.length + payload.length);
  message.set(PREFIX, 0);
  message.set(payload, PREFIX.length);

  const shaDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
  const cs64 = cs64Digest(payload, shaDigest);
  return `${toHex(cs64)}-${toHex(shaDigest)}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function localeOf(voice) {
  const match = /^([a-z]{2,3}-[A-Z]{2,4})-/.exec(voice);
  return match ? match[1] : "zh-CN";
}

function buildSpeechConfigMessage() {
  return (
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: "false",
              wordBoundaryEnabled: "true",
            },
            outputFormat: OUTPUT_FORMAT,
          },
        },
      },
    })
  );
}

function buildSsmlMessage({ text, voice, rate, pitch, volume, requestId }) {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${localeOf(voice)}">` +
    `<voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapeXml(text)}</prosody></voice></speak>`;

  return (
    `X-RequestId:${requestId}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    "Path:ssml\r\n\r\n" +
    ssml
  );
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let headerLength = 2;

  if (length >= 126 && length < 65536) headerLength += 2;
  else if (length >= 65536) headerLength += 8;
  headerLength += 4; // mask key

  const frame = new Uint8Array(headerLength + length);
  frame[0] = 0x80 | opcode;

  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame[2] = (length >>> 8) & 0xff;
    frame[3] = length & 0xff;
  } else {
    frame[1] = 0x80 | 127;
    let remaining = length;
    for (let index = 9; index >= 2; index -= 1) {
      frame[index] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
  }

  const maskOffset = headerLength - 4;
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  frame.set(mask, maskOffset);

  for (let index = 0; index < length; index += 1) {
    frame[headerLength + index] = payload[index] ^ mask[index % 4];
  }

  return frame;
}

function appendBuffer(previous, next) {
  if (!previous.length) return next;
  const merged = new Uint8Array(previous.length + next.length);
  merged.set(previous);
  merged.set(next, previous.length);
  return merged;
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function readHandshake(reader) {
  let buffer = new Uint8Array(0);

  for (;;) {
    let end = -1;
    for (let index = 0; index + 3 < buffer.length; index += 1) {
      if (
        buffer[index] === 0x0d &&
        buffer[index + 1] === 0x0a &&
        buffer[index + 2] === 0x0d &&
        buffer[index + 3] === 0x0a
      ) {
        end = index;
        break;
      }
    }

    if (end >= 0) {
      const headerText = new TextDecoder().decode(buffer.slice(0, end));
      if (!/^HTTP\/1\.[01] 101/.test(headerText)) {
        throw new Error(`Voice service handshake failed: ${headerText.split("\r\n")[0]}`);
      }
      return buffer.slice(end + 4);
    }

    const { value, done } = await reader.read();
    if (done) throw new Error("Voice service closed during handshake");
    buffer = appendBuffer(buffer, value);
  }
}

function parseFrames(buffer, chunks, onText) {
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = (buffer[offset + 2] << 8) | buffer[offset + 3];
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = 0;
      for (let index = 0; index < 8; index += 1) {
        length = length * 256 + buffer[offset + 2 + index];
      }
      headerLength = 10;
    }

    if (masked) headerLength += 4;
    if (offset + headerLength + length > buffer.length) break;

    let payload = buffer.slice(offset + headerLength, offset + headerLength + length);
    if (masked) {
      const mask = buffer.slice(offset + headerLength - 4, offset + headerLength);
      payload = payload.map((byte, index) => byte ^ mask[index % 4]);
    }

    if (opcode === 0x01) {
      onText(new TextDecoder().decode(payload));
    } else if (opcode === 0x02 && payload.length >= 2) {
      const metadataLength = (payload[0] << 8) | payload[1];
      const audio = payload.slice(2 + metadataLength);
      if (audio.length) chunks.push(audio);
    } else if (opcode === 0x08) {
      return { offset: buffer.length, closed: true };
    }

    offset += headerLength + length;
  }

  return { offset, closed: false };
}

async function closeSocket(socket, writer, reader) {
  try {
    await writer.close();
  } catch {
    // ignore
  }
  try {
    reader.releaseLock();
  } catch {
    // ignore
  }
  try {
    await socket.close();
  } catch {
    // ignore
  }
}

/**
 * @returns {Promise<Uint8Array>} encoded audio bytes
 */
export async function synthesizeVoice({ text, voice, rate, pitch, volume = "+0%" }) {
  const accessToken = await generateAccessToken();
  const connectionId = randomHex(16);
  const requestId = randomHex(16);
  const socketKey = randomBase64(16);
  const muid = randomHex(16);

  const socket = connect({ hostname: HOST, port: PORT }, { secureTransport: "on" });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let timer = null;

  try {
    const connectDeadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Voice service connect timeout")), TIMEOUT_MS);
    });

    await Promise.race([socket.opened, connectDeadline]);

    const handshake =
      `GET ${PATH}?TrustedClientToken=${SERVICE_TOKEN}&Sec-MS-GEC=${accessToken}&Sec-MS-GEC-Version=${TOKEN_VERSION}&ConnectionId=${connectionId} HTTP/1.1\r\n` +
      `Host: ${WS_HOST_HEADER}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${socketKey}\r\n` +
      "Sec-WebSocket-Version: 13\r\n" +
      "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n" +
      `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0\r\n` +
      "Accept-Encoding: gzip, deflate, br, zstd\r\n" +
      "Accept-Language: en-US,en;q=0.9\r\n" +
      "Pragma: no-cache\r\n" +
      "Cache-Control: no-cache\r\n" +
      `Cookie: muid=${muid};\r\n\r\n`;

    await writer.write(new TextEncoder().encode(handshake));
    let buffer = await Promise.race([readHandshake(reader), connectDeadline]);

    clearTimeout(timer);
    timer = null;

    await writer.write(encodeFrame(0x01, new TextEncoder().encode(buildSpeechConfigMessage())));
    await writer.write(encodeFrame(0x01, new TextEncoder().encode(buildSsmlMessage({
      text,
      voice,
      rate,
      pitch,
      volume,
      requestId,
    }))));

    const chunks = [];
    let finished = false;

    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Voice service synthesis timed out")), TIMEOUT_MS);
    });

    const readLoop = (async () => {
      while (!finished) {
        const parsed = parseFrames(buffer, chunks, (message) => {
          if (message.includes("Path:turn.end")) finished = true;
        });

        if (finished) return;
        if (parsed.closed) throw new Error("Voice service connection closed before audio completed");

        buffer = buffer.slice(parsed.offset);
        const { value, done } = await reader.read();
        if (done) {
          if (!chunks.length) throw new Error("Voice service closed without audio");
          return;
        }
        buffer = appendBuffer(buffer, value);
      }
    })();

    await Promise.race([readLoop, deadline]);
    if (!chunks.length) throw new Error("Voice service returned no audio");
    return concatChunks(chunks);
  } finally {
    if (timer) clearTimeout(timer);
    await closeSocket(socket, writer, reader);
  }
}