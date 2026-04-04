# 🧬 Observer Internal Logic & Forensics

## 1. Trace Locking & Aggregation
Sistem binlerce mikroservis logu arasından tek bir çağrıyı nasıl ayıklar?
* **Aggregator:** `src/core/aggregator.rs` içinde her `trace_id` için bir `CallSession` oluşturulur.
* **LruCache:** Bellek sızıntısını önlemek için en eski 50.000 oturumdan fazlası otomatik silinir.

## 2. Tactical Wire Interceptor (Sniffer)
Ağ kartı üzerinden SIP ve RTP paketlerini yakalama mantığı:
* **BPF Filter:** `udp port 5060 or portrange 10000-20000` gibi filtreler doğrudan çekirdek (Kernel) seviyesinde uygulanır.
* **Zero-Copy Ingestion:** Yakalanan paketler parse edilmeden önce byte-offset analizi ile SIP Call-ID üzerinden loglarla eşleştirilir.

## 3. SUTS v4.0 Validation
Gelen logların `schema_v: 1.0.0` ve zorunlu alanlara sahip olup olmadığı `LogRecord::sanitize_and_enrich` metodunda kontrol edilir.
