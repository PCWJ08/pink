/**
 * 音频转文字接口。
 *
 * 浏览器把录音直接以二进制 POST 过来（不套 base64，省 1/3 体积），
 * Worker 再以 multipart/form-data 转发给硅基流动的 OpenAI 兼容转写接口。
 *
 * 注意：Workers 不能给 FormData 手动设置 Content-Type，
 * 必须让运行时自动补 boundary。
 */

import { ApiError, fetchUpstream, joinUrl, readUpstreamJson } from "./utils.js";

const UPSTREAM_TIMEOUT_MS = 25000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB，足够几分钟的语音

const EXT_BY_MIME = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
};

/**
 * @param {Request} request 请求体是音频二进制
 * @param {object} env
 * @returns {Promise<{text:string}>}
 */
export async function handleAsr(request, env) {
  const apiKey = env.ASR_API_KEY || env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new ApiError(500, "CONFIG_MISSING", "服务端还没有配置 ASR_API_KEY，语音输入暂时不可用。");
  }

  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("audio/")) {
    throw new ApiError(415, "UNSUPPORTED_AUDIO", "请以 audio/* 的 Content-Type 上传录音。");
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

  const ext = (request.headers.get("x-audio-ext") || "").trim().toLowerCase() || EXT_BY_MIME[contentType];
  if (!ext || !/^[a-z0-9]{2,5}$/.test(ext)) {
    throw new ApiError(415, "UNSUPPORTED_AUDIO", `暂不支持 ${contentType} 格式的录音。`);
  }

  const baseUrl = env.ASR_BASE_URL || "https://api.siliconflow.cn/v1";
  const model = env.ASR_MODEL || "FunAudioLLM/SenseVoiceSmall";

  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([audio], { type: contentType }), `audio.${ext}`);

  const response = await fetchUpstream(
    joinUrl(baseUrl, "/audio/transcriptions"),
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    },
    UPSTREAM_TIMEOUT_MS,
  );

  const data = await readUpstreamJson(response, "语音识别");
  const text = String(data?.text ?? "").replace(/\s+/g, " ").trim();

  return { text };
}