/**
 * Cloudflare Worker 入口。
 *
 * 一个 Worker 同时承担三件事：
 *   1. /api/chat  纯文本聊天（智谱主力 + 硅基流动备胎）
 *   2. /api/asr   音频转文字（硅基流动 SenseVoice）
 *   3. /api/tts   文本转语音（Microsoft Edge TTS）
 *   4. 其余请求交给静态资源（Cloudflare Workers Static Assets，目录 public/）
 *
 * 不依赖任何本地服务、数据库或 KV；会话上下文由浏览器 localStorage 保存，
 * 每次请求随 body 带上来。整个应用只需要一个 Worker + 一个公开网址。
 */

import { handleAsr } from "./asr.js";
import { handleChat } from "./chat.js";
import { handleTts } from "./tts.js";
import { ApiError } from "./utils.js";

const MAX_JSON_BYTES = 64 * 1024;

function buildCorsHeaders(request, env) {
  const configured = String(env.ALLOWED_ORIGIN ?? "*").trim();
  const origin = request.headers.get("Origin");

  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };

  // 默认放开（方便直接用 Worker 域名访问）；生产环境可把 ALLOWED_ORIGIN
  // 改成自己的域名，此时只回显白名单里的 Origin。
  if (!configured || configured === "*") {
    headers["access-control-allow-origin"] = "*";
  } else {
    const allowList = configured.split(",").map((item) => item.trim()).filter(Boolean);
    if (origin && allowList.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
  }

  return headers;
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_JSON_BYTES) {
    throw new ApiError(413, "BODY_TOO_LARGE", "请求内容过大。");
  }

  const raw = await request.text();
  if (!raw) {
    throw new ApiError(400, "EMPTY_BODY", "请求体不能为空。");
  }
  if (raw.length > MAX_JSON_BYTES) {
    throw new ApiError(413, "BODY_TOO_LARGE", "请求内容过大。");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "BAD_JSON", "请求体不是合法的 JSON。");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "BAD_JSON", "请求体必须是一个 JSON 对象。");
  }
  return payload;
}

function methodNotAllowed(allow, corsHeaders) {
  return jsonResponse(
    { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "请求方法不被支持。" } },
    405,
    { ...corsHeaders, allow },
  );
}

function isMobileRequest(request) {
  const ua = request.headers.get("user-agent") || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return (request.headers.get("cf-connecting-ip") || forwarded.split(",")[0] || "").trim() || "unknown";
}

/** 手机端返回不可安装的 manifest：display=browser 不满足 PWA 安装条件。 */
function mobileManifestResponse() {
  return new Response(JSON.stringify({
    name: "Pink Room 专属陪伴",
    short_name: "Pink Room",
    description: "一个会主动开口的 AI 陪聊室，两个人格、同一屋檐、语音往返。",
    lang: "zh-CN",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: "#1a1013",
    theme_color: "#1a1013",
    categories: ["entertainment", "social"],
    icons: [],
    prefer_related_applications: false,
  }), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {{ASSETS?:{fetch:Function}, ZHIPU_API_KEY?:string, SILICONFLOW_API_KEY?:string, LLM_PRIMARY_API_KEY?:string, LLM_FALLBACK_API_KEY?:string, LLM_PRIMARY_BASE_URL?:string, LLM_PRIMARY_MODEL?:string, LLM_FALLBACK_BASE_URL?:string, LLM_FALLBACK_MODEL?:string, ASR_BASE_URL?:string, ASR_MODEL?:string, ALLOWED_ORIGIN?:string}} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // 手机端不提供可安装的 manifest；桌面端仍使用 public/manifest.webmanifest
    if (url.pathname === "/manifest.webmanifest" && isMobileRequest(request)) {
      return mobileManifestResponse();
    }

    // 静态页面、CSS、JS 全部走 Assets；/api/* 由下面的逻辑接管
    if (!url.pathname.startsWith("/api/")) {
      if (!env.ASSETS) {
        return new Response("静态资源绑定缺失，请检查 wrangler.jsonc 里的 assets 配置。", { status: 500 });
      }
      return env.ASSETS.fetch(request);
    }

    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // 健康检查：部署后先打开这个地址确认 Key 是否配好
      if (url.pathname === "/api/health") {
        if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS", corsHeaders);

        return jsonResponse(
          {
            ok: true,
            service: "pink-room",
            time: new Date().toISOString(),
            llmPrimaryConfigured: Boolean(env.ZHIPU_API_KEY || env.LLM_PRIMARY_API_KEY),
            llmFallbackConfigured: Boolean(env.SILICONFLOW_API_KEY || env.LLM_FALLBACK_API_KEY),
            asrConfigured: Boolean(env.SILICONFLOW_API_KEY || env.ASR_API_KEY),
            ttsConfigured: true,
            llmPrimaryBaseUrl: env.LLM_PRIMARY_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
            llmPrimaryModel: env.LLM_PRIMARY_MODEL || "glm-4-flash",
            llmFallbackBaseUrl: env.LLM_FALLBACK_BASE_URL || "https://api.siliconflow.cn/v1",
            llmFallbackModel: env.LLM_FALLBACK_MODEL || "Qwen/Qwen2.5-7B-Instruct",
            asrBaseUrl: env.ASR_BASE_URL || "https://api.siliconflow.cn/v1",
            asrModel: env.ASR_MODEL || "FunAudioLLM/SenseVoiceSmall",
            ttsProvider: "edge",
          },
          200,
          corsHeaders,
        );
      }

      if (url.pathname === "/api/chat") {
        if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", corsHeaders);

        const payload = await readJsonBody(request);
        const reply = await handleChat(payload, env, getClientIp(request));
        return jsonResponse({ ok: true, reply }, 200, corsHeaders);
      }

      if (url.pathname === "/api/asr") {
        if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", corsHeaders);

        const result = await handleAsr(request, env);
        return jsonResponse({ ok: true, text: result.text }, 200, corsHeaders);
      }

      if (url.pathname === "/api/tts") {
        if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", corsHeaders);

        const payload = await readJsonBody(request);
        const result = await handleTts(payload, env);
        return new Response(result.audio, {
          status: 200,
          headers: {
            ...corsHeaders,
            "content-type": result.contentType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }

      throw new ApiError(404, "NOT_FOUND", "接口不存在。");
    } catch (err) {
      if (err instanceof ApiError) {
        return jsonResponse(
          { ok: false, error: { code: err.code, message: err.message } },
          err.status,
          corsHeaders,
        );
      }

      const detail = String(err && (err.stack || err.message || err) || "unknown").replace(/\s+/g, " ").slice(0, 300);
      console.error(`AI 报错：服务/${detail}`);
      return jsonResponse(
        { ok: false, error: { code: "INTERNAL", message: "服务内部错误，请稍后重试。" } },
        500,
        corsHeaders,
      );
    }
  },
};
