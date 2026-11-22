/**
 * 文本转语音：Microsoft Edge TTS（非官方接口）。
 *
 * 不使用 Azure，也不需要任何语音 Key。音色、语速、音调直接沿用角色配置：
 * zh-TW-HsiaoChenNeural / zh-CN-XiaoyiNeural / zh-CN-YunxiNeural /
 * zh-TW-YunJheNeural，配合原来的 rate / pitch / volume。
 *
 * Edge TTS 没有官方 SLA，微软调整接口时会失败；接口会明确返回 502，
 * 前端只显示文字，不会退回机械的浏览器 speechSynthesis。
 */

import { synthesizeEdge } from "./edge-tts.js";
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
export async function handleTts(payload, env) {
  const input = readTtsBody(payload);

  try {
    const audio = await synthesizeEdge(input);
    if (!audio || !audio.byteLength) {
      throw new Error("Edge TTS 没有返回音频。");
    }
    return { audio, contentType: "audio/mpeg" };
  } catch (err) {
    console.error(`AI 报错：TTS/${err && (err.message || err)}`);
    throw new ApiError(502, "TTS_FAILED", "语音服务暂时不可用，请稍后再点一次。");
  }
}