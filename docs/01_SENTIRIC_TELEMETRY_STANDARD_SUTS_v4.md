# 📡 SENTIRIC UNIFIED TELEMETRY STANDARD (SUTS v4.0) - Golden Standard

| Meta Veri | Detay |
| :--- | :--- |
| **Status** | **MANDATORY (ZORUNLU)** |
| **Schema Version** | `1.0.0` (Semantic Versioning) |
| **Compliance** | OpenTelemetry v1.0 Logs Data Model |
| **Scope** | Rust, Go, Python, Node.js Microservices |
| **Author** | Sentiric Architecture Board |

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
  "schema_v": "1.0.0",                    // (Zorunlu) Şema Versiyonu
  "ts": "2026-02-19T14:30:00.123Z",       // (Zorunlu) ISO 8601 UTC Time
  "severity": "INFO",                     // (Zorunlu) DEBUG, INFO, WARN, ERROR, FATAL
  "tenant_id": "sentiric_demo",           // (Opsiyonel) Multi-tenancy için
  
  // --- 2. RESOURCE (KİMLİK) ---
  "resource": {
    "service.name": "sbc-service",        // (Zorunlu) Servis adı (kebab-case)
    "service.version": "1.4.0",           // (Zorunlu) SemVer
    "service.env": "production",          // (Zorunlu) dev, staging, prod
    "host.name": "gcp-iowa-gw-01",        // (Otomatik) Pod veya Hostname
    "host.ip": "10.0.0.5"                 // (Otomatik)
  },

  // --- 3. TRACING (BAĞLAM - Distributed Tracing) ---
  "trace_id": "0ac76572b31e0daa",         // (Zorunlu) W3C Trace ID (128-bit hex)
  "span_id": null,                        // (Opsiyonel) İşlem parçacığı ID'si
  
  // --- 4. PAYLOAD (OLAY) ---
  "event": "SIP_DIALOG_START",            // (Zorunlu) Enum (Büyük harf, snake_case)
  "message": "Inbound call initiated",    // (Zorunlu) İnsan okunabilir mesaj
  
  // --- 5. ATTRIBUTES (DETAYLAR - Key-Value) ---
  "attributes": {
    "sip.call_id": "0ac76572b31e0daa",
    "sip.method": "INVITE",
    "net.peer.ip": "192.168.1.50",
    "net.peer.port": 5060,
    "error.code": 503,
    "duration_ms": 45
  }
}
```

---

## 3. ALAN TANIMLARI VE KURALLARI (FIELD DEFINITIONS & RULES)

| Seviye | Tanım | Örnek |
| :--- | :--- | :--- |
| **DEBUG** | Geliştirme detayları, değişken değerleri. Prod ortamında genelde kapalıdır. | `Payload dump: {...}` |
| **INFO** | Normal iş akışı. Servis başladı, çağrı kuruldu. | `SIP_DIALOG_ESTABLISHED` |
| **WARN** | İş akışını bozmayan ama dikkat gerektiren durumlar. | `API_DEPRECATED_USE`, `RETRY_ATTEMPT` |
| **ERROR** | İş akışını bozan hatalar. Operasyon başarısız. | `DB_CONNECTION_FAILED`, `SIP_TIMEOUT` |
| **FATAL** | Servisin çökmesine neden olan kritik hatalar. | `PANIC`, `OUT_OF_MEMORY` |


*   `schema_v`: Değişmez. `"1.0.0"`.
*   `ts`: **Zorunlu.** ISO 8601 UTC formatında zaman damgası.
*   `severity`: **Zorunlu.** `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.
*   `tenant_id`: **Kural:** Platformun V1'i için `"sentiric_demo"` olarak sabitlenmiştir. Gelecekte dinamik hale gelecektir.
*   `resource."service.name"`: **Kural:** `docker-compose.yml` içinde tanımlanan kısa, mantıksal servis adı (örn: `sbc-service`, `proxy-service`).
*   `resource."service.version"`: **Kural:** `Cargo.toml` veya `package.json`'dan alınan SemVer versiyon numarası.
*   `resource."service.env"`: **Kural:** `ENV` çevre değişkeninden alınır (`production`, `staging`, `development`).
*   `resource."host.name"`: **Kural:** Servisin üzerinde çalıştığı ana makinenin (node) hostname'i. `NODE_HOSTNAME` çevre değişkeninden enjekte edilir.
*   `trace_id`: **Kural (ANAYASAL):** Bir çağrının başından sonuna kadar tüm loglarda aynı olan korelasyon kimliği. **Telekom servisleri için bu alan `sip.call_id` değeri ile doldurulmalıdır.** Observer, bu alanı gruplama için kullanır.
*   `span_id`: **Kural:** Bir `trace_id` içindeki tekil ve ölçülebilir bir işlemi temsil eder (örn: bir TTS sentezi, bir DB sorgusu). **Platform V1 için bu alanın doldurulması ertelenmiştir ve `null` olması beklenmektedir.**
*   `event`: **Zorunlu.** Olayı anlatan, `UPPER_SNAKE_CASE` formatında, makine tarafından okunabilir bir kimlik (örn: `SDP_REWRITE_SUCCESS`).
*   `message`: **Zorunlu.** Olayı özetleyen, insan tarafından okunabilir bir metin.
*   `attributes`: Olayla ilgili tüm ek yapısal verilerin (IP, port, süre vb.) bulunduğu key-value nesnesi.

---

## 4. GÜVENLİK (SECURITY & PII)

Aşağıdaki veriler **ASLA** ham haliyle loglanamaz:
*   🔑 Şifreler, API Key'ler, Token'lar.
*   💳 Kredi kartı numaraları.
*   👤 Kişisel veriler (GDPR kapsamındaki İsim, T.C. vb.).

**Çözüm:** Maskeleme yapılmalıdır. Örn: `password: "[REDACTED]"`
