// ============================================================
// Cloudflare Worker — worker/index.js
// النسخة الكاملة — جاهز للإنتاج
// ============================================================
// متغيرات البيئة المطلوبة في Settings → Variables:
//
//   SUPABASE_URL            = https://XXXX.supabase.co
//   SUPABASE_KEY            = service_role key (من Supabase Settings → API)
//   CLOUDINARY_CLOUD_NAME   = اسم الـ cloud من Cloudinary Dashboard
//   CLOUDINARY_API_KEY      = API Key من Cloudinary
//   CLOUDINARY_API_SECRET   = API Secret من Cloudinary
//   RESEND_API_KEY          = مفتاح Resend (من resend.com)
//   RESEND_FROM_EMAIL       = noreply@yourdomain.com (دومين تحققت منه في Resend)
//   TURNSTILE_SECRET_KEY    = Secret Key من Cloudflare Turnstile Dashboard
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // ---- التوجيه ----
      if (path.startsWith('/site/'))                return serveSite(path, env, cors);
      if (path === '/api/cloudinary-signature')      return cloudinarySignature(request, env, cors);
      if (path === '/api/send-welcome')             return sendWelcome(request, env, cors);
      if (path === '/api/send-trial-reminder')      return sendTrialReminder(request, env, cors);
      if (path === '/api/verify-turnstile')         return verifyTurnstile(request, env, cors);
      if (path === '/api/clinic/')                  return getClinicJson(path, env, cors);
      return new Response(homePage(), { headers: { 'Content-Type': 'text/html;charset=utf-8', ...cors } });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, cors);
    }
  }
};

// ============================================================
// Supabase: طلب مساعد
// ============================================================
async function supabaseFetch(path, env, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {})
    }
  });
  return res.json();
}

// ============================================================
// التحقق من JWT الخاص بـ Supabase
// ============================================================
async function getAuthUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return null;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${token}`
    }
  });
  if (!res.ok) return null;
  return res.json();
}

// ============================================================
// 1. عرض موقع العيادة للزوار
// ============================================================
async function serveSite(path, env, cors) {
  const subdomain = path.replace('/site/', '').replace(/\/$/, '');

  const rows = await supabaseFetch(
    `/clinics?subdomain=eq.${subdomain}&is_published=eq.true&select=*`,
    env
  );
  const clinic = rows?.[0];

  if (!clinic) return new Response(notFoundPage(), {
    status: 404,
    headers: { 'Content-Type': 'text/html;charset=utf-8', ...cors }
  });

  // التحقق من الاشتراك
  const subStatus = clinic.subscription_status;
  const trialEnd  = clinic.trial_ends_at ? new Date(clinic.trial_ends_at) : null;
  const now       = new Date();

  const isExpired =
    subStatus === 'expired' ||
    subStatus === 'cancelled' ||
    (subStatus === 'trial' && trialEnd && now > trialEnd);

  if (isExpired) return new Response(expiredPage(clinic.clinic_name), {
    status: 402,
    headers: { 'Content-Type': 'text/html;charset=utf-8', ...cors }
  });

  return new Response(buildSiteHTML(clinic), {
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...cors
    }
  });
}

// ============================================================
// 2. توليد توقيع Cloudinary للرفع المباشر
// ============================================================
async function cloudinarySignature(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return jsonResponse({ error: 'غير مصرح' }, 401, cors);

  const { folder } = await request.json();
  const timestamp  = Math.round(Date.now() / 1000).toString();
  const safeFolder = folder || `clinics/${user.id}`;

  // بناء نص التوقيع: يجب ترتيب المفاتيح أبجدياً
  const paramsToSign = { folder: safeFolder, timestamp };
  const signStr = Object.keys(paramsToSign).sort()
    .map(k => `${k}=${paramsToSign[k]}`)
    .join('&') + env.CLOUDINARY_API_SECRET;

  const signature = await sha1(signStr);

  return jsonResponse({
    signature,
    timestamp,
    api_key:    env.CLOUDINARY_API_KEY,
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    folder:     safeFolder
  }, 200, cors);
}

// SHA-1 عبر Web Crypto API (متاح في Cloudflare Workers)
async function sha1(str) {
  const buf  = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// 3. إيميل الترحيب عبر Resend
// ============================================================
async function sendWelcome(request, env, cors) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: 'البريد مطلوب' }, 400, cors);

  const result = await sendEmail(env, {
    to:      email,
    subject: '🏥 مرحباً بك في عيادتي!',
    html:    welcomeEmailHTML(email)
  });

  return jsonResponse({ sent: result }, 200, cors);
}

// ============================================================
// 4. إيميل تذكير انتهاء التجربة
// ============================================================
async function sendTrialReminder(request, env, cors) {
  const { email, daysLeft } = await request.json();
  if (!email) return jsonResponse({ error: 'البريد مطلوب' }, 400, cors);

  const result = await sendEmail(env, {
    to:      email,
    subject: `⏰ تبقّى ${daysLeft} أيام فقط على انتهاء تجربتك`,
    html:    trialReminderEmailHTML(email, daysLeft)
  });

  return jsonResponse({ sent: result }, 200, cors);
}

// دالة إرسال Resend المساعدة
async function sendEmail(env, { to, subject, html }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    env.RESEND_FROM_EMAIL || 'noreply@clinic-saas.com',
        to:      [to],
        subject,
        html
      })
    });
    return res.ok;
  } catch { return false; }
}

// ============================================================
// 5. التحقق من Cloudflare Turnstile
// ============================================================
async function verifyTurnstile(request, env, cors) {
  const { token } = await request.json();
  if (!token) return jsonResponse({ success: false }, 400, cors);

  const formData = new FormData();
  formData.append('secret',   env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);

  const res  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body:   formData
  });
  const data = await res.json();
  return jsonResponse({ success: data.success === true }, 200, cors);
}

// ============================================================
// 6. بيانات العيادة JSON
// ============================================================
async function getClinicJson(path, env, cors) {
  const subdomain = path.replace('/api/clinic/', '');
  const rows = await supabaseFetch(
    `/clinics?subdomain=eq.${subdomain}&is_published=eq.true&select=*`, env
  );
  const clinic = rows?.[0];
  if (!clinic) return jsonResponse({ error: 'not found' }, 404, cors);
  const { user_id, subscription_status, trial_ends_at, ...pub } = clinic;
  return jsonResponse(pub, 200, cors);
}

// ============================================================
// مساعد JSON
// ============================================================
function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

// ============================================================
// بناء HTML موقع العيادة
// ============================================================
function buildSiteHTML(c) {
  const t = {
    blue:  { primary:'#1a56db', tag:'#dbeafe', tagText:'#1e40af' },
    green: { primary:'#057a55', tag:'#dcfce7', tagText:'#166534' },
    dark:  { primary:'#1f2937', tag:'#e5e7eb', tagText:'#374151' },
  }[c.template_id] || { primary:'#1a56db', tag:'#dbeafe', tagText:'#1e40af' };

  const services = c.services
    ? c.services.split(',').map(s => s.trim()).filter(Boolean) : [];
  const wa = c.whatsapp ? c.whatsapp.replace(/\D/g, '') : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${c.clinic_name || 'العيادة'} — ${c.doctor_name || ''}</title>
  <meta name="description" content="${c.specialty || ''} — ${c.city || ''}">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#1e293b;background:#f8fafc}
    .hero{background:${t.primary};color:#fff;padding:3rem 1.5rem 2.5rem;text-align:center}
    .hero img{max-height:80px;margin-bottom:1rem;border-radius:8px}
    .hero h1{font-size:2rem;margin-bottom:6px}
    .hero p{font-size:1rem;opacity:.9}
    .container{max-width:700px;margin:0 auto;padding:0 1rem}
    section{margin:2rem 0}
    h2{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${t.primary};margin-bottom:.75rem}
    .about{font-size:.95rem;color:#475569;line-height:1.8}
    .services{display:flex;flex-wrap:wrap;gap:8px}
    .tag{padding:7px 16px;background:${t.tag};color:${t.tagText};border-radius:20px;font-size:.875rem;font-weight:500}
    .contact-item{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;font-size:.9rem;text-decoration:none;color:#1e293b;margin-bottom:8px;transition:border-color .2s}
    .contact-item:hover{border-color:${t.primary}}
    .wa-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;background:#25d366;color:#fff;border-radius:14px;text-decoration:none;font-size:1.1rem;font-weight:700;margin:2rem 0}
    footer{text-align:center;padding:1.5rem;font-size:.75rem;color:#94a3b8;border-top:1px solid #e2e8f0;margin-top:2rem}
  </style>
</head>
<body>
<div class="hero">
  ${c.logo_url ? `<img src="${c.logo_url}" alt="${c.clinic_name}">` : ''}
  <h1>${c.clinic_name || ''}</h1>
  <p>${c.doctor_name || ''}${c.specialty?' — '+c.specialty:''}${c.city?' | '+c.city:''}</p>
</div>
<div class="container">
  ${c.about?`<section><h2>عن العيادة</h2><p class="about">${c.about}</p></section>`:''}
  ${services.length?`<section><h2>خدماتنا</h2><div class="services">${services.map(s=>`<span class="tag">${s}</span>`).join('')}</div></section>`:''}
  <section>
    <h2>تواصل معنا</h2>
    ${c.phone?`<a class="contact-item" href="tel:${c.phone}">📞 ${c.phone}</a>`:''}
    ${c.address?`<div class="contact-item">📍 ${c.address}${c.city?'، '+c.city:''}</div>`:''}
    ${c.working_hours?`<div class="contact-item">🕐 ${c.working_hours}</div>`:''}
    ${wa?`<a class="wa-btn" href="https://wa.me/${wa}">💬 احجز موعدك عبر واتساب</a>`:''}
  </section>
</div>
<footer>موقع ${c.clinic_name||''} — مدعوم بـ عيادتي</footer>
</body></html>`;
}

// ============================================================
// قوالب الإيميلات
// ============================================================
function welcomeEmailHTML(email) {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;direction:rtl;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#1a56db;padding:2rem;text-align:center;color:#fff">
      <h1 style="margin:0;font-size:1.5rem">🏥 مرحباً بك في عيادتي!</h1>
    </div>
    <div style="padding:2rem;color:#1e293b">
      <p style="font-size:1rem;margin-bottom:1rem">أهلاً وسهلاً،</p>
      <p style="color:#475569;line-height:1.7;margin-bottom:1.5rem">
        حسابك جاهز الآن. لديك <strong>14 يوماً مجاناً</strong> لاستكشاف كل مميزات منصة عيادتي وإنشاء موقعك الاحترافي.
      </p>
      <div style="background:#f0f9ff;border-radius:10px;padding:1rem;margin-bottom:1.5rem">
        <p style="font-weight:600;margin-bottom:.5rem;color:#0369a1">ابدأ بهذه الخطوات:</p>
        <p style="color:#475569;font-size:.9rem;line-height:1.8">
          1️⃣ اختر قالباً يناسب تخصصك<br>
          2️⃣ أضف بيانات عيادتك والخدمات<br>
          3️⃣ ارفع شعار العيادة<br>
          4️⃣ انشر موقعك وشاركه مع مرضاك
        </p>
      </div>
      <div style="text-align:center">
        <a href="${'https://your-github-pages-url.github.io/clinic-saas/dashboard.html'}"
           style="display:inline-block;padding:12px 32px;background:#1a56db;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">
          ابدأ الآن →
        </a>
      </div>
    </div>
    <div style="background:#f8fafc;padding:1rem;text-align:center;font-size:.8rem;color:#94a3b8">
      عيادتي — منصة المواقع الطبية الاحترافية
    </div>
  </div>`;
}

function trialReminderEmailHTML(email, daysLeft) {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;direction:rtl;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#d97706;padding:2rem;text-align:center;color:#fff">
      <h1 style="margin:0;font-size:1.5rem">⏰ تبقّى ${daysLeft} أيام فقط!</h1>
    </div>
    <div style="padding:2rem;color:#1e293b">
      <p style="color:#475569;line-height:1.7;margin-bottom:1.5rem">
        تجربتك المجانية ستنتهي خلال <strong>${daysLeft} أيام</strong>. فعّل اشتراكك الآن للاستمرار بدون انقطاع.
      </p>
      <div style="text-align:center">
        <a href="${'https://your-github-pages-url.github.io/clinic-saas/dashboard.html'}"
           style="display:inline-block;padding:12px 32px;background:#d97706;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">
          فعّل اشتراكك الآن →
        </a>
      </div>
    </div>
    <div style="background:#f8fafc;padding:1rem;text-align:center;font-size:.8rem;color:#94a3b8">
      عيادتي — يمكنك إلغاء الاشتراك في أي وقت
    </div>
  </div>`;
}

// ============================================================
// صفحة انتهاء الاشتراك
// ============================================================
function expiredPage(clinicName) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>الاشتراك منتهي</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:4rem 1rem;color:#1e293b;background:#fef9f0}
.box{max-width:400px;margin:0 auto;background:#fff;border-radius:16px;padding:2rem;border:1px solid #fde68a}
h1{color:#d97706;margin-bottom:1rem}p{color:#92400e;line-height:1.7}</style></head>
<body><div class="box">
<h1>⏰ الاشتراك منتهٍ</h1>
<p>موقع <strong>${clinicName || 'هذه العيادة'}</strong> غير متاح حالياً بسبب انتهاء الاشتراك.</p>
<p style="margin-top:1rem;font-size:.875rem">إذا كنت صاحب العيادة، يرجى تسجيل الدخول وتجديد اشتراكك.</p>
</div></body></html>`;
}

// ============================================================
// صفحات مساعدة
// ============================================================
function notFoundPage() {
  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>غير موجود</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:4rem;color:#475569}</style></head>
<body><h1>🏥 العيادة غير موجودة</h1><p>تأكد من صحة الرابط.</p></body></html>`;
}

function homePage() {
  return `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>عيادتي API</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:4rem;color:#1e293b}
h1{color:#1a56db}code{background:#f1f5f9;padding:4px 10px;border-radius:6px;font-size:.875rem}
.routes{display:inline-block;text-align:right;margin-top:1.5rem;background:#f8fafc;padding:1rem 1.5rem;border-radius:12px}
.route{margin:.4rem 0;font-size:.9rem;color:#475569}</style></head>
<body>
<h1>🏥 عيادتي — Worker</h1>
<p>يعمل بنجاح ✅</p>
<div class="routes">
  <div class="route"><code>GET  /site/:subdomain</code> — موقع العيادة</div>
  <div class="route"><code>POST /api/cloudinary-signature</code> — توقيع الرفع</div>
  <div class="route"><code>POST /api/send-welcome</code> — إيميل ترحيب</div>
  <div class="route"><code>POST /api/send-trial-reminder</code> — تذكير التجربة</div>
  <div class="route"><code>POST /api/verify-turnstile</code> — التحقق من البشر</div>
</div>
</body></html>`;
}
