# --- Builder Stage ---
FROM rust:1.93-slim-bookworm AS builder

# Gerekli sistem bağımlılıkları
# protobuf-compiler: .proto dosyalarını derlemek (protoc) için eklendi.
# [GÜNCELLEME]: libpcap-dev eklendi (Network Sniffing için)
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    libpcap-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bağımlılıkları önceden çekmek (Layer Cache) için önce kopyalıyoruz
COPY Cargo.toml Cargo.lock ./
# Dummy bir main yaratarak bağımlılıkları build edelim (Opsiyonel ama hızlandırır)
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Proje dosyalarını kopyala
COPY . .

# Derleme (Build script artık protoc'u bulabilecek)
RUN cargo build --release

# --- Final Stage ---
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Binary kopyala
COPY --from=builder /app/target/release/sentiric-observer .
# UI dosyasını kopyala (Eğer binary içine gömmediyseniz - biz include_str! kullandık, o yüzden binary içindedir)

# Standard Environment
ENV RUST_LOG=info

# 11070: Web UI / WebSocket
# 11071: gRPC Ingest
EXPOSE 11070 11071

ENTRYPOINT ["./sentiric-observer"]