# --- Builder Stage ---
FROM rust:1.93-slim-bookworm AS builder

# Sistem bağımlılıkları
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Derleme
RUN cargo build --release

# --- Final Stage ---
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Binary kopyala
COPY --from=builder /app/target/release/sentiric-observer .

# Standard Environment
ENV RUST_LOG=info

# Docker socket erişimi için root yetkisi gerekebilir (veya docker grubu)
# Konteyner başlatılırken -u 0:0 veya volume izinleri ile yönetilir.
ENTRYPOINT ["./sentiric-observer"]