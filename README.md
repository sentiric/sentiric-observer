# 👁️ SENTIRIC OBSERVER (v4.0 Sovereign Edition)

[![Status](https://img.shields.io/badge/status-active-success.svg)]()
[![Standard](https://img.shields.io/badge/standard-SUTS_v4.0-blue.svg)](docs/01_SENTIRIC_TELEMETRY_STANDARD_SUTS_v4.md)
[![Architecture](https://img.shields.io/badge/arch-Hexagonal-purple.svg)](docs/03_OBSERVER_ARCHITECTURE_BLUEPRINT_v4.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()

> **"Data is the new oil, but Intelligence is the engine."**

**Sentiric Observer**, dağıtık mikroservis mimarileri (Rust, Go, Python, Node.js) için tasarlanmış, **OpenTelemetry (OTel)** uyumlu, gerçek zamanlı bir **Telemetri ve Anomali Tespit Platformudur**.

Sadece log toplamaz; veriyi **anlar**, **ilişkilendirir** (correlation) ve **görselleştirir**. Özellikle Telekom (SIP/RTP) ve Yüksek Trafikli Edge sistemler için optimize edilmiştir.

---

## 🚀 Temel Yetenekler (Key Capabilities)

*   **Carrier-Grade Governance:** Tüm servisler için zorunlu [SUTS v4.0 Standardı](docs/01_SENTIRIC_TELEMETRY_STANDARD_SUTS_v4.md) ile veri bütünlüğü sağlar.
*   **Polyglot Ingestion:** Docker Container'ları, gRPC streamleri ve Ağ Paketlerini (Sniffer) aynı anda işler.
*   **Real-time Intelligence:** Logları bir veritabanına gömüp sonra sorgulamak yerine, **hafızada (In-Memory)** analiz eder ve anlık anomali tespiti yapar.
*   **Hexagonal Architecture:** İş mantığı (Core), dış dünyadan (Adapters) tamamen izole edilmiştir.
*   **Zero-Overhead UI:** WebSocket üzerinden çalışan, binlerce logu saniyeler içinde çizebilen "Matrix Style" arayüz.

---

## 📚 Dokümantasyon (The Constitution)

Bu proje rastgele kodlanmamıştır. Aşağıdaki standartlara sıkı sıkıya bağlıdır:

| Belge | Açıklama |
| :--- | :--- |
| 📜 **[SUTS v4.0 Standardı](docs/01_SENTIRIC_TELEMETRY_STANDARD_SUTS_v4.md)** | Tüm servislerin uyması gereken JSON Log Şeması ve Kuralları. |
| 🏗️ **[Mimari Blueprint](docs/03_OBSERVER_ARCHITECTURE_BLUEPRINT_v4.md)** | Sistemin Hexagonal yapısı, Actor Modeli ve Veri Akışı. |
| 🛠️ **[Implementation Guide](docs/02_LANGUAGE_IMPLEMENTATION_GUIDE_v1.md)** | Rust, Go, Python ve Node.js için entegrasyon rehberi. |
| 🗺️ **[Yol Haritası](docs/04_PROJECT_EXECUTION_ROADMAP.md)** | Faz faz geliştirme planı ve hedefler. |

---

## 🏗️ Sistem Mimarisi (High-Level)

```mermaid
graph LR
    A[Microservices] -- JSON Log Stream --> B(Ingestion Adapters)
    N[Network Traffic] -- PCAP --> B
    B --> C{Schema Validator}
    C -- Valid --> D[Core Domain / Aggregator]
    C -- Invalid --> X[Dead Letter Queue]
    D --> E[Export Adapters]
    E --> F((WebSocket UI))
    E --> G[(External Storage / Loki)]
```

---

## 🛠️ Kurulum ve Çalıştırma

### Gereksinimler
*   Docker & Docker Compose
*   Rust 1.75+ (Geliştirme için)

### Hızlı Başlat (Production Mode)


`sentiric-infrastructure` içinde bu servisi şu şekilde tanımlayın:

```yaml
observer-service:
  image: ghcr.io/sentiric/sentiric-observer:latest
  container_name: observer-service
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  environment:
      # --- Global ---
    - ENV=production
    - LOG_LEVEL=info
    - LOG_FORMAT=json
    - RUST_LOG=info
    
    # --- Network ---
    # - OBSERVER_SERVICE_IPV4_ADDRESS=10.88.11.7
    - OBSERVER_SERVICE_HTTP_PORT=11070
    - OBSERVER_SERVICE_GRPC_PORT=11071
    - OBSERVER_SERVICE_METRICS_PORT=11072
    - OBSERVER_SERVICE_HOST=observer-service
        
    # ---
    # Bu servis hariç tutulacak mı? Hayır
    - SERVICE_IGNORE=false
    # Başka observer stream akıt ( yada ana observer'a)
    # Boş ise sadece kendisi aktif
    # - UPSTREAM_OBSERVER_URL=http://master-node-or-ip:11081
    - UPSTREAM_OBSERVER_URL=

    # SNIFFER AKTİVASYONU
    - SNIFFER_ENABLED=true # UI Aracılıgıyla kapatılabilir
    - SNIFFER_INTERFACE=any  # eth0, ens192 vb # Ui aracılığı ile seçilebilir
    - SNIFFER_FILTER=udp port 13084 or udp portrange 50000-50100
    # Boş bırıkılnca sniffer kapalıdır.
    # UI arabiriminden yönetilebilir
    
    # !Farklı node larda filreleme örnekleri

    # e2 micro gibi makinelerde sniffer performansı etkilebilir?
    # sbc sip port and proxy sip port and sbc relay rtp port range
    # - SNIFFER_FILTER=udp port 5060 or udp port 13074 or udp portrange 30000-30010

    # # b2bua sip port and media service rtp port range
    # - SNIFFER_FILTER=udp port 13084 or udp portrange 50000-50100    
    
    - MAX_ACTIVE_SESSIONS=50000     # RAM'e göre artırılabilir
    - SESSION_TTL_SECONDS=600       # 10 dakika sonra unut


  #   networks:
  #     sentiric-net:
  #       ipv4_address: 10.88.11.8

  # [KRİTİK]: Host ağını kullan (Sniffing için şart)
  # Bu sayede host üzerindeki eth0, tailscale0 vb. her şeyi görür.
  network_mode: host

  # Cap Add, host mode kullanıldığı için Linux'ta genelde gerekmeyebilir ama garanti olsun
  cap_add:
    - NET_ADMIN
    - NET_RAW  
  
  ports:
    - "11080:11080" # HTTP Port
    - "11081:11081" # GRPC POrt
    - "11082:11082" # Metric Port
  restart: always
```

### Geliştirici Modu (Dev)

```bash
# 1. Projeyi derle
cargo build --release

# 2. Çalıştır (Log seviyesi: INFO)
RUST_LOG=info ./target/release/sentiric-observer
```

---

## 🔌 Portlar ve Erişim

*   **UI Dashboard:** `http://localhost:11070`
*   **gRPC Ingest:** `0.0.0.0:11071`
*   **Metrics:** `http://localhost:11072/metrics`

---

## 🛡️ Lisans ve Katkı

Bu proje **Sentiric Core Team** tarafından geliştirilmektedir.
Standartlara katkıda bulunmak için lütfen önce [RFC Sürecini](docs/) inceleyin.

---
© 2026 Sentiric Platform | *Observability for the Sovereign Cloud*
