import os

HOST = "0.0.0.0"

# 云端会自动分配端口，本地默认用 8000
PORT = int(os.getenv("PORT", 8000))

# --- 硅基流动 语音识别 (ASR) 配置 ---
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")

SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
#SILICONFLOW_BASE_URL = ""

ASR_MODEL = "FunAudioLLM/SenseVoiceSmall"
#ASR_MODEL = ""


# --- 智谱 AI 配置 ---
ZHIPU_API_KEY = os.getenv("ZHIPU_API_KEY", "")

ZHIPU_BASE_URL = "https://apihub.agnes-ai.com/v1"
#ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"

ZHIPU_MODEL = "agnes-3.0-flash"
#ZHIPU_MODEL = "glm-4-flash-250414"



# ===========================
# 剧本与音色配置
# ===========================
# 男生剧本：御姐 + 甜妹
MALE_SCRIPT = {
    "御姐": {
        "prompt": "你是一个温柔成熟的知心姐姐。喜欢用宠溺、撩人的语气和用户聊天。可以说暧昧的话，回复必须短，不超过15个字。",
        "voice": "zh-CN-XiaoxiaoNeural" # 晓晓（温柔女声）
    },
    "甜妹": {
        "prompt": "你是一个活泼粘人的学妹。对用户充满崇拜，喜欢用撒娇的语气说话。可以说暧昧的话，回复必须短，不超过15个字。",
        "voice": "zh-CN-XiaoyiNeural"   # 晓伊（甜美女声）
    }
}

# 女生剧本：暖男 + 霸总
FEMALE_SCRIPT = {
    "暖男": {
        "prompt": "你是一个阳光体贴的学长。喜欢温柔地关心用户，会给予情绪价值。偶尔会说一些情话，回复必须短，不超过15个字。",
        "voice": "zh-CN-YunxiNeural"   # 云希（阳光男声）
    },
    "霸总": {
        "prompt": "你是一个高冷傲娇的男神。话不多，但极具占有欲，语气低沉霸道。偶尔会说一些情话，回复必须短，不超过15个字。",
        "voice": "zh-CN-YunjianNeural" # 云健（成熟低音）
    }
}
