/**
 * Recifra o acervo de certificados A1 com a chave mestra atual.
 *
 * Roda na janela de rotação: `CERTIFICATE_MASTER_KEY` já é a nova e
 * `CERTIFICATE_MASTER_KEY_PREVIOUS` ainda é a antiga. Cada linha é decifrada com
 * a que funcionar e regravada com a atual.
 *
 * Três garantias que o script precisa ter, porque um erro aqui torna o
 * certificado do cliente ilegível para sempre:
 *
 * - **Idempotente.** Rodar duas vezes não corrompe: a segunda passada não acha
 *   linha com id antigo e não faz nada.
 * - **Uma transação por linha.** Uma falha no meio deixa as anteriores
 *   recifradas e as seguintes intactas, nunca uma linha pela metade.
 * - **Confere antes de gravar.** O PFX decifrado é comparado com o
 *   `fingerprint` guardado; se não bater, a linha é pulada e reportada em vez de
 *   ser regravada com conteúdo que já estava errado.
 *
 * Sem `--executar`, só relata o que faria.
 *
 * ```
 * npx tsx scripts/recifrar-certificados.ts
 * npx tsx scripts/recifrar-certificados.ts --executar
 * ```
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { CertificateVault } from '../src/fiscal/portfolio/certificate-vault.js';
import { ignorarErroDeClienteOcioso } from '../src/infrastructure/persistence/pool-errors.js';

interface Linha {
  tenant_id: string;
  cnpj: string;
  encrypted_pfx: string;
  fingerprint: string;
  key_id: string | null;
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL não definida.');
  }

  const atual = process.env['CERTIFICATE_MASTER_KEY'];
  if (atual === undefined || atual === '') {
    throw new Error('CERTIFICATE_MASTER_KEY não definida.');
  }

  const anterior = process.env['CERTIFICATE_MASTER_KEY_PREVIOUS'];
  const vault = new CertificateVault(atual, anterior);

  console.log(`Chave atual:    ${vault.keyId}`);
  console.log(`Chave anterior: ${vault.previousKeyId ?? '(não definida)'}`);

  if (vault.previousKeyId === null) {
    console.log(
      '\nSem chave anterior: só as linhas cifradas com a chave atual podem ser lidas.\n' +
        'Se houver linha de outra chave, ela será reportada como ilegível — e é isso\n' +
        'que você quer ver ANTES de remover a chave antiga do ambiente.',
    );
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  ignorarErroDeClienteOcioso(pool, 'RecifragemPool');

  try {
    const { rows } = await pool.query<Linha>(
      `select tenant_id, cnpj, encrypted_pfx, fingerprint, key_id
         from certificates
        order by stored_at`,
    );

    console.log(`\n${rows.length} certificado(s) no acervo.`);

    const pendentes = rows.filter((linha) => linha.key_id !== vault.keyId);
    console.log(`${pendentes.length} fora da chave atual.`);

    if (pendentes.length === 0) {
      console.log('Nada a fazer.');
      return;
    }

    if (!executar) {
      for (const linha of pendentes) {
        console.log(`  ${linha.cnpj} · chave ${linha.key_id ?? '(anterior à rotação)'}`);
      }
      console.log('\nSimulação. Use --executar para recifrar.');
      return;
    }

    let recifrados = 0;
    const falhas: { cnpj: string; motivo: string }[] = [];

    for (const linha of pendentes) {
      const client = await pool.connect();
      try {
        await client.query('begin');

        const pfx = vault.decrypt(linha.encrypted_pfx);

        // O fingerprint é do PFX em claro: se não bater, o que está guardado não
        // é o que foi guardado, e regravar carimbaria a chave nova num conteúdo
        // já comprometido.
        const conferido = createHash('sha256').update(pfx).digest('hex');
        if (conferido !== linha.fingerprint) {
          throw new Error(
            `fingerprint não confere (guardado ${linha.fingerprint.slice(0, 12)}…, ` +
              `calculado ${conferido.slice(0, 12)}…)`,
          );
        }

        const novo = vault.encrypt(pfx);

        await client.query(
          `update certificates
              set encrypted_pfx = $3, key_id = $4
            where tenant_id = $1::uuid and cnpj = $2::char(14)`,
          [linha.tenant_id, linha.cnpj, novo.ciphertext, novo.keyId],
        );

        await client.query('commit');
        recifrados += 1;
        console.log(`  ✓ ${linha.cnpj}`);
      } catch (causa) {
        await client.query('rollback').catch(() => undefined);
        const motivo = causa instanceof Error ? causa.message : String(causa);
        falhas.push({ cnpj: linha.cnpj, motivo });
        console.error(`  ✗ ${linha.cnpj}: ${motivo}`);
      } finally {
        client.release();
      }
    }

    console.log(`\n${recifrados} recifrado(s), ${falhas.length} com falha.`);

    if (falhas.length > 0) {
      console.error(
        '\nNÃO remova a chave antiga do ambiente enquanto houver falha: as linhas\n' +
          'acima só abrem com ela.',
      );
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((causa: unknown) => {
  console.error(causa instanceof Error ? causa.message : causa);
  process.exit(1);
});
