<div align="center">

# Pink Room

**一个会主动开口的 AI 陪聊室**

两个人格、同一屋檐、语音往返

[![在线试玩](https://img.shields.io/badge/在线试玩-ai.weidenglu.com-ff8eaa?style=flat-square&logo=googlechrome&logoColor=white)](https://ai.weidenglu.com)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![PWA](https://img.shields.io/badge/PWA-可安装到桌面-5A0FC8?style=flat-square&logo=pwa&logoColor=white)](https://ai.weidenglu.com)
[![License](https://img.shields.io/badge/License-MIT-ff8eaa?style=flat-square)](LICENSE)

</div>

---

**在线试玩**：<https://ai.weidenglu.com>

Pink Room 不是「输入问题、输出回答」的对话框，而是一个房间。房间里住着两个性格相反的角色：你说话时，一个回应你；1.4 秒后另一个插话，附和、吐槽，或者把话题拽走。你沉默超过 15 秒，它们会自己找话题。

回复由浏览器直接念出来，带波形、秒数、未读红点，也能展开成文字。页面可以安装到桌面，下次从图标打开，像一个小应用。

<br>

## 界面预览

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/images/preview-room-male.jpeg" alt="男生房间：御姐 / 甜妹" /></td>
    <td width="50%" align="center"><img src="docs/images/preview-room-female.jpeg" alt="女生房间：暖男 / 霸总" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>男生房间</b> · 御姐 &amp; 甜妹</sub></td>
    <td align="center"><sub><b>女生房间</b> · 暖男 &amp; 霸总</sub></td>
  </tr>
</table>

<div align="center">
<img src="docs/images/preview-setup.jpeg" alt="入场页" width="58%" />
<br>
<sub>入场页 · 昵称与性别决定加载哪套剧本，聊天记录按房间隔离</sub>
</div>

<br>

## 玩法

| | |
|---|---|
| **房间** | 男生房住着御姐和甜妹，女生房住着暖男和霸总，性格两两相反 |
| **对话** | 文字或按住说话；角色 A 先回应，约 1.4 秒后角色 B 接着补一句 |
| **冷场** | 安静 15 秒后，随机角色主动开口，最多连续两次 |
| **声音** | 回复自动朗读；点气泡重播，点「转文字」展开字幕 |
| **记录** | 最近 30 条留在浏览器，按「性别 + 昵称」隔离 |
| **安装** | 支持 PWA，可添加到桌面，独立窗口打开 |

<br>

## 设计

### 一个 Worker，两种接口

静态页面和 API 挂在同一个 Cloudflare Worker 上，同源，没有跨域。`public/` 交给 Workers Static Assets 直接分发，`/api/*` 进入 Worker。没有数据库，也没有常驻进程。

### 双人格调度

一次用户发言拆成两步：

1. `mode=chat`：随机角色 A 按人设回复
2. 1.4 秒后 `mode=interject`：角色 B 读取用户原话和 A 的回复，再接一句

冷场由前端计时触发 `mode=idle`，进房问候是 `mode=greeting`。四种模式共用 `src/chat.js` 的 prompt 构建，回复统一裁成一句话。

### 语音链路

- **输入**：MediaRecorder 录音 → Web Audio 解码 → 16kHz 单声道 WAV → `/api/asr` → SenseVoice
- **输出**：浏览器 `speechSynthesis`，按角色配置的语速和音调朗读

这样 iOS 的 mp4 录音和 Android 的 webm 录音都能走同一条链路，也不需要后端 TTS。

### 记忆

聊天记录只存在 `localStorage`，请求时附带最近 12 条。Worker 不保存会话，实例回收不影响上下文。刷新后还能接着聊，换设备则从空白开始。

### PWA

`manifest.webmanifest` 提供名称、图标与独立窗口；`sw.js` 缓存页面和静态资源，但不缓存 `/api/*`。断网时能打开界面，聊天仍然需要联网。`_headers` 负责 manifest 的 MIME 和 Service Worker 的缓存策略。

### 几个取舍

回复限制在十几个字，是为了像一条语音消息，而不是小作文。没有使用 WebSocket，是因为每个角色只说一句话，前端控制节奏更简单，Worker 也不需要维护长连接。

<br>

## 技术栈

Cloudflare Workers · Workers Static Assets · 原生 JavaScript · SpeechSynthesis · SenseVoice · OpenAI 兼容对话接口

<br>

## 项目结构

```
pink/
├── public/
│   ├── index.html
│   ├── app.js
│   ├── theme.css
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── _headers
│   └── icons/
├── src/
│   ├── index.js                # 接口路由、跨域、错误处理
│   ├── chat.js                 # 人设 prompt 与对话模型调用
│   ├── asr.js                  # 音频转文字
│   ├── personas.js             # 角色剧本与朗读参数
│   └── utils.js                # 超时与上游响应解析
├── docs/images/
├── wrangler.jsonc
├── package.json
├── README.md
└── LICENSE
```

<br>

## 开发说明

### 角色

角色都写在 `src/personas.js`。追加一项即可，前端不需要改，角色名与朗读参数会随接口返回：

```js
MALE_SCRIPT["邻家姐姐"] = {
  prompt: "你是住在隔壁的插画师，说话慢、爱笑，喜欢用比喻。",
  tts: { rate: 0.98, pitch: 1.05, voice: "female" },
};
```

`prompt` 是人设；`tts.rate` 是语速，`tts.pitch` 是音调，`tts.voice` 用来在系统语音里挑男声或女声。

### 配置

`wrangler.jsonc` 里的普通变量：

| 名称 | 说明 |
|---|---|
| `LLM_BASE_URL` | 对话接口地址，兼容 OpenAI 协议 |
| `LLM_MODEL` | 对话模型名 |
| `ASR_BASE_URL` | 语音识别接口地址 |
| `ASR_MODEL` | 语音识别模型名 |
| `ALLOWED_ORIGIN` | 允许的页面来源，当前是 `https://ai.weidenglu.com` |

密钥不进入仓库，通过 Cloudflare Worker 的 `LLM_API_KEY` 与 `ASR_API_KEY` 注入。

### 接口

| 地址 | 用途 |
|---|---|
| `POST /api/chat` | 文字聊天，支持 `chat` / `interject` / `idle` / `greeting` |
| `POST /api/asr` | 音频转文字，请求体为音频二进制 |
| `GET /api/health` | 检查模型地址与密钥是否就绪 |

失败时统一返回：

```json
{ "ok": false, "error": { "code": "UPSTREAM_TIMEOUT", "message": "..." } }
```

### 限制

| 项目 | 数值 |
|---|---|
| 单条回复 | 24 字（prompt 约束 15 字） |
| 上下文 | 最近 12 条 |
| 本地记录 | 30 条 |
| 音频 | 10MB |
| 上游超时 | 对话 15 秒，识别 25 秒 |
| 冷场 | 15 秒，最多连续 2 次 |

项目以 Cloudflare Workers 运行，静态资源与接口同源；本地开发使用 `wrangler dev`。

<br>

## License

[MIT](LICENSE) © 2026 [PCWJ08](https://github.com/PCWJ08)

可自由使用、修改、分发，含商业用途，只需保留版权与许可声明。

> 角色均由大语言模型实时生成，不代表任何真实人物，也不构成情感或心理建议。

<br>

<div align="center">
<sub><b>未登录 · 亲署</b></sub>
</div>