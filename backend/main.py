import json
import random
import asyncio
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from voice_ai import audio_to_text
import game_ai

app = FastAPI()
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"

@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    chat_history = [] 
    last_interaction_time = time.time()
    user_gender = "male"
    user_name = "主人"
    is_ai_talking = False

    # 辅助函数：发语音（加入了异常保护）
    async def send_ai_voice(ai_name, text):
        if not text: return
        audio_base64 = await game_ai.text_to_base64_audio(text, ai_name, user_gender)
        if not audio_base64: return
        
        resData = {
            "type": "voice", 
            "sender": ai_name, 
            "text": text,
            "audio": f"data:audio/mp3;base64,{audio_base64}", 
            "duration": max(2, len(text) // 3)
        }
        try:
            await websocket.send_text(json.dumps(resData))
        except Exception:
            pass # 如果用户断线了，静默忽略

    # 🌟 核心：纯净版看戏永动机（只给身份和上下文，不给死指令）
    async def auto_chat_loop():
        nonlocal last_interaction_time, is_ai_talking
        
        while True:
            await asyncio.sleep(3) 
            
            # 冷场超过 6 秒，触发看戏模式
            if time.time() - last_interaction_time > 6 and not is_ai_talking:
                is_ai_talking = True
                try:
                    ai_list = ["御姐", "甜妹"] if user_gender == "male" else ["暖男", "霸总"]
                    ai_name = random.choice(ai_list)
                    
                    # 提取最近 5 条记录，让 AI 顺着聊
                    recent_context = "\n".join(chat_history[-5:]) if chat_history else "你们刚认识"
                    
                    # 纯净 Prompt：没有"强制吃醋"，只有身份和自然延伸
                    prompt = f"""你们现在在房间里聊天。
最近的聊天记录：
{recent_context}

你现在是"{ai_name}"，请顺着上面的话题或气氛，自然地接一句话。可以吐槽、关心、分享日常或者说说情话，不要总问“你怎么不理我”。
短，15字以内，直接输出回复："""
                    
                    reply_text = await game_ai.generate_ai_reply(ai_name, prompt, user_gender, user_name, chat_history)
                    
                    if reply_text:
                        chat_history.append(f"{ai_name}: {reply_text}")
                        if len(chat_history) > 20: chat_history.pop(0)
                        await send_ai_voice(ai_name, reply_text)
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

            # 1. 用户打字
            if msgData.get("type") == "text":
                user_text = msgData.get("content", "")
                user_gender = msgData.get("gender", "male")
                user_name = msgData.get("username", "主人") 
                
                print(f"👤 [打字] {user_name}: {user_text}", flush=True)
                chat_history.append(f"用户: {user_text}")
                if len(chat_history) > 20: chat_history.pop(0)
                
                await websocket.send_text(json.dumps({"type": "status", "status": "typing"}))
                
                ai_list = ["御姐", "甜妹"] if user_gender == "male" else ["暖男", "霸总"]
                ai1_name = random.choice(ai_list)
                ai2_name = ai_list[0] if ai1_name == ai_list[1] else ai_list[1]
                
                # AI1 正常回复用户
                reply_text = await game_ai.generate_ai_reply(ai1_name, user_text, user_gender, user_name, chat_history)
                if reply_text:
                    chat_history.append(f"{ai1_name}: {reply_text}")
                    if len(chat_history) > 20: chat_history.pop(0)
                    await send_ai_voice(ai1_name, reply_text)

                    # 🌟 等待 1.4 秒，AI2 自由发挥（取消强制反驳，让它自己看上下文）
                    await asyncio.sleep(1.4)
                    prompt2 = f"用户说：'{user_text}'，{ai1_name}刚刚回复了：'{reply_text}'。你作为{ai2_name}，请自然地接一句话，可以附和、吐槽或者延伸话题。极短15字以内："
                    reply_text2 = await game_ai.generate_ai_reply(ai2_name, prompt2, user_gender, user_name, chat_history)
                    
                    if reply_text2:
                        chat_history.append(f"{ai2_name}: {reply_text2}")
                        if len(chat_history) > 20: chat_history.pop(0)
                        await send_ai_voice(ai2_name, reply_text2)

            # 2. 用户语音
            elif msgData.get("type") == "voice":
                audio_b64 = msgData.get("audio", "")
                user_gender = msgData.get("gender", "male")
                user_name = msgData.get("username", "主人")
                
                await websocket.send_text(json.dumps({"type": "status", "status": "typing"}))
                user_text = await audio_to_text(audio_b64)
                
                if user_text and user_text != "（没听清）":
                    print(f"👤 [语音] {user_name} 识别: {user_text}", flush=True)
                    chat_history.append(f"用户: {user_text}")
                    if len(chat_history) > 20: chat_history.pop(0)
                    
                    ai_list = ["御姐", "甜妹"] if user_gender == "male" else ["暖男", "霸总"]
                    ai1_name = random.choice(ai_list)
                    
                    reply_text = await game_ai.generate_ai_reply(ai1_name, user_text, user_gender, user_name, chat_history)
                    if reply_text:
                        chat_history.append(f"{ai1_name}: {reply_text}")
                        if len(chat_history) > 20: chat_history.pop(0)
                        await send_ai_voice(ai1_name, reply_text)

            # 3. 进房间问候（纯净版，无固定模板）
            elif msgData.get("type") == "greeting":
                user_gender = msgData.get("gender", "male")
                user_name = msgData.get("username", "主人")
                hour = msgData.get("hour", 12) # 前端传过来的本地时间

                room_type = "男生" if user_gender == "male" else "女生"
                print(f"✔️ [连接] {user_name}: 进入了{room_type}专属房间", flush=True)
                
                ai_list = ["御姐", "甜妹"] if user_gender == "male" else ["暖男", "霸总"]
                ai_name = random.choice(ai_list)
                
                # 🌟 让大模型自由发挥，取代死板的“你终于来了”
                prompt = f"现在是{hour}点，用户'{user_name}'刚进房间。作为{ai_name}，请自由发挥，主动对用户说一句极短的欢迎语或打招呼（15字以内）。"
                greeting_text = await game_ai.generate_ai_reply(ai_name, prompt, user_gender, user_name, [])
                
                # 如果大模型抽风没出字，再给个兜底
                if not greeting_text:
                    greeting_text = "你终于来啦~"
                    
                await send_ai_voice(ai_name, greeting_text)
                last_interaction_time = time.time()


    except Exception as e:
        if "WebSocketDisconnect" not in str(type(e)) and "disconnect" not in str(e).lower():
            room_type = "男生" if user_gender == "male" else "女生"
            print(f"❌ [断开] {user_name}: 离开了{room_type}专属房间\n", flush=True)
    finally:
        auto_chat_task.cancel()
        room_type = "男生" if user_gender == "male" else "女生"
        print(f"❌ [断开] {user_name}: 离开了{room_type}专属房间\n", flush=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))