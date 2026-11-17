<div align="center">

# Pink Room

**一个会主动开口的 AI 陪聊室**

两个人格、同一屋檐、语音往返

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-WebSocket-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Edge TTS](https://img.shields.io/badge/TTS-Edge--TTS-ff8eaa?style=flat-square)](https://github.com/rany2/edge-tts)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white)](Dockerfile)
[![License](https://img.shields.io/badge/License-MIT-ff8eaa?style=flat-square)](LICENSE)

</div>

---

Pink Room 不是又一个「输入问题、输出回答」的对话框，它是一个**房间**。房间里住着两个性格相反的角色：你说话时，一个回应你；1.5 秒后另一个插话，附和、吐槽，或者把话题拽走。你沉默超过 5 秒，它们会自己聊下去。

每条回复都会被合成语音推回来——带波形、带秒数、带未读红点，也带「转文字」。前端不刷新、不断流，全程一条 WebSocket 连接。

> ⚠️ **使用前必读**：本项目**不内置任何 API Key**，需要自备密钥并完成配置，否则 AI 不会说话。详见 [配置密钥](#配置密钥必读)。

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
<sub>入场页 · 昵称与性别决定加载哪套剧本（localStorage 按房间隔离）｜ 页脚签名：未登录 · 亲署</sub>
</div>

<br>

## 核心特性

| 特性 | 说明 |
|---|---|
| **双人格同场** | 每个房间常驻两个对立人设。A 回复你，B 基于 A 的话再补一句，形成「三人在场」的错位感 |
| **冷场自循环** | 独立 `asyncio` 任务监听最后交互时间，静默超 5 秒即由随机角色主动开口 |
| **全语音往返** | 按住说话 → `MediaRecorder` → base64 → WebSocket → SenseVoice 转写；回复 → Edge-TTS 合成 mp3 → 回传直读 |
| **人设化音色** | 四个角色各自绑定音色，并按性格微调 `rate / pitch / volume`（御姐沉稳、甜妹上扬、霸总低音） |
| **零后端存储** | 历史只留浏览器 `localStorage`，按「性别 + 昵称」隔离；服务端上下文随连接释放，不落盘 |
| **一处改人设** | 角色增删、语气修改、换模型通道，都集中在 `config.py`，不必动业务逻辑 |

技术栈：FastAPI · Uvicorn · WebSocket · OpenAI 兼容 SDK · Edge-TTS · 原生 JS（无框架、无构建步骤）。后端仅三个文件，没有数据库与任务队列——所有状态跟着一条连接生灭。

<br>

## 快速开始

**要求**：Python 3.10+、现代浏览器（需麦克风权限）、两个 API Key（对话必填，语音可选）。

```bash
git clone https://github.com/PCWJ08/pink.git
cd pink

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt

cp .env.example .env             # 随后填入密钥，见下方
```

### 配置密钥（必读）

| 变量 | 用途 | 必填性 | 获取方式 |
|---|---|---|---|
| `ZHIPU_API_KEY` | AI 对话回复 | ✅ **必填** | 见下方「模型通道」 |
| `SILICONFLOW_API_KEY` | 语音转文字 | ⚠️ 用语音时必填 | [cloud.siliconflow.cn](https://cloud.siliconflow.cn) |

```ini
# .env
ZHIPU_API_KEY=your_llm_api_key_here         # 必填：对话模型
SILICONFLOW_API_KEY=your_siliconflow_key    # 用语音输入时必填
```

`Edge-TTS` 负责把文字念出来，走微软公开接口——**不需要 Key，也不产生费用**。

### 启动

```bash
cd backend
uvicorn main:app --reload --port 8000
```

打开 <http://127.0.0.1:8000>，输入昵称、选性别、进房间。

> 浏览器只在 `localhost` 或 `https` 下开放麦克风。用局域网 IP 访问时语音会失败，需要自签 HTTPS 或走反向代理。

### 用 Docker 跑

```bash
docker build -t pink .
docker run -d --name pink -p 8000:80 \
  -e ZHIPU_API_KEY=your_key \
  -e SILICONFLOW_API_KEY=your_key \
  pink
```

镜像基于 `python:3.10-slim`，启动时会读取平台注入的 `PORT`（未注入则回落到 80），所以同一份镜像既能在本地跑，也能直接丢给云托管。

### 部署到云托管

以腾讯云云托管为例，其余平台同理：

1. 新建服务，代码来源选 GitHub 仓库 `PCWJ08/pink`，自动构建方式选 `Dockerfile`
2. 端口填 **80**（与 `EXPOSE` 一致）
3. 环境变量填 `ZHIPU_API_KEY`、`SILICONFLOW_API_KEY`——**不要把 Key 写进 `.env` 一起提交**
4. 部署后访问平台分配的域名

容器内不写任何文件、不依赖本地存储，因此无需配置持久化卷。

<br>

## 模型通道

`config.py` 预设了两套已验证的通道，改两行注释即可切换。两者都提供免费额度，在「短句高频」场景下延迟与口语化程度都够用——这正是陪聊最需要的两件事。

| 通道 | `ZHIPU_BASE_URL` | `ZHIPU_MODEL` |
|---|---|---|
| **Ignis**（默认） | `https://apihub.agnes-ai.com/v1` | `agnes-3.0-flash` |
| **智谱 AI** | `https://open.bigmodel.cn/api/paas/v4/` | `glm-4-flash-250414` |

```python
ZHIPU_BASE_URL = "https://apihub.agnes-ai.com/v1"
# ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"
```

两者都兼容 OpenAI 协议，共用同一个客户端——换供应商只换 `base_url`，业务代码零改动。想接 DeepSeek、Moonshot 或本地 Ollama，同样只需补两行。

<br>

## 角色与音色

角色定义在 `config.py` 的 `MALE_SCRIPT` / `FEMALE_SCRIPT`。用户选择的性别只决定加载哪套剧本，不影响语音识别。

| 房间 | 角色 | 人设 | Edge-TTS 音色 | 语速 / 音调 / 音量 |
|---|---|---|---|---|
| 男生 | 御姐 | 温柔成熟的知心姐姐，宠溺撩人 | `zh-TW-HsiaoChenNeural`| `+33%` / `+15Hz` / `+4%` |
| 男生 | 甜妹 | 活泼粘人的积极学妹，带崇拜感 | `zh-CN-XiaoyiNeural`   | `+13%` / `+14Hz` / `+5%` |
| 女生 | 暖男 | 阳光体贴的热心学长，情绪价值 | `zh-CN-YunxiNeural`    | `+3%`  / `-4Hz`  / `+5%` |
| 女生 | 霸总 | 高冷傲慢的低音霸总，占有欲强 | `zh-TW-YunJheNeural`   | `+17%` / `-10Hz` / `+9%` |

新增角色只要追加一项，前端无需改动（角色名由后端随机挑选后随消息下发）：

```python
MALE_SCRIPT["邻家姐姐"] = {
    "prompt": "你是住在隔壁的插画师，说话慢、爱笑，喜欢用比喻。回复短，不超过15个字。",
    "voice": "zh-CN-XiaoxiaoNeural",
}
```

<br>

## 通信协议

单端点 `ws://<host>/ws/chat`，帧体为 JSON 字符串。

| 方向 | `type` | 关键字段 |
|---|---|---|
| 客户端 → 服务端 | `greeting` | `gender` `username` `hour` |
| 客户端 → 服务端 | `text` | `content` `gender` `username` |
| 客户端 → 服务端 | `voice` | `audio`（`data:audio/webm;base64,…`） |
| 服务端 → 客户端 | `status` | `status: "typing"` |
| 服务端 → 客户端 | `voice` | `sender` `text` `audio`（`data:audio/mp3;base64,…`）`duration` |

`duration` 按文本长度估算（`max(2, len(text) // 3)`），不额外探测音频时长——回复本就只有十几个字，省一次 IO。

<br>

## 项目结构

```
pink/
├── backend/
│   ├── main.py           # WebSocket 会话、双角色调度、冷场循环
│   ├── game_ai.py        # 对话生成 + Edge-TTS 合成
│   ├── voice_ai.py       # SenseVoiceSmall 语音转写
│   └── config.py         # 模型通道、角色剧本、音色参数
├── static/
│   ├── index.html        # 入场页 + 聊天页
│   ├── app.js            # 录音手势、WebSocket、本地缓存
│   └── theme.css         # 暗色 + 粉色主题
├── docs/images/          # 界面截图
├── Dockerfile
├── .env.example
└── LICENSE
```

<br>

## 常见问题

**不配 Key 会怎样？**
页面能打开、能进房间，但 AI 不回复——鉴权失败后 `generate_ai_reply` 返回空串，前端因此收不到语音帧。

**要花钱吗？**
Edge-TTS 免费；智谱 `glm-4-flash` 是官方免费模型；SenseVoiceSmall 在硅基流动有免费额度。只有把对话量打到额度之外才可能产生费用。

**聊天记录会上传吗？**
不会。历史只在你自己的浏览器 `localStorage` 里，键名 `history_{gender}_{name}`，只留最近 20 条；服务端上下文是连接级变量，断线即销毁。

**为什么只回十几个字？**
故意的。`max_tokens=20` 加上 prompt 约束 15 字，是为了让回复像一条语音消息，而不是一段小作文。想放宽就改 `game_ai.py` 里的这两个常量。

<br>

## 参与贡献

Issue 与 PR 都欢迎。提交前请确认 `python -m compileall backend` 通过，新配置项同步写进 `.env.example` 与本文档。

后续计划：会话持久化、角色卡导入导出、流式 TTS（边生成边播放）。

<br>

## License

[MIT](LICENSE) © 2026 [PCWJ08](https://github.com/PCWJ08)

可自由使用、修改、分发，含商业用途，只需保留版权与许可声明。

> 角色均由大语言模型实时生成，不代表任何真实人物，也不构成情感或心理建议。请勿用于冒充真人、情感操控或任何违法用途。

<br>

<div align="center">
<sub><b>未登录 · 亲署</b></sub>
</div>
