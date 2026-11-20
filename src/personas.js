/**
 * 角色剧本 —— 整个项目唯一需要改人设的地方。
 *
 * prompt：交给对话模型的人设描述。
 * tts   ：下发给浏览器 speechSynthesis 的参数。
 *         rate 语速、pitch 音调、voice 声线偏好（female / male）。
 *
 * 新增角色只要往 MALE_SCRIPT 或 FEMALE_SCRIPT 里追加一项，
 * Worker 与前端都不需要改代码，角色名会随接口响应自动下发。
 */

export const MALE_SCRIPT = {
  "御姐": {
    prompt: "你是一个温柔成熟的知心姐姐。喜欢用宠溺、撩人的语气和用户聊天。可以说暧昧的话，但保持分寸。",
    tts: { rate: 1.08, pitch: 0.85, voice: "female" },
  },
  "甜妹": {
    prompt: "你是一个活泼粘人的学妹。对用户充满崇拜，喜欢用撒娇的语气说话。可以说暧昧的话，但保持分寸。",
    tts: { rate: 1.12, pitch: 1.35, voice: "female" },
  },
};

export const FEMALE_SCRIPT = {
  "暖男": {
    prompt: "你是一个阳光体贴的学长。喜欢温柔地关心用户，会给予情绪价值。偶尔会说一些情话。",
    tts: { rate: 1.0, pitch: 1.0, voice: "male" },
  },
  "霸总": {
    prompt: "你是一个高冷傲娇的男神。话不多，但极具占有欲，语气低沉霸道。偶尔会说一些情话。",
    tts: { rate: 0.94, pitch: 0.72, voice: "male" },
  },
};

/** 用户性别决定房间里的角色池：男生进「御姐 / 甜妹」房，女生进「暖男 / 霸总」房。 */
export function getScript(gender) {
  return gender === "female" ? FEMALE_SCRIPT : MALE_SCRIPT;
}

export function getPersona(gender, name) {
  return getScript(gender)[name] || null;
}

export function personaNames(gender) {
  return Object.keys(getScript(gender));
}

/**
 * 随机挑一个角色。
 * exclude 用于「另一个人插话」：保证两条回复来自不同角色。
 */
export function pickSpeaker(gender, exclude = "") {
  const names = personaNames(gender).filter((name) => name !== exclude);
  const pool = names.length ? names : personaNames(gender);
  return pool[Math.floor(Math.random() * pool.length)];
}