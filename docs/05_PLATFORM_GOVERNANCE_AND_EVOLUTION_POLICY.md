# 🏛️ SENTIRIC PLATFORM GOVERNANCE & EVOLUTION POLICY

| Status | ACTIVE |
| Owner | Sentiric Architecture Board |
| Applies To | All Microservices & Observer Platform |
| Purpose | Long-term sustainability & controlled evolution |

---

# 1. AMAÇ

Bu doküman, Sentiric platformunun:

- Kontrolsüz büyümemesi
- Geriye dönük uyumluluğu koruması
- Evrim sürecinde sistem kırılmalarını önlemesi
- Ürünleşmeye hazır kalması

için kuralları tanımlar.

---

# 2. SCHEMA VERSIONING POLICY

## 2.1 Semantic Versioning

`schema_v` alanı SemVer kurallarına uyar:

MAJOR.MINOR.PATCH

### MAJOR
Breaking change.
Observer aynı anda en fazla 2 MAJOR versiyonu destekler.

### MINOR
Backward compatible alan ekleme.

### PATCH
Dokümantasyon veya validation düzeltmesi.

---

## 2.2 Compatibility Matrix

| Observer Version | Supported Schema Versions |
|------------------|---------------------------|
| v4.x | 1.x |
| v5.x | 1.x + 2.x |

Eski schema desteği en fazla 18 ay sürer.

---

# 3. DEPRECATION POLICY

Bir alan kaldırılacaksa:

1. MINOR versiyonda "deprecated" olarak işaretlenir
2. 2 minor cycle sonra MAJOR versiyonda kaldırılır
3. Migration guide yayınlanır

---

# 4. STORAGE STRATEGY (EVOLUTION PATH)

## Phase 1
In-memory only (Ephemeral).

## Phase 2
Optional external export:
- Loki
- ClickHouse
- Object Storage (S3-compatible)

## Phase 3
Pluggable storage abstraction layer.

Storage kararı:
- Core domain storage-aware değildir.
- Storage adapter seviyesinde eklenir.

---

# 5. BACKPRESSURE & OVERLOAD POLICY

## 5.1 Channel Limits
- Default channel capacity: 10,000 messages.
- Eğer dolarsa: oldest drop policy.

## 5.2 Overload Mode
Eğer:
- CPU > %85
- Memory > %80

Observer:
- DEBUG logları drop eder.
- WARN ve üstünü önceliklendirir.

---

# 6. SDK STRATEGY (MANDATORY IN FUTURE)

## 6.1 Phase 1
Manual logging allowed.

## 6.2 Phase 2
Official Sentiric SDK required for production services.

## 6.3 SDK Responsibilities
- schema_v injection
- resource auto-injection
- trace context propagation
- PII masking middleware
- local validation

---

# 7. OBSERVER POSITIONING

Observer:

- OpenTelemetry Collector’ın yerine geçmez.
- Domain-aware intelligence katmanı olarak konumlanır.
- OTel uyumlu ingestion destekler (OTLP future phase).

---

# 8. HIGH AVAILABILITY ROADMAP

## Phase 1
Single instance.

## Phase 2
Stateless + external storage.

## Phase 3
Horizontal scaling:
- Sharded trace processing
- Distributed aggregation

---

# 9. SECURITY EVOLUTION

Phase 1:
- Local only

Phase 2:
- Token-based ingestion
- TLS support

Phase 3:
- mTLS
- RBAC
- Audit logs

---

# 10. OBSERVABILITY OF OBSERVER

Observer expose eder:

- ingest_rate
- dropped_logs_total
- parse_error_rate
- active_sessions
- memory_usage_bytes
- processing_latency_ms

Metrics endpoint:
`/metrics` (Prometheus compatible)

---

# 11. NON-BLOCKING PRINCIPLE

Bu dokümanda tanımlanan Phase 2 ve Phase 3 özellikleri:

- Şu anki geliştirmeyi bloklamaz.
- Ancak mimari tasarım bu özelliklere izin verecek şekilde yapılmalıdır.

Bu bir "Future-Proofing Contract"tır.
