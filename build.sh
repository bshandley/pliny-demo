#!/bin/bash
set -euo pipefail

PLINY_SRC_DIR="${PLINY_SRC_DIR:-/tmp/pliny-src}"
PLINY_REPO="https://github.com/bshandley/pliny"

echo "==> Fetching pliny source..."
if [ -d "$PLINY_SRC_DIR" ]; then
  echo "    Using existing source at $PLINY_SRC_DIR"
  cd "$PLINY_SRC_DIR" && git pull --ff-only 2>/dev/null || true
  cd -
else
  git clone --depth 1 "$PLINY_REPO" "$PLINY_SRC_DIR"
fi

# Symlink into build context so Dockerfiles can COPY it
ln -sfn "$PLINY_SRC_DIR" pliny-src

echo "==> Building demo server image..."
docker build -f Dockerfile.server -t ghcr.io/bshandley/pliny-demo-server:latest .

echo "==> Building demo client image..."
docker build -f Dockerfile.client -t ghcr.io/bshandley/pliny-demo-client:latest .

echo "==> Build complete!"
echo "    ghcr.io/bshandley/pliny-demo-server:latest"
echo "    ghcr.io/bshandley/pliny-demo-client:latest"

# Push if PUSH=1 is set
if [ "${PUSH:-0}" = "1" ]; then
  echo "==> Pushing images to GHCR..."
  docker push ghcr.io/bshandley/pliny-demo-server:latest
  docker push ghcr.io/bshandley/pliny-demo-client:latest
  echo "==> Push complete!"
fi
