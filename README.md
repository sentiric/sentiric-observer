# 👁️ Sentiric Observer

**Sentiric Observer**, platformdaki tüm konteyner loglarını gerçek zamanlı olarak hasat eden, etiketleyen ve merkezi bir noktada birleştiren hafif bir Rust servisidir.

## 🎯 Temel Sorumluluklar
1. **Docker Harvesting:** Yerel Docker socket üzerinden canlı log akışlarını yakalar.
2. **Standardization:** Farklı servislerin loglarını Sentiric Trace formatına sokar.
3. **Loop Protection:** Kendi loglarını dinlemeyi otomatik olarak engeller.
4. **Nexus Ready:** Merkezi Observability servisine (Nexus) veri basmaya hazırdır.

## 🔌 Harmonik Bağlantılar
- **HTTP/UI:** `11070`
- **gRPC Ingest:** `11071`
- **Metrics:** `11072`

## 🛠️ Kurulum (Infrastructure)
Sentiric Infrastructure içinde şu şekilde tanımlanır:

```yaml
observer-service:
  image: ghcr.io/sentiric/sentiric-observer:latest
  container_name: observer-service
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
```
---
© 2026 Sentiric Team | GNU AGPL-3.0 License