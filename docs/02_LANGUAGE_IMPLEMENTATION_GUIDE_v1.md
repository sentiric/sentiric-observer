# 🛠️ SUTS IMPLEMENTATION GUIDE (Polyglot)

Bu rehber, SUTS v4.0 standardının farklı dillerde nasıl uygulanacağını gösterir.
**Hedef:** Geliştirici manuel JSON oluşturmaz, kütüphane otomatik yapar.

---

## 1. RUST (Microservices & Core)

*   **Önerilen Kütüphaneler:** `tracing`, `tracing-subscriber`, `serde_json`.
*   **Strateji:** `tracing-subscriber` için Custom Layer yazılır.

```rust
// Cargo.toml
// tracing = "0.1"
// tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }

use tracing::{info, error};

fn main() {
    // SUTS Uyumlu Formatter burada konfigüre edilmeli
    // (Detaylı kod Observer projesinde utils altında verilecektir)
    
    info!(
        event = "SIP_PACKET_RECEIVED",
        sip.method = "INVITE",
        sip.call_id = "12345@10.0.0.1",
        "Incoming SIP Invite processed"
    );
}
```

---

## 2. GO LANG (Agents & Networking)

*   **Standart:** Go 1.21+ ile gelen `log/slog` paketi kullanılmalıdır. Harici kütüphaneye gerek yoktur.

```go
package main

import (
    "log/slog"
    "os"
    "time"
)

func init() {
    // JSON Handler Config
    opts := &slog.HandlerOptions{
        ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
            // Standart uyumu için Time key'ini 'ts' yap
            if a.Key == slog.TimeKey {
                a.Key = "ts"
                a.Value = slog.StringValue(time.Now().UTC().Format(time.RFC3339))
            }
            return a
        },
    }

    logger := slog.New(slog.NewJSONHandler(os.Stdout, opts)).With(
        slog.String("schema_v", "1.0.0"),
        slog.String("service.name", "go-agent"),
    )
    slog.SetDefault(logger)
}

func main() {
    slog.Info("Agent started", 
        "event", "SYSTEM_START",
        "host.ip", "192.168.1.10",
    )
}
```

---

## 3. PYTHON (AI & Analytics)

*   **Kütüphane:** `structlog` (Zorunlu). Standart `logging` modülü yetersizdir.

```python
import structlog
import datetime

# Yapılandırma
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso", key="ts", utc=True),
        structlog.processors.JSONRenderer()
    ],
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger()

# Kullanım
log.info("Prediction completed", 
         event="AI_INFERENCE_DONE",
         model="gpt-4-turbo",
         duration_ms=450)
```

---

## 4. NODE.JS (BFF & Web)

*   **Kütüphane:** `pino` (En hızlısı).
*   **Trace Context:** `AsyncLocalStorage` kullanılarak request boyunca Trace ID korunmalı.

```javascript
const pino = require('pino');

const logger = pino({
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  base: {
    schema_v: "1.0.0",
    "service.name": "node-bff"
  },
  messageKey: "message",
  formatters: {
    level: (label) => { return { severity: label.toUpperCase() } }
  }
});

logger.info({ 
    event: "USER_LOGIN", 
    user_id: 12345 
}, "User logged in successfully");
```

## 5. C++ (Core Networking / SIP / High-Performance Components)

### 🎯 Hedef

* Manuel JSON üretimi yasak.
* Yüksek performans.
* Thread-safe logging.
* Structured JSON output (SUTS v4.0 uyumlu).
* Stdout only.

---

## 5.1 Önerilen Kütüphane

**Tercih 1 (Önerilen):** `spdlog` + `nlohmann/json`

* Yüksek performans
* Async logging desteği
* Header-only JSON desteği

Alternatif:

* Boost.Log (daha ağır)
* Native OTel C++ SDK (ileride Phase 2 için)

---

## 5.2 Bağımlılıklar

CMake örneği:

```cmake
find_package(spdlog REQUIRED)
find_package(nlohmann_json REQUIRED)

target_link_libraries(your_service
    spdlog::spdlog
    nlohmann_json::nlohmann_json
)
```

---

## 5.3 SUTS Uyumlu Logger Wrapper (Önerilen Mimari)

❗ Kritik prensip:
Servis içinde doğrudan `spdlog::info()` kullanılmaz.
Bir **SentiricLogger wrapper** yazılır.

---

### Örnek: SentiricLogger.hpp

```cpp
#pragma once

#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <iomanip>
#include <sstream>

class SentiricLogger {
public:
    static void init(const std::string& service_name,
                     const std::string& version,
                     const std::string& environment)
    {
        logger_ = spdlog::stdout_color_mt("sentiric");
        logger_->set_pattern("%v"); // Raw JSON only

        service_name_ = service_name;
        version_ = version;
        environment_ = environment;
    }

    static void info(const std::string& event,
                     const std::string& message,
                     const nlohmann::json& attributes = {})
    {
        log("INFO", event, message, attributes);
    }

    static void error(const std::string& event,
                      const std::string& message,
                      const nlohmann::json& attributes = {})
    {
        log("ERROR", event, message, attributes);
    }

private:
    static inline std::shared_ptr<spdlog::logger> logger_;
    static inline std::string service_name_;
    static inline std::string version_;
    static inline std::string environment_;

    static std::string now_iso8601()
    {
        auto now = std::chrono::system_clock::now();
        auto t = std::chrono::system_clock::to_time_t(now);
        std::stringstream ss;
        ss << std::put_time(gmtime(&t), "%FT%TZ");
        return ss.str();
    }

    static void log(const std::string& severity,
                    const std::string& event,
                    const std::string& message,
                    const nlohmann::json& attributes)
    {
        nlohmann::json log_entry = {
            {"schema_v", "1.0.0"},
            {"ts", now_iso8601()},
            {"severity", severity},
            {"trace_id", generate_trace_id()},  // Stub (real impl later)
            {"event", event},
            {"message", message},
            {"resource", {
                {"service.name", service_name_},
                {"service.version", version_},
                {"service.env", environment_}
            }},
            {"attributes", attributes}
        };

        logger_->info(log_entry.dump());
    }

    static std::string generate_trace_id()
    {
        return "00000000000000000000000000000000";
    }
};
```

---

## 5.4 Kullanım

```cpp
#include "SentiricLogger.hpp"

int main() {

    SentiricLogger::init(
        "sip-gateway",
        "1.0.0",
        "production"
    );

    SentiricLogger::info(
        "SIP_PACKET_RECEIVED",
        "Incoming SIP Invite processed",
        {
            {"sip.method", "INVITE"},
            {"net.peer.ip", "192.168.1.50"},
            {"duration_ms", 42}
        }
    );

    return 0;
}
```

---

## 5.5 Thread Safety & Performance

Telekom seviyesinde dikkat edilmesi gerekenler:

### Async Mode (Önerilir)

```cpp
spdlog::init_thread_pool(8192, 1);
auto async_logger = spdlog::create_async<spdlog::sinks::stdout_sink_mt>("sentiric");
```

Bu:

* IO blocking’i azaltır
* High PPS ortamında güvenlidir

---

## 5.6 Trace Propagation (Phase 2)

Gelecekte:

* W3C Trace Context (`traceparent`)
* Header parsing
* Context injection

eklenecek.

Bu noktada C++ tarafı için:
OpenTelemetry C++ SDK entegrasyonu düşünülebilir.

---

## 5.7 Performans Notları (Carrier-Grade)

C++ servisler genelde:

* SIP proxy
* RTP handler
* Edge gateway

gibi yüksek throughput sistemlerdir.

Bu yüzden:

* JSON serialization hot-path’te minimize edilmeli
* DEBUG loglar prod’da kapatılmalı
* Backpressure farkındalığı olmalı

---
