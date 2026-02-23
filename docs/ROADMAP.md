# 🗺️ Sentiric Panopticon - Stratejik Yol Haritası

Bu proje, canlı bir organizma gibi evrimleşmektedir. Mevcut durum ve hedefler aşağıdadır.

## ✅ TAMAMLANANLAR (v1.0 -> v12.0)

- [x] **Core:** Yüksek performanslı Rust motoru (Tokio/Axum).
- [x] **Ingestion:** Docker, gRPC ve Pcap (Sniffer) adaptörleri.
- [x] **UI Framework:** Grid tabanlı, "Dark Theme" profesyonel arayüz.
- [x] **Forensics:** Trace Locking, Causality Timeline ve RTP Analiz modülleri.
- [x] **Intelligence:** AI-Ready Export motoru.

---

## 🚧 GELİŞTİRME AŞAMASINDA (v13.0 - Next Gen)

### 1. Browser-Side Audio Reconstruction (WebAssembly)
*   **Hedef:** Yakalanan RTP (PCMA/PCMU) paketlerini tarayıcı içinde `wasm` kullanarak `WAV` formatına çevirmek ve anlık olarak dinletmek.
*   **Durum:** Ar-Ge aşamasında.

### 2. SIP Ladder Diagrams (Mermaid.js Integration)
*   **Hedef:** Timeline sekmesinde, metin yerine standart Telekomünikasyon ok diyagramları (Sequence Diagram) çizdirmek.
*   **Durum:** Tasarım aşamasında.

### 3. Distributed Tracing (Multi-Node)
*   **Hedef:** Birden fazla sunucudan (Core, Edge, AI) gelen logları tek bir ekranda, zaman senkronizasyonu ile birleştirmek.
*   **Durum:** Planlandı.

### 4. Autonomous Alerts (Bekçi Modu)
*   **Hedef:** "Son 1 dakikada %5'ten fazla RTP kaybı var" veya "SIP 503 hataları arttı" gibi durumlarda tarayıcı bildirimi göndermek.
*   **Durum:** Planlandı.

---

## 🔮 VİZYON (v20.0+)
Sentiric Panopticon, sadece bir izleme aracı değil; sorunları kendi kendine tespit edip, onarmak için Orchestrator'a emir veren bir **"Yapay Zeka Operatörü"**ne dönüşecektir.