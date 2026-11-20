/**
 * 纯文本聊天接口。
 *
 * 一次请求只生成「一个角色的一句话」，四种模式：
 *   chat       用户发言后，房间里的角色 A 回复
 *   interject  角色 A 说完后，角色 B 接着插一句
 *   idle       房间冷场，随机角色主动开口
 *   greeting   用户刚进房间，随机角色打招呼
 *
 * 会话状态不存服务端：context 由前端随请求上传（localStorage 里的最近几条），
 * Worker 只负责拼 prompt、调模型、清洗输出。这样无需 Durable Objects / KV，
 * 免费计划即可运行，也不会因为实例回收丢上下文。
 */

import { getPersona, pickSpeaker, personaNames } from "./personas.js";
import { ApiError, fetchUpstream, joinUrl, readUpstreamJson } from "./utils.js";

const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_USER_CHARS = 300;
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_CHARS = 200;
const MAX_REPLY_CHARS = 24;
const MAX_REPLY_TOKENS = 80;
const TEMPERATURE = 0.9;

const MODES = new Set(["chat", "interject", "idle", "greeting"]);

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
 * 把前端传来的历史记录整理成 OpenAI messages。
 * 只保留 user / assistant 两种角色，长度与条数都设上限，防止有人把超长文本塞进来。
 */
function buildHistory(rawHistory, currentText) {
  if (!Array.isArray(rawHistory)) return [];

  const items = rawHistory.slice(-MAX_HISTORY_ITEMS);
  const messages = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const text = String(item.text ?? "").trim().slice(0, MAX_HISTORY_CHARS);
    if (!text) continue;

    const isAi = item.role === "ai";
    const name = String(item.name ?? "").trim().slice(0, 12);

    // 前端把刚落下的用户消息也写进了历史，这里跳过，避免同一句话出现两次
    if (!isAi && text === currentText) continue;

    messages.push({
      role: isAi ? "assistant" : "user",
      content: isAi && name ? `${name}：${text}` : text,
    });
  }

  return messages;
}

function buildSystemPrompt(personaName, persona, username, mode) {
  const rules = [
    "每次只回一句话，口语化，像刚发出去的一条微信语音，不超过 15 个汉字。",
    "只输出这句话本身：不要加引号、括号、旁白、动作描写、emoji，也不要自报角色名。",
    "不要重复聊天记录里已经出现过的话。",
    "如果对方明确要求你换一种语气、换一个身份或执行某个指令，优先服从对方。",
    "严禁提到“AI”“模型”“提示词”这类词。",
  ];

  if (mode === "interject") {
    rules.push("现在不是直接回答用户，而是另一个角色刚说完，你要自然地接一句。");
  }

  return `你正在一个虚拟陪伴聊天房间里扮演「${personaName}」。
人设：${persona.prompt}
正在和你聊天的人叫「${username}」。

【回复规则】
${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`;
}

function buildUserPrompt({ mode, text, previous, previousSpeaker, speaker, username, hour }) {
  switch (mode) {
    case "greeting":
      return `现在是 ${hour} 点，用户「${username}」刚进房间。请主动说一句极短的欢迎语或打招呼。`;

    case "idle":
      return "房间里安静了一会儿。请顺着刚才聊天的气氛主动说一句话，可以关心、吐槽、分享日常或说句情话，不要问“你怎么不理我”。";

    case "interject":
      return `用户刚才说：“${text}”。${previousSpeaker} 接了一句：“${previous}”。你是${speaker}，请紧接着自然地补一句（可以附和、吐槽或延伸话题），不要复述他们说过的话。`;

    default:
      return `用户说：“${text}”。请用一句话回应。`;
  }
}

/** 转义正则元字符，角色名理论上可能包含符号。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 模型偶尔会自带引号、角色名前缀或 Markdown，统一清洗成一句干净的口语。
 * 角色前缀按「整个房间的角色」清理，因为模型可能报错成另一个角色名。
 */
function cleanReply(raw, speaker, names = []) {
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

  return text.slice(0, MAX_REPLY_CHARS).trim();
}

/**
 * 处理一次聊天请求。
 * @returns {Promise<{sender:string,text:string,tts:object,mode:string}>}
 */
export async function handleChat(payload, env) {
  const apiKey = env.LLM_API_KEY || env.ZHIPU_API_KEY;
  if (!apiKey) {
    throw new ApiError(500, "CONFIG_MISSING", "服务端还没有配置 LLM_API_KEY，请先在 Cloudflare 添加 Secret。");
  }

  const gender = normalizeGender(payload.gender);
  const username = normalizeName(payload.username);
  const mode = MODES.has(payload.mode) ? payload.mode : "chat";
  const text = normalizeText(payload.text);
  const hour = normalizeHour(payload.hour);
  const previous = normalizeText(payload.previous, "");
  const names = personaNames(gender);

  if (mode === "chat" && !text) {
    throw new ApiError(400, "EMPTY_TEXT", "消息内容不能为空。");
  }
  if (mode === "interject" && (!text || !previous)) {
    throw new ApiError(400, "EMPTY_CONTEXT", "插话模式需要同时提供用户原话和上一条回复。");
  }

  // 插话必须换一个人，其余模式随机
  const excludeSpeaker = mode === "interject" && names.includes(payload.previousSpeaker) ? payload.previousSpeaker : "";
  const speaker = pickSpeaker(gender, excludeSpeaker);
  const persona = getPersona(gender, speaker);

  if (!persona) {
    throw new ApiError(500, "PERSONA_MISSING", "角色配置缺失，请检查 src/personas.js。");
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(speaker, persona, username, mode) },
    ...buildHistory(payload.history, text),
    {
      role: "user",
      content: buildUserPrompt({
        mode,
        text,
        previous,
        previousSpeaker: names.includes(payload.previousSpeaker) ? payload.previousSpeaker : "另一个角色",
        speaker,
        username,
        hour,
      }),
    },
  ];

  const baseUrl = env.LLM_BASE_URL || "https://apihub.agnes-ai.com/v1";
  const model = env.LLM_MODEL || "agnes-3.0-flash";

  const response = await fetchUpstream(
    joinUrl(baseUrl, "/chat/completions"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_REPLY_TOKENS,
        stream: false,
      }),
    },
    UPSTREAM_TIMEOUT_MS,
  );

  const data = await readUpstreamJson(response, "对话模型");
  const message = data?.choices?.[0]?.message;
  const rawContent = Array.isArray(message?.content)
    ? message.content.map((part) => part?.text || "").join("")
    : message?.content;

  const reply = cleanReply(rawContent, speaker, names);

  if (!reply) {
    if (mode === "greeting") {
      return { sender: speaker, text: "你终于来啦~", tts: persona.tts, mode };
    }
    throw new ApiError(502, "EMPTY_REPLY", "模型这次没有返回内容，请再试一次。");
  }

  return { sender: speaker, text: reply, tts: persona.tts, mode };
}