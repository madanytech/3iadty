-- ============================================
-- منصة عيادتي - Supabase Schema
-- الخطوة 1: انسخ هذا الكود في Supabase SQL Editor
-- ============================================

-- جدول العيادات (البيانات الرئيسية لكل عميل)
create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,

  -- معلومات العيادة الأساسية
  clinic_name text not null default '',
  doctor_name text not null default '',
  specialty text not null default '',
  phone text default '',
  whatsapp text default '',
  address text default '',
  city text default '',
  about text default '',

  -- الخدمات (قائمة نصية مفصولة بفاصلة)
  services text default '',

  -- ساعات العمل
  working_hours text default 'السبت - الخميس: 9 صباحاً - 9 مساءً',

  -- المظهر
  template_id text default 'blue',
  logo_url text default '',
  primary_color text default '#1a56db',

  -- رابط الموقع
  subdomain text unique,

  -- حالة الاشتراك
  subscription_status text default 'trial'
    check (subscription_status in ('trial','active','cancelled','expired')),
  trial_ends_at timestamptz default (now() + interval '14 days'),

  -- النشر
  is_published boolean default false,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- جدول القوالب
create table public.templates (
  id text primary key,
  name_ar text not null,
  description_ar text,
  primary_color text not null,
  is_active boolean default true
);

insert into public.templates (id, name_ar, description_ar, primary_color) values
  ('blue',  'الأزرق الكلاسيكي',  'احترافي وهادئ - مناسب لجميع التخصصات', '#1a56db'),
  ('green', 'الأخضر الصحي',      'طبيعي وودود - مناسب لأطباء الأطفال',    '#057a55'),
  ('dark',  'الداكن الفاخر',     'أنيق ومميز - مناسب لعيادات التجميل',    '#1f2937');

-- ============================================
-- Row Level Security (أمان البيانات)
-- كل عميل يرى بياناته فقط
-- ============================================

alter table public.clinics enable row level security;

create policy "المستخدم يرى عيادته فقط"
  on clinics for select using (auth.uid() = user_id);

create policy "المستخدم ينشئ عيادته"
  on clinics for insert with check (auth.uid() = user_id);

create policy "المستخدم يعدّل عيادته"
  on clinics for update using (auth.uid() = user_id);

-- القوالب مرئية للجميع
alter table public.templates enable row level security;
create policy "القوالب مرئية للجميع" on templates for select using (true);

-- ============================================
-- تحديث updated_at تلقائياً
-- ============================================

create or replace function handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger clinics_updated_at
  before update on clinics
  for each row execute function handle_updated_at();

-- ============================================
-- دالة مساعدة: إنشاء عيادة جديدة عند التسجيل
-- ============================================

create or replace function public.create_clinic_on_signup()
returns trigger language plpgsql security definer as $$
begin
  insert into public.clinics (user_id, subdomain)
  values (
    new.id,
    'clinic-' || substr(replace(new.id::text, '-', ''), 1, 8)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.create_clinic_on_signup();
