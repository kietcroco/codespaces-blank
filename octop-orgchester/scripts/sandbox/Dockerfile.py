FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq git build-essential >/dev/null && pip install -q uv
