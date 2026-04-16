FROM python:3.13-slim

# NS3 build deps
RUN apt-get update && apt-get install -y \
    cmake g++ ninja-build python3-dev \
    libgsl-dev libxml2-dev libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy and build NS3
COPY ns3/ ./ns3/
WORKDIR /app/ns3
RUN cmake -B build -G Ninja -DNS3_WARNINGS_AS_ERRORS=OFF 2>&1 | tail -5 \
    && cmake --build build --parallel $(nproc)

# Backend
WORKDIR /app/backend
COPY backend/ .
RUN pip install uv && uv sync

RUN mkdir -p output

EXPOSE 8000
CMD ["uv", "run", "fastapi", "run", "main.py", "--host", "0.0.0.0", "--port", "8000"]
