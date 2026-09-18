import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Migrations rodam uma vez, antes de qualquer arquivo. Ver o comentário em
    // tests/setup/global-db.ts: aplicá-las por arquivo causava deadlock de DDL
    // entre workers paralelos.
    globalSetup: ['tests/setup/global-db.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',
        // Shell de linha de comando: só faz parsing de argv, escreve em stdout e
        // chama process.exit. A lógica que importa vive no kernel e na composition
        // root, que têm teste próprio.
        'src/cli/**',
      ],
      // Piso, não meta: trava contra regressão. Sobe a cada onda junto com o
      // código entregue. Onda 0: 60/60/70/80. Onda 1: abaixo.
      thresholds: {
        lines: 68,
        statements: 68,
        functions: 73,
        branches: 80,
      },
    },
  },
});
