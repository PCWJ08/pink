/**
 * 音频转文字接口。
 *
 * 前端把 MediaRecorder 的 webm/mp4 在浏览器里解码，重采样成 16kHz 单声道 WAV，
 * 再以二进制 POST 到 /api/asr。Worker 使用硅基流动 SenseVoice 识别。
 *
 * 使用前需要在 Cloudflare 配置 SILICONFLOW_API_KEY。
 * 录入静音时直接返回 ASR_SILENT，不把空录音送进模型，避免模型幻觉出“在吗”。
 */

import { ApiError, fetchUpstream, joinUrl, readUpstreamJson } from "./utils.js";

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "FunAudioLLM/SenseVoiceSmall";
const TIMEOUT_MS = 25000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const WAV_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
]);

function errorMessage(error) {
  return String(error?.message || error || "unknown").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * 检查 16k/16bit/mono WAV 的音量，拦截静音或几乎无声的录音。
 * 只处理前端 encodeWav 生成的固定 44 字节头 WAV。
 */
function inspectWav(audio) {
  if (audio.byteLength < 46) return { silent: true, duration: 0 };

  const view = new DataView(audio);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== "RIFF" || String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)) !== "WAVE") {
    return { silent: false, duration: 0 };
  }

  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const dataSize = view.getUint32(40, true);
  const dataOffset = 44;

  if (channels !== 1 || sampleRate !== 16000 || dataOffset + dataSize > audio.byteLength) {
    return { silent: false, duration: 0 };
  }

  let peak = 0;
  let sumSquares = 0;
  let samples = 0;

  for (let offset = dataOffset; offset + 1 < dataOffset + dataSize; offset += 2) {
    const sample = view.getInt16(offset, true) / 32768;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
    samples += 1;
  }

  const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
  const duration = samples / sampleRate;

  return {
    silent: peak < 0.012 || rms < 0.0025 || duration < 0.25,
    duration,
  };
}

/**
 * @param {Request} request 请求体是 16kHz 单声道 WAV 二进制
 * @param {object} env
 * @returns {Promise<{text:string}>}
 */
export async function handleAsr(request, env) {
  env = env || {};
  const apiKey = String(env?.SILICONFLOW_API_KEY || env?.ASR_API_KEY || "").trim();
  if (!apiKey) {
    console.error("AI 报错：识别/未配置 SILICONFLOW_API_KEY");
    throw new ApiError(500, "CONFIG_MISSING", "服务端还没有配置 SILICONFLOW_API_KEY，语音输入暂时不可用。");
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

  const wav = inspectWav(audio);
  if (wav.silent) {
    console.error("AI 报错：识别/录音音量过低或没有检测到说话");
    throw new ApiError(422, "ASR_SILENT", "没有听到声音，靠近麦克风再说一次。");
  }

  const baseUrl = env.ASR_BASE_URL || DEFAULT_BASE_URL;
  const model = env.ASR_MODEL || DEFAULT_MODEL;
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([audio], { type: contentType }), "audio.wav");

  try {
    const response = await fetchUpstream(
      joinUrl(baseUrl, "/audio/transcriptions"),
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      },
      TIMEOUT_MS,
    );
    const data = await readUpstreamJson(response, "语音识别");
    const text = String(data?.text || "").replace(/\s+/g, " ").trim();

    if (!text) {
      console.error("AI 报错：识别/SenseVoice 返回空文本");
      throw new ApiError(422, "ASR_EMPTY", "没听清，靠近麦克风再说一次。");
    }

    return { text };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error(`AI 报错：识别/${errorMessage(err)}`);
    throw new ApiError(502, "ASR_FAILED", "语音识别失败，请稍后再试。");
  }
}