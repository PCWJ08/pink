<div align="center">

# Pink Room

**A quiet room for two voices.**

一个安静、克制的 AI 陪伴空间。两个人格，同一屋檐，语音往返。

[![在线体验](https://img.shields.io/badge/在线体验-ai.weidenglu.com-ee8da6?style=flat-square&logo=googlechrome&logoColor=white)](https://ai.weidenglu.com)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![PWA](https://img.shields.io/badge/桌面端-可安装-5A0FC8?style=flat-square&logo=pwa&logoColor=white)](https://ai.weidenglu.com)
[![License](https://img.shields.io/badge/License-MIT-ee8da6?style=flat-square)](LICENSE)

</div>

---

**在线体验**：<https://ai.weidenglu.com>

Pink Room 不是“输入问题、输出回答”的对话框，而是一个房间。房间里住着两个性格相反的角色：你说话时，一个回应你；片刻后另一个接话，附和、吐槽，或者把话题轻轻带走。你沉默一会儿，它们也会自己聊下去，直到你再次开口。

回复以语音气泡呈现，带波形、时长和未读提示；点一下即可播放，也可以展开成文字。桌面端可以安装成一个独立的小应用，手机端只保留聊天本身。

## 体验

| | |
|---|---|
| **房间** | 男生房住着御姐和甜妹，女生房住着暖男和霸总，性格两两相反 |
| **对话** | 文字或按住说话；一个角色先回应，另一个自然接话 |
| **冷场** | 安静后角色会主动开口，保持房间里的呼吸感 |
| **声音** | 语音气泡 + 可展开字幕，播放状态清晰但不喧闹 |
| **语言** | 入场时选择中文或 English；进入房间后语言锁定 |
| **记录** | 最近 20 条留在浏览器，按“性别 + 昵称”隔离 |
| **安装** | 仅桌面端提供安装入口；手机端专注聊天 |

## 语言

入场页右上角提供 `中文 / EN` 两段式切换。选择后会同时影响：

- 界面文案
- AI 回复语言
- 角色显示名称（Emily / Ana / Guy / Christopher）
- 语音音色

进入房间后不再提供切换入口，避免对话中途改变语言导致上下文混乱。选择会保存在本机，下次打开继续沿用。

## 设计

### 克制的界面

以深色为底，用低对比粉光、细噪点和玻璃质感建立层次。没有高饱和装饰，也没有频繁动效；重点放在文字、留白和气泡节奏上。

### 双人格

一次用户发言拆成两步：角色 A 先回应，角色 B 在短暂停顿后接话。冷场由前端计时触发，进房问候单独处理。角色只说自己的一句话，像真实的语音消息，而不是小作文。

### 语音优先

语音在服务端生成，前端只负责播放和字幕。录音会先在浏览器内整理成统一格式，再交给识别接口；自己发出的语音同样可以回放。语音服务不可用时，文字仍然完整保留。

### 隐私

聊天记录和录音只保存在 `localStorage`，不会写入服务端数据库。Worker 不保存会话；刷新页面后仍能接着聊，换设备则从空白开始。

## 部署

### 环境

- Node.js 20+
- Cloudflare 账号
- 一个指向 Worker 的域名

### 本地

```bash
npm install
npx wrangler dev
```

### Cloudflare

1. 在 Cloudflare 创建 Worker，名称设为 `pink`。
2. 在 **Settings → Variables and Secrets** 添加：
   - `ZHIPU_API_KEY`：对话主通道
   - `SILICONFLOW_API_KEY`：对话备通道 + 语音识别
3. 确认 `ALLOWED_ORIGIN` 与站点域名一致。
4. 部署：

```bash
npx wrangler deploy
```

5. 在 Worker 的 **Settings → Domains & Routes** 绑定自定义域名。
6. 打开 `/api/health` 检查配置状态，再强制刷新一次页面。

### GitHub 自动部署

将仓库连接到 Cloudflare Workers Builds：

- Build command：`npm install`
- Deploy command：`npx wrangler deploy`
- Root directory：`/`

如果使用 GitHub Actions，自行配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。

## 配置

`wrangler.jsonc` 已包含运行所需的普通变量，通常不需要手动改动：

| 变量 | 用途 |
|---|---|
| `LLM_PRIMARY_BASE_URL` | 对话主通道地址 |
| `LLM_PRIMARY_MODEL` | 对话主通道模型 |
| `LLM_FALLBACK_BASE_URL` | 对话备通道地址 |
| `LLM_FALLBACK_MODEL` | 对话备通道模型 |
| `ASR_BASE_URL` | 语音识别地址 |
| `ASR_MODEL` | 语音识别模型 |
| `ALLOWED_ORIGIN` | 允许的页面来源 |

密钥只放在 Cloudflare Secrets，不进入仓库：

| Secret | 用途 |
|---|---|
| `ZHIPU_API_KEY` | 对话主通道 |
| `SILICONFLOW_API_KEY` | 对话备通道 + 语音识别 |

语音合成不需要额外 Key。

## API

| 地址 | 用途 |
|---|---|
| `POST /api/chat` | 生成一条角色回复，支持 `chat` / `interject` / `idle` / `greeting` |
| `POST /api/asr` | 音频转文字 |
| `POST /api/tts` | 文字转语音 |
| `GET /api/health` | 检查对话、识别、语音配置是否就绪 |

失败响应统一为：

```json
{ "ok": false, "error": { "code": "UPSTREAM_TIMEOUT", "message": "..." } }
```

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
│   ├── index.js              # 路由、跨域与错误处理
│   ├── chat.js               # 角色上下文与对话编排
│   ├── asr.js                # 语音识别
│   ├── tts.js                # 语音合成入口
│   ├── voice-engine.js       # 语音传输层
│   ├── personas.js           # 角色剧本与音色参数
│   └── utils.js              # 超时与上游响应处理
├── wrangler.jsonc
├── package.json
├── README.md
├── THIRD_PARTY_NOTICES.md
└── LICENSE
```

## 说明

- 角色由语言模型实时生成，不代表任何真实人物，也不构成情感或心理建议。
- 语音与对话均由服务端完成，前端不内置模型。
- 上游服务波动时，界面会保留文字内容，不会退回机械朗读。

<br>

## License

[MIT](LICENSE) © 2026 [PCWJ08](https://github.com/PCWJ08)

可自由使用、修改、分发，含商业用途，只需保留版权与许可声明。

<br>

<div align="center">
<sub><b>未登录 · 亲署</b></sub>
</div>