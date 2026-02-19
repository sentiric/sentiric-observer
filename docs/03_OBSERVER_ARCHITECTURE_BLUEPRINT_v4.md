# 🏗️ SENTIRIC OBSERVER v4.0 - ARCHITECTURE BLUEPRINT

| Component | Tech Stack |
| :--- | :--- |
| **Language** | Rust (2021 Edition) |
| **Runtime** | Tokio (Async) |
| **Architecture** | Hexagonal (Ports & Adapters) |
| **Concurrency** | Actor Model (MPSC Channels) |
| **Web Framework** | Axum |

---

## 1. MİMARİ KATMANLAR (HEXAGONAL)

Observer, "Ports and Adapters" mimarisine göre 3 ana katmana ayrılır.

### A. CORE (Domain Layer) - `src/core/`
*   İş mantığının bulunduğu yerdir.
*   Dış dünyadan (HTTP, Docker, DB) habersizdir.
*   **Bileşenler:**
    *   `LogRecord`: Veri modeli (Struct).
    *   `Aggregator`: Çağrıları birleştiren mantık (Trace ID Correlation).
    *   `SchemaValidator`: SUTS v4.0 doğrulama kuralları.

### B. ADAPTERS (Infrastructure Layer) - `src/adapters/`
*   Dış dünya ile iletişim kurar.
*   **Giriş Adaptörleri (Input):**
    *   `DockerIngestor`: Docker soketini dinler (`bollard`).
    *   `GrpcIngestor`: Port 11071'den veri alır (`tonic`).
    *   `PcapSniffer`: Ağı dinler (`pcap`).
*   **Çıkış Adaptörleri (Output):**
    *   `WebSocketEmitter`: UI'a veri basar.
    *   `PrometheusExporter`: Metrikleri dışarı açar.

### C. PORTS (Interfaces) - `src/ports/`
*   Core ve Adapters arasındaki kontratlar (Trait tanımları).

---

## 2. VERİ AKIŞ HATTI (PIPELINE)

Veri sistem içinde şu sırayla akar:

1.  **Ingestion:** Adaptör veriyi yakalar (Raw JSON veya Packet).
2.  **Validation:** `SchemaValidator` JSON'u kontrol eder. Uymayanı atar veya "ParseError" olarak işaretler.
3.  **Normalization:** Veri, Rust'ın dahili `LogRecord` struct'ına çevrilir.
4.  **Buffer:** Veri, `mpsc::channel` üzerinden Aggregator'a gönderilir. (Backpressure burada yönetilir).
5.  **Aggregation (The Brain):**
    *   Eğer `trace_id` varsa, hafızadaki `CallSession` bulunur.
    *   Log, bu session'a eklenir.
    *   Anomali kontrolü yapılır (Örn: Timeout).
6.  **Emission:** Güncellenen veri WebSocket üzerinden UI'a yayınlanır.

---

## 3. DAYANIKLILIK VE PERFORMANS (RESILIENCE)

*   **Self-Healing:** Docker servisi çökerse, Ingestor thread'i ölmez; 5 saniye bekleyip tekrar bağlanmayı dener (Exponential Backoff).
*   **Memory Safety:** `RingBuffer` mantığı kullanılır. Hafızada en fazla 5.000 aktif çağrı tutulur. Eskiler silinir.
*   **Panic Free:** Kodda `unwrap()` kullanımı yasaktır. Her hata `Result<>` ile yönetilir.

---

## 4. UI VİZYONU (THE FACE)

*   **Teknoloji:** Vanilla JS (ES6) + CSS Variables. (Framework yok, saf hız).
*   **Özellikler:**
    *   **Live Matrix:** Akan loglar.
    *   **Sequence Diagram:** Çağrı akış şeması (Mermaid.js mantığı).
    *   **Dark Mode:** Operatör dostu tema.
