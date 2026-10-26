# بررسی معماری و ریپوها — ۲۴ اکتبر ۲۰۲۶

هدف بررسی: کاربر به ایران، مدیریت کاربر در سنایی ایران، آغاز کانال از Worker به ایران، خروج TCP از Worker، بدون VPS خارجی. جست‌وجوی گسترده انجام شد و ۱۸ مخزن برای مقایسه انتخاب شدند؛ این فهرست ادعای پوشش تمام ریپوهای گیت‌هاب یا ممیزی کامل سورس آنها نیست. SHA دقیق snapshotها در repositories.json ثبت شده است. برای پنج مخزن فایل‌های منتخب سورس نیز خوانده شد؛ دامنهٔ بررسی در source-inspection.json آمده است.

| مخزن | نتیجه برای این هدف |
|---|---|
| [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui) | انتخاب بخش ایران: مدیریت کاربران و Xray. به‌تنهایی Worker را به سمت خروجی تبدیل نمی‌کند. |
| [XTLS/Xray-core](https://github.com/XTLS/Xray-core) | پیاده‌سازی Reverse و VLESS دارای منطق Bridge/Mux اختصاصی است؛ قرار دادن لینک VLESS در Worker جای اجرای آن را نمی‌گیرد. اتصال SOCKS استاندارد برای ادغام انتخاب شد. |
| [bia-pain-bache/BPB-Worker-Panel](https://github.com/bia-pain-bache/BPB-Worker-Panel) | Worker ورودی WS/VLESS/Trojan و تولید subscription؛ ترتیب اتصال موردنظر ما در مسیر اصلی کد مشاهده نشد. |
| [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) | پنل و خروجی پروکسی Worker، گزینه‌های upstream/ProxyIP؛ فایل بزرگ worker فقط به‌صورت هدفمند بررسی شد، نه ممیزی کامل. |
| [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel) | مخزن مرجع تاریخی؛ README فعلی فقط خط جداکننده داشت و برای اثبات قابلیت فعلی کافی نبود. |
| [yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan) | اسکریپت‌های VLESS/Trojan و پراکسی محلی؛ مدرکی برای پنل آماده با همهٔ شروط شما پیدا نشد. |
| [bepass-org/bepass-relay](https://github.com/bepass-org/bepass-relay) | README توضیح می‌دهد رفع محدودیت مقصدهای Cloudflare و UDP از relay خارجی کمک می‌گیرد؛ وجود relay عمومی وابستگی خارجی را حذف نمی‌کند. |
| [radkesvat/RTCF](https://github.com/radkesvat/RTCF) | ریورس با CDN، اما سمت خارج سرور و برنامهٔ بومی دارد. مخزن هنگام بررسی آرشیوشده بود. |
| [radkesvat/ReverseTlsTunnel](https://github.com/radkesvat/ReverseTlsTunnel) | جهت آغاز اتصال مشابه هدف شماست؛ اجرا به دو سمت سروری متکی است. مخزن آرشیوشده و README به WaterWall اشاره می‌کند. |
| [erebe/wstunnel](https://github.com/erebe/wstunnel) | تونل و reverse forwarding و SOCKS؛ باینری مستقل سمت مقابل لازم دارد، Worker آمادهٔ جایگزین آن نیست. |
| [fatedier/frp](https://github.com/fatedier/frp) | ابزار reverse proxy با اجزای client/server؛ نیاز خروجی بدون سرور خارجی را مستقیم برآورده نمی‌کند. |
| [rathole-org/rathole](https://github.com/rathole-org/rathole) | reverse proxy بومی با دو جزء؛ برای ایدهٔ مدیریت اتصال مفید، نه Worker egress آماده. |
| [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared) | اتصال origin به Cloudflare برای انتشار سرویس؛ خروج اینترنت خارجی برای کاربران متصل به ایران را به‌خودی‌خود فراهم نمی‌کند. |
| [remorses/traforo](https://github.com/remorses/traforo) | انتشار HTTP/WS محلی با DO؛ در معماری مستند client محلی به DO وصل می‌شود، خلاف شرط آغاز از Worker. |
| [volter-ai/volter-tunnel](https://github.com/volter-ai/volter-tunnel) | انتشار سرویس HTTP/WS با Worker+DO؛ کاربرد اصلی ingress است، نه خروج عمومی کاربران ایران. |
| [PdYrust/cf-xray-proxy](https://github.com/PdYrust/cf-xray-proxy) | Worker جلوی backendهای Xray/sing-box؛ backend همچنان مسئول پروتکل و خروج است. |
| [Drshahinka/Nahan-Panel](https://github.com/Drshahinka/Nahan-Panel) | پنل Worker با VLESS/Trojan و امکانات کاربری طبق README؛ همهٔ امکانات ادعایی اجرا یا ممیزی نشد. ترتیب دقیق موردنظر تأیید نشد. |
| [MR-SHARIFI-Dev/IVA-PANEL](https://github.com/MR-SHARIFI-Dev/IVA-PANEL) | مخزن توزیع و مستندات؛ README می‌گوید سورس اختصاصی منتشر نشده. metadata گیت‌هاب MIT نشان می‌داد ولی README proprietary است؛ این metadata مجوز استفاده از سورس محصول تلقی نشد. |

نتیجهٔ این بررسی: گزینهٔ آماده‌ای که همهٔ شروط را با شواهد کافی تأیید کند پیدا نشد. این نتیجه اثبات نبودن هیچ پروژه‌ای در اینترنت نیست. راه انتخاب‌شده، حفظ سنایی و نوشتن Agent سبک و transport مستقل است. هیچ سورس GPL یا کد ناشناخته از مخزنهای بررسی‌شده داخل بسته کپی نشده است.

## مبنای تصمیم‌های فنی

- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/): خروج TCP با connect ممکن است؛ مقصدهای Cloudflare و خصوصی محدودند و اتصال مستقیم ورودی عمومی TCP با حالت service binding متفاوت است.
- [WebSockets در DO](https://developers.cloudflare.com/durable-objects/best-practices/websockets/): اتصال خروجی WebSocket hibernate نمی‌شود. این نکته در هزینه و ماندگاری اتصال تعیین‌کننده است.
- [Limits](https://developers.cloudflare.com/workers/platform/limits/): محدودیت شش اتصال دارای جزئیات مربوط به مرحلهٔ اتصال/انتظار پاسخ و نوع API است. آن را به «شش کاربر برای هر Worker» تبدیل نکرده‌ایم. سقف چهار stream در هر کانال محدودیت عمدی این نمونه است.
- [Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): هزینهٔ duration و پیام‌ها مطرح است؛ رایگان بودن سرویس دائمی فرض نشده است.
- [SOCKS outbound در Xray](https://xtls.github.io/en/config/outbounds/socks.html): مرز ادغام استاندارد با Agent ایران.

## برنامهٔ اجرا و پذیرش

۱. انجام‌شده: تعریف جهت اتصال، بررسی مخزنها، جایگزینی transport قبلی با کنترل جریان و نیمه‌بستن TCP.
۲. انجام‌شده: داشبورد فارسی شروع/توقف، حفظ وضعیت خاموش، heartbeat، alarm و توزیع بین کانال‌ها.
۳. انجام‌شده: ۱۸ تست خودکار، انتقال ۸ MiB و تطبیق SHA-256، کنترل پنجره، احراز هویت، ظرفیت، قطع و بازیابی، خطاهای پروتکل؛ Wrangler dry-run موفق.
۴. محدودیت محیط ساخت: `wrangler dev` با خطای `uv_interface_addresses` اجرا نشد. آزمون loopback با adapter واقعی TCP/WS جای تأیید workerd یا edge را نمی‌گیرد.
۵. نیازمند محیط شما: دامنه و TLS ایران، نشر Worker، اتصال واقعی، سپس یک inbound آزمایشی سنایی و کنترل سهمیهٔ کاربر.
۶. پس از پذیرش: آزمون طولانی‌مدت، اندازه‌گیری هزینه و سرعت با RTT واقعی، بازبینی امنیتی مستقل و تصمیم دربارهٔ ظرفیت. اگر دسترسی به همهٔ مقاصد یا UDP ضروری باشد، الزام «فقط Worker و بدون خروجی دیگر» باید دوباره ارزیابی شود.
