# 📡 SENTIRIC UNIFIED TELEMETRY STANDARD (SUTS v4.0)

| Meta Veri | Detay |
| :--- | :--- |
| **Status** | **MANDATORY (ZORUNLU)** |
| **Schema Version** | `1.0.0` (Semantic Versioning) |
| **Compliance** | OpenTelemetry v1.0 Logs Data Model |
| **Scope** | Rust, Go, Python, Node.js Microservices |
| **Author** | Sentiric Architecture Team |

---

## 1. MİMARİ PRENSİPLER (THE CONSTITUTION)

1.  **Stdout Only:** Servisler asla dosyaya yazmaz. Sadece `STDOUT` (Log) ve `STDERR` (Hata) kanallarına yazar.
2.  **JSON Enforcement:** Loglar asla düz metin (text) olamaz. Her satır geçerli bir JSON objesidir.
3.  **Schema Governance:** `schema_v` alanı zorunludur. Observer, desteklemediği şemaları reddeder.
4.  **No Vendor Lock:** Log formatı belirli bir araca (Splunk, Datadog) göre değil, açık standartlara (OTel) göre tasarlanmıştır.

---

## 2. ZORUNLU VERİ ŞEMASI (THE SCHEMA)

Tüm servisler aşağıdaki JSON yapısını **GARANTİ ETMEK ZORUNDADIR**:

```json
{
  // --- 1. GOVERNANCE (YÖNETİŞİM) ---
  "schema_v": "1.0.0",                   // (Zorunlu) Şema Versiyonu
  
  // --- 2. METADATA (ZAMAN VE SEVİYE) ---
  "ts": "2026-02-19T14:30:00.123Z",      // (Zorunlu) ISO 8601 UTC Time
  "severity": "INFO",                    // (Zorunlu) DEBUG, INFO, WARN, ERROR, FATAL
  "tenant_id": "default",                // (Opsiyonel) Multi-tenancy için
  
  // --- 3. RESOURCE (KİMLİK) ---
  "resource": {
    "service.name": "sbc-core",          // (Zorunlu) Servis adı (kebab-case)
    "service.version": "1.2.4",          // (Zorunlu) SemVer
    "service.env": "production",         // (Zorunlu) dev, staging, prod
    "host.name": "edge-eu-01",           // (Otomatik) Pod veya Hostname
    "host.ip": "10.0.0.5"                // (Otomatik)
  },

  // --- 4. TRACING (BAĞLAM - Distributed Tracing) ---
  "trace_id": "c74a9b8f5e3...",          // (Zorunlu) W3C Trace ID (128-bit hex)
  "span_id": "b12...",                   // (Opsiyonel) İşlem parçacığı ID'si
  
  // --- 5. PAYLOAD (OLAY) ---
  "event": "SIP_DIALOG_START",           // (Zorunlu) Enum (Büyük harf, snake_case)
  "message": "Inbound call initiated",   // (Zorunlu) İnsan okunabilir mesaj
  
  // --- 6. ATTRIBUTES (DETAYLAR - Flattened Key-Value) ---
  "attributes": {
    "sip.call_id": "ue83-12s@1.2.3.4",
    "sip.method": "INVITE",
    "net.peer.ip": "192.168.1.50",
    "net.peer.port": 5060,
    "error.code": 503,
    "duration_ms": 45
  }
}
```

---

## 3. SEVERITY LEVEL TANIMLARI

| Seviye | Tanım | Örnek |
| :--- | :--- | :--- |
| **DEBUG** | Geliştirme detayları, değişken değerleri. Prod ortamında genelde kapalıdır. | `Payload dump: {...}` |
| **INFO** | Normal iş akışı. Servis başladı, çağrı kuruldu. | `SIP_DIALOG_ESTABLISHED` |
| **WARN** | İş akışını bozmayan ama dikkat gerektiren durumlar. | `API_DEPRECATED_USE`, `RETRY_ATTEMPT` |
| **ERROR** | İş akışını bozan hatalar. Operasyon başarısız. | `DB_CONNECTION_FAILED`, `SIP_TIMEOUT` |
| **FATAL** | Servisin çökmesine neden olan kritik hatalar. | `PANIC`, `OUT_OF_MEMORY` |

---

## 4. GÜVENLİK (SECURITY & PII)

Aşağıdaki veriler **ASLA** ham haliyle loglanamaz:
*   🔑 Şifreler, API Key'ler, Token'lar.
*   💳 Kredi kartı numaraları.
*   👤 Kişisel veriler (GDPR kapsamındaki İsim, T.C. vb.).

**Çözüm:** Maskeleme yapılmalıdır. Örn: `password: "[REDACTED]"`