/**
 * Conversation endpoint.
 *
 * Produces one short in-character reply per request. Four modes are supported:
 *   chat       a character answers the user's latest message
 *   interject  the other character adds a follow-up line
 *   idle       a character speaks after a quiet period
 *   greeting   a character welcomes the user on entry
 *
 * Conversation state is kept by the client and sent with each request. The
 * Worker only builds context, calls the model and normalizes the output, so no
 * server-side session storage is required.
 *
 * A primary/fallback provider chain keeps the room responsive when one upstream
 * is rate-limited or unavailable.
 */

import { getPersona, pickSpeaker, personaNames } from "./personas.js";
import { ApiError, fetchUpstream, joinUrl, readUpstreamJson } from "./utils.js";

const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_USER_CHARS = 60;
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_CHARS = 200;
const MAX_REPLY_CHARS = 20;
const MAX_REPLY_CHARS_EN = 160;
const MAX_REPLY_TOKENS = 20;
const MAX_REPLY_TOKENS_EN = 60;
const TEMPERATURE = 1;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 600;

const MODES = new Set(["chat", "interject", "idle", "greeting"]);

const DEFAULT_PRIMARY_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_PRIMARY_MODEL = "glm-4-flash";
const DEFAULT_FALLBACK_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_FALLBACK_MODEL = "Qwen/Qwen2.5-7B-Instruct";

function cleanKey(value) {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "").trim();
}

/**
 * 按优先级返回可用的对话通道。密钥只从 Cloudflare Secrets 读取。
 * 新变量优先，保留 LLM_PRIMARY_API_KEY / LLM_FALLBACK_API_KEY 兼容旧部署。
 */
function buildProviders(env) {
  return [
    {
      baseUrl: env.LLM_PRIMARY_BASE_URL || DEFAULT_PRIMARY_BASE_URL,
      model: env.LLM_PRIMARY_MODEL || DEFAULT_PRIMARY_MODEL,
      apiKey: cleanKey(env.ZHIPU_API_KEY || env.LLM_PRIMARY_API_KEY),
    },
    {
      baseUrl: env.LLM_FALLBACK_BASE_URL || DEFAULT_FALLBACK_BASE_URL,
      model: env.LLM_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
      apiKey: cleanKey(env.SILICONFLOW_API_KEY || env.LLM_FALLBACK_API_KEY),
    },
  ].filter((provider) => provider.apiKey);
}

/** 用户性别（决定加载哪套角色剧本），非法值一律回落到 male。 */
export function normalizeGender(value) {
  return value === "female" ? "female" : "male";
}

function normalizeName(value) {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 12);
  return name || "主人";
}

function normalizeText(value, fallback = "") {
  return String(value ?? "").trim().slice(0, MAX_USER_CHARS) || fallback;
}

function normalizeHour(value) {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 12;
}

/**
 * 把前端历史拼成原版那种「角色: 内容」的文本。
 * AI messages use the character name; user messages use a neutral label.
 */
function buildHistoryString(rawHistory, limit = MAX_HISTORY_ITEMS) {
  if (!Array.isArray(rawHistory)) return "";

  return rawHistory
    .slice(-limit)
    .map((item) => {
      if (!item || typeof item !== "object") return "";

      const text = String(item.text ?? "").trim().slice(0, MAX_HISTORY_CHARS);
      if (!text) return "";

      const name = item.role === "ai"
        ? String(item.name || "AI").trim().slice(0, 12)
        : "用户";

      return `${name}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** Build the outer prompt while preserving each character's established voice. */
function buildPrompt(persona, username, userText, historyStr, locale = "zh") {
  const english = locale === "en";
  return `你现在的设定是${persona.prompt}
对方的名字叫“${username}”。
最近的聊天记录：
${historyStr || "（暂无历史记录）"}

用户刚刚对你说：“${userText}”

【最高执行指令】：
1. 正常情况下，保持你的设定和语气。
2. 但是，如果用户明确向你下达了具体的命令，你要服从用户的指令，可以改变说话方式，满足用户的要求，不要被原本的设定限制。
3. 绝对不要重复聊天记录里说过的话。
4. 回复中禁止出现任何 Emoji、颜文字、表情符号或表情字符，只输出纯文字。
5. 必须紧扣用户最后一句话回答，不要答非所问；不知道就简短追问。
6. ${english ? "Reply in English only." : "请用中文回复。"}

${english ? "Please reply directly in English (no more than 25 words):" : "请直接输出你的回复（不超过15个字）："}`;
}

/** Build the mode-specific user text passed to the model. */
function buildUserText({ mode, text, previous, previousSpeaker, speaker, username, hour, recentHistory, locale = "zh" }) {
  const en = locale === "en";
  switch (mode) {
    case "greeting":
      return en
        ? `It is ${hour}:00. The user '${username}' just entered the room. As ${speaker}, greet them warmly in one very short English sentence (no more than 12 words).`
        : `现在是${hour}点，用户'${username}'刚进房间。作为${speaker}，请自由发挥，主动对用户说一句极短的欢迎语或打招呼（15字以内）。`;

    case "idle":
      return en
        ? `You are chatting in the room.
Recent chat:
${recentHistory || "You just met"}

You are "${speaker}". Continue the topic or mood naturally with one short English sentence. You may tease, care, share your day, or say something sweet. Do not keep asking why they are ignoring you. No more than 15 words. Reply directly:`
        : `你们现在在房间里聊天。
最近的聊天记录：
${recentHistory || "你们刚认识"}

你现在是"${speaker}"，请顺着上面的话题或气氛，自然地接一句话。可以吐槽、关心、分享日常或者说说情话，不要总问“你怎么不理我”。
短，15字以内，直接输出回复：`;

    case "interject":
      return en
        ? `The user said: '${text}'. ${previousSpeaker} just replied: '${previous}'. As ${speaker}, add one natural English sentence. You may agree, tease, or extend the topic. No more than 15 words:`
        : `用户说：'${text}'，${previousSpeaker}刚刚回复了：'${previous}'。你作为${speaker}，请自然地接一句话，可以附和、吐槽或者延伸话题。极短15字以内：`;

    default:
      return text;
  }
}

/** 转义正则元字符，角色名理论上可能包含符号。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 模型偶尔会自带引号、角色名前缀或 Markdown，统一清洗成一句干净的口语。 */
function cleanReply(raw, speaker, names = [], locale = "zh") {
  let text = String(raw ?? "").replace(/\s+/g, " ").trim();

  text = text.split("\n")[0].trim();
  text = text.replace(/^[#*\-\s]+/, "");
  text = text.replace(/^[“"‘'「『（(【\[]+/, "");
  text = text.replace(/[”"’'」』）)】\]]+$/, "");

  const prefixes = [...new Set([speaker, ...names])].filter(Boolean).map(escapeRegExp);
  if (prefixes.length) {
    text = text.replace(new RegExp(`^(?:${prefixes.join("|")})\\s*[：:]\\s*`), "");
  }
  text = text.replace(/^\*+|\*+$/g, "").trim();

  // Remove emoji and modifiers: speech synthesis would otherwise read them aloud.
  text = text.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu, "");
  text = text.replace(/\s+/g, " ").trim();

  return text.slice(0, locale === "en" ? MAX_REPLY_CHARS_EN : MAX_REPLY_CHARS).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return String(error?.message || error || "unknown").replace(/\s+/g, " ").slice(0, 300);
}

function isRetryable(err) {
  const code = err && err.code;
  return code === "UPSTREAM_TIMEOUT"
    || code === "UPSTREAM_UNREACHABLE"
    || code === "UPSTREAM_BUSY"
    || code === "UPSTREAM_ERROR"
    || code === "UPSTREAM_BAD_RESPONSE";
}

/** 同一个通道最多重试两次；仍然失败就交给下一个通道。 */
async function requestProvider(provider, body) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchUpstream(
        joinUrl(provider.baseUrl, "/chat/completions"),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey}`,
          },
          body,
        },
        UPSTREAM_TIMEOUT_MS,
      );

      return await readUpstreamJson(response, "对话模型");
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) {
        throw err;
      }

      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError || new ApiError(502, "UPSTREAM_ERROR", "她刚才走神了，再叫她一次吧。");
}

/**
 * 处理一次聊天请求。
 * @returns {Promise<{sender:string,text:string,tts:object,mode:string}>}
 */
export async function handleChat(payload, env, clientIp = "unknown") {
  const providers = buildProviders(env);
  if (!providers.length) {
    console.error("AI 报错：模型/未配置对话服务密钥");
    throw new ApiError(500, "CONFIG_MISSING", "服务端还没有配置对话模型密钥，请先在 Cloudflare 添加 Secret。");
  }

  const gender = normalizeGender(payload.gender);
  const username = normalizeName(payload.username);
  const mode = MODES.has(payload.mode) ? payload.mode : "chat";
  const locale = payload.locale === "en" ? "en" : "zh";
  const text = normalizeText(payload.text);
  const hour = normalizeHour(payload.hour);
  const previous = normalizeText(payload.previous, "");
  const source = payload.source === "voice" ? "语音" : "打字";
  const names = personaNames(gender);

  if (mode === "chat" && !text) {
    throw new ApiError(400, "EMPTY_TEXT", "消息内容不能为空。");
  }
  if (mode === "interject" && (!text || !previous)) {
    throw new ApiError(400, "EMPTY_CONTEXT", "插话模式需要同时提供用户原话和上一条回复。");
  }

  // Interjections must come from the other character; other modes are random.
  const excludeSpeaker = mode === "interject" && names.includes(payload.previousSpeaker) ? payload.previousSpeaker : "";
  const speaker = pickSpeaker(gender, excludeSpeaker);
  const persona = getPersona(gender, speaker);

  if (!persona) {
    throw new ApiError(500, "PERSONA_MISSING", "角色配置缺失，请检查 src/personas.js。");
  }

  const historyStr = buildHistoryString(payload.history);
  const recentHistory = buildHistoryString(payload.history, 5);
  const previousSpeaker = names.includes(payload.previousSpeaker) ? payload.previousSpeaker : "另一个角色";

  if (mode === "chat") {
    console.log(`[${clientIp}]：${username} ${source}：${text}`);
  }
  if (mode === "greeting") {
    const roomType = gender === "male" ? "男生" : "女生";
    console.log(`[${clientIp}]：${username} 进入${roomType}专属房间`);
  }

  const userText = buildUserText({
    mode,
    text,
    previous,
    previousSpeaker,
    speaker,
    username,
    hour,
    recentHistory,
    locale,
  });

  const prompt = buildPrompt(
    persona,
    username,
    userText,
    mode === "greeting" ? "" : historyStr,
    locale,
  );

  let data = null;
  let lastError = null;

  // Try the fallback provider; only surface an error after all providers fail.
  for (const provider of providers) {
    try {
      const providerBody = JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        temperature: TEMPERATURE,
        max_tokens: locale === "en" ? MAX_REPLY_TOKENS_EN : MAX_REPLY_TOKENS,
        stream: false,
      });
      data = await requestProvider(provider, providerBody);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!data) {
    console.error(`AI 报错：模型/${errorMessage(lastError)}`);
    throw lastError || new ApiError(502, "UPSTREAM_ERROR", "她刚才走神了，再叫她一次吧。");
  }

  const message = data?.choices?.[0]?.message;
  const rawContent = Array.isArray(message?.content)
    ? message.content.map((part) => part?.text || "").join("")
    : message?.content;
  const reply = cleanReply(rawContent, speaker, names, locale);
  const tts = locale === "en" && persona.ttsEn ? persona.ttsEn : persona.tts;

  if (!reply) {
    if (mode === "greeting") {
      const fallback = locale === "en" ? "I've been waiting for you~" : "你终于来啦~";
      console.log(`[${speaker}AI]：${fallback}`);
      return { sender: speaker, text: fallback, tts, mode };
    }
    throw new ApiError(502, "EMPTY_REPLY", "她刚才走神了，再叫她一次吧。");
  }

  console.log(`[${speaker}AI]：${reply}`);
  return { sender: speaker, text: reply, tts, mode };
}
