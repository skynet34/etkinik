# Etkinik — Giriş / Çıkış Hatırlatıcı

Çalışanların işe giriş ve özellikle **işten çıkış yapmayı unutmasını** önlemek için hazırlanmış bağımsız bir mobil web uygulaması (PWA).

- Kolay İK'dan tamamen bağımsızdır: giriş yapmaz, veri göndermez, API kullanmaz.
- **Yalnızca hatırlatır.** Giriş/çıkış kaydı sadece "Giriş yaptım" / "Çıkış yaptım" butonlarına basınca oluşur; uygulama hiçbir zaman kendiliğinden kayıt oluşturmaz.
- Sunucu, veritabanı, hesap yoktur. Tüm ayarlar ve kayıtlar telefonda (`localStorage`) tutulur.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `index.html` | Ana ekran ve Ayarlar ekranı |
| `style.css` | Sade, mobil öncelikli açık tema |
| `app.js` | Uygulama mantığı (Store, Validate, Geo, Engine, Notifier, UI katmanları) |
| `manifest.json` | PWA tanımı (ad, ikon, ana ekrana ekleme) |
| `service-worker.js` | Çevrimdışı önbellek, bildirime dokununca uygulamayı açma |
| `icons/` | Ana ekran ikonları (Android ve iPhone'un PWA kurulumu için gerekli) |

## Çalıştırma

Konum ve service worker yalnızca **https** üzerinde (veya bilgisayarda `localhost`'ta) çalışır.

**Bilgisayarda deneme:**

```bash
python3 -m http.server 8080
# Tarayıcıda: http://localhost:8080
```

**Telefonda deneme (önerilen): GitHub Pages**

1. Repository → Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`.
2. Birkaç dakika sonra `https://skynet34.github.io/etkinik/` adresini telefonda açın.

## PWA kurulumu (ana ekrana ekleme)

- **iPhone (Safari):** Paylaş → "Ana Ekrana Ekle". Bildirimler yalnızca bu şekilde eklenip ana ekrandan açıldığında çalışır (iOS 16.4+).
- **Android (Chrome):** Menü (⋮) → "Ana ekrana ekle" / "Uygulamayı yükle".

## Konum izni

İlk konum kontrolünde telefon izin sorar; **"İzin ver"** seçin. Reddedildiyse:

- iPhone: Ayarlar → Gizlilik ve Güvenlik → Konum Servisleri → Safari Web Siteleri (veya ana ekrandaki uygulama) → "Uygulamayı Kullanırken". Ayrıca "Tam Konum" açık olmalı.
- Android: Chrome → Site ayarları → Konum → site için "İzin ver". Telefonun konum servisi açık olmalı.

## Kapsama alanı (10–300 m)

Her iş yerinin kendi kapsama alanı vardır. 10 ile 300 metre arasında **1 metre hassasiyetle** herhangi bir tam sayı seçilebilir (ör. 58 m). Varsayılan 100 m. Sayı kutusu ve kaydırıcı birbirini günceller; aralık dışı değer kaydedilmez.

GPS hassasiyeti genellikle ±5–30 m'dir; kapalı alanda daha kötü olabilir. Hassasiyet kapsama alanından büyükse uygulama uyarır. Çok küçük alanlar (10–30 m) yanlış "dışarıdasınız" sonucu verebilir.

## Hatırlatma mantığı

| Yöntem | Çıkış hatırlatması ne zaman? |
|---|---|
| Yalnızca konum | Giriş yaptıktan sonra iş yeri alanı içinde görüldünüz **ve** son konum ölçümü alanın dışında |
| Yalnızca saat | Giriş yaptınız, çıkış yapmadınız **ve** mesai bitiş saati geldi |
| Konum + saat (varsayılan) | Yukarıdakilerden **herhangi biri** gerçekleşince |

- Çıkış uyarısı "Çıkış yaptım"a basana kadar ekranda kalır.
- Bildirim izni varsa sistem bildirimi de gönderilir; "Tekrar hatırlatma" süresi (Kapalı / 5 / 10 / 15 / 30 dk, varsayılan 10) dolduğunda tekrarlanır.
- Giriş yapılmamışken iş yeri alanındaysanız veya mesai başladıysa "Giriş yapmayı unutma!" bilgisi gösterilir.

## Web/PWA sınırlamaları (önemli)

Bu ilk sürüm bir web uygulamasıdır; native uygulama gibi arka planda çalışamaz.

- **Arka planda konum takibi yok.** Konum yalnızca uygulama ekrandayken (açılışta, öne gelince, "Konumumu kontrol et"e basınca ve ekran açıkken sürekli) okunur. Uygulama kapalıyken iş yerinden ayrıldığınızı **anlayamaz**.
- **Arka planda saat kontrolü güvenilir değil.** Zamanlayıcılar sadece uygulama açıkken çalışır. Telefon kilitliyken veya uygulama kapalıyken 18:00 bildirimi **gelmeyebilir**; uygulamayı açtığınız anda uyarı görünür.
- **iPhone:** Bildirimler için iOS 16.4+ ve ana ekrana ekleme şart. Safari arka plandaki PWA'yı kısa sürede askıya alır. Konum izni bazı iOS sürümlerinde her açılışta tekrar sorulabilir. Titreşim desteklenmez.
- **Android:** Bildirimler tarayıcıda da çalışır; ancak Chrome arka plandaki sekmeyi kısıtlar, pil tasarrufu modu zamanlayıcıları geciktirir.
- Veriler yalnızca bu telefonda ve bu tarayıcıdadır. Tarayıcı verisi silinirse ayarlar da silinir. iPhone'da Safari ile ana ekran uygulamasının verileri ayrıdır.

Güvenilir "işten çıkınca otomatik uyarı" için native iOS/Android uygulamasında sistem geofencing'i gerekir. Kod buna hazır olacak şekilde katmanlara ayrıldı: `Geo` ve `Notifier` native karşılıklarıyla değiştirilebilir, karar mantığı (`Engine.evaluate`) aynen kalabilir.
