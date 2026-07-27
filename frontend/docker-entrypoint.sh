#!/bin/sh
set -e
envsubst '${SUPABASE_URL} ${SUPABASE_ANON_KEY} ${PHP_API_BASE} ${ML_SERVICE_URL} ${KDS_URL} ${CATALOG_URL}' \
  < /usr/share/nginx/html/env.js.template \
  > /usr/share/nginx/html/env.js
exec nginx -g 'daemon off;'
