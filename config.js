// ============================================
// config.js — الإعدادات المشتركة
// عدّل هذا الملف بمعلوماتك من Supabase
// ============================================

// 1. افتح https://supabase.com/dashboard
// 2. اختر مشروعك → Settings → API
// 3. انسخ "Project URL" و "anon public key"

const SUPABASE_URL  = 'https://XXXXXXXXXXXXXXXX.supabase.co';  // ← عدّل هذا
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'; // ← عدّل هذا

// رابط الـ Worker على Cloudflare (ستضيفه لاحقاً)
const WORKER_URL = 'https://clinic-sites.YOUR-SUBDOMAIN.workers.dev';
