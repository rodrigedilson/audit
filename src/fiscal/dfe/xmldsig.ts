import { createHash, createSign } from 'node:crypto';
import type { CredencialA1 } from '../portfolio/certificate-vault.js';
import { NS_NFE } from './dfe-xml.js';

/**
 * Assinatura XMLDSig do evento, do jeito que a NF-e exige: RSA-SHA1, C14N 1.0
 * (inclusiva, sem comentários), `enveloped-signature`, e o certificado do
 * titular em `X509Data`. A referência aponta o `Id` do `infEvento`.
 *
 * **Sem canonicalizador genérico, de propósito.** O XML é gerado aqui, sem
 * espaços, só com dígitos, uma data e texto ASCII fixo. Com isso, a forma
 * canônica é determinável sem parser. Pela C14N inclusiva, o elemento de topo
 * do subconjunto recebe a declaração de namespace herdada, e só ela. Um
 * canonicalizador genérico seria mais código para errar num lugar onde o erro
 * aparece como "assinatura inválida" vinda da SEFAZ, sem mais detalhe. Os
 * testes conferem com uma verificação independente.
 */

const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

function signedInfo(id: string, digest: string): string {
  return (
    `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${RSA_SHA1}"></SignatureMethod>` +
    `<Reference URI="#${id}"><Transforms>` +
    `<Transform Algorithm="${ENVELOPED}"></Transform>` +
    `<Transform Algorithm="${C14N}"></Transform>` +
    `</Transforms><DigestMethod Algorithm="${SHA1}"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference>`
  );
}

/** Corpo base64 do certificado, sem cabeçalho PEM nem quebras. */
function certificadoBase64(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

/**
 * Devolve o `<evento>` assinado.
 *
 * @param id     o `Id` do `infEvento` (ver `idDoEvento`)
 * @param corpo  os filhos do `infEvento` (ver `corpoDaCiencia`)
 */
export function assinarEvento(id: string, corpo: string, credencial: CredencialA1): string {
  // No documento, `infEvento` herda o namespace de `evento`. Na forma canônica
  // do subconjunto, a declaração aparece nele: é o que a SEFAZ digere.
  const infCanonico = `<infEvento xmlns="${NS_NFE}" Id="${id}">${corpo}</infEvento>`;
  const digest = createHash('sha1').update(infCanonico, 'utf8').digest('base64');

  const info = signedInfo(id, digest);
  // `SignedInfo` herda o namespace de `Signature`, e pela mesma regra ele
  // aparece na forma canônica, que é a que se assina.
  const infoCanonico = `<SignedInfo xmlns="${NS_DSIG}">${info}</SignedInfo>`;
  const valor = createSign('RSA-SHA1').update(infoCanonico, 'utf8').sign(credencial.key, 'base64');

  return (
    `<evento xmlns="${NS_NFE}" versao="1.00">` +
    `<infEvento Id="${id}">${corpo}</infEvento>` +
    `<Signature xmlns="${NS_DSIG}"><SignedInfo>${info}</SignedInfo>` +
    `<SignatureValue>${valor}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certificadoBase64(credencial.cert)}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature></evento>`
  );
}
