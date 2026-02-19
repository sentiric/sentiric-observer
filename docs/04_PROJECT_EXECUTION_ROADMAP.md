# 🚀 PROJECT EXECUTION ROADMAP

Bu belge, Observer v4.0'ın geliştirme aşamalarını tanımlar.

---

## ✅ PHASE 0: PREPARATION (Tamamlandı)
- [x] SUTS v4.0 Standardının belirlenmesi.
- [x] Mimari Blueprint'in (Hexagonal) çizilmesi.
- [x] Repository temizliği ve dokümantasyon (docs/ klasörü).

## 🚧 PHASE 1: CORE & INGESTION (Şu anki Odak)
**Hedef:** Docker'dan log okuyan, parse eden ve ekrana basan temel Rust servisi.
1.  **Scaffold:** `cargo new` ile yeni proje yapısını kur (`src/core`, `src/adapters`).
2.  **Domain:** `LogRecord` struct'ını ve `serde` tanımını yaz.
3.  **Validator:** Gelen JSON'un şemaya uygunluğunu kontrol eden kodu yaz.
4.  **Docker Adapter:** `bollard` ile container loglarını stream et.
5.  **Output:** Logları renkli formatta terminale bas (debug amaçlı).

## ⏳ PHASE 2: AGGREGATION & UI
**Hedef:** Veriyi Trace ID'ye göre gruplayıp Web arayüzünde göstermek.
1.  **Aggregator:** `HashMap` tabanlı Session yönetimi.
2.  **Web Server:** Axum ile HTTP ve WebSocket sunucusunu kur.
3.  **Frontend:** HTML/CSS/JS dosyalarını oluştur ve WebSocket'e bağla.
4.  **Sniffer:** `pcap` entegrasyonunu (thread-safe şekilde) ekle.

## 🔮 PHASE 3: PRODUCTIZATION (Gelecek)
**Hedef:** Production-ready özellikler.
1.  **Persistence:** Logları Loki veya ClickHouse'a asenkron yazma.
2.  **Auth:** Basit bir Token/Password koruması.
3.  **Metrics:** `/metrics` endpoint'i ile Prometheus entegrasyonu.
4.  **SDK:** Diğer diller için hazır kütüphanelerin (SDK) paketlenmesi.