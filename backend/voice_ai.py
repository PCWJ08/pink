import base64
import io
from openai import AsyncOpenAI
import config

voice_client = AsyncOpenAI(
    base_url=config.SILICONFLOW_BASE_URL,
    api_key=config.SILICONFLOW_API_KEY
)

async def audio_to_text(base64_audio: str) -> str:
    try:
        if "," in base64_audio:
            base64_data = base64_audio.split(",")[1]
        else:
            base64_data = base64_audio
            
        audio_bytes = base64.b64decode(base64_data)
        audio_file = ("audio.webm", io.BytesIO(audio_bytes), "audio/webm")

        response = await voice_client.audio.transcriptions.create(
            model=config.ASR_MODEL,
            file=audio_file
        )
        return response.text
    except Exception as e:
        print(f"❗️ [识别报错]: {e}", flush=True)
        return "（没听清）"