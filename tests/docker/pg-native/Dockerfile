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
    selected_pg_config="$(which pg_config)"; \
    test "$selected_pg_config" = "$PG_CONFIG"; \
    test -x "$PG_CONFIG"; \
    pg_config_real="$(readlink -f "$PG_CONFIG")"; \
    pg_config_bindir="$("$PG_CONFIG" --bindir)"; \
    test "$pg_config_real" = "$(readlink -f "$pg_config_bindir/pg_config")"; \
    version_output="$("$PG_CONFIG" --version)"; \
    printf '%s\n' "$version_output"; \
    actual_version="$(printf '%s\n' "$version_output" | sed -nE 's/^PostgreSQL ([0-9]+\.[0-9]+)( \(Debian [^)]+\))?$/\1/p')"; \
    test -n "$actual_version"; \
    test "$actual_version" = "$LIBPQ_EXPECTED_VERSION"; \
    actual_major="${actual_version%%.*}"; \
    test "$actual_major" -ge "$LIBPQ_MINIMUM_MAJOR"; \
    test "$(pkg-config --modversion libpq)" = "$LIBPQ_EXPECTED_VERSION"; \
    test "$(dpkg-query -W -f='${Version}' libpq-dev)" = "$LIBPQ_PACKAGE_VERSION"; \
    test "$(dpkg-query -W -f='${Version}' libpq5)" = "$LIBPQ_PACKAGE_VERSION"; \
    printf 'node-libpq build pg_config: %s -> %s; approved libpq: %s (minimum major %s)\n' \
      "$selected_pg_config" "$pg_config_real" "$actual_version" "$LIBPQ_MINIMUM_MAJOR"; \
    rm -f /tmp/pgdg.asc; \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Fail the image build if install scripts did not build the native addon or if
# the resulting module has unresolved shared-library dependencies.
RUN set -eux; \
    test "$(which pg_config)" = "$PG_CONFIG"; \
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
