FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml ./
COPY uv.lock ./
COPY typeandsee ./typeandsee
RUN uv sync --frozen --no-dev --no-cache
RUN useradd --create-home appuser && mkdir /app/data && chown -R appuser:appuser /app
USER appuser
EXPOSE 8080
CMD ["sh", "-c", ".venv/bin/uvicorn typeandsee.api:app --host 0.0.0.0 --port ${PORT} --workers 1"]
