import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
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
      // Piso fixado no patamar atingido na Onda 0. Não é meta — é trava contra
      // regressão. Cada onda seguinte sobe o piso junto com o código que entrega.
      thresholds: {
        lines: 60,
        statements: 60,
        functions: 70,
        branches: 80,
      },
    },
  },
});
