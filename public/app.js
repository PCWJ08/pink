'use strict';

/* ============================================================
   Pink Room 前端交互
   - 文本与语音都通过 fetch 调用 Worker 接口
   - 回复语音使用浏览器 speechSynthesis
   - 聊天记录保存在 localStorage，请求时附带最近几条作为上下文
   - 录音在浏览器内转为 16kHz 单声道 WAV，兼容移动端
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

const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;

const STORAGE_PREFIX = 'pink_room_history_';
const MAX_LOCAL_HISTORY = 30;
const MAX_API_HISTORY = 12;
const IDLE_DELAY_MS = 15000;
const IDLE_MAX_LOOPS = 2;
const INTERJECT_DELAY_MS = 1400;

let myGender = 'male';

const state = {
  gender: 'male',
  name: '',
  history: [],
  busy: false,
  token: 0,
  idleTimer: null,
  idleLoops: 0,
};

let typingEl = null;
let currentAudio = null;
let speechPrimed = false;
let toastTimer = null;

/* ---------------- 2. 通用工具 ---------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

/** 兼容旧版 localStorage（旧数据里带有 base64 音频，这里只取文字，避免撑爆配额）。 */
function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return null;

  const text = String(item.text || '').trim();
  if (!text) return null;

  let role = item.role === 'ai' || item.role === 'user' ? item.role : null;
  if (!role && item.sender) role = item.sender === state.name ? 'user' : 'ai';
  if (!role) return null;

  const name = role === 'user' ? state.name : String(item.name || item.sender || 'AI');
  return { role, name, text };
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey()) || '[]');
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
  try {
    localStorage.setItem(historyKey(), JSON.stringify(state.history.slice(-MAX_LOCAL_HISTORY)));
  } catch {
    // localStorage 满了也不影响本轮的聊天
  }
}

function addHistory(role, name, text) {
  state.history.push({ role, name, text });
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
    if (err && err.name === 'AbortError') throw new Error('请求超时，请检查网络后重试。');
    throw new Error('网络连接失败，请稍后重试。');
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
    throw new Error(data && data.error && data.error.message
      ? data.error.message
      : `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

function requestReply(options = {}) {
  const payload = {
    mode: options.mode || 'chat',
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

/* ---------------- 4. 浏览器语音合成（代替 Edge-TTS） ---------------- */

const speechState = { queue: [], speaking: false, generation: 0 };

/** 在用户手势里先播放一个静音片段，绕过移动端「首次朗读需要交互」的限制。 */
function primeSpeech() {
  if (speechPrimed || !synth) return;
  try {
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    utterance.rate = 2;
    synth.speak(utterance);
    speechPrimed = true;
  } catch {
    // 不支持就只显示文字
  }
}

function pickVoice(voiceGender) {
  if (!synth) return null;

  let voices = [];
  try {
    voices = synth.getVoices() || [];
  } catch {
    return null;
  }
  if (!voices.length) return null;

  const chinese = voices.filter(
    (voice) => /^zh([-_]|$)/i.test(voice.lang) || /chinese|中文|普通话|國語/i.test(voice.name),
  );
  const pool = chinese.length ? chinese : voices;
  const female = /xiaoxiao|xiaoyi|huihui|yaoyao|ting[- ]?ting|meijia|sinji|female|女/i;
  const male = /yunxi|yunjian|yunyang|kangkang|liang|male|男/i;
  const pattern = voiceGender === 'male' ? male : female;

  return pool.find((voice) => pattern.test(voice.name)) || pool[0] || null;
}

function pauseLocalAudio() {
  if (!currentAudio) return;
  try {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  } catch {
    // ignore
  }
}

function pumpSpeech() {
  if (!synth || speechState.speaking || speechState.queue.length === 0) return;

  const generation = speechState.generation;
  const item = speechState.queue.shift();
  const tts = item.tts || {};

  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = 'zh-CN';
  utterance.rate = clamp(Number(tts.rate) || 1, 0.5, 2);
  utterance.pitch = clamp(Number(tts.pitch) || 1, 0, 2);
  utterance.volume = 1;

  const voice = pickVoice(tts.voice);
  if (voice) utterance.voice = voice;

  speechState.speaking = true;
  pauseLocalAudio();

  const finish = () => {
    if (generation !== speechState.generation) return;
    speechState.speaking = false;
    window.setTimeout(() => {
      if (generation === speechState.generation) pumpSpeech();
    }, 120);
  };

  utterance.onend = finish;
  utterance.onerror = finish;

  try {
    synth.speak(utterance);
  } catch {
    finish();
  }
}

function speak(text, tts) {
  if (!synth || !text) return;
  speechState.queue.push({ text, tts });
  pumpSpeech();
}

function stopSpeech() {
  if (!synth) return;
  speechState.generation += 1;
  speechState.queue = [];
  speechState.speaking = false;
  try {
    synth.cancel();
  } catch {
    // ignore
  }
}

function replaySpeech(text, tts) {
  if (!synth) {
    showToast('当前浏览器不支持语音朗读，文字仍可阅读。');
    return;
  }
  stopSpeech();
  speak(text, tts);
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

function appendAiVoiceBubble(sender, text, tts) {
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
  dot.className = 'red-dot active';

  bubble.append(wave, durationEl, dot);

  let playTimer = null;
  const play = () => {
    dot.classList.remove('active');
    bubble.classList.add('playing');
    clearTimeout(playTimer);
    playTimer = window.setTimeout(() => bubble.classList.remove('playing'), Math.max(1500, duration * 1000));
    replaySpeech(text, tts);
  };

  bubble.addEventListener('click', play);
  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      play();
    }
  });

  rowDiv.appendChild(bubble);

  // 字幕默认展开，语音被浏览器拦截时也能读
  const transBtn = document.createElement('div');
  transBtn.className = 'trans-btn';
  transBtn.textContent = '收起';

  const transText = document.createElement('div');
  transText.className = 'trans-text show';
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
    stopSpeech();
    pauseLocalAudio();
    currentAudio = new Audio(objectUrl);
    currentAudio.play().catch(() => showToast('录音回放失败。'));
  });
  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      bubble.click();
    }
  });

  const transText = document.createElement('div');
  transText.className = 'trans-text';

  rowDiv.appendChild(bubble);
  msgDiv.append(nameDiv, rowDiv, transText);
  messagesArea.appendChild(msgDiv);
  scrollToBottom();

  return {
    setText(text) {
      transText.textContent = text;
      transText.classList.add('show');
      scrollToBottom();
    },
    setFailure(text) {
      transText.textContent = text;
      transText.classList.add('show');
      scrollToBottom();
    },
  };
}

function renderHistory() {
  state.history.forEach((item) => {
    appendTextMessage(item.text, item.role === 'user' ? 'user' : 'ai', item.name);
  });
  saveHistory();
}

/* ---------------- 6. 聊天主流程 ---------------- */

function setBusy(busy) {
  state.busy = busy;
  sendBtn.disabled = busy;
  voiceBtn.disabled = busy;
  chatInput.placeholder = busy ? '对方正在回复...' : '发消息...';
  if (!busy) {
    sendBtn.style.display = chatInput.value.trim() ? 'block' : 'none';
  }
}

function deliverReply(reply) {
  if (!reply || !reply.text) return;
  appendAiVoiceBubble(reply.sender, reply.text, reply.tts);
  addHistory('ai', reply.sender, reply.text);
  speak(reply.text, reply.tts);
}

async function runChatTurn(text) {
  const token = ++state.token;
  setBusy(true);
  showTyping(true);

  try {
    const data = await requestReply({ mode: 'chat', text });
    if (token !== state.token) return;

    showTyping(false);
    deliverReply(data.reply);
    state.idleLoops = 0;
    resetIdleTimer();
    scheduleInterject(text, data.reply, token);
  } catch (err) {
    if (token === state.token) {
      showTyping(false);
      appendSystemMessage(err.message);
    }
  } finally {
    if (token === state.token) setBusy(false);
  }
}

/** 角色 A 说完 1.4 秒后，让房间里的另一个角色插一句话。 */
function scheduleInterject(userText, mainReply, token) {
  if (!mainReply || !mainReply.text) return;

  window.setTimeout(async () => {
    if (token !== state.token || state.busy) return;

    try {
      const data = await requestReply({
        mode: 'interject',
        text: userText,
        previous: mainReply.text,
        previousSpeaker: mainReply.sender,
      });
      if (token !== state.token) return;

      deliverReply(data.reply);
      resetIdleTimer();
    } catch {
      // 插话失败不打扰用户，主回复已经完整展示
    }
  }, INTERJECT_DELAY_MS);
}

function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text || state.busy) return;

  primeSpeech();
  state.idleLoops = 0;
  appendTextMessage(text, 'user', state.name);
  addHistory('user', state.name, text);

  chatInput.value = '';
  sendBtn.style.display = 'none';

  runChatTurn(text);
}

/* ---------------- 7. 冷场时角色主动开口 ---------------- */

function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = null;

  if (!state.name || state.idleLoops >= IDLE_MAX_LOOPS) return;

  state.idleTimer = window.setTimeout(runIdle, IDLE_DELAY_MS);
}

async function runIdle() {
  if (!state.name || state.busy || document.visibilityState !== 'visible') {
    resetIdleTimer();
    return;
  }

  const token = ++state.token;
  setBusy(true);
  showTyping(true);

  try {
    const data = await requestReply({ mode: 'idle' });
    if (token !== state.token) return;

    showTyping(false);
    deliverReply(data.reply);
    state.idleLoops += 1;
  } catch {
    // 冷场接话失败就安静待着，不弹错误
    if (token === state.token) showTyping(false);
  } finally {
    if (token === state.token) {
      setBusy(false);
      if (state.idleLoops < IDLE_MAX_LOOPS) resetIdleTimer();
    }
  }
}

/* ---------------- 8. 进房问候 ---------------- */

async function sendGreeting() {
  const token = ++state.token;
  setBusy(true);
  showTyping(true);

  try {
    const data = await requestReply({ mode: 'greeting' });
    if (token !== state.token) return;

    showTyping(false);
    deliverReply(data.reply);
    resetIdleTimer();
  } catch (err) {
    if (token === state.token) {
      showTyping(false);
      appendSystemMessage(err.message);
    }
  } finally {
    if (token === state.token) setBusy(false);
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
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);

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
  const duration = Math.max(1, Math.round((Date.now() - pressStartTime) / 1000));
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
  if (blob.size < 1200 || duration < 1) {
    showToast('说话时间太短，再按住试一次。');
    return;
  }

  handleVoiceBlob(blob, duration);
}

function onVoicePressStart(event) {
  if (state.busy) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  if (!mediaRecorder) {
    ensureMic().then((ok) => {
      if (ok) showToast('麦克风已就绪，长按「按住说话」开始录音。');
    });
    return;
  }

  primeSpeech();

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

/** 把任意浏览器能解码的录音转成 16kHz 单声道 WAV，最大化 ASR 兼容性。 */
async function blobToWav(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext unsupported');

  const arrayBuffer = await blob.arrayBuffer();
  const context = new AudioContextClass();
  let audioBuffer;

  try {
    audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (context.close) context.close().catch(() => {});
  }

  const sampleRate = 16000;
  const length = Math.max(1, Math.ceil(audioBuffer.duration * sampleRate));
  const offline = new OfflineAudioContext(1, length, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), sampleRate);
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function handleVoiceBlob(blob, duration) {
  const objectUrl = URL.createObjectURL(blob);
  const bubble = appendUserVoiceBubble(duration, objectUrl);
  const token = ++state.token;

  setBusy(true);
  showTyping(true);

  try {
    const upload = await blobToWav(blob).catch((err) => {
      console.warn('WAV 转换失败，改为上传原始录音：', err);
      return blob;
    });

    const data = await requestJson('/api/asr', {
      method: 'POST',
      headers: { 'content-type': upload.type || blob.type || 'audio/webm' },
      body: upload,
      timeout: 45000,
    });

    if (token !== state.token) return;

    const text = String(data.text || '').trim();
    if (!text || text === '（没听清）') {
      bubble.setFailure('没听清，再说一次吧');
      showTyping(false);
      showToast('没听清，请靠近麦克风再说一次。');
      return;
    }

    bubble.setText(text);
    addHistory('user', state.name, text);
    showTyping(false);

    await runChatTurn(text);
  } catch (err) {
    if (token !== state.token) return;
    bubble.setFailure('转写失败');
    showTyping(false);
    appendSystemMessage(err.message);
  } finally {
    if (token === state.token) setBusy(false);
  }
}

/* ---------------- 10. 入场与事件绑定 ---------------- */

function enterRoom() {
  const name = nicknameInput.value.trim();
  if (!name) return;

  state.gender = myGender;
  state.name = name;
  primeSpeech();

  setupPage.classList.remove('active');
  chatPage.classList.add('active');
  displayName.textContent = name;
  messagesArea.innerHTML = '';

  state.history = loadHistory();
  renderHistory();
  scrollToBottom();

  if (!synth) showToast('当前浏览器不支持语音朗读，将以文字显示回复。');

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
  stopSpeech();
  releaseMic();
});

/* ---------------- 11. 安装到桌面与离线缓存 ---------------- */

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;

  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service Worker 注册失败：', err);
  });
}