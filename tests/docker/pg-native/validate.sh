#!/usr/bin/env bash
set -Eeuo pipefail

PG_MAJOR=${PG_MAJOR:?Set PG_MAJOR to 16 or 18}
PG_IMAGE=${PG_IMAGE:?Set PG_IMAGE to an exact PostgreSQL patch and distro tag}
PG_VERSION="$PG_MAJOR"
WORK_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/shweta-pg-native-${GITHUB_RUN_ID:-local}-${PG_MAJOR}"
SUFFIX="${GITHUB_RUN_ID:-local}-${PG_MAJOR}"
MAIN_CONTAINER="shweta-pg-native-main-${SUFFIX}"
WRONG_CA_CONTAINER="shweta-pg-native-wrong-ca-${SUFFIX}"
APP_IMAGE="shweta-pg-native-app:${SUFFIX}"
PG_MAIN_IMAGE="shweta-pg-native-postgres-main:${SUFFIX}"
PG_WRONG_CA_IMAGE="shweta-pg-native-postgres-wrong-ca:${SUFFIX}"

ADMIN_PASSWORD=$(openssl rand -hex 24)
APP_PASSWORD=$(openssl rand -hex 24)
POC_PASSWORD=$(openssl rand -hex 24)
for secret in "$ADMIN_PASSWORD" "$APP_PASSWORD" "$POC_PASSWORD"; do
  echo "::add-mask::$secret"
done

cleanup() {
  set +e
  local admin_conn="host=127.0.0.1 port=5433 dbname=postgres user=postgres sslmode=verify-full sslrootcert=$WORK_DIR/ca.crt connect_timeout=3"
  if docker inspect "$MAIN_CONTAINER" >/dev/null 2>&1 && [[ -f "$WORK_DIR/ca.crt" ]]; then
    PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 \
      -c 'DROP DATABASE IF EXISTS shweta_native_app_test WITH (FORCE);' >/dev/null 2>&1
    PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 \
      -c 'DROP DATABASE IF EXISTS shweta_native_poc_test WITH (FORCE);' >/dev/null 2>&1
    PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 \
      -c 'DROP DATABASE IF EXISTS shweta_studio_checkout_test WITH (FORCE);' >/dev/null 2>&1
    PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 \
      -c 'DROP DATABASE IF EXISTS shweta_fixture_other_test WITH (FORCE);' >/dev/null 2>&1
    PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 \
      -c 'DROP ROLE IF EXISTS shweta_native_app;' -c 'DROP ROLE IF EXISTS poc_scram_user;' \
      -c 'DROP ROLE IF EXISTS shweta_fixture_ci;' >/dev/null 2>&1
  fi
  docker rm -fv "$MAIN_CONTAINER" "$WRONG_CA_CONTAINER" >/dev/null 2>&1
  docker image rm "$APP_IMAGE" "$PG_MAIN_IMAGE" "$PG_WRONG_CA_IMAGE" >/dev/null 2>&1
  rm -rf "$WORK_DIR"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "Disposable PostgreSQL containers, roles, databases, images, passwords, and certificates were cleaned." >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -keyout "$WORK_DIR/ca.key" -out "$WORK_DIR/ca.crt" \
  -subj "/CN=Shweta Studio Disposable CI CA" \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -keyout "$WORK_DIR/wrong-ca.key" -out "$WORK_DIR/wrong-ca.crt" \
  -subj "/CN=Untrusted Shweta Studio Disposable CI CA" \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$WORK_DIR/server-main.key" -out "$WORK_DIR/server-main.csr" \
  -subj "/CN=phase6-main.neon.tech"
printf 'subjectAltName=IP:127.0.0.1,DNS:phase6-main.neon.tech\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' \
  > "$WORK_DIR/server-main.ext"
openssl x509 -req -sha256 -days 1 -in "$WORK_DIR/server-main.csr" \
  -CA "$WORK_DIR/ca.crt" -CAkey "$WORK_DIR/ca.key" -CAcreateserial \
  -extfile "$WORK_DIR/server-main.ext" -out "$WORK_DIR/server-main.crt"

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$WORK_DIR/server-wrong-ca.key" -out "$WORK_DIR/server-wrong-ca.csr" \
  -subj "/CN=phase6-wrong-ca.neon.tech"
printf 'subjectAltName=DNS:phase6-wrong-ca.neon.tech\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' \
  > "$WORK_DIR/server-wrong-ca.ext"
openssl x509 -req -sha256 -days 1 -in "$WORK_DIR/server-wrong-ca.csr" \
  -CA "$WORK_DIR/wrong-ca.crt" -CAkey "$WORK_DIR/wrong-ca.key" -CAcreateserial \
  -extfile "$WORK_DIR/server-wrong-ca.ext" -out "$WORK_DIR/server-wrong-ca.crt"
rm -f "$WORK_DIR/ca.key" "$WORK_DIR/wrong-ca.key" "$WORK_DIR/server-main.csr" \
  "$WORK_DIR/server-wrong-ca.csr" "$WORK_DIR/server-main.ext" "$WORK_DIR/server-wrong-ca.ext" \
  "$WORK_DIR/ca.srl" "$WORK_DIR/wrong-ca.srl"

cat > "$WORK_DIR/pg_hba.conf" <<'EOF'
local all all trust
hostnossl all all 0.0.0.0/0 reject
hostnossl all all ::/0 reject
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::/0 scram-sha-256
EOF
cat > "$WORK_DIR/postgres.Dockerfile" <<'EOF'
ARG PG_IMAGE
FROM ${PG_IMAGE}
ARG CERT_FILE=server.crt
ARG KEY_FILE=server.key
COPY ${CERT_FILE} /etc/ssl/certs/shweta-ci-postgres.crt
COPY ${KEY_FILE} /etc/ssl/private/shweta-ci-postgres.key
COPY pg_hba.conf /etc/postgresql/pg_hba.conf
RUN chown postgres:postgres /etc/ssl/certs/shweta-ci-postgres.crt /etc/ssl/private/shweta-ci-postgres.key /etc/postgresql/pg_hba.conf \
    && chmod 0644 /etc/ssl/certs/shweta-ci-postgres.crt /etc/postgresql/pg_hba.conf \
    && chmod 0600 /etc/ssl/private/shweta-ci-postgres.key
CMD ["postgres", "-c", "listen_addresses=*", "-c", "ssl=on", "-c", "password_encryption=scram-sha-256", "-c", "ssl_cert_file=/etc/ssl/certs/shweta-ci-postgres.crt", "-c", "ssl_key_file=/etc/ssl/private/shweta-ci-postgres.key", "-c", "hba_file=/etc/postgresql/pg_hba.conf"]
EOF

docker build -f "$WORK_DIR/postgres.Dockerfile" \
  --build-arg "PG_IMAGE=$PG_IMAGE" --build-arg CERT_FILE=server-main.crt \
  --build-arg KEY_FILE=server-main.key -t "$PG_MAIN_IMAGE" "$WORK_DIR"
docker build -f "$WORK_DIR/postgres.Dockerfile" \
  --build-arg "PG_IMAGE=$PG_IMAGE" --build-arg CERT_FILE=server-wrong-ca.crt \
  --build-arg KEY_FILE=server-wrong-ca.key -t "$PG_WRONG_CA_IMAGE" "$WORK_DIR"
docker run --detach --name "$MAIN_CONTAINER" \
  --publish 127.0.0.1:5433:5432 --publish 127.0.0.2:5433:5432 \
  --env POSTGRES_DB=shweta_studio_test --env POSTGRES_USER=postgres \
  --env "POSTGRES_PASSWORD=$ADMIN_PASSWORD" "$PG_MAIN_IMAGE"
docker run --detach --name "$WRONG_CA_CONTAINER" --publish 127.0.0.1:5434:5432 \
  --env POSTGRES_DB=postgres --env POSTGRES_USER=postgres \
  --env "POSTGRES_PASSWORD=$ADMIN_PASSWORD" "$PG_WRONG_CA_IMAGE"

admin_conn="host=127.0.0.1 port=5433 dbname=postgres user=postgres sslmode=verify-full sslrootcert=$WORK_DIR/ca.crt connect_timeout=3"
admin_psql() { PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 "$@"; }
ready=false
for attempt in $(seq 1 60); do
  if PGPASSWORD="$ADMIN_PASSWORD" psql "$admin_conn" -X -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' \
    > "$WORK_DIR/readiness.out" 2> "$WORK_DIR/readiness.err" && grep -qx '1' "$WORK_DIR/readiness.out"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  cat "$WORK_DIR/readiness.err"
  docker logs --tail 100 "$MAIN_CONTAINER"
  exit 1
fi
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$WRONG_CA_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs --tail 100 "$WRONG_CA_CONTAINER"
  exit 1
fi

admin_psql \
  -c "CREATE ROLE shweta_native_app LOGIN PASSWORD '$APP_PASSWORD' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;" \
  -c 'CREATE DATABASE shweta_native_app_test OWNER shweta_native_app;' \
  -c "CREATE ROLE poc_scram_user LOGIN PASSWORD '$POC_PASSWORD' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;" \
  -c 'CREATE DATABASE shweta_native_poc_test OWNER poc_scram_user;' \
  -c 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;'

APP_NATIVE_URL="postgresql://shweta_native_app:${APP_PASSWORD}@phase6-main.neon.tech:5433/shweta_native_app_test?sslmode=require&channel_binding=require"
APP_HOST_URL="postgresql://shweta_native_app:${APP_PASSWORD}@127.0.0.1:5433/shweta_native_app_test"
ADMIN_HOST_URL="postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:5433/shweta_studio_test?sslmode=verify-full&sslrootcert=$WORK_DIR/ca.crt"
POC_URL="postgresql://poc_scram_user:${POC_PASSWORD}@127.0.0.1:5433/shweta_native_poc_test?sslmode=verify-full&sslrootcert=$WORK_DIR/ca.crt&channel_binding=require"
POC_DOCKER_URL="postgresql://poc_scram_user:${POC_PASSWORD}@127.0.0.1:5433/shweta_native_poc_test?sslmode=verify-full&sslrootcert=/run/ci/ca.crt&channel_binding=require"
for secret_url in "$APP_NATIVE_URL" "$APP_HOST_URL" "$ADMIN_HOST_URL" "$POC_URL" "$POC_DOCKER_URL"; do
  echo "::add-mask::$secret_url"
done

echo "Building application Docker test image against pinned libpq 18.6 and Node 24.22.1."
docker build -f tests/docker/pg-native/Dockerfile -t "$APP_IMAGE" .
image_bytes=$(docker image inspect --format '{{.Size}}' "$APP_IMAGE")
image_mib=$(awk -v bytes="$image_bytes" 'BEGIN { printf "%.1f", bytes / 1048576 }')
echo "Native test image size: ${image_mib} MiB."

docker run --rm --network host \
  --add-host phase6-main.neon.tech:127.0.0.1 \
  --add-host phase6-wrong-host.neon.tech:127.0.0.1 \
  --add-host phase6-wrong-ca.neon.tech:127.0.0.1 \
  --volume "$WORK_DIR:/run/ci:ro" \
  --env CI=true --env NODE_ENV=test --env PG_VERSION="$PG_VERSION" \
  --env DATABASE_PROVIDER=neon --env DATABASE_DRIVER=pg-native \
  --env "DATABASE_URL=$APP_NATIVE_URL" \
  --env "PG_NATIVE_ADAPTER_DATABASE_URL=$APP_NATIVE_URL" \
  --env "PG_NATIVE_ADAPTER_WRONG_HOST=phase6-wrong-host.neon.tech" \
  --env "PG_NATIVE_ADAPTER_WRONG_CA_HOST=phase6-wrong-ca.neon.tech" \
  --env PG_NATIVE_ADAPTER_WRONG_CA_PORT=5434 \
  --env "NODE_EXTRA_CA_CERTS=/run/ci/ca.crt" \
  --env "PG_NATIVE_POC_DATABASE_URL=$POC_DOCKER_URL" \
  --env "PG_NATIVE_POC_CA_FILE=/run/ci/ca.crt" \
  --env "PG_NATIVE_POC_WRONG_CA_FILE=/run/ci/wrong-ca.crt" \
  --env PG_NATIVE_POC_PASSWORD="$POC_PASSWORD" \
  --env PG_NATIVE_POC_SERVER_KEY=/run/ci/server-main.key \
  --env PG_NATIVE_POC_SERVER_CERT=/run/ci/server-main.crt \
  --entrypoint /bin/bash "$APP_IMAGE" -lc '
    set -euo pipefail
    cp /run/ci/ca.crt /usr/local/share/ca-certificates/shweta-phase6-ci.crt
    update-ca-certificates
    pg_config --version
    pkg-config --modversion libpq
    libpq_entry="$(node -p "require.resolve(\"libpq\")")"
    addon="${libpq_entry%/index.js}/build/Release/addon.node"
    ldd "$addon"
    ! ldd "$addon" | grep -q "not found"
    npm run db:migrate
    npm run test:postgres-native-adapter
    PG_NATIVE_POC_SUITE=pg-native node tests/pg-native-channel-binding-poc.test.js
    unset DATABASE_URL MIGRATION_DATABASE_URL
    PG_NATIVE_ADAPTER_CI=true PG_NATIVE_ADAPTER_HOST=phase6-main.neon.tech \
      TEST_DATABASE_URL="postgres://postgres:'"$ADMIN_PASSWORD"'@127.0.0.1:5433/shweta_studio_test?sslmode=verify-full&sslrootcert=/run/ci/ca.crt" \
      npm run test:staging-fixture-postgres
    PG_NATIVE_ADAPTER_CI=true TEST_DATABASE_URL="postgres://postgres:'"$ADMIN_PASSWORD"'@127.0.0.1:5433/shweta_native_app_test?sslmode=verify-full&sslrootcert=/run/ci/ca.crt" \
      npm run test:webhook-postgres
  '

echo "Running full application, database, TLS, and fixture regressions with Node pg (default driver)."
CI=true NODE_ENV=test PGSSLMODE=require NODE_EXTRA_CA_CERTS="$WORK_DIR/ca.crt" \
  TEST_DATABASE_URL="$APP_HOST_URL" npm run test:all
CI=true PGSSLMODE=require NODE_EXTRA_CA_CERTS="$WORK_DIR/ca.crt" \
  TEST_DATABASE_URL="$APP_HOST_URL" INVALID_TEST_CA_FILE="$WORK_DIR/wrong-ca.crt" \
  npm run test:db-connection-tls
CI=true PGSSLMODE=require NODE_EXTRA_CA_CERTS="$WORK_DIR/ca.crt" \
  TEST_DATABASE_URL="$ADMIN_HOST_URL" npm run test:staging-fixture-postgres

echo "Running mandatory strict pg-native PLUS and downgrade checks against the disposable PostgreSQL peer."
CI=true NODE_ENV=test PG_NATIVE_POC_SUITE=pg-native \
  PG_NATIVE_POC_DATABASE_URL="$POC_URL" \
  PG_NATIVE_POC_CA_FILE="$WORK_DIR/ca.crt" \
  PG_NATIVE_POC_WRONG_CA_FILE="$WORK_DIR/wrong-ca.crt" \
  PG_NATIVE_POC_PASSWORD="$POC_PASSWORD" \
  PG_NATIVE_POC_SERVER_KEY="$WORK_DIR/server-main.key" \
  PG_NATIVE_POC_SERVER_CERT="$WORK_DIR/server-main.crt" \
  node tests/pg-native-channel-binding-poc.test.js

echo "Running Chromium browser verification."
CI=true NODE_ENV=test ALLOW_DEMO_CHECKOUT=true \
  DATA_DIR="${DATA_DIR:-$WORK_DIR/browser-data}" \
  node tests/test-complete-verification.js

echo "Native CI validation completed for PostgreSQL ${PG_MAJOR}; test image ${image_mib} MiB."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### pg-native Docker validation — PostgreSQL ${PG_MAJOR}"
    echo
    echo "- Application test image: ${image_mib} MiB"
    echo "- Node image tag: 24.22.1-bookworm-slim"
    echo "- Application image libpq: 18.6"
    echo "- Adapter, POC downgrade, inventory, webhook, fixture, TLS, schema, payment, and security checks passed."
  } >> "$GITHUB_STEP_SUMMARY"
fi
