const setupPage = document.getElementById('setup-page');
const chatPage = document.getElementById('chat-page');
const nicknameInput = document.getElementById('nickname-input');
const enterBtn = document.getElementById('enter-btn');
const genderBtns = document.querySelectorAll('.gender-btn');
const displayName = document.getElementById('display-name');

let myGender = 'male';
let myName = '';
let ws = null;
let currentAudio = null;

// ============================================================
// 1. 入场配置
// 昵称与性别共同决定加载哪一套角色剧本，同时也是本地缓存的隔离维度
// ============================================================
nicknameInput.addEventListener('input', () => {
    enterBtn.disabled = nicknameInput.value.trim().length === 0;
});
genderBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        genderBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        myGender = btn.dataset.gender;
    });
});

enterBtn.addEventListener('click', () => {
    myName = nicknameInput.value.trim();
    if (!myName) return;
    setupPage.classList.remove('active');
    chatPage.classList.add('active');
    displayName.textContent = myName;
    
    // 切换房间时清空 DOM 并载入对应性别的历史记录
    document.getElementById('messages').innerHTML = '';
    loadLocalHistory(); 
    
    connectWebSocket();
});

// ============================================================
// 2. WebSocket 连接
// 单端点长连接，所有下行帧由 type 字段区分：status / voice
// ============================================================
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const voiceBtn = document.getElementById('voice-btn');
const messagesArea = document.getElementById('messages');

let sysMsgDiv = null;

function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws/chat');

    ws.onopen = () => {
        // 把客户端本地时间一并上报，让问候语能区分清晨与深夜
        const currentHour = new Date().getHours();
        ws.send(JSON.stringify({
            type: 'greeting',
            gender: myGender,
            username: myName,
            hour: currentHour
        }));
    };

    ws.onmessage = (event) => {
        const msgData = JSON.parse(event.data);
        if (msgData.type === 'status' && msgData.status === 'typing') {
            showTypingStatus();
        } else if (msgData.type === 'voice') {
            removeTypingStatus();
            // 渲染 AI 语音气泡（带未读红点）
            appendVoiceBubble(msgData.sender, msgData.duration, msgData.audio, msgData.text, true);
            // 同步写入本地缓存
            saveLocalMessage(msgData.sender, msgData.audio, msgData.text);
        }
    };

    ws.onclose = () => {
        console.log("连接已断开");
    };
}

// ============================================================
// 3. 会话缓存
// 键名按 性别 + 昵称 隔离，同一浏览器的不同房间互不串台
// ============================================================
function getHistoryKey() {
    return `history_${myGender}_${myName}`; 
}

function saveLocalMessage(sender, audio, text) {
    let history = JSON.parse(localStorage.getItem(getHistoryKey()) || "[]");
    history.push({ sender, audio, text });
    // 仅保留最近 20 条，避免 base64 音频撑爆 localStorage 配额
    if(history.length > 20) history.shift(); 
    localStorage.setItem(getHistoryKey(), JSON.stringify(history));
}

function loadLocalHistory() {
    let history = JSON.parse(localStorage.getItem(getHistoryKey()) || "[]");
    history.forEach(msg => {
        if (msg.audio && msg.audio.length > 100) { // 足够长才视为真实音频数据
            appendVoiceBubble(msg.sender, 2, msg.audio, msg.text, false); 
        } else {
            appendTextMessage(msg.text, msg.sender === myName ? 'user' : 'ai');
        }
    });
}

// ============================================================
// 4. 文字消息
// ============================================================
function sendTextMessage() {
    const text = chatInput.value.trim();
    if (!text || !ws) return;
    
    appendTextMessage(text, 'user');
    
    // 本地留存，刷新后仍能看到自己说过的话
    saveLocalMessage(myName, "", text);

    ws.send(JSON.stringify({ 
        type: 'text', 
        content: text, 
        gender: myGender, 
        username: myName 
    }));
    
    chatInput.value = '';
    sendBtn.style.display = 'none';
    chatInput.blur();
}

sendBtn.addEventListener('click', sendTextMessage);
// Enter 发送；移动端软键盘不触发 keypress，仍走按钮
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendTextMessage(); });
chatInput.addEventListener('input', () => {
    sendBtn.style.display = chatInput.value.trim() ? 'block' : 'none';
});

// ============================================================
// 5. 语音消息
// 手势约定：长按 200ms 进入录音，上滑超过 40px 松手即取消
// ============================================================
let pressTimer = null;
let pressStartTime = 0;
let isLongPress = false;
let startY = 0;
let isCanceling = false;
let mediaRecorder;
let audioChunks = [];

navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = () => {
        if (isCanceling || !ws) { audioChunks = []; return; }
        
        const duration = Math.round((Date.now() - pressStartTime) / 1000) || 1;
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
            const base64Str = reader.result;
            
            // 先上屏自己的语音气泡，再等 AI 回，交互上更即时
            appendVoiceBubble(myName, duration, base64Str, "", false);
            
            saveLocalMessage(myName, base64Str, "");
            
            ws.send(JSON.stringify({
                type: 'voice',
                audio: base64Str,
                gender: myGender,
                username: myName
            }));
        };
        audioChunks = [];
    };
}).catch(err => console.log("麦克风获取失败: ", err));

function onVoicePressStart(e) {
    if (e.button && e.button !== 0) return;
    startY = e.clientY || (e.touches && e.touches[0].clientY);
    isCanceling = false;

    pressTimer = setTimeout(() => {
        isLongPress = true;
        pressStartTime = Date.now();
        
        voiceBtn.textContent = '松开结束 (上滑取消)';
        voiceBtn.classList.add('recording');
        
        chatInput.value = '';
        sendBtn.style.display = 'none';
        chatInput.blur();

        audioChunks = [];
        mediaRecorder.start();

        document.addEventListener('mousemove', onVoicePressMove);
        document.addEventListener('mouseup', onVoicePressEnd);
        document.addEventListener('touchmove', onVoicePressMove, { passive: false });
        document.addEventListener('touchend', onVoicePressEnd);
    }, 200); 
}

function onVoicePressMove(e) {
    if (!isLongPress) return;
    if (e.cancelable) e.preventDefault(); 

    const currentY = e.clientY || (e.touches && e.touches[0].clientY);
    const deltaY = startY - currentY; 

    if (deltaY > 40) {
        if (!isCanceling) {
            isCanceling = true;
            voiceBtn.classList.remove('recording');
            voiceBtn.classList.add('canceling');
            voiceBtn.textContent = '松开取消';
        }
    } else {
        if (isCanceling) {
            isCanceling = false;
            voiceBtn.classList.add('recording');
            voiceBtn.classList.remove('canceling');
            voiceBtn.textContent = '松开结束 (上滑取消)';
        }
    }
}

function onVoicePressEnd(e) {
    clearTimeout(pressTimer);

    document.removeEventListener('mousemove', onVoicePressMove);
    document.removeEventListener('mouseup', onVoicePressEnd);
    document.removeEventListener('touchmove', onVoicePressMove);
    document.removeEventListener('touchend', onVoicePressEnd);

    if (isLongPress) {
        voiceBtn.classList.remove('recording', 'canceling');
        voiceBtn.textContent = '按住说话';
        mediaRecorder.stop();
        isLongPress = false;
    }
}

voiceBtn.addEventListener('mousedown', onVoicePressStart);
voiceBtn.addEventListener('touchstart', onVoicePressStart, { passive: false });


// ============================================================
// 6. 消息渲染
// 全部通过 DOM API 构建，文本一律走 textContent 或受控模板，避免注入
// ============================================================
function showTypingStatus() {
    removeTypingStatus();
    sysMsgDiv = document.createElement('div');
    sysMsgDiv.style.cssText = "text-align:center; font-size:12px; color:var(--pink-main); margin:10px 0;";
    sysMsgDiv.textContent = "对方正在输入...";
    messagesArea.appendChild(sysMsgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function removeTypingStatus() {
    if (sysMsgDiv) { sysMsgDiv.remove(); sysMsgDiv = null; }
}

function appendTextMessage(text, role) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${role}`;
    
    const senderName = role === 'user' ? myName : 'AI'; 
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'sender-name';
    nameDiv.textContent = senderName;

    const bubble = document.createElement('div');
    bubble.className = 'text-bubble';
    bubble.textContent = text;

    msgDiv.appendChild(nameDiv);
    msgDiv.appendChild(bubble);

    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function appendVoiceBubble(sender, duration, audioBase64, text, isUnread) {
    const role = sender === myName ? 'user' : 'ai';
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${role}`;
    
    // 发送者名
    const nameDiv = document.createElement('div');
    nameDiv.className = 'sender-name';
    nameDiv.textContent = sender;
    msgDiv.appendChild(nameDiv);

    // 气泡行：语音气泡 + 转文字按钮
    const rowDiv = document.createElement('div');
    rowDiv.className = 'bubble-row';

    // 语音气泡本体
    const bubble = document.createElement('div');
    bubble.className = 'voice-bubble';
    bubble.innerHTML = `
        <div class="wave"><span></span><span></span><span></span></div>
        <span>${duration}"</span>
        <div class="red-dot ${isUnread ? 'active' : ''}"></div>
    `;
    
    if (audioBase64) {
        bubble.onclick = () => {
            // 播放即视为已读
            const dot = bubble.querySelector('.red-dot');
            if(dot) dot.classList.remove('active');

            // 同一时刻只允许一条语音在播，避免叠音
            if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; }
            currentAudio = new Audio(audioBase64);
            currentAudio.play();
        };
    }
    rowDiv.appendChild(bubble);

    // 折叠式字幕：默认收起，按需展开
    let transText = null;
    if (role === 'ai' && text) {
        const transBtn = document.createElement('div');
        transBtn.className = 'trans-btn';
        transBtn.textContent = '转文字';
        
        transText = document.createElement('div');
        transText.className = 'trans-text';
        transText.textContent = text;
        
        transBtn.onclick = () => {
            if (transText.style.display === 'none' || !transText.style.display) {
                transText.style.display = 'block';
                transBtn.textContent = '收起';
            } else {
                transText.style.display = 'none';
                transBtn.textContent = '转文字';
            }
        };
        rowDiv.appendChild(transBtn);
    }
    
    msgDiv.appendChild(rowDiv);

    if (transText) {
        msgDiv.appendChild(transText);
    }
    
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}