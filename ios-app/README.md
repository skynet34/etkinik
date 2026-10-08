# Etkinik — iPhone uygulaması

Web/PWA sürümünün native iPhone karşılığı. Fark: **uygulama kapalıyken de** hatırlatır.

| Durum | Ne olur |
|---|---|
| "Giriş yaptım" | Mesai bitişinde (ve tekrar süresi aralıklarla 3 saat boyunca) çıkış bildirimi telefona zamanlanır |
| İş yeri alanından çıkış | iOS bölge izleme uygulamayı arka planda uyandırır; giriş var/çıkış yoksa anında bildirim + tekrarlar |
| Alana geri dönüş | Konum kaynaklı tekrarlar durur |
| "Çıkış yaptım" | Tüm bekleyen ve ekrandaki çıkış bildirimleri silinir |
| Sabah alana giriş (giriş kaydı yoksa) | Günde bir kez "Giriş yapmayı unutma!" |

Uygulama hiçbir zaman kendiliğinden giriş/çıkış kaydı oluşturmaz. Sunucu yok; veriler telefonda (AsyncStorage).

## Yapı

- `src/logic.js` — doğrulama ve karar mantığı (web sürümüyle aynı kurallar)
- `src/storage.js` — cihaz üzerinde saklama
- `src/reminders.js` — yerel bildirimler + geofencing (iOS katmanı)
- `src/tasks.js` — arka plan geofencing görevi (uygulama kapalıyken çalışır)
- `App.js` — ana ekran ve ayarlar

## Derleme (Mac gerekmez)

```bash
npm install
npx eas-cli@latest login
npx eas-cli@latest build -p ios --profile production --auto-submit
```

Build Expo'nun sunucularında yapılır, `--auto-submit` App Store Connect'e (TestFlight) yükler.

## Gereken izinler

- Konum: **Her Zaman** (uygulama kapalıyken alandan çıkışı algılamak için)
- Bildirimler

## Sınırlamalar

- iOS bölge izleme hücresel/Wi-Fi verisine dayanır; çıkış bildirimi genellikle alandan **birkaç yüz metre ve 1–3 dakika** sonra gelir. 100 m altındaki kapsama alanları iOS tarafında yaklaşık olarak uygulanır.
- Kullanıcı uygulamayı uygulama değiştiriciden yukarı kaydırıp kapatırsa iOS bölge olaylarını yine iletir; ancak telefon yeniden başlatıldıktan sonra ilk kilit açılışına kadar olay gelmez.
- Düşük Güç Modu bildirimleri geciktirebilir.
