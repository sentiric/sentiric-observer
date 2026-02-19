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