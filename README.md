# 👁️ Sentiric Observer (Panopticon)

[![Status](https://img.shields.io/badge/status-active-neon_green.svg)]()
[![Edition](https://img.shields.io/badge/edition-Sovereign_Black_Box-blueviolet.svg)]()

**Sentiric Observer**, platformun merkezi gözlemlenebilirlik ve adli tıp (Forensics) aracıdır. Uygulama loglarını (SUTS v4.0) ve ağ trafiğini (PCAP Sniffing) gerçek zamanlı birleştirerek uçtan uca izleme sağlar.

## 🚀 Hızlı Başlangıç

### 1. Çalıştırma (Docker)
```bash
# Docker socket erişimi ve Host Network modu sniffing için şarttır
docker run -d \
  --network host \
  --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/sentiric/sentiric-observer:latest
```

### 2. Erişim
* **Dashboard (UI):** http://localhost:11070
* **Metrics:** http://localhost:11072/metrics

## 🏛️ Mimari ve Mantık
* **Geliştirici Kuralları:** Gizli [.context.md](.context.md) dosyasını inceleyin.
* **Adli Analiz Algoritmaları:** Trace Locking, PCAP Interceptor ve Aggregator mantığı için [LOGIC.md](LOGIC.md) dosyasını okuyun.
* **Sistem Topolojisi:** Global konum [sentiric-spec](https://github.com/sentiric/sentiric-spec) içindedir.
