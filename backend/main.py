"""服务入口：一条 WebSocket 连接 = 一个聊天房间。

阅读顺序建议（从上往下就是一次完整对话的流程）：

    1. websocket_endpoint 开头  → 建立连接，初始化这个房间的变量
    2. remember / send_ai_voice → 两个小工具：记上下文、把话变成语音发出去
    3. auto_chat_loop           → 后台任务：没人说话超过 5 秒，AI 主动开口
    4. 下面的 while True        → 收消息的三个分支：文字 / 语音 / 进房问候
    5. 最后的 mount + index     → 把 static 目录和首页挂上去

所有状态（聊天记录、最后交互时间、当前角色）都是这个函数里的局部变量，
连接断开就一起释放，服务端不存任何东西。
"""

import asyncio
import json
import random
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import game_ai
from voice_ai import audio_to_text

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"

# 保留的上下文轮数：短，是为了让 prompt 更聚焦，也压低单次请求的 token 成本
MAX_HISTORY = 20

# 静默超过该秒数且无人发言时，触发主动接话
IDLE_THRESHOLD = 5

# 角色 A 与角色 B 之间的插入间隔，制造"另一个人也听到了"的错位感
INTERJECT_DELAY = 1.5


def pick_personas(gender: str) -> list:
    """按用户性别返回该房间的角色池。"""
    return ["御姐", "甜妹"] if gender == "male" else ["暖男", "霸总"]


@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    chat_history = []
    last_interaction_time = time.time()
    user_gender = "male"
    user_name = "主人"
    is_ai_talking = False

    def remember(role: str, text: str) -> None:
        """追加一条对话，并维持上下文窗口长度。"""
        chat_history.append(f"{role}: {text}")
        if len(chat_history) > MAX_HISTORY:
            chat_history.pop(0)

    async def send_ai_voice(ai_name: str, text: str) -> None:
        """合成语音并下发给当前连接。文本为空则不发送。"""
        if not text:
            return

        print(f"🤖 [ AI ]({user_name}): {text}", flush=True)

        audio_base64 = await game_ai.text_to_base64_audio(text, ai_name, user_gender)
        if not audio_base64:
            return

        payload = {
            "type": "voice",
            "sender": ai_name,
            "text": text,
            "audio": f"data:audio/mp3;base64,{audio_base64}",
            # 音频时长不单独探测，按文本长度估算即可，避免额外 IO
            "duration": max(2, len(text) // 3),
        }
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception:
            # 用户已断开：静默丢弃，由外层 finally 统一清理
            pass

    async def auto_chat_loop() -> None:
        """冷场看戏：房间安静下来后，让其中一个角色主动开口。

        只给身份和上下文，不写死台词，具体说什么交给模型自由发挥。
        """
        nonlocal last_interaction_time, is_ai_talking

        while True:
            await asyncio.sleep(2)

            if time.time() - last_interaction_time > IDLE_THRESHOLD and not is_ai_talking:
                is_ai_talking = True
                try:
                    ai_name = random.choice(pick_personas(user_gender))

                    # 只取最近 5 条，足够让模型接住当前气氛
                    recent_context = (
                        "\n".join(chat_history[-5:]) if chat_history else "你们刚认识"
                    )

                    prompt = f"""你们现在在房间里聊天。
最近的聊天记录：
{recent_context}

你现在是"{ai_name}"，请顺着上面的话题或气氛，自然地接一句话。可以吐槽、关心、分享日常或者说说情话，不要总问“你怎么不理我”。
短，15字以内，直接输出回复："""

                    reply_text = await game_ai.generate_ai_reply(
                        ai_name, prompt, user_gender, user_name, chat_history
                    )

                    if reply_text:
                        remember(ai_name, reply_text)
                        await send_ai_voice(ai_name, reply_text)
                        # 主动接话也算一次交互，重置静默计时，避免连续刷屏
                        last_interaction_time = time.time()

                except asyncio.CancelledError:
                    break
                except Exception as e:
                    print(f"❗️ [永动报错]: {e}", flush=True)
                finally:
                    is_ai_talking = False

    auto_chat_task = asyncio.create_task(auto_chat_loop())

    try:
        while True:
            data = await websocket.receive_text()
            msgData = json.loads(data)

            last_interaction_time = time.time()

            # --- 1. 文字消息：角色 A 回复，角色 B 随后插话 ---
            if msgData.get("type") == "text":
                user_text = msgData.get("content", "")
                user_gender = msgData.get("gender", "male")
                user_name = msgData.get("username", "主人")

                print(f"\n👤 [打字] {user_name} : {user_text}", flush=True)
                remember("用户", user_text)

                await websocket.send_text(
                    json.dumps({"type": "status", "status": "typing"})
                )

                # A 随机，B 取池中另一人，保证每轮都是两个不同角色
                ai_list = pick_personas(user_gender)
                ai1_name = random.choice(ai_list)
                ai2_name = ai_list[0] if ai1_name == ai_list[1] else ai_list[1]

                reply_text = await game_ai.generate_ai_reply(
                    ai1_name, user_text, user_gender, user_name, chat_history
                )
                if reply_text:
                    remember(ai1_name, reply_text)
                    await send_ai_voice(ai1_name, reply_text)

                    # 稍作停顿再让 B 接话，否则两条语音会在前端撞在一起
                    await asyncio.sleep(INTERJECT_DELAY)
                    prompt2 = f"用户说：'{user_text}'，{ai1_name}刚刚回复了：'{reply_text}'。你作为{ai2_name}，请自然地接一句话，可以附和、吐槽或者延伸话题。极短15字以内："
                    reply_text2 = await game_ai.generate_ai_reply(
                        ai2_name, prompt2, user_gender, user_name, chat_history
                    )

                    if reply_text2:
                        remember(ai2_name, reply_text2)
                        await send_ai_voice(ai2_name, reply_text2)

            # --- 2. 语音消息：先转写，再由角色 A 回复 ---
            elif msgData.get("type") == "voice":
                audio_b64 = msgData.get("audio", "")
                user_gender = msgData.get("gender", "male")
                user_name = msgData.get("username", "主人")

                await websocket.send_text(
                    json.dumps({"type": "status", "status": "typing"})
                )
                user_text = await audio_to_text(audio_b64)

                if user_text and user_text != "（没听清）":
                    print(f"\n👤 [语音] {user_name} : {user_text}", flush=True)
                    remember("用户", user_text)

                    ai1_name = random.choice(pick_personas(user_gender))
                    reply_text = await game_ai.generate_ai_reply(
                        ai1_name, user_text, user_gender, user_name, chat_history
                    )
                    if reply_text:
                        remember(ai1_name, reply_text)
                        await send_ai_voice(ai1_name, reply_text)

            # --- 3. 进房问候：由模型按时段自由生成，不写死模板 ---
            elif msgData.get("type") == "greeting":
                user_gender = msgData.get("gender", "male")
                user_name = msgData.get("username", "主人")
                hour = msgData.get("hour", 12)  # 用户本地时间，由前端传入

                room_type = "男生" if user_gender == "male" else "女生"
                print(f"✔️ [连接] {user_name} : 进入了{room_type}专属房间", flush=True)

                ai_name = random.choice(pick_personas(user_gender))

                prompt = (
                    f"现在是{hour}点，用户'{user_name}'刚进房间。"
                    f"作为{ai_name}，请自由发挥，主动对用户说一句极短的欢迎语或打招呼（15字以内）。"
                )
                greeting_text = await game_ai.generate_ai_reply(
                    ai_name, prompt, user_gender, user_name, []
                )

                # 模型无输出时的兜底，避免进房后完全没有声音
                if not greeting_text:
                    greeting_text = "你终于来啦~"

                await send_ai_voice(ai_name, greeting_text)
                last_interaction_time = time.time()

    except Exception as e:
        # 正常断开不打印错误，仅记录异常中断
        if "WebSocketDisconnect" not in str(type(e)) and "disconnect" not in str(e).lower():
            room_type = "男生" if user_gender == "male" else "女生"
            print(f"❌ [断开] {user_name} : 离开了{room_type}专属房间", flush=True)
    finally:
        auto_chat_task.cancel()
        room_type = "男生" if user_gender == "male" else "女生"
        print(f"❌ [断开] {user_name} : 离开了{room_type}专属房间", flush=True)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))
