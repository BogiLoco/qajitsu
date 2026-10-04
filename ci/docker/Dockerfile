# QAJitsu image for CI systems without a ready-made integration, e.g. Jenkins (REQ-CI-01/AC3):
# Node.js 22, git, Playwright Chromium with its system libraries, and the `qajitsu` command.
#   docker build -f ci/docker/Dockerfile -t qajitsu .
#   docker run --rm -v "$PWD:/work" -w /work -e JIRA_TOKEN qajitsu fetch SHOP-482
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

# Browsers in a shared folder, so the unprivileged `qa` user can start them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/qajitsu
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter @qajitsu/cli exec playwright-core install --with-deps chromium

RUN printf '#!/bin/sh\nexec node /opt/qajitsu/packages/cli/dist/bin.js "$@"\n' > /usr/local/bin/qajitsu \
  && chmod +x /usr/local/bin/qajitsu \
  && ln -s /usr/local/bin/qajitsu /usr/local/bin/qj \
  && cp /opt/qajitsu/ci/qajitsu-ci.sh /usr/local/bin/qajitsu-ci.sh

RUN useradd --create-home qa
USER qa
WORKDIR /work
ENTRYPOINT ["qajitsu"]
CMD ["--help"]
