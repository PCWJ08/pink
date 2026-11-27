/**
 * Speech synthesis endpoint.
 *
 * Validates text and prosody input, delegates audio generation to the isolated
 * voice transport, and returns an audio response. Upstream details and
 * credentials stay inside the transport; failures degrade to text-only playback.
 */

import { synthesizeVoice } from "./voice-engine.js";
import { ApiError } from "./utils.js";

const DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
const MAX_TEXT_CHARS = 200;
const DEFAULT_RATE = "+0%";
const DEFAULT_PITCH = "+0Hz";
const DEFAULT_VOLUME = "+0%";

function sanitizeVoice(value) {
  const voice = String(value || "").trim();
  return /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9]+Neural$/.test(voice) ? voice : DEFAULT_VOICE;
}

function sanitizeProsody(value, fallback, unit) {
  const raw = String(value || "").trim();
  const pattern = unit === "%" ? /^[+-]?\d{1,3}%$/ : /^[+-]?\d{1,3}Hz$/;
  return pattern.test(raw) ? raw : fallback;
}

function readTtsBody(payload) {
  const text = String(payload?.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) throw new ApiError(400, "EMPTY_TEXT", "没有需要朗读的文字。");

  return {
    text,
    voice: sanitizeVoice(payload?.voice),
    rate: sanitizeProsody(payload?.rate, DEFAULT_RATE, "%"),
    pitch: sanitizeProsody(payload?.pitch, DEFAULT_PITCH, "Hz"),
    volume: sanitizeProsody(payload?.volume, DEFAULT_VOLUME, "%"),
  };
}

/**
 * @returns {Promise<{audio:Uint8Array,contentType:string}>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleTts(payload, env) {
  const input = readTtsBody(payload);
  let lastError = null;

  // The upstream can fail transiently; retry once without making the user wait too long.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const audio = await synthesizeVoice(input);
      if (!audio || !audio.byteLength) {
        throw new Error("语音服务没有返回音频。");
      }
      return { audio, contentType: "audio/mpeg" };
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(400 * attempt);
    }
  }

  console.error(`AI 报错：TTS/${lastError && (lastError.message || lastError)}`);
  throw new ApiError(502, "TTS_FAILED", "语音服务暂时不可用，请稍后再点一次。");
}