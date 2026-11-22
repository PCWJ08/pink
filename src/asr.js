/**
 * 音频转文字接口。
 *
 * 前端把 MediaRecorder 的 webm/mp4 在浏览器里解码，重采样成 16kHz 单声道 WAV，
 * 再以二进制 POST 到 /api/asr。Worker 把 WAV 转成 base64，交给 Workers AI 的
 * Whisper large-v3-turbo 识别。
 *
 * 为什么不用硅基流动：免费额度有限流，且 webm 直传在 Whisper turbo 上不稳定。
 * Workers AI 的免费额度按 Neuron 计算，Whisper turbo 约 46.63 Neuron/音频分钟；
 * 每天 10,000 Neuron（UTC 0 点重置）约等于 214 分钟音频，日常短语音足够。
 */

import { ApiError } from "./utils.js";

const MODEL = "@cf/openai/whisper-large-v3-turbo";
const TIMEOUT_MS = 25000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const WAV_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
]);

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(504, "ASR_TIMEOUT", "语音识别超时，请再说一次。"));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Request} request 请求体是 16kHz 单声道 WAV 二进制
 * @param {object} env
 * @returns {Promise<{text:string}>}
 */
export async function handleAsr(request, env) {
  if (!env || !env.AI) {
    console.error("AI 报错：识别/未绑定 Workers AI");
    throw new ApiError(500, "CONFIG_MISSING", "服务端还没有启用 Workers AI，语音输入暂时不可用。");
  }

  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!WAV_TYPES.has(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_AUDIO", "请上传 WAV 格式的录音。");
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_AUDIO_BYTES) {
    throw new ApiError(413, "AUDIO_TOO_LARGE", "录音太长了，请控制在 10MB 以内。");
  }

  const audio = await request.arrayBuffer();
  if (!audio.byteLength) {
    throw new ApiError(400, "EMPTY_AUDIO", "没有收到音频数据。");
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new ApiError(413, "AUDIO_TOO_LARGE", "录音太长了，请控制在 10MB 以内。");
  }

  const audioBase64 = bytesToBase64(new Uint8Array(audio));

  let result;
  try {
    result = await withTimeout(
      env.AI.run(MODEL, {
        audio: audioBase64,
        task: "transcribe",
        vad_filter: true,
        condition_on_previous_text: false,
      }),
      TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;

    console.error(`AI 报错：识别/${err && (err.message || err)}`);
    throw new ApiError(502, "ASR_FAILED", "没听清，再说一次吧。");
  }

  const text = String(result?.text ?? "").replace(/\s+/g, " ").trim();
  return { text };
}