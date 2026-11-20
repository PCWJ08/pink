/**
 * Worker 通用工具：统一错误、JSON 响应、带超时的上游请求。
 *
 * 所有对外错误都收敛成 ApiError，index.js 负责序列化成
 * { ok:false, error:{ code, message } }，不把上游的原始报错直接抛给浏览器。
 */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code   稳定的错误码，方便前端做分支
   * @param {string} message 可以直接展示给用户的中文提示
   */
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 拼 URL，容忍 base 末尾有斜杠（智谱的 base 就带 /v4/）。 */
export function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}${path}`;
}

/**
 * 带超时的 fetch。
 * Cloudflare Workers 的 fetch 本身没有默认超时，不主动中止可能把请求挂到平台上限。
 */
export async function fetchUpstream(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new ApiError(504, "UPSTREAM_TIMEOUT", "上游服务响应超时，请稍后重试。");
    }
    console.error("[upstream] network error:", err && err.message);
    throw new ApiError(502, "UPSTREAM_UNREACHABLE", "无法连接上游服务，请检查 Base URL 或稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取上游 JSON，并把常见状态码翻译成用户能看懂的提示。
 * 上游的错误正文只截断写日志，不回传给浏览器（避免泄露供应商细节）。
 */
export async function readUpstreamJson(response, serviceName) {
  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    console.error(`[${serviceName}] HTTP ${response.status}: ${raw.slice(0, 300)}`);

    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, "UPSTREAM_AUTH", `${serviceName} 鉴权失败，请检查 Cloudflare 里配置的 API Key。`);
    }
    if (response.status === 404) {
      throw new ApiError(502, "UPSTREAM_NOT_FOUND", `${serviceName} 接口不存在，请检查 Base URL 与模型名。`);
    }
    if (response.status === 429) {
      throw new ApiError(503, "UPSTREAM_RATE_LIMIT", `${serviceName} 触发限流或额度不足，请稍后再试。`);
    }
    throw new ApiError(502, "UPSTREAM_ERROR", `${serviceName} 返回 ${response.status}，请稍后重试。`);
  }

  if (!data) {
    throw new ApiError(502, "UPSTREAM_BAD_RESPONSE", `${serviceName} 返回了无法解析的内容。`);
  }
  return data;
}