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
      // código entregue. Onda 0: 60/60/70/80 · Onda 1: 68/68/73/80 · Onda 2: 82/82/76/80
      // · Onda 3: 83/83/78/80 · Onda 4: 85/85/80/80 · setup: 86/86/81/80 · Onda 5: 87/87/82/80
      // · Onda 6: 88/88/83/80 · Onda 7: 90/90/85/83 · Onda 8: 91/91/88/85
      // · Onda 9: abaixo.
      thresholds: {
        lines: 92,
        statements: 92,
        functions: 89,
        branches: 86,
      },
    },
  },
});
