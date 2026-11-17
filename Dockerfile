FROM python:3.10-slim

WORKDIR /app

COPY backend/requirements.txt .

# 阿里云镜像加速，国内构建更快
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

COPY . .

WORKDIR /app/backend

# 腾讯云云托管会注入 PORT 环境变量；本地或其他平台未注入时回落到 80
EXPOSE 80

# 用 sh -c 读取 $PORT 后再 exec：
# 直接写死 80 也能跑，但一旦平台换端口就要改镜像；
# 加 exec 是为了让 uvicorn 能收到停止信号，容器可以正常优雅退出。
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-80}"]
