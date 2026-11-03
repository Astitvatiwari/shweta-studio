FROM node:24.22.1-bookworm-slim

ARG LIBPQ_PACKAGE_VERSION=18.6-1.pgdg12+2
ARG LIBPQ_EXPECTED_VERSION=18.6
ARG LIBPQ_MINIMUM_MAJOR=16
ENV PG_CONFIG=/usr/bin/pg_config
ENV NODE_ENV=test
WORKDIR /workspace

# pg-native's libpq addon is built against these headers and links to the
# same versioned libpq shared library retained in this test-only image.
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends ca-certificates curl gnupg python3 make g++ pkg-config; \
    curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc; \
    actual_fingerprint="$(gpg --show-keys --with-colons /tmp/pgdg.asc | awk -F: '$1 == "fpr" { print $10; exit }')"; \
    test "$actual_fingerprint" = B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8; \
    gpg --dearmor -o /usr/share/keyrings/pgdg.gpg /tmp/pgdg.asc; \
    echo 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      "libpq-dev=${LIBPQ_PACKAGE_VERSION}" "libpq5=${LIBPQ_PACKAGE_VERSION}"; \
    selected_pg_config="$(command -v pg_config)"; \
    test -n "$selected_pg_config"; \
    test -x "$selected_pg_config"; \
    test "$selected_pg_config" = "$PG_CONFIG"; \
    test -x "$PG_CONFIG"; \
    pg_config_real="$(readlink -f "$PG_CONFIG")"; \
    pg_config_bindir="$("$PG_CONFIG" --bindir)"; \
    test -n "$pg_config_bindir"; \
    test "$pg_config_bindir" != "$(dirname "$pg_config_real")"; \
    version_output="$("$PG_CONFIG" --version)"; \
    printf '%s\n' "$version_output"; \
    parse_approved_version() { \
      case "$1" in \
        "PostgreSQL ${LIBPQ_EXPECTED_VERSION}"|"PostgreSQL ${LIBPQ_EXPECTED_VERSION} (Debian ${LIBPQ_PACKAGE_VERSION})") printf '%s\n' "$LIBPQ_EXPECTED_VERSION" ;; \
        *) return 1 ;; \
      esac; \
    }; \
    actual_version="$(parse_approved_version "$version_output")"; \
    test "$(parse_approved_version "PostgreSQL ${LIBPQ_EXPECTED_VERSION}")" = "$LIBPQ_EXPECTED_VERSION"; \
    test "$(parse_approved_version "PostgreSQL ${LIBPQ_EXPECTED_VERSION} (Debian ${LIBPQ_PACKAGE_VERSION})")" = "$LIBPQ_EXPECTED_VERSION"; \
    if parse_approved_version 'PostgreSQL 99.99 (unapproved build)' >/dev/null 2>&1; then echo 'Rejected unapproved libpq version unexpectedly passed.' >&2; exit 1; fi; \
    actual_major="${actual_version%%.*}"; \
    test "$actual_major" -ge "$LIBPQ_MINIMUM_MAJOR"; \
    test "$pg_config_bindir" = "/usr/lib/postgresql/${actual_major}/bin"; \
    test "$(pkg-config --modversion libpq)" = "$LIBPQ_EXPECTED_VERSION"; \
    test "$(dpkg-query -W -f='${Version}' libpq-dev)" = "$LIBPQ_PACKAGE_VERSION"; \
    test "$(dpkg-query -W -f='${Version}' libpq5)" = "$LIBPQ_PACKAGE_VERSION"; \
    includedir="$("$PG_CONFIG" --includedir)"; \
    libdir="$("$PG_CONFIG" --libdir)"; \
    test -f "$includedir/libpq-fe.h"; \
    test -d "$libdir"; \
    expected_libpq="$(readlink -f "$libdir/libpq.so.5")"; \
    test -f "$expected_libpq"; \
    linker_libpq="$(ldconfig -p | awk '$1 == "libpq.so.5" { print $NF; exit }')"; \
    test -n "$linker_libpq"; \
    test "$(readlink -f "$linker_libpq")" = "$expected_libpq"; \
    printf 'Debian 12 toolchain: pg_config=%s; server bindir=%s; include=%s; libdir=%s\n' \
      "$selected_pg_config" "$pg_config_bindir" "$includedir" "$libdir"; \
    printf 'Approved libpq: %s (minimum major %s), package %s, resolved library %s\n' \
      "$actual_version" "$LIBPQ_MINIMUM_MAJOR" "$LIBPQ_PACKAGE_VERSION" "$expected_libpq"; \
    rm -f /tmp/pgdg.asc; \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Fail the image build if install scripts did not build the native addon or if
# the resulting module has unresolved shared-library dependencies.
RUN set -eux; \
    test "$(command -v pg_config)" = "$PG_CONFIG"; \
    node --input-type=module -e "import pg from 'pg'; if (!pg.native?.Pool || !pg.native?.Client) process.exit(1); console.log('pg.native Pool and Client loaded');"; \
    addon="$(node -p "require.resolve('libpq')" | sed 's@/index.js$@/build/Release/addon.node@')"; \
    test -f "$addon"; \
    ldd_output="$(ldd "$addon")"; \
    printf '%s\n' "$ldd_output"; \
    ! printf '%s\n' "$ldd_output" | grep -q 'not found'; \
    linked_libpq="$(printf '%s\n' "$ldd_output" | awk '$1 == "libpq.so.5" && $2 == "=>" { print $3; exit }')"; \
    test -n "$linked_libpq"; \
    expected_libpq="$(readlink -f "$("$PG_CONFIG" --libdir)/libpq.so.5")"; \
    test "$(readlink -f "$linked_libpq")" = "$expected_libpq"; \
    printf 'Native addon linked libpq: %s -> %s\n' "$linked_libpq" "$expected_libpq"; \
    pkg-config --modversion libpq

CMD ["node", "--version"]
