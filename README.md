# 👁️ Sentiric Observer Service

[![Status](https://img.shields.io/badge/status-active-success.svg)]()
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)]()
[![Standard](https://img.shields.io/badge/standard-OpenTelemetry-purple.svg)]()

**Sentiric Observer**, platformun merkezi gözlem ve telemetri motorudur. Dağıtık sistemdeki (Rust, Go, Python) tüm servislerden gelen logları, metrikleri ve ağ paketlerini (Sniffer) toplar, **OpenTelemetry (OTEL)** standardına dönüştürür ve gerçek zamanlı olarak görselleştirir.

## 🚀 v2.0 Yenilikleri (The OTEL Engine)

1.  **OpenTelemetry Standardı:** Tüm veriler artık endüstri standardı olan OTEL Logs Data Model (v1.0) formatında işlenir.
2.  **Auto-Discovery:** Servis, çalıştığı fiziksel/sanal sunucunun adını (`host.name`) otomatik keşfeder ve loglara etiketler.
3.  **Akıllı Ayrıştırma (Smart Parsing):** Docker'dan gelen karmaşık JSON loglarını otomatik algılar ve temizler.
4.  **Network İzolasyonu:** RTP/SIP ağ trafiği (Noise) ile Uygulama logları (Signal) arayüzde ayrı sekmelerde yönetilir.

## 🎯 Temel Sorumluluklar

1.  **Log Toplama (Harvester):** Yerel Docker socket üzerinden çalışan tüm konteynerlerin loglarını toplar.
2.  **Ağ Analizi (Sniffer):** `libpcap` kullanarak 5060 (SIP) ve RTP portlarını dinler, sinyalleşme ve medya akışını analiz eder.
3.  **Normalizasyon:** Farklı kaynaklardan (Redis, Postgres, Rust Apps) gelen verileri tek bir JSON şemasına (STS v2.0) dönüştürür.
4.  **Yönlendirme (Relay):** Toplanan verileri WebSocket üzerinden UI'a veya gRPC üzerinden merkezi bir sunucuya (Nexus) iletir.

## 🔌 Bağlantılar

*   **HTTP UI:** `11070` (Gerçek zamanlı Dashboard)
*   **gRPC Ingest:** `11071` (Dış servislerden log kabulü)
*   **Metrics:** `11072` (Prometheus endpoint)

## 🛠️ Kurulum (Infrastructure)

Observer, ana makine (Host) ağını dinleyebilmek için `network_mode: host` ile çalışmalıdır.

```yaml
observer-service:
  image: ghcr.io/sentiric/sentiric-observer:latest
  container_name: observer-service
  network_mode: host
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - /etc/hostname:/etc/hostname:ro # Node ismini doğru almak için
  environment:
    - ENABLE_NETWORK_SNIFFER=true
    - UPSTREAM_OBSERVER_URL=http://center-node:11071 # Opsiyonel
```

## 📊 Telemetri Standardı

Bu servis, [Sentiric Telemetry Standard (STS v2.0)](../sentiric-infrastructure/TELEMETRY_STANDARD.md) spesifikasyonunu uygular.

---
© 2026 Sentiric Team | Carrier-Grade Observability
