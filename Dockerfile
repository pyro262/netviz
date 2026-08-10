FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY netviz ./netviz
RUN pip install --no-cache-dir . && \
    useradd --system --uid 10001 netviz && \
    mkdir -p /state && chown netviz:netviz /state
USER netviz

EXPOSE 2055/udp 5514/udp 8099/tcp
ENTRYPOINT ["python", "-m", "netviz.main"]
