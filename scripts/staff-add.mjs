#!/usr/bin/env node
// Bootstrap (or re-activate) a staff member — needed once, for the first staff account.
// After that, staff can add each other in /admin → 설정.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run staff:add -- someone@example.org "이름"
//
// Creates a confirmed Supabase Auth user (public signup stays disabled) and an ACTIVE row in
// public.staff_members via the audited ftl_staff_upsert function (actor = system).
import { createClient } from "@supabase/supabase-js";

const [email, displayName] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!email || !displayName || !url || !key) {
  console.error(
    'usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run staff:add -- <email> "<display name>"',
  );
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const normalized = email.trim().toLowerCase();

let userId = null;
const created = await db.auth.admin.createUser({ email: normalized, email_confirm: true });
if (created.data.user) {
  userId = created.data.user.id;
} else {
  for (let page = 1; page <= 50 && !userId; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    userId = data.users.find((u) => u.email?.toLowerCase() === normalized)?.id ?? null;
    if (data.users.length < 200) break;
  }
}
if (!userId) {
  console.error("Could not create or find the auth user:", created.error?.message);
  process.exit(1);
}

const { data, error } = await db.rpc("ftl_staff_upsert", {
  p_user_id: userId,
  p_email: normalized,
  p_display_name: displayName,
  p_active: true,
  p_actor_id: null,
});
if (error) {
  console.error("Could not add to staff_members:", error.message);
  process.exit(1);
}
console.log(
  `Staff ready: ${data[0].email} (${data[0].display_name}) — log in at /admin/login with an emailed code.`,
);
