# 📡 Sentiric Telemetry Standard (STS v2.0)

Bu belge, Sentiric platformundaki tüm mikroservislerin (Rust, Go, Python, Node.js) uyması gereken loglama ve telemetri standartlarını tanımlar.

## 1. Temel Felsefe: "OpenTelemetry First"

Platform, özel (proprietary) log formatları yerine endüstri standardı olan **OpenTelemetry (OTEL) Logs Data Model (v1.0)** yapısını kullanır. Bu sayede loglar, herhangi bir modern araçla (Grafana Loki, Datadog, Jaeger, Elastic) ek dönüşüme gerek kalmadan analiz edilebilir.

## 2. Zorunlu Log Formatı (JSON)

Tüm servisler, **Production** ortamında `STDOUT` (Standart Çıktı) kanalına aşağıdaki JSON şemasına uygun satırlar basmalıdır.

### Şema Örneği
```json
{
  "Timestamp": "2026-02-18T04:00:00.123Z",
  "SeverityText": "INFO",
  "Body": "Kullanıcı girişi başarılı.",
  "Resource": {
    "service.name": "USER-SERVICE",
    "service.namespace": "sentiric-mesh",
    "host.name": "SENTIRIC-ANT-PROD-01"
  },
  "Attributes": {
    "user.id": "u-12345",
    "telephony.call_id": "c-98765",
    "source": "grpc"
  }
}
```

### Alan Tanımları
*   **`Timestamp`**: ISO 8601 / RFC 3339 formatında zaman damgası.
*   **`SeverityText`**: Log seviyesi (`INFO`, `WARN`, `ERROR`, `DEBUG`, `TRACE`).
*   **`Body`**: İnsan tarafından okunabilir ana mesaj.
*   **`Resource`**: Logu üreten kaynağın kimliği.
    *   `service.name`: Servisin adı (Büyük harf, tireli).
    *   `host.name`: Çalıştığı fiziksel/sanal makinenin adı. (Observer bunu otomatik doldurur, servis boş gönderebilir).
*   **`Attributes`**: Yapısal veriler. (Trace ID, Request ID, User ID gibi bağlam bilgileri).

## 3. Observer Service Rolü

`sentiric-observer`, bu standarttaki "Collector" ve "Normalizer" rolünü üstlenir.

1.  **JSON Loglar:** Standart formattaki logları olduğu gibi alır ve yayınlar.
2.  **Ham (Raw) Loglar:** 3. parti uygulamalardan (Redis, Postgres) gelen düz metin loglarını yakalar ve bu şemaya otomatik olarak dönüştürür (Wrap eder).
3.  **Zenginleştirme:** Eğer `host.name` eksikse, çalıştığı makinenin adını otomatik olarak ekler.

## 4. Servis İmplementasyon Rehberi

### Rust (Tracing)
`tracing-subscriber` ile JSON formatında log basın. `flatten_event(true)` kullanın.

### Python
`python-json-logger` kütüphanesini kullanın ve alan isimlerini `Timestamp`, `SeverityText` vb. olarak yeniden eşleyin (rename).

### Go
`slog` (Go 1.21+) kullanın ve JSON Handler ile alanları yapılandırın.

---
**Sentiric Governance Committee**
