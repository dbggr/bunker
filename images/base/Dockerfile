# Base agent image for the docker() sandbox: git + the native claude binary, no language runtime.
# Repos extend it with their own toolchain in .bunker/Dockerfile (FROM bunker-claude).
FROM debian:trixie-slim
ARG CLAUDE_VERSION=2.1.301
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/*
# The installer puts claude under $HOME; move the real binary onto PATH so any --user can run it.
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION" \
  && cp "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
  && rm -rf /root/.local /root/.claude
