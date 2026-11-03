FROM node:24.22.1-bookworm-slim

ARG LIBPQ_PACKAGE_VERSION=18.6-1.pgdg12+2
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
    pg_config --version; \
    test "$(pg_config --version)" = 'PostgreSQL 18.6'; \
    rm -f /tmp/pgdg.asc; \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Fail the image build if install scripts did not build the native addon or if
# the resulting module has unresolved shared-library dependencies.
RUN set -eux; \
    node --input-type=module -e "import pg from 'pg'; if (!pg.native?.Pool || !pg.native?.Client) process.exit(1); console.log('pg.native Pool and Client loaded');"; \
    addon="$(node -p "require.resolve('libpq')" | sed 's@/index.js$@/build/Release/addon.node@')"; \
    test -f "$addon"; \
    ldd "$addon"; \
    ! ldd "$addon" | grep -q 'not found'; \
    pkg-config --modversion libpq

CMD ["node", "--version"]
