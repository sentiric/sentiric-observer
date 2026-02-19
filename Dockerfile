# --- Builder Stage ---
FROM rust:1.93-slim-bookworm AS builder

# Gerekli sistem bağımlılıkları (Derleme için)
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    libpcap-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bağımlılıkları önceden çekmek (Layer Cache) için önce kopyalıyoruz
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Proje dosyalarını kopyala
COPY . .

# Derleme
RUN cargo build --release

# --- Final Stage ---
FROM debian:bookworm-slim

# Runtime kütüphaneleri
RUN apt-get update && apt-get install -y --no-install-recommends \
    netcat-openbsd \
    ca-certificates \
    libpcap0.8 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Binary kopyala
COPY --from=builder /app/target/release/sentiric-observer .

# KRİTİK DÜZELTME: UI Dosyalarını kopyala (Hatanın Sebebi Buydu)
COPY --from=builder /app/src/ui ./src/ui

# Standard Environment
ENV RUST_LOG=info

# 11070: Web UI / WebSocket
# 11071: gRPC Ingest
# 11072: Metrics
EXPOSE 11070 11071 11072

# Host Networking kullanılacağı için Docker tarafında port maplemeye gerek kalmayabilir
# ama dökümantasyon açısından EXPOSE kalmalı.

ENTRYPOINT ["./sentiric-observer"]