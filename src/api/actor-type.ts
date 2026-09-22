/**
 * Tipo do actor a partir do texto guardado no envelope do evento.
 *
 * O envelope guarda o actor como texto livre. Um UUID é o `sub` do JWT do
 * Supabase, logo um usuário; os demais nomes são agentes ou o orquestrador.
 *
 * Vive aqui, e não dentro de uma rota, porque duas rotas precisam da mesma
 * resposta: a trilha de eventos e o log de uso do certificado. A segunda
 * afirmava `type: 'agent'` para todo uso, inclusive o disparado por uma pessoa —
 * e o log de uso do A1 é justamente onde importa saber quem agiu.
 *
 * Some quando o actor virar tipado no envelope.
 */
export type ActorType = 'user' | 'agent' | 'orchestrator' | 'system';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inferActorType(actor: string): ActorType {
  if (UUID.test(actor)) {
    return 'user';
  }
  return actor === 'tech-lead' || actor === 'closer' ? 'orchestrator' : 'agent';
}
