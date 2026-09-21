#!/usr/bin/env tsx
/**
 * Descobre o host do pooler (Supavisor) de um projeto Supabase.
 *
 *   npm run pooler -- SEU-PROJECT-REF
 *
 * Existe porque o hostname do pooler não é previsível: o prefixo varia entre
 * `aws-0` e `aws-1`, e a região não aparece em lugar público nenhum. Errar o
 * hostname devolve "Tenant or user not found", que é indistinguível de "este
 * projeto não tem pooler" — e foi exatamente a conclusão errada a que eu cheguei
 * antes de sondar os dois prefixos.
 *
 * Não precisa da senha. O pooler distingue os dois casos na mensagem de erro:
 *   - `Tenant or user not found`        -> hostname errado
 *   - `password authentication failed`  -> hostname CERTO, só a senha é inválida
 */
import pg from 'pg';
import { lookup } from 'node:dns/promises';

const PREFIXOS = ['aws-0', 'aws-1'] as const;

const REGIOES = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ca-central-1',
] as const;

type Resultado = 'certo' | 'errado' | 'sem-dns';

async function sondar(host: string, ref: string): Promise<Resultado> {
  try {
    await lookup(host, { family: 4 });
  } catch {
    return 'sem-dns';
  }

  const pool = new pg.Pool({
    host,
    port: 5432,
    user: `postgres.${ref}`,
    // Senha deliberadamente inválida: a sondagem só lê a mensagem de erro.
    password: 'sondagem-sem-senha-real',
    database: 'postgres',
    max: 1,
    connectionTimeoutMillis: 8_000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pool.query('select 1');
    return 'certo';
  } catch (erro) {
    const mensagem = (erro instanceof Error ? erro.message : String(erro)).toLowerCase();
    return mensagem.includes('password authentication failed') ? 'certo' : 'errado';
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const ref = process.argv[2];

  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) {
    process.stderr.write(
      'Uso: npm run pooler -- <project-ref>\n\n' +
        '  O project-ref são os 20 caracteres do seu domínio Supabase:\n' +
        '  https://SEU-REF.supabase.co\n',
    );
    return 2;
  }

  process.stdout.write(`Sondando o pooler de ${ref} (. = hostname errado, _ = sem DNS)\n`);
  const achados: { host: string; ipv4: string }[] = [];

  for (const prefixo of PREFIXOS) {
    for (const regiao of REGIOES) {
      const host = `${prefixo}-${regiao}.pooler.supabase.com`;
      const resultado = await sondar(host, ref);

      if (resultado === 'certo') {
        const { address } = await lookup(host, { family: 4 });
        achados.push({ host, ipv4: address });
        process.stdout.write(`\n  encontrado: ${host} (${address})\n`);
      } else {
        process.stdout.write(resultado === 'sem-dns' ? '_' : '.');
      }
    }
  }

  process.stdout.write('\n\n');

  const achado = achados[0];
  if (!achado) {
    process.stdout.write(
      'Nenhum pooler reconheceu este projeto.\n\n' +
        '  Confira o project-ref, ou copie a string direto do painel:\n' +
        '  Supabase → Connect → Session pooler.\n',
    );
    return 1;
  }

  process.stdout.write(
    [
      'Use no DATABASE_URL do .env:',
      '',
      `  postgresql://postgres.${ref}:SUA-SENHA@${achado.host}:5432/postgres`,
      '',
      `  Este host atende em IPv4 (${achado.ipv4}), ao contrário de`,
      `  db.${ref}.supabase.co, que só tem endereço IPv6 e é inalcançável de`,
      '  máquina sem rota IPv6 — o caso do WSL em modo NAT.',
      '',
      '  Porta 5432 = session pooler, 6543 = transaction pooler. As duas servem à',
      '  API; a 5432 é o default mais simples para um pool de conexões longo.',
      '',
      '  URL-encode de caracteres especiais na senha: @ = %40, # = %23, : = %3A.',
      '',
    ].join('\n'),
  );

  return 0;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((erro: unknown) => {
    process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
    process.exit(1);
  });
