import base64
import edge_tts
import re
from openai import AsyncOpenAI
import config

llm_client = AsyncOpenAI(
    base_url=config.ZHIPU_BASE_URL,
    api_key=config.ZHIPU_API_KEY
)

# 整个 generate_ai_reply 函数
async def generate_ai_reply(ai_name: str, user_text: str, gender: str, username: str, chat_history: list) -> str:
    script = config.MALE_SCRIPT if gender == "male" else config.FEMALE_SCRIPT
    persona = script[ai_name]
    
    # 把之前的聊天记录拼起来，让它有记忆
    history_str = "\n".join(chat_history) if chat_history else "（暂无历史记录）"
    
    prompt = f"""你现在的设定是{persona['prompt']}
对方的名字叫“{username}”。
最近的聊天记录：
{history_str}

用户刚刚对你说：“{user_text}”

【最高执行指令】：
1. 正常情况下，保持你的设定和语气。
2. 但是，如果用户明确向你下达了具体的命令，你要服从用户的指令，可以改变说话方式，满足用户的要求，不要被原本的设定限制。
3. 绝对不要重复聊天记录里说过的话。

请直接输出你的回复（不超过15个字）："""
    
    try:
        response = await llm_client.chat.completions.create(
            model=config.ZHIPU_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=30,
            temperature=0.9
        )
        result = response.choices[0].message.content.strip()
        result = re.sub(r'[“”"\'\(\)]', '', result)
        return result[:20]
    except Exception as e:
        print(f"❗️ [模型报错]: {e}", flush=True)
        return ""
        
async def text_to_base64_audio(text: str, ai_name: str, gender: str) -> str:
    # 🌟 如果文本为空或只有标点，直接返回，不去请求
    if not text or not re.search(r'[\u4e00-\u9fa5a-zA-Z0-9]', text):
        return ""
    
    script = config.MALE_SCRIPT if gender == "male" else config.FEMALE_SCRIPT
    voice = script[ai_name]["voice"]


    try:
        # 根据 AI 的名字，定制不同的语速和语调
        if   "御姐" in ai_name:
            rate, pitch = "+1%", "-4Hz"   # 御姐：语速慢，声音沉稳
        elif "甜妹" in ai_name:
            rate, pitch = "-4%", "+14Hz"   # 甜妹：正常语速，音调拉高（甜美）
        elif "暖男" in ai_name:
            rate, pitch = "-8%", "+0Hz"   # 暖男：温柔中等语速
        elif "霸总" in ai_name:
            rate, pitch = "-4%", "-10Hz"   # 霸总：语速稍快，低音炮
        else:
            rate, pitch = "-10%", "+5Hz"   # 默认

        # 传参给 Edge-TTS
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]
        return base64.b64encode(audio_data).decode('utf-8')
    except Exception as e:
        print(f"❗️ [TTS 报错]: {e}", flush=True)
        return ""