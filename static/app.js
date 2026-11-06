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

// ================= 1. 设置页逻辑 =================
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
    
    // 切换剧本时，清空屏幕，加载对应性别的本地记录
    document.getElementById('messages').innerHTML = '';
    loadLocalHistory(); 
    
    connectWebSocket();
});

// ================= 2. WebSocket 连接 =================
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const voiceBtn = document.getElementById('voice-btn');
const messagesArea = document.getElementById('messages');

let sysMsgDiv = null;

function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws/chat');

    ws.onopen = () => {
        const currentHour = new Date().getHours(); // 获取用户本地时间
        ws.send(JSON.stringify({
            type: 'greeting',
            gender: myGender,
            username: myName,
            hour: currentHour // 🌟 把本地时间传给后端
        }));
    };

    ws.onmessage = (event) => {
        const msgData = JSON.parse(event.data);
        if (msgData.type === 'status' && msgData.status === 'typing') {
            showTypingStatus();
        } else if (msgData.type === 'voice') {
            removeTypingStatus();
            // 渲染 AI 的语音气泡
            appendVoiceBubble(msgData.sender, msgData.duration, msgData.audio, msgData.text, true);
            // 存到本地记录
            saveLocalMessage(msgData.sender, msgData.audio, msgData.text);
        }
    };

    ws.onclose = () => {
        console.log("连接已断开");
    };
}

// ================= 3. 缓存隔离系统 =================
function getHistoryKey() {
    return `history_${myGender}_${myName}`; 
}

function saveLocalMessage(sender, audio, text) {
    let history = JSON.parse(localStorage.getItem(getHistoryKey()) || "[]");
    history.push({ sender, audio, text });
    if(history.length > 20) history.shift(); 
    localStorage.setItem(getHistoryKey(), JSON.stringify(history));
}

function loadLocalHistory() {
    let history = JSON.parse(localStorage.getItem(getHistoryKey()) || "[]");
    history.forEach(msg => {
        if (msg.audio && msg.audio.length > 100) { // 如果有音频数据
            appendVoiceBubble(msg.sender, 2, msg.audio, msg.text, false); 
        } else {
            appendTextMessage(msg.text, msg.sender === myName ? 'user' : 'ai');
        }
    });
}

// ================= 4. 发送文字 =================
function sendTextMessage() {
    const text = chatInput.value.trim();
    if (!text || !ws) return;
    
    appendTextMessage(text, 'user');
    
    // 存入本地
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
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendTextMessage(); });
chatInput.addEventListener('input', () => {
    sendBtn.style.display = chatInput.value.trim() ? 'block' : 'none';
});

// ================= 5. 发送语音 =================
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
            
            // 渲染自己的语音气泡
            appendVoiceBubble(myName, duration, base64Str, "", false);
            
            // 存入本地
            saveLocalMessage(myName, base64Str, "");
            
            // 发给后端
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


// ================= 6. UI 渲染工具 =================
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
    
    msgDiv.innerHTML = `
        <div class="sender-name">${senderName}</div>
        <div class="text-bubble">${text}</div>
    `;
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function appendVoiceBubble(sender, duration, audioBase64, text, isUnread) {
    const role = sender === myName ? 'user' : 'ai';
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${role}`;
    
    // 名字
    const nameDiv = document.createElement('div');
    nameDiv.className = 'sender-name';
    nameDiv.textContent = sender;
    msgDiv.appendChild(nameDiv);

    // 气泡行
    const rowDiv = document.createElement('div');
    rowDiv.className = 'bubble-row';

    // 语音气泡
    const bubble = document.createElement('div');
    bubble.className = 'voice-bubble';
    bubble.innerHTML = `
        <div class="wave"><span></span><span></span><span></span></div>
        <span>${duration}"</span>
        <div class="red-dot ${isUnread ? 'active' : ''}"></div>
    `;
    
    if (audioBase64) {
        bubble.onclick = () => {
            const dot = bubble.querySelector('.red-dot');
            if(dot) dot.classList.remove('active');

            if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; }
            currentAudio = new Audio(audioBase64);
            currentAudio.play();
        };
    }
    rowDiv.appendChild(bubble);

    // 转文字
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