"""语音识别（ASR）。

前端把 MediaRecorder 录到的 webm 以 data URL 形式传入，
这里解码后交给 SenseVoiceSmall 转写，返回纯文本。

识别失败统一返回占位文本，调用方据此判断是否跳过本轮回复。
"""

import base64
import io

from openai import AsyncOpenAI

import config

# 硅基流动同样兼容 OpenAI 协议，可直接复用 audio.transcriptions 接口
voice_client = AsyncOpenAI(
    base_url=config.SILICONFLOW_BASE_URL,
    api_key=config.SILICONFLOW_API_KEY,
)

UNRECOGNIZED = "（没听清）"


async def audio_to_text(base64_audio: str) -> str:
    """将 base64 音频转写为文本。

    base64_audio 可以带 data URL 前缀（data:audio/webm;base64,...），也可为裸 base64。
    """
    try:
        # 兼容前端 FileReader 产出的 data URL
        if "," in base64_audio:
            base64_data = base64_audio.split(",")[1]
        else:
            base64_data = base64_audio

        audio_bytes = base64.b64decode(base64_data)
        # 用 BytesIO 包装，避免落盘产生临时文件
        audio_file = ("audio.webm", io.BytesIO(audio_bytes), "audio/webm")

        response = await voice_client.audio.transcriptions.create(
            model=config.ASR_MODEL,
            file=audio_file,
        )
        return response.text

    except Exception as e:
        print(f"❗️ [识别报错]: {e}", flush=True)
        return UNRECOGNIZED
