-- ══════════════════════════════════════════════════════════════
-- LAO ມາເກັດ — Supabase SQL Schema
-- วาง SQL ทั้งหมดนี้ใน: Supabase Dashboard → SQL Editor → New Query → Run
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────
-- 1. PROFILES (ข้อมูลผู้ใช้งาน)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email      TEXT,
  full_name  TEXT,
  phone      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────
-- 2. WALLETS (กระเป๋าเงิน)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  balance    DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────
-- 3. WALLET_TRANSACTIONS (ประวัติการเงิน)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('topup_request','topup','purchase','sale','refund','commission','withdrawal')),
  amount     DECIMAL(15,2) NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wt_user ON wallet_transactions(user_id, created_at DESC);

-- ─────────────────────────────────────
-- 4. TOPUP_REQUESTS (คำขอเติมเงิน — Admin จัดการ)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS topup_requests (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  amount     DECIMAL(15,2) NOT NULL,
  method     TEXT DEFAULT 'qr_bcel',
  status     TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────
-- 5. SELLERS (ร้านค้าที่ผ่านการอนุมัติ)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sellers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  shop_name       TEXT NOT NULL,
  commission_rate DECIMAL(5,4) NOT NULL DEFAULT 0.05,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────
-- 6. SELLER_APPLICATIONS (ใบสมัครผู้ขาย)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS seller_applications (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name    TEXT NOT NULL,
  shop_name    TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,
  house        TEXT,
  village      TEXT,
  city         TEXT NOT NULL,
  province     TEXT NOT NULL,
  category     TEXT NOT NULL,
  bank_name    TEXT NOT NULL,
  bank_account TEXT NOT NULL,
  bio          TEXT,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────
-- 7. PRODUCTS (สินค้า)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id        UUID REFERENCES sellers(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  type             TEXT DEFAULT 'general' CHECK (type IN ('game_id','topup','general')),
  game             TEXT CHECK (game IN ('free_fire','rov','ml','pubg','cod','cs2') OR game IS NULL),
  price            DECIMAL(15,2) NOT NULL CHECK (price > 0),
  old_price        DECIMAL(15,2),
  tags             TEXT[] DEFAULT '{}',
  game_rank        TEXT,
  game_server      TEXT,
  game_diamonds    INTEGER,
  game_skins_count INTEGER,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prod_active ON products(is_active, type, game);

-- ─────────────────────────────────────
-- 8. ORDERS (คำสั่งซื้อ — Escrow)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  seller_id            UUID REFERENCES sellers(id) ON DELETE SET NULL,
  product_id           UUID REFERENCES products(id) ON DELETE SET NULL,
  amount               DECIMAL(15,2) NOT NULL,
  status               TEXT DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','delivered','completed','disputed','refunded')),
  note                 TEXT,
  guarantee_expires_at TIMESTAMPTZ,
  commission_rate      DECIMAL(5,4) DEFAULT 0.05,
  commission_amount    DECIMAL(15,2),
  id_confirmed         BOOLEAN DEFAULT FALSE,
  dispute_reason       TEXT,
  dispute_note         TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- RPC FUNCTIONS (Atomic wallet operations)
-- ══════════════════════════════════════════════════════════════

-- หักเงิน Wallet (ตรวจ balance ก่อนหัก — atomic)
CREATE OR REPLACE FUNCTION decrement_wallet_balance(p_user_id UUID, p_amount DECIMAL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_balance DECIMAL;
BEGIN
  SELECT balance INTO current_balance FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF current_balance IS NULL THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;
  IF current_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance: have %, need %', current_balance, p_amount;
  END IF;
  UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$;

-- เพิ่มเงิน Wallet
CREATE OR REPLACE FUNCTION increment_wallet_balance(p_user_id UUID, p_amount DECIMAL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO wallets (user_id, balance, updated_at)
  VALUES (p_user_id, p_amount, NOW())
  ON CONFLICT (user_id) DO UPDATE
    SET balance = wallets.balance + p_amount, updated_at = NOW();
END;
$$;

-- Admin: อนุมัติ topup request
CREATE OR REPLACE FUNCTION approve_topup(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  req topup_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM topup_requests WHERE id = p_request_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already processed'; END IF;

  PERFORM increment_wallet_balance(req.user_id, req.amount);

  UPDATE topup_requests SET status = 'approved', updated_at = NOW() WHERE id = p_request_id;

  INSERT INTO wallet_transactions(user_id, type, amount, note)
  VALUES (req.user_id, 'topup', req.amount, 'ເຕີມຜ່ານ ' || req.method);
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ══════════════════════════════════════════════════════════════

-- Profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_own" ON profiles;
CREATE POLICY "profiles_own" ON profiles FOR ALL USING (auth.uid() = id);

-- Wallets
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallets_own" ON wallets;
CREATE POLICY "wallets_own" ON wallets FOR ALL USING (auth.uid() = user_id);

-- Wallet Transactions
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wt_own" ON wallet_transactions;
CREATE POLICY "wt_own" ON wallet_transactions FOR ALL USING (auth.uid() = user_id);

-- Topup Requests
ALTER TABLE topup_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "topup_own" ON topup_requests;
CREATE POLICY "topup_own" ON topup_requests FOR ALL USING (auth.uid() = user_id);

-- Orders
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orders_own" ON orders;
CREATE POLICY "orders_own" ON orders FOR ALL USING (auth.uid() = user_id);

-- Products — public read, seller write
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "products_public_read" ON products;
DROP POLICY IF EXISTS "products_seller_write" ON products;
CREATE POLICY "products_public_read" ON products FOR SELECT USING (is_active = TRUE);
CREATE POLICY "products_seller_write" ON products FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM sellers WHERE id = seller_id AND user_id = auth.uid()));

-- Sellers — public read
ALTER TABLE sellers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sellers_public_read" ON sellers;
CREATE POLICY "sellers_public_read" ON sellers FOR SELECT USING (is_active = TRUE);

-- Seller Applications — user can insert
ALTER TABLE seller_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "seller_app_insert" ON seller_applications;
CREATE POLICY "seller_app_insert" ON seller_applications FOR INSERT WITH CHECK (TRUE);

-- ══════════════════════════════════════════════════════════════
-- REALTIME (enable for wallet live updates)
-- ══════════════════════════════════════════════════════════════
ALTER PUBLICATION supabase_realtime ADD TABLE wallets;

-- ══════════════════════════════════════════════════════════════
-- SAMPLE DATA (สินค้าตัวอย่าง — ลบออกก่อน launch จริง)
-- ══════════════════════════════════════════════════════════════

-- สร้าง seller ตัวอย่างก่อน (ไม่มี user_id เพื่อ demo)
INSERT INTO sellers (id, shop_name, commission_rate, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'GamingLao Shop', 0.05, true),
  ('00000000-0000-0000-0000-000000000002', 'LAO ID Store', 0.05, true)
ON CONFLICT (id) DO NOTHING;

-- สินค้าตัวอย่าง
INSERT INTO products (seller_id, name, type, game, price, old_price, tags, game_rank, game_server, game_diamonds)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Free Fire TH Level 60 Full Skin', 'game_id', 'free_fire', 150000, 200000, ARRAY['HOT','สกิน'], 'Heroic', 'TH', 8500),
  ('00000000-0000-0000-0000-000000000001', 'Free Fire SEA Ranked Master', 'game_id', 'free_fire', 280000, NULL, ARRAY['NEW'], 'Master', 'SEA', 15000),
  ('00000000-0000-0000-0000-000000000002', 'ROV TH Legend+ Full Hero', 'game_id', 'rov', 350000, 420000, ARRAY['HOT'], 'Legend+', 'TH', NULL),
  ('00000000-0000-0000-0000-000000000002', 'Mobile Legends S30 Mythic', 'game_id', 'ml', 220000, 260000, ARRAY['HOT'], 'Mythic', 'SEA', 12000),
  ('00000000-0000-0000-0000-000000000001', 'PUBG Mobile TH Conqueror', 'game_id', 'pubg', 400000, NULL, ARRAY['RARE'], 'Conqueror', 'TH', NULL),
  ('00000000-0000-0000-0000-000000000002', 'CS2 Global Elite 1500h', 'game_id', 'cs2', 500000, 600000, ARRAY['RARE'], 'Global Elite', 'Asia', NULL),
  ('00000000-0000-0000-0000-000000000001', 'เติม Free Fire 520 Diamonds', 'topup', 'free_fire', 85000, NULL, ARRAY[], NULL, NULL, 520),
  ('00000000-0000-0000-0000-000000000002', 'เติม Mobile Legends 250 Diamonds', 'topup', 'ml', 45000, NULL, ARRAY[], NULL, NULL, 250)
ON CONFLICT DO NOTHING;
