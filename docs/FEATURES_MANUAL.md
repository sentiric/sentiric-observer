# 📘 Panopticon Kullanım Kılavuzu & Özellik Sözlüğü

Bu belge, v12.0 sürümündeki tüm özellikleri ve nasıl kullanılacağını açıklar.

## 1. Üst Kontrol Paneli (Header)

*   **WIRE INTERCEPTOR (Anahtar):** 
    *   *OFF (Gri):* Sistem sadece uygulama loglarını (Docker/gRPC) dinler. İşlemci dostudur.
    *   *ON (Kırmızı/Yanıp Söner):* Sistem ağ kartını dinlemeye başlar. Tüm SIP ve RTP paketlerini yakalar. *Sadece hata ayıklarken açın.*
*   **UPLINK STATUS:** WebSocket bağlantısının durumu. Koparsa otomatik bağlanır.
*   **METRICS:** 
    *   `PPS`: Saniyede işlenen olay sayısı (Packets/Events Per Second).
    *   `BUFFER`: Tarayıcı hafızasının doluluk oranı (Max 10.000 satır).

## 2. Araç Çubuğu (Toolbar)

*   **Trace Lock (Search):** Buraya bir `Call-ID` yapıştırırsanız veya sol menüden seçerseniz, sistem **Focus Mode**'a geçer. Sadece o ID'ye ait veriler akar.
*   **Noise Filter (Sessiz Mod):** 
    *   *Aktif:* Binlerce `RTP_PACKET` logunu listede gizler (Göz yormamak için).
    *   *Pasif:* Her bir ses paketini tek tek listeye basar.
*   **AI Export:** O an ekranda ne görüyorsanız (Filtrelenmiş), onu Yapay Zeka analizi için optimize edilmiş bir formatta indirir.

## 3. Sağ Panel (Inspector)

Bu panel bir satıra tıklandığında açılır.

### A. Details Sekmesi
*   **RTP Flow Diagnostics:** Eğer seçilen satır bir RTP paketi ise, burada canlı bir grafik belirir.
    *   `SEQ`: Paket sıra numarası. Atlama varsa (örn: 1, 2, 5) paket kaybı var demektir.
    *   `Jitter Bar`: Mor çubuk, paketlerin geliş düzensizliğini gösterir.
*   **Raw Wire Payload:** Paketin ağdan yakalanan ham hali (Hex/ASCII).

### B. Timeline Sekmesi
*   Seçili çağrının başından sonuna kadar olan hikayesini gösterir.
*   Kırmızı noktalar hatayı, Mavi noktalar SIP sinyallerini, Mor noktalar Medya olaylarını temsil eder.
*   Her adımın yanında `+120ms` gibi, bir önceki adımdan ne kadar sonra gerçekleştiği yazar. (Gecikme tespiti için).

## 4. Klavye Kısayolları (Power User)

*   `P`: Akışı Durdur/Devam Ettir (Pause/Resume).
*   `ESC`: Sağ paneli (Inspector) kapat.