'use strict';

/* ============================================================
   Pink Room 前端交互
   - 文本、语音识别、语音合成都通过 fetch 调用 Worker 接口
   - AI 语音由 /api/tts 生成神经网络 mp3，不再使用浏览器 speechSynthesis
   - 聊天记录保存在 localStorage，请求时附带最近几条作为上下文
   - 录音保留原始文件用于回放，另转 16kHz WAV 用于 Whisper 识别
   ============================================================ */

/* ---------------- 1. 元素与状态 ---------------- */

const setupPage = document.getElementById('setup-page');
const chatPage = document.getElementById('chat-page');
const nicknameInput = document.getElementById('nickname-input');
const enterBtn = document.getElementById('enter-btn');
const genderBtns = document.querySelectorAll('.gender-btn');
const displayName = document.getElementById('display-name');
const messagesArea = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const voiceBtn = document.getElementById('voice-btn');
const toastEl = document.getElementById('toast');
const installBtn = document.getElementById('install-btn');

const STORAGE_PREFIX = 'pink_room_history_';
const MAX_LOCAL_HISTORY = 20;
const MAX_API_HISTORY = 20;
const IDLE_DELAY_MS = 5000;
const INTERJECT_DELAY_MS = 1500;

// 旧记录里 tts.voice 是 female / male，迁移时按角色名回到原来的神经音色。
const VOICE_PRESETS = {
  '御姐': { voice: 'zh-TW-HsiaoChenNeural', rate: '+33%', pitch: '+15Hz', volume: '+4%' },
  '甜妹': { voice: 'zh-CN-XiaoyiNeural', rate: '+13%', pitch: '+14Hz', volume: '+5%' },
  '暖男': { voice: 'zh-CN-YunxiNeural', rate: '+3%', pitch: '-4Hz', volume: '+5%' },
  '霸总': { voice: 'zh-TW-YunJheNeural', rate: '+17%', pitch: '-10Hz', volume: '+9%' },
};

let myGender = 'male';

const state = {
  gender: 'male',
  name: '',
  history: [],
  busy: false,
  token: 0,
  queue: [],
  queueRunning: false,
  idleTimer: null,
};

let typingEl = null;
let currentAudio = null;
let audioGeneration = 0;
let toastTimer = null;

/* ---------------- 2. 通用工具 ---------------- */

function scrollToBottom() {
  window.requestAnimationFrame(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

function showToast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function historyKey() {
  return `${STORAGE_PREFIX}${state.gender}_${state.name}`;
}

/** 兼容旧版本地记录：用户语音保留原始录音，AI 语音保留文字与朗读参数。 */
function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return null;

  const text = String(item.text || '').trim();

  let role = item.role === 'ai' || item.role === 'user' ? item.role : null;
  if (!role && item.sender) role = item.sender === state.name ? 'user' : 'ai';
  if (!role) return null;

  const audio = typeof item.audio === 'string' && item.audio.startsWith('data:audio/')
    ? item.audio
    : '';

  if (!text && !audio) return null;

  const name = role === 'user' ? state.name : String(item.name || item.sender || 'AI');
  const normalized = { role, name, text };

  if (audio) {
    normalized.audio = audio;
    if (role === 'user') {
      normalized.duration = Math.max(1, Math.min(10, Number(item.duration) || 2));
    }
  }

  // 新的记录带神经音色参数，刷新后 AI 消息仍以语音气泡显示
  if (role === 'ai' && item.tts && typeof item.tts === 'object') {
    const preset = VOICE_PRESETS[name] || VOICE_PRESETS['御姐'];
    const voice = typeof item.tts.voice === 'string' && /Neural$/.test(item.tts.voice)
      ? item.tts.voice
      : preset.voice;
    const rate = /^[+-]?\d{1,3}%$/.test(String(item.tts.rate || ''))
      ? String(item.tts.rate)
      : preset.rate;
    const pitch = /^[+-]?\d{1,3}Hz$/.test(String(item.tts.pitch || ''))
      ? String(item.tts.pitch)
      : preset.pitch;
    const volume = /^[+-]?\d{1,3}%$/.test(String(item.tts.volume || ''))
      ? String(item.tts.volume)
      : preset.volume;

    normalized.tts = { voice, rate, pitch, volume };
  }

  return normalized;
}

function loadHistory() {
  try {
    // 兼容旧键名 history_{gender}_{name}，让同名同性别继续读到原来的记录
    const current = localStorage.getItem(historyKey());
    const legacy = localStorage.getItem(`history_${state.gender}_${state.name}`);
    const raw = JSON.parse(current || legacy || '[]');

    if (!Array.isArray(raw)) return [];

    return raw
      .map((item) => normalizeHistoryItem(item))
      .filter(Boolean)
      .slice(-MAX_LOCAL_HISTORY);
  } catch {
    return [];
  }
}

function saveHistory() {
  const key = historyKey();
  const items = state.history.slice(-MAX_LOCAL_HISTORY).map((item) => ({ ...item }));

  try {
    localStorage.setItem(key, JSON.stringify(items));
    return;
  } catch {
    // 配额不足时从最旧的语音开始释放，优先保留文字
  }

  for (let i = 0; i < items.length; i += 1) {
    if (!items[i].audio) continue;

    delete items[i].audio;

    try {
      localStorage.setItem(key, JSON.stringify(items));
      return;
    } catch {
      // 继续释放下一条语音
    }
  }

  try {
    localStorage.setItem(
      key,
      JSON.stringify(items.map(({ audio, ...rest }) => rest)),
    );
  } catch {
    // 仍然放不下就放弃本轮缓存，不影响当前聊天
  }
}

function addHistory(role, name, text, extra) {
  const item = { role, name, text };

  if (role === 'ai' && extra && extra.rate) {
    item.tts = extra;
  }

  if (role === 'user' && extra && extra.audio) {
    item.audio = extra.audio;
    item.duration = extra.duration || 2;
  }

  state.history.push(item);
  state.history = state.history.slice(-MAX_LOCAL_HISTORY);
  saveHistory();
}

/* ---------------- 3. 网络请求 ---------------- */

async function requestJson(path, { method = 'GET', headers = {}, body, timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    const error = new Error(err && err.name === 'AbortError'
      ? '请求超时，请检查网络后重试。'
      : '网络连接失败，请稍后重试。');
    error.code = err && err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || !data || data.ok === false) {
    const error = new Error(data && data.error && data.error.message
      ? data.error.message
      : `请求失败（HTTP ${response.status}）`);

    error.code = data && data.error && data.error.code
      ? data.error.code
      : 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return data;
}

/** 聊天室的错误提示：限流/空回复用轻提示，配置错误才显示系统消息。 */
function showChatError(err) {
  if (err && (err.code === 'UPSTREAM_BUSY' || err.code === 'EMPTY_REPLY')) {
    showToast('她刚才走神了，再叫她一次吧。');
    return;
  }

  appendSystemMessage(err && err.message ? err.message : '网络开小差了，再试一次吧。');
}

function requestReply(options = {}) {
  const payload = {
    mode: options.mode || 'chat',
    source: options.source || 'text',
    gender: state.gender,
    username: state.name,
    hour: new Date().getHours(),
    text: options.text || '',
    previous: options.previous || '',
    previousSpeaker: options.previousSpeaker || '',
    history: state.history.slice(-MAX_API_HISTORY).map((item) => ({
      role: item.role,
      name: item.name,
      text: item.text,
    })),
  };

  return requestJson('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 45000,
  });
}

/* ---------------- 4. 神经语音播放（Worker /api/tts） ---------------- */

function pauseLocalAudio() {
  if (!currentAudio) return;
  try {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  } catch {
    // ignore
  }
}

function stopAudio() {
  pauseLocalAudio();
  currentAudio = null;
}

let silentAudioUrl = '';

/** 生成一段很短的静音 WAV，用于在用户点击的同一个手势里解锁移动端音频。 */
function getSilentAudioUrl() {
  if (silentAudioUrl) return silentAudioUrl;

  const length = 800;
  const silentBuffer = {
    numberOfChannels: 1,
    length,
    getChannelData: () => new Float32Array(length),
  };

  silentAudioUrl = URL.createObjectURL(encodeWav(silentBuffer));
  return silentAudioUrl;
}

function playAudioBlob(blob, bubble, dot, audio) {
  const generation = ++audioGeneration;
  stopAudio();

  const url = URL.createObjectURL(blob);
  const player = audio || new Audio();
  currentAudio = player;

  const finish = () => {
    if (generation === audioGeneration) {
      bubble.classList.remove('playing');
      currentAudio = null;
    }
    URL.revokeObjectURL(url);
  };

  bubble.classList.add('playing');
  if (dot) dot.classList.remove('active');

  player.addEventListener('ended', finish, { once: true });
  player.addEventListener('error', () => {
    finish();
    showToast('语音播放失败，先看文字吧。');
  }, { once: true });

  try {
    player.pause();
    player.volume = 1;
    player.src = url;
    player.load();
    player.play().catch(() => {
      finish();
      showToast('点击后仍未能播放，请检查浏览器是否静音。');
    });
  } catch {
    finish();
    showToast('语音播放失败，先看文字吧。');
  }
}

async function requestAudio(payload) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    const error = new Error(err && err.name === 'AbortError'
      ? '语音生成超时，请再点一次。'
      : '网络连接失败，请稍后重试。');
    error.code = err && err.name === 'AbortError' ? 'TTS_TIMEOUT' : 'NETWORK_ERROR';
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const error = new Error(data && data.error && data.error.message
      ? data.error.message
      : `语音生成失败（HTTP ${response.status}）`);
    error.code = data && data.error && data.error.code
      ? data.error.code
      : 'TTS_FAILED';
    error.status = response.status;
    throw error;
  }

  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('audio/')) {
    throw new Error('语音服务没有返回音频。');
  }

  return response.blob();
}

async function playAiVoice({ text, tts, bubble, dot }) {
  if (!text) return;

  const generation = ++audioGeneration;
  bubble.classList.add('playing');
  if (dot) dot.classList.remove('active');

  // 在点击的同一个任务里播放静音片段，解锁 iOS/Android 的音频播放权限。
  const player = new Audio(getSilentAudioUrl());
  player.volume = 0;
  currentAudio = player;
  player.play().catch(() => {});

  try {
    const blob = await requestAudio({
      text,
      voice: tts && tts.voice,
      rate: tts && tts.rate,
      pitch: tts && tts.pitch,
      volume: tts && tts.volume,
    });

    if (generation !== audioGeneration) {
      player.pause();
      return;
    }

    playAudioBlob(blob, bubble, dot, player);
  } catch (err) {
    if (generation !== audioGeneration) return;

    player.pause();
    bubble.classList.remove('playing');
    console.error(`AI 报错：TTS/${err && err.message}`);

    if (err && err.code === 'TTS_NOT_CONFIGURED') {
      showToast('语音服务还没配置，先点「转文字」看内容吧。');
    } else {
      showToast('语音暂时不可用，先点「转文字」看内容吧。');
    }
  }
}

/* ---------------- 5. 消息渲染 ---------------- */

function showTyping(show) {
  if (show) {
    if (!typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'typing';
      typingEl.textContent = '对方正在输入...';
      messagesArea.appendChild(typingEl);
      scrollToBottom();
    }
  } else if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

function appendTextMessage(text, role, senderName) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `msg ${role}`;

  const nameDiv = document.createElement('div');
  nameDiv.className = 'sender-name';
  nameDiv.textContent = role === 'user' ? (senderName || state.name) : (senderName || 'AI');

  const bubble = document.createElement('div');
  bubble.className = 'text-bubble';
  bubble.textContent = text;

  msgDiv.append(nameDiv, bubble);
  messagesArea.appendChild(msgDiv);
  scrollToBottom();
}

function appendSystemMessage(text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg system';

  const note = document.createElement('div');
  note.className = 'system-note';
  note.textContent = text;

  msgDiv.appendChild(note);
  messagesArea.appendChild(msgDiv);
  scrollToBottom();
}

function appendAiVoiceBubble(sender, text, tts, unread = true, audioUrl = '') {
  const duration = Math.max(2, Math.round(text.length / 3));
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg ai';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'sender-name';
  nameDiv.textContent = sender;

  const rowDiv = document.createElement('div');
  rowDiv.className = 'bubble-row';

  const bubble = document.createElement('div');
  bubble.className = 'voice-bubble';
  bubble.tabIndex = 0;
  bubble.setAttribute('role', 'button');
  bubble.setAttribute('aria-label', `播放 ${sender} 的语音`);

  const wave = document.createElement('div');
  wave.className = 'wave';
  wave.innerHTML = '<span></span><span></span><span></span>';

  const durationEl = document.createElement('span');
  durationEl.textContent = `${duration}"`;

  const dot = document.createElement('div');
  dot.className = unread ? 'red-dot active' : 'red-dot';

  bubble.append(wave, durationEl, dot);

  const play = () => {
    dot.classList.remove('active');

    if (audioUrl) {
      const generation = ++audioGeneration;
      stopAudio();
      bubble.classList.add('playing');
      const audio = new Audio(audioUrl);
      currentAudio = audio;
      const finish = () => {
        if (generation === audioGeneration) {
          bubble.classList.remove('playing');
          currentAudio = null;
        }
      };
      audio.addEventListener('ended', finish, { once: true });
      audio.addEventListener('error', finish, { once: true });
      audio.play().catch(() => {
        finish();
        showToast('语音播放失败。');
      });
      return;
    }

    playAiVoice({ text, tts, bubble, dot });
  };

  bubble.addEventListener('click', play);
  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      play();
    }
  });

  rowDiv.appendChild(bubble);

  // 字幕默认收起，点「转文字」再展开
  const transBtn = document.createElement('div');
  transBtn.className = 'trans-btn';
  transBtn.textContent = '转文字';

  const transText = document.createElement('div');
  transText.className = 'trans-text';
  transText.textContent = text;

  transBtn.addEventListener('click', () => {
    const shown = transText.classList.toggle('show');
    transBtn.textContent = shown ? '收起' : '转文字';
  });

  rowDiv.appendChild(transBtn);
  msgDiv.append(nameDiv, rowDiv, transText);
  messagesArea.appendChild(msgDiv);
  scrollToBottom();
}

function appendUserVoiceBubble(duration, objectUrl) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg user';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'sender-name';
  nameDiv.textContent = state.name;

  const rowDiv = document.createElement('div');
  rowDiv.className = 'bubble-row';

  const bubble = document.createElement('div');
  bubble.className = 'voice-bubble';
  bubble.tabIndex = 0;
  bubble.setAttribute('role', 'button');
  bubble.setAttribute('aria-label', '播放我刚录的语音');

  const wave = document.createElement('div');
  wave.className = 'wave';
  wave.innerHTML = '<span></span><span></span><span></span>';

  const durationEl = document.createElement('span');
  durationEl.textContent = `${duration}"`;

  bubble.append(wave, durationEl);

  bubble.addEventListener('click', () => {
    if (!objectUrl) return;
    stopAudio();
    currentAudio = new Audio(objectUrl);
    currentAudio.play().catch(() => showToast('录音回放失败。'));
  });
  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      bubble.click();
    }
  });

  rowDiv.appendChild(bubble);
  msgDiv.append(nameDiv, rowDiv);
  messagesArea.appendChild(msgDiv);
  scrollToBottom();
}

function renderHistory() {
  state.history.forEach((item) => {
    if (item.role === 'ai' && item.audio) {
      appendAiVoiceBubble(item.name, item.text, item.tts, false, item.audio);
      return;
    }

    if (item.role === 'ai' && item.tts) {
      appendAiVoiceBubble(item.name, item.text, item.tts, false);
      return;
    }

    if (item.role === 'user' && item.audio) {
      appendUserVoiceBubble(item.duration || 2, item.audio);
      return;
    }

    appendTextMessage(item.text, item.role === 'user' ? 'user' : 'ai', item.role === 'user' ? item.name : 'AI');
  });
  saveHistory();
}

/* ---------------- 6. 聊天主流程 ---------------- */

function setBusy(busy) {
  state.busy = busy;
}

function deliverReply(reply) {
  if (!reply || !reply.text) return;
  appendAiVoiceBubble(reply.sender, reply.text, reply.tts);
  addHistory('ai', reply.sender, reply.text, reply.tts);
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function enqueueTurn(text, source = 'text', audio = '', duration = 0) {
  state.queue.push({ text, source, audio, duration });
  runQueue();
}

async function runQueue() {
  if (state.queueRunning) return;

  state.queueRunning = true;

  try {
    while (state.queue.length) {
      const turn = state.queue.shift();
      await runChatTurn(turn);
    }
  } finally {
    state.queueRunning = false;

    if (state.queue.length) {
      runQueue();
    } else if (state.name) {
      resetIdleTimer();
    }
  }
}

async function runChatTurn(turn) {
  const { text, source, audio, duration } = turn;
  addHistory('user', state.name, text, source === 'voice' && audio ? { audio, duration } : undefined);

  const token = ++state.token;
  setBusy(true);
  showTyping(true);

  try {
    const data = await requestReply({ mode: 'chat', text, source });
    if (token !== state.token) return;

    showTyping(false);
    deliverReply(data.reply);

    // 原版节奏：A 说完后等 1.5 秒，B 再补一句，然后才处理下一条用户消息
    await wait(INTERJECT_DELAY_MS);
    if (token !== state.token) return;

    try {
      const interject = await requestReply({
        mode: 'interject',
        text,
        previous: data.reply.text,
        previousSpeaker: data.reply.sender,
      });

      if (token === state.token) deliverReply(interject.reply);
    } catch {
      // 插话失败不打扰用户，主回复已经完整展示
    }
  } catch (err) {
    if (token === state.token) {
      showTyping(false);
      showChatError(err);
    }
  } finally {
    if (token === state.token) setBusy(false);
  }
}

function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  appendTextMessage(text, 'user', state.name);

  chatInput.value = '';
  sendBtn.style.display = 'none';

  enqueueTurn(text, 'text');
}
/* ---------------- 7. 冷场时角色主动开口 ---------------- */

function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = null;

  if (!state.name) return;

  state.idleTimer = window.setTimeout(runIdle, IDLE_DELAY_MS);
}

async function runIdle() {
  if (!state.name || state.busy || state.queueRunning || state.queue.length) return;

  // 页面不可见时不发起模型请求，等回到前台再继续
  if (document.visibilityState !== 'visible') return;

  state.queueRunning = true;
  const token = ++state.token;
  setBusy(true);
  showTyping(true);

  try {
    const data = await requestReply({ mode: 'idle' });
    if (token !== state.token) return;

    showTyping(false);
    deliverReply(data.reply);
  } catch (err) {
    if (token === state.token) {
      showTyping(false);
      console.error(`AI 报错：永动/${err && err.message}`);
    }
  } finally {
    if (token === state.token) {
      setBusy(false);
      state.queueRunning = false;

      if (state.queue.length) {
        runQueue();
      } else {
        resetIdleTimer();
      }
    }
  }
}

/* ---------------- 8. 进房问候 ---------------- */

async function sendGreeting() {
  state.queueRunning = true;
  const token = ++state.token;
  setBusy(true);
  showTyping(true);

  try {
    const data = await requestReply({ mode: 'greeting' });
    if (token !== state.token) return;

    showTyping(false);
    deliverReply(data.reply);
  } catch (err) {
    if (token === state.token) {
      showTyping(false);
      showChatError(err);
    }
  } finally {
    if (token === state.token) {
      setBusy(false);
      state.queueRunning = false;

      if (state.queue.length) {
        runQueue();
      } else {
        resetIdleTimer();
      }
    }
  }
}

/* ---------------- 9. 录音与语音转文字 ---------------- */

let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let pressTimer = null;
let pressStartTime = 0;
let isLongPress = false;
let isCanceling = false;
let startY = 0;
let discardRecording = false;
let maxDurationTimer = null;

function pickAudioMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function ensureMic() {
  if (mediaRecorder) return true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    showToast('当前浏览器不支持录音，请改用文字聊天。');
    return false;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    const mimeType = pickAudioMime();
    const options = { audioBitsPerSecond: 64000 };
    if (mimeType) options.mimeType = mimeType;

    try {
      mediaRecorder = new MediaRecorder(mediaStream, options);
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) audioChunks.push(event.data);
    });
    mediaRecorder.addEventListener('stop', onRecordingStop);
    return true;
  } catch (err) {
    console.warn('麦克风获取失败：', err);
    showToast('麦克风不可用，请允许麦克风权限，或先用文字聊天。');
    return false;
  }
}

/** 释放麦克风；iOS 切后台再回来时，原来的 MediaStream 可能已经失效。 */
function releaseMic() {
  clearTimeout(maxDurationTimer);
  maxDurationTimer = null;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    discardRecording = true;
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = null;
  mediaRecorder = null;
  audioChunks = [];
}

function onRecordingStop() {
  clearTimeout(maxDurationTimer);
  maxDurationTimer = null;

  const duration = Math.max(1, Math.min(10, Math.round((Date.now() - pressStartTime) / 1000)));
  const mimeType = (mediaRecorder && mediaRecorder.mimeType)
    || (audioChunks[0] && audioChunks[0].type)
    || 'audio/webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];

  if (discardRecording) {
    discardRecording = false;
    showToast('已取消录音。');
    return;
  }
  if (!blob.size) {
    showToast('没有录到声音，再试一次。');
    return;
  }

  handleVoiceBlob(blob, duration);
}

function onVoicePressStart(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  if (!mediaRecorder) {
    ensureMic().then((ok) => {
      if (ok) showToast('麦克风已就绪，长按「按住说话」开始录音。');
    });
    return;
  }

  startY = event.clientY || 0;
  isCanceling = false;

  // 先绑结束事件：短按（<180ms）也能清掉定时器，不会误触发录音
  document.addEventListener('pointermove', onVoicePressMove);
  document.addEventListener('pointerup', onVoicePressEnd);
  document.addEventListener('pointercancel', onVoicePressEnd);

  pressTimer = window.setTimeout(() => {
    isLongPress = true;
    pressStartTime = Date.now();
    audioChunks = [];

    try {
      mediaRecorder.start();
    } catch (err) {
      console.warn('录音启动失败：', err);
      isLongPress = false;
      showToast('录音启动失败，请重试。');
      return;
    }

    maxDurationTimer = window.setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        showToast('已自动结束录音。');
        onVoicePressEnd();
      }
    }, 10000);

    voiceBtn.textContent = '松开结束 (上滑取消)';
    voiceBtn.classList.add('recording');
    chatInput.blur();
  }, 180);
}

function onVoicePressMove(event) {
  if (!isLongPress) return;
  if (event.cancelable) event.preventDefault();

  const currentY = event.clientY || 0;
  const deltaY = startY - currentY;

  if (deltaY > 40) {
    if (!isCanceling) {
      isCanceling = true;
      voiceBtn.classList.remove('recording');
      voiceBtn.classList.add('canceling');
      voiceBtn.textContent = '松开取消';
    }
  } else if (isCanceling) {
    isCanceling = false;
    voiceBtn.classList.add('recording');
    voiceBtn.classList.remove('canceling');
    voiceBtn.textContent = '松开结束 (上滑取消)';
  }
}

function onVoicePressEnd(event) {
  clearTimeout(pressTimer);
  clearTimeout(maxDurationTimer);
  maxDurationTimer = null;

  document.removeEventListener('pointermove', onVoicePressMove);
  document.removeEventListener('pointerup', onVoicePressEnd);
  document.removeEventListener('pointercancel', onVoicePressEnd);

  // pointercancel 通常来自来电、切后台等系统行为，直接丢弃这段录音
  const shouldDiscard = isCanceling || (event && event.type === 'pointercancel');

  if (isLongPress && mediaRecorder && mediaRecorder.state === 'recording') {
    discardRecording = shouldDiscard;
    voiceBtn.classList.remove('recording', 'canceling');
    voiceBtn.textContent = '按住说话';
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }

  isLongPress = false;
  isCanceling = false;
}

/** 保存原始录音用于历史回放；另外转成 16kHz 单声道 WAV 供 Whisper 使用。 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取录音失败'));
    reader.readAsDataURL(blob);
  });
}

function encodeWav(audioBuffer) {
  const channels = Math.max(1, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }

  const buffer = new ArrayBuffer(44 + mono.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + mono.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, mono.length * 2, true);

  for (let i = 0; i < mono.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function blobToWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioCtx || !OfflineCtx) {
    throw new Error('当前浏览器不支持音频转码。');
  }

  const raw = await blob.arrayBuffer();
  const ctx = new AudioCtx();

  try {
    const decoded = await new Promise((resolve, reject) => {
      ctx.decodeAudioData(raw.slice(0), resolve, reject);
    });

    if (!decoded.length || !decoded.duration) {
      throw new Error('录音内容为空。');
    }

    const targetRate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineCtx(1, frames, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);

    return encodeWav(await offline.startRendering());
  } finally {
    if (typeof ctx.close === 'function' && ctx.state !== 'closed') {
      ctx.close().catch(() => {});
    }
  }
}

async function handleVoiceBlob(blob, duration) {
  const objectUrl = URL.createObjectURL(blob);
  appendUserVoiceBubble(duration, objectUrl);

  const ownTyping = !state.busy && !state.queueRunning;
  if (ownTyping) showTyping(true);

  let audioData = '';
  try {
    audioData = await blobToDataUrl(blob);
  } catch (err) {
    console.error(`AI 报错：识别/${err && err.message}`);
  }

  let wav;
  try {
    // Whisper turbo 对 webm/opus 容器不稳定，先解码并重采样成 16k 单声道 WAV
    wav = await blobToWav(blob);
  } catch (err) {
    console.error(`AI 报错：识别/${err && err.message}`);
    if (audioData) addHistory('user', state.name, '', { audio: audioData, duration });
    showToast('录音处理失败，请再说一次。');
    if (ownTyping) showTyping(false);
    return;
  }

  try {
    const data = await requestJson('/api/asr', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
      timeout: 45000,
    });

    const text = String(data.text || '').trim();
    if (!text || text === '（没听清）') {
      if (audioData) addHistory('user', state.name, '', { audio: audioData, duration });
      showToast('没听清，靠近麦克风再说一次。');
      return;
    }

    enqueueTurn(text, 'voice', audioData, duration);
  } catch (err) {
    if (audioData) addHistory('user', state.name, '', { audio: audioData, duration });
    console.error(`AI 报错：识别/${err && err.message}`);
    showToast('没听清，再说一次吧。');
  } finally {
    if (ownTyping && !state.busy && !state.queueRunning) showTyping(false);
  }
}

/* ---------------- 10. 入场与事件绑定 ---------------- */

function enterRoom() {
  const name = nicknameInput.value.trim();
  if (!name) return;

  state.gender = myGender;
  state.name = name;
  state.queue = [];
  state.queueRunning = false;

  setupPage.classList.remove('active');
  chatPage.classList.add('active');
  displayName.textContent = name;
  messagesArea.innerHTML = '';

  state.history = loadHistory();
  renderHistory();
  scrollToBottom();

  ensureMic();
  sendGreeting();
}

nicknameInput.addEventListener('input', () => {
  enterBtn.disabled = nicknameInput.value.trim().length === 0;
});

genderBtns.forEach((button) => {
  button.addEventListener('click', () => {
    genderBtns.forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    myGender = button.dataset.gender === 'female' ? 'female' : 'male';
  });
});

enterBtn.addEventListener('click', enterRoom);

sendBtn.addEventListener('click', sendTextMessage);

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    sendTextMessage();
  }
});

chatInput.addEventListener('input', () => {
  sendBtn.style.display = chatInput.value.trim() ? 'block' : 'none';
});

voiceBtn.addEventListener('pointerdown', onVoicePressStart);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    return;
  }

  // 回到前台：iOS 可能已经回收麦克风轨道，释放后下次长按会重新申请
  const track = mediaStream && mediaStream.getAudioTracks()[0];
  if (!track || track.readyState === 'ended') {
    releaseMic();
  }

  if (state.name && !state.busy) resetIdleTimer();
});

window.addEventListener('pagehide', () => {
  stopAudio();
  releaseMic();
});

/* ---------------- 11. 安装到桌面与离线缓存 ---------------- */

let deferredInstallPrompt = null;

const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || window.matchMedia('(hover: none) and (pointer: coarse)').matches
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

function hideInstallButton() {
  if (installBtn) installBtn.hidden = true;
}

function showInstallButton() {
  // 明确禁止手机端安装入口：手机只用于聊天，不提供 PWA 安装。
  if (!installBtn || isMobile || isStandalone) {
    hideInstallButton();
    return;
  }

  installBtn.hidden = false;
  installBtn.textContent = '安装到桌面';
}

function installHint() {
  showToast('请用 Chrome / Edge 打开本页，再从地址栏安装。');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();

  if (isMobile) {
    hideInstallButton();
    return;
  }

  deferredInstallPrompt = event;
  showInstallButton();
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    installHint();
    return;
  }

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;

  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

// 手机端无论浏览器是否触发安装事件，都不显示入口。
if (isMobile || isStandalone) {
  hideInstallButton();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service Worker 注册失败：', err);
  });
}
