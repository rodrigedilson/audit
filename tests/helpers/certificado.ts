import forge from 'node-forge';

/**
 * PFX de verdade para os testes da coleta de DF-e, com a opção de trazer a CA
 * intermediária antes do titular — como vem de muita AC da ICP-Brasil —, para
 * provar que o titular é escolhido pela chave, e não pela ordem no arquivo.
 */
export function pfxDeTeste(options: { password: string; comCadeia?: boolean } = { password: 'senha' }): Buffer {
  const chaveCa = forge.pki.rsa.generateKeyPair(1024);
  const ca = forge.pki.createCertificate();
  ca.publicKey = chaveCa.publicKey;
  ca.serialNumber = '01';
  ca.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  ca.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  ca.setSubject([{ shortName: 'CN', value: 'AC TESTE' }]);
  ca.setIssuer([{ shortName: 'CN', value: 'AC TESTE' }]);
  ca.sign(chaveCa.privateKey);

  const chave = forge.pki.rsa.generateKeyPair(1024);
  const titular = forge.pki.createCertificate();
  titular.publicKey = chave.publicKey;
  titular.serialNumber = '02';
  titular.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  titular.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  titular.setSubject([{ shortName: 'CN', value: 'CLIENTE DE TESTE:12345678000195' }]);
  titular.setIssuer(ca.subject.attributes);
  titular.sign(chaveCa.privateKey);

  const certs = options.comCadeia ? [ca, titular] : [titular];
  const asn1 = forge.pkcs12.toPkcs12Asn1(chave.privateKey, certs, options.password);
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}
