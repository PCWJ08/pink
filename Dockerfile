FROM python:3.10-slim

WORKDIR /app

COPY backend/requirements.txt .

# 阿里云镜像加速
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

COPY . .

WORKDIR /app/backend

# 腾讯云默认使用 80 端口
EXPOSE 80

# 直接用 uvicorn 启动，监听 80 端口
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "80"]