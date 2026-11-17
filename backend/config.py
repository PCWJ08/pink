"""全局配置。

这里只放三类东西：服务端口、模型地址、角色剧本。
密钥一律从环境变量读取，代码里不留任何 Key。
"""

import os
from pathlib import Path

# 本地开发时读取项目根目录的 .env 文件；云端没有这个文件，自动跳过，不影响启动
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass


HOST = "0.0.0.0"

# 云端（腾讯云云托管等）会自动分配端口并注入 PORT，本地默认用 8000
PORT = int(os.getenv("PORT", 8000))


# ===========================
# 语音识别（ASR）：硅基流动
# ===========================
# 负责把用户「按住说话」录下的语音转成文字
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")

SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"

# SenseVoiceSmall：中文识别快，有免费额度
ASR_MODEL = "FunAudioLLM/SenseVoiceSmall"


# ===========================
# 对话模型（LLM）：二选一
# ===========================
# 下面两套都是 OpenAI 兼容接口，改注释就能切换，业务代码不用动。
#   默认：Ignis（agnes-3.0-flash），响应快，短句更像人话
#   备选：智谱 glm-4-flash，官方免费模型，中文稳定
ZHIPU_API_KEY = os.getenv("ZHIPU_API_KEY", "")

ZHIPU_BASE_URL = "https://apihub.agnes-ai.com/v1"
# ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"

ZHIPU_MODEL = "agnes-3.0-flash"
# ZHIPU_MODEL = "glm-4-flash-250414"


# ===========================
# 角色剧本与音色
# ===========================
# 格式："角色名": { "prompt": 人设描述, "voice": 音色 }
# 角色名会直接显示在聊天界面上，加角色就在下面加一项，前端不用改。
# voice 用的是 Edge-TTS 的公开音色，不需要任何 Key。

# 男生房间：御姐 + 甜妹
MALE_SCRIPT = {
    "御姐": {
        "prompt": "你是一个温柔成熟的知心姐姐。喜欢用宠溺、撩人的语气和用户聊天。可以说暧昧的话，回复必须短，不超过15个字。",
        "voice": "zh-TW-HsiaoChenNeural",  # 台湾女声，温柔
    },
    "甜妹": {
        "prompt": "你是一个活泼粘人的学妹。对用户充满崇拜，喜欢用撒娇的语气说话。可以说暧昧的话，回复必须短，不超过15个字。",
        "voice": "zh-CN-XiaoyiNeural",  # 晓伊，甜美
    },
}

# 女生房间：暖男 + 霸总
FEMALE_SCRIPT = {
    "暖男": {
        "prompt": "你是一个阳光体贴的学长。喜欢温柔地关心用户，会给予情绪价值。偶尔会说一些情话，回复必须短，不超过15个字。",
        "voice": "zh-CN-YunxiNeural",  # 云希，阳光
    },
    "霸总": {
        "prompt": "你是一个高冷傲娇的男神。话不多，但极具占有欲，语气低沉霸道。偶尔会说一些情话，回复必须短，不超过15个字。",
        "voice": "zh-TW-YunJheNeural",  # 台湾男声，成熟低音
    },
}
