# EtkinIK 1.1 — iPhone kişisel hatırlatıcı

Bu sürüm giriş/çıkış kaydı tutmaz. Kullanıcı herhangi bir şirkete bağlı olmadan iş yeri, mesai saatleri ve çalışma günlerini seçer.

- Giriş ve çıkış için günde birer hatırlatma; 5/10/15/30 dakika tekrarları kaldırıldı.
- "Giriş yaptım" ve "Çıkış yaptım" butonları kaldırıldı.
- Belirgin mavi giriş ve turuncu çıkış uyarısı ekrana dokunarak kapanır; ayrı kapatma butonu yoktur.
- Aktif/Pasif anahtarı bekleyen bildirimleri ve geofencing'i durdurur.
- Konum modunda ilk varış ve gün içinde gözlenen iş yeri ziyaretinden sonraki ayrılış hatırlatılır. Saat modunda iki mesai saati kullanılır. Konum + saat aynı gün aynı uyarıyı iki kez üretmez.
- Çalışma günleri seçilebilir. Gece vardiyası desteklenmez.
- Veriler telefondadır. Eski v1 verisi korunur, yalnızca iş yeri ayarları yeni sürüme aktarılır; eski giriş/çıkış kayıtları yeni arayüze taşınmaz.

## iPhone’da deneme

Gerçek bildirim/geofencing testi için imzalı native build gerekir; Expo Go tam test için yeterli değildir.

```bash
npm ci
npx eas-cli@latest login
npx eas-cli@latest build -p ios --profile production
```

Bu komut yalnızca EAS build oluşturur. App Store Connect/TestFlight'a yükleme yapmaz. Mevcut `com.etkin.etkinik` kimliği ve EAS projesi korunur. Yeni sürüm `1.1.0`; EAS uzak build numarasını otomatik artırır.

Kullanıcının ayrıca açık onayı alınmadan `eas submit`, `--auto-submit`, `eas update` veya App Review yeniden gönderimi yapılmamalıdır.

## Test adımları

1. Güncel iOS yüklü fiziksel iPhone’a yeni build kurulur.
2. Ayarlar açılır; çalışma günü, başlangıç/bitiş saatleri, yöntem ve iş yeri kaydedilir.
3. Saat testi için iki saat de geleceğe, örneğin 2 ve 4 dakika sonrasına ayarlanır. Bildirim izni verilir; telefon kilitliyken iki uyarı denenir.
4. Uygulama açıkken uyarıya dokunulur; aynı gün yeniden gösterilmemesi kontrol edilir.
5. Konum testi için Her Zaman izni verilir. İş yeri alanına varış/ayrılış gerçek cihazla denenir. iOS bölge olayları tam sınırda veya hemen gelmeyebilir.
6. Pasif yapılır; kilitliyken saat ve konum uyarısı gelmediği kontrol edilir. Yeniden aktifleştirme denenir.
7. Çalışılmayan gün, konum/bildirim izni reddi ve gün değişimi kontrol edilir.
8. Apple videosu simgeden açılışla başlar; ayarlar, iki uyarı, dokunarak kapatma ve Pasif akışı gösterilir. Cihaz modeli/iOS sürümü belirtilir.

## Saat bildirimlerinin kapsamı

Saat bildirimleri en fazla 28 gün ileriye, her çalışma günü için tek giriş ve tek çıkış olarak kurulur (en fazla 56 bekleyen bildirim). Uygulamayı açınca bu pencere yenilenir; son tarih ana ekranda gösterilir. 28 gün hiç açılmazsa saat bildirimleri sona erer. Geofencing'in böyle bir tarih sınırı yoktur. Bu sınır fiziksel cihaz QA’da doğrulanmalı; sınırsız çalışma iddiası yapılmamalıdır.

## Kontroller

```bash
npm test
npx expo lint
npx tsc --noEmit
npx expo export --platform ios
```

JS projede TypeScript `checkJs: false` ile yalnızca yapılandırma/sözdizimi denetimidir; kapsamlı statik tür doğrulaması değildir. Otomatik mantık ve bildirim kuyruğu testleri native cihaz testinin yerini tutmaz.
# Ayrı kapsama ayarları

Giriş ve çıkış kapsama alanları ayrı ayrı 10–300 metre arasında ayarlanır. Giriş bölgesine girme ve çıkış bölgesinden ayrılma bağımsız olarak izlenir. Önceki tek kapsama değeri ilk açılışta iki alana da aktarılır.

