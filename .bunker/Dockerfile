# bunker's own agent image: the bunker base + bun, so agents can run `bun test`.
FROM bunker-claude
COPY --from=oven/bun:1.4.2-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
