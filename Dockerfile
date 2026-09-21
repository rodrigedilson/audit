# =============================================================================
# API do audit.
#
# Multi-stage de propósito: o estágio de build precisa do TypeScript e das
# devDependencies, e nada disso tem razão de existir na imagem que roda. O
# estágio final leva só `dist/`, as dependências de produção e o `package.json`.
# =============================================================================

FROM node:22-slim AS build

WORKDIR /app

# `package*.json` antes do código: a camada do `npm ci` só invalida quando as
# dependências mudam, e não a cada alteração de fonte.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --------------------------------------------------------------------- runtime
FROM node:22-slim AS runtime

# `dumb-init` como PID 1: sem ele, o Node não recebe SIGTERM do orquestrador e
# o contêiner é morto à força. Num processo que serve escrita em event log,
# encerrar sem terminar a requisição em voo é perder o append no meio.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# `--omit=dev` deixa a imagem com as 9 dependências de produção, e não com as
# ferramentas de teste e build.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# `config/` não é artefato de desenvolvimento: o servidor carrega
# `esaa.config.yaml` no start e, a partir dele, o `AGENT_CONTRACT.yaml` que
# alimenta a camada 5 de validação (fronteiras de escrita por agente). Sem estes
# arquivos o processo não sobe — e isso só aparece rodando o contêiner, porque o
# `tsc` não vê leitura de disco.
COPY config ./config

# Usuário sem privilégio. A imagem `node` já traz o usuário `node` (uid 1000).
USER node

# `0.0.0.0` é o padrão de `API_HOST`, e é declarado aqui porque `localhost`
# dentro do contêiner não recebe tráfego de fora dele.
ENV API_HOST=0.0.0.0
ENV API_PORT=3000
EXPOSE 3000

# Healthcheck na única rota pública que não toca o banco. `/v1/plans` tocaria, e
# um banco lento marcaria o contêiner como morto sem ele estar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/cli/audit.js", "serve"]
