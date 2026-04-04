# 🧬 Observer (Panopticon) Diagnostics & Sniffing Logic

Bu belge, `observer-service`'in sistem loglarını ve çekirdek (Kernel) seviyesindeki ağ trafiğini nasıl birleştirip UI'a aktardığını açıklar.

## 1. Tactical Wire Interceptor (Pcap Sniffer)
Sistemdeki SIP ve RTP trafiğini dinlemek için Docker logları yetmez. Ağ kartı (eth0 / any) üzerinden okuma yapılmalıdır.
* **Algoritma:** `libpcap` kullanılır. İşletim sistemi çekirdeğine `udp port 5060 or portrange 10000-20000` BPF (Berkeley Packet Filter) kuralı enjekte edilir. Çekirdek, sadece bu paketleri User-Space'e kopyalar.
* **Zero-Copy Parsing:** Yakalanan Ethernet, IP ve UDP başlıkları bayt atlama (Byte Offset) matematiği ile geçilir. Paket payload'u içinde regex kullanılmaz, saf string search ile `Call-ID:` bulunur ve sistemdeki diğer JSON loglarının `trace_id`'si ile eşleştirilir.

## 2. Omniscient Micro-Batching (UI Crash Koruması)
Sistem yük altındayken saniyede 5.000 log (PPS) gelebilir. Bu logları WebSocket üzerinden anında tarayıcıya (Frontend) basmak, React/JS motorunu (DOM Reflow) kilitler ve sekmeyi çökertir (Crash).
* **Algoritma:** Loglar `tx` kanalına geldikçe bir `Vec<LogRecord>` (Buffer) içine atılır. 
* Sadece **100ms'de bir** (veya buffer 100'ü aşarsa) tüm yığın (Batch) tek bir JSON dizisi (Array) olarak tarayıcıya fırlatılır. Tarayıcı (Frontend), DOM'a her elementi tek tek eklemek yerine `DocumentFragment` kullanarak tek seferde (Surgical Update) çizer.

## 3. Trace Locking & Aggregation
Sistem binlerce farklı aramayı aynı anda izlerken, operatör bir hatayı bulmak için `Call-ID`'ye tıklar (Lock Trace).
* **O(1) Karmaşıklık:** Tüm loglar bellekte bir `HashMap<String, CallSession>` içinde tutulur. Anahtar (Key) her zaman `trace_id`'dir. Eğer RAM şişerse (Max Sessions > 10.000), `LruCache` mantığıyla TTL süresi dolan (eski) aramalar periyodik olarak çöpe atılır (Garbage Collection).
