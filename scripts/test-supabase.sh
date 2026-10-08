#!/usr/bin/env bash
# Run the Supabase integration tests against the local Supabase stack (needs Docker).
#   npx supabase start   # once; applies supabase/migrations
#   npm run test:supabase
set -euo pipefail
SUPABASE_BIN="$(command -v supabase || echo "npx supabase")"
eval "$($SUPABASE_BIN status -o env 2>/dev/null | sed 's/^/export SB_/')"
export SUPABASE_TEST_URL="$SB_API_URL"
export SUPABASE_TEST_SERVICE_ROLE_KEY="$SB_SERVICE_ROLE_KEY"
export SUPABASE_TEST_ANON_KEY="$SB_ANON_KEY"
export SUPABASE_TEST_DB_URL="$SB_DB_URL"
export SUPABASE_TEST_MAILPIT_URL="${SB_MAILPIT_URL:-${SB_INBUCKET_URL:-}}"
exec npx vitest run tests/integration
