"""对话生成与语音合成。

职责：
1. generate_ai_reply —— 按角色人设构建 prompt，调用兼容 OpenAI 协议的对话模型；
2. text_to_base64_audio —— 用 Edge-TTS 把回复合成为 mp3，编码成 base64 直接下发给前端播放。

本模块不持有会话状态，上下文由调用方（main.py）按需传入。
"""

import base64
import re

import edge_tts
from openai import AsyncOpenAI

import config

# 兼容 OpenAI 协议，切换供应商只需改 config 中的 BASE_URL / MODEL
llm_client = AsyncOpenAI(
    base_url=config.ZHIPU_BASE_URL,
    api_key=config.ZHIPU_API_KEY,
)

# 回复长度上限：先约束 prompt，再用 max_tokens 兜底
MAX_REPLY_CHARS = 20
MAX_REPLY_TOKENS = 20


async def generate_ai_reply(
    ai_name: str,
    user_text: str,
    gender: str,
    username: str,
    chat_history: list,
) -> str:
    """生成一条角色回复。

    ai_name      角色名，需存在于对应剧本中
    user_text    用户本轮输入（语音消息传入的是转写结果）
    gender       用户性别，决定加载 MALE_SCRIPT 还是 FEMALE_SCRIPT
    username     用户昵称，用于 prompt 中的称呼
    chat_history 最近若干条对话，按 "角色: 内容" 格式拼接
    """
    script = config.MALE_SCRIPT if gender == "male" else config.FEMALE_SCRIPT
    persona = script[ai_name]

    # 带上历史对话，让模型能自然承接上文
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
            max_tokens=MAX_REPLY_TOKENS,
            temperature=1,
        )
        result = response.choices[0].message.content.strip()
        # 模型偶尔会带引号或括号，去掉后再截断，避免气泡里出现多余符号
        result = re.sub(r'[“”"\'\(\)]', "", result)
        return result[:MAX_REPLY_CHARS]

    except Exception as e:
        # 鉴权失败、限流、超时都归到这里：返回空串，由调用方决定是否跳过本轮
        print(f"❗️ [模型报错]: {e}", flush=True)
        return ""


async def text_to_base64_audio(text: str, ai_name: str, gender: str) -> str:
    """把文本合成为语音，返回可直接嵌入 data URL 的 base64 字符串。

    每个角色有独立的语速/音调/音量，用于还原人设差异。
    合成失败或文本无有效字符时返回空串。
    """
    # 纯标点或空白不必请求合成，省一次网络往返
    if not text or not re.search(r"[\u4e00-\u9fa5a-zA-Z0-9]", text):
        return ""

    script = config.MALE_SCRIPT if gender == "male" else config.FEMALE_SCRIPT
    voice = script[ai_name]["voice"]

    try:
        # 按人设微调发声参数：御姐沉稳、甜妹上扬、暖男柔和、霸总低沉
        if "御姐" in ai_name:
            rate, pitch, volume = "+33%", "+15Hz", "+4%"
        elif "甜妹" in ai_name:
            rate, pitch, volume = "+13%", "+14Hz", "+5%"
        elif "暖男" in ai_name:
            rate, pitch, volume = "+3%", "-4Hz", "+5%"
        elif "霸总" in ai_name:
            rate, pitch, volume = "+17%", "-10Hz", "+9%"
        else:
            rate, pitch, volume = "+10%", "+5Hz", "+5%"

        communicate = edge_tts.Communicate(
            text, voice, rate=rate, pitch=pitch, volume=volume
        )

        # 流式分块接收后合并，短句场景下比整段请求更稳
        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]

        return base64.b64encode(audio_data).decode("utf-8")

    except Exception as e:
        print(f"❗️ [TTS 报错]: {e}", flush=True)
        return ""
