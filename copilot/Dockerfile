# Hawkama Copilot — FastAPI agent on Cloud Run.
# Self-contained: fonts + skill spec are vendored inside the package, so Arabic
# PDF export and the governance methodology work with no external files.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HAWKAMA_DATA_DIR=/tmp/hawkama

WORKDIR /app

# Dependencies first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application package (includes vendored fonts/ and the skill markdown).
COPY hawkama_copilot ./hawkama_copilot

# Cloud Run injects $PORT (defaults to 8080); bind to it.
ENV PORT=8080
EXPOSE 8080
CMD exec uvicorn hawkama_copilot.api:app --host 0.0.0.0 --port ${PORT} --workers 1
