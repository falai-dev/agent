/**
 * The labelled set the understand gate replays: one Brazilian company's
 * WhatsApp assistant, six flows the customer can ask for, two things the
 * customer can mention in passing, seven fields.
 *
 * Every case says what a careful human reading the message would decide:
 * which flow takes the conversation (or none), what was mentioned, which
 * fields the message filled. A case with `setup` first sends that message so
 * a run is asking, then judges `message` against the floor.
 */

import { falai } from "../../src/index.js";

export const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, de um jeito leve." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  tamanho: { type: "string", enum: ["1-10", "11-50", "51-200", "200+"], ask: "Pergunte quantas pessoas trabalham lá e ofereça as faixas." },
  cidade: { type: "string", ask: "Pergunte de qual cidade a pessoa fala." },
  email: { type: "string", ask: "Peça um e-mail para enviar a proposta." },
  urgencia: { type: "string", enum: ["agora", "30 dias", "sem prazo"], ask: "Pergunte para quando precisam resolver." },
  horario: { type: "string", ask: "Pergunte o melhor dia e horário para a demonstração." },
});

export const messageFlowIds = ["triagem", "precos", "agendamento", "suporte", "cancelamento", "humano"] as const;
export const mentionFlowIds = ["concorrente", "reclamacao"] as const;

export const flows = [
  f.flow({
    id: "triagem",
    name: "Triagem",
    description: "Quando alguém chega querendo entender o produto ou saber se serve para a empresa dele",
    on: [{ message: ["quer saber como o sistema funciona", "pergunta se serve para a empresa dele", "quer entender o produto"] }],
    steps: [
      { id: "quem", collect: ["nome", "empresa"] },
      { id: "porte", collect: ["tamanho", "urgencia"] },
      { id: "onde", collect: ["cidade"] },
      { id: "fim", prompt: "Agradeça e diga que um consultor continua daqui." },
    ],
  }),
  f.flow({
    id: "precos",
    name: "Preços e planos",
    description: "Quando a pessoa pergunta quanto custa, quais planos existem ou se há desconto",
    on: [{ message: ["pergunta preço, plano, valor ou desconto"] }],
    steps: [
      { id: "porte", collect: ["tamanho"] },
      { id: "contato", collect: ["email"] },
      { id: "fim", prompt: "Diga que a proposta vai por e-mail em até um dia útil." },
    ],
  }),
  f.flow({
    id: "agendamento",
    name: "Agendar demonstração",
    description: "Quando a pessoa quer marcar uma demonstração, reunião ou call",
    on: [{ message: ["quer marcar uma demonstração, reunião ou call"] }],
    steps: [
      { id: "quem", collect: ["nome", "empresa"] },
      { id: "quando", collect: ["horario"] },
      { id: "fim", prompt: "Confirme o horário e diga que o convite chega por e-mail." },
    ],
  }),
  f.flow({
    id: "suporte",
    name: "Suporte",
    description: "Quando quem já é cliente relata que algo não funciona",
    on: [{ message: ["já é cliente e algo não funciona", "relata um erro ou problema no sistema"] }],
    steps: [
      { id: "problema", prompt: "Pergunte o que aconteceu e desde quando." },
      { id: "fim", prompt: "Diga que abriu um chamado e que o suporte responde em até duas horas." },
    ],
  }),
  f.flow({
    id: "cancelamento",
    name: "Cancelamento",
    description: "Quando a pessoa quer cancelar, encerrar a conta ou parar de pagar",
    on: [{ message: ["quer cancelar, encerrar a conta ou parar de pagar"] }],
    steps: [{ id: "motivo", prompt: "Pergunte o motivo, sem insistir, e explique como o cancelamento acontece." }],
  }),
  f.flow({
    id: "humano",
    name: "Falar com uma pessoa",
    description: "Quando a pessoa pede para falar com um atendente humano",
    on: [{ message: ["pede para falar com uma pessoa, atendente ou vendedor"] }],
    steps: [{ id: "aviso", say: "Vou chamar alguém da equipe. Um momento." }],
  }),
  f.flow({
    id: "concorrente",
    name: "Citou um concorrente",
    on: [{ mention: ["cita, usa ou compara com outro sistema de CRM ou de vendas"], extract: { nome: { type: "string", description: "nome do sistema concorrente citado" } } }],
    steps: [{ id: "fim", if: () => true }],
  }),
  f.flow({
    id: "reclamacao",
    name: "Reclamou do atendimento",
    on: [{ mention: ["reclama do atendimento, da demora ou de ficar sem resposta"] }],
    steps: [{ id: "fim", if: () => true }],
  }),
];

export interface Case {
  id: string;
  /** Sent first, unsilenced: `flow` must start and stay asking. */
  setup?: { message: string; flow: (typeof messageFlowIds)[number] };
  message: string;
  expect: {
    /** The message flow that starts this turn; `null` = none (the floor holds, or nobody). */
    flow: (typeof messageFlowIds)[number] | null;
    mentions?: (typeof mentionFlowIds)[number][];
    /** Compared after trim and lower-case. */
    fields?: Record<string, string>;
  };
}

const demo = { message: "quero marcar uma demonstração do sistema", flow: "agendamento" } as const;
const conhecer = { message: "oi, queria entender como funciona o sistema de vocês", flow: "triagem" } as const;

export const cases: Case[] = [
  // Clear routing
  { id: "r01", message: "oi, queria entender como funciona o sistema de vocês", expect: { flow: "triagem" } },
  { id: "r02", message: "quanto custa o plano pra 10 usuários?", expect: { flow: "precos" } },
  { id: "r03", message: "consigo marcar uma demonstração pra quinta?", expect: { flow: "agendamento" } },
  { id: "r04", message: "meu login não está funcionando desde ontem", expect: { flow: "suporte" } },
  { id: "r05", message: "quero cancelar minha assinatura", expect: { flow: "cancelamento" } },
  { id: "r06", message: "posso falar com uma pessoa de verdade?", expect: { flow: "humano" } },
  { id: "r07", message: "vcs atendem empresa de 200 funcionários? serve pra gente?", expect: { flow: "triagem", fields: { tamanho: "51-200" } } },
  { id: "r08", message: "tem desconto no plano anual?", expect: { flow: "precos" } },
  { id: "r09", message: "o relatório de vendas tá dando erro 500 aqui", expect: { flow: "suporte" } },
  { id: "r10", message: "não quero mais, pode encerrar minha conta", expect: { flow: "cancelamento" } },
  { id: "r11", message: "me passa pra um atendente por favor", expect: { flow: "humano" } },
  { id: "r12", message: "agenda uma call comigo amanhã de manhã", expect: { flow: "agendamento", fields: { horario: "amanhã de manhã" } } },

  // Nobody takes the conversation
  { id: "i01", message: "bom dia", expect: { flow: null } },
  { id: "i02", message: "obrigado!", expect: { flow: null } },
  { id: "i03", message: "vcs ficam em São Paulo?", expect: { flow: null } },
  { id: "i04", message: "qual o horário de atendimento de vocês?", expect: { flow: null } },
  { id: "i05", message: "ok", expect: { flow: null } },
  { id: "i06", message: "kkkk boa", expect: { flow: null } },

  // Fields land from the first message
  { id: "e01", message: "oi, sou o Rafael da Loja Bem Viver, queria saber como funciona", expect: { flow: "triagem", fields: { nome: "rafael", empresa: "loja bem viver" } } },
  { id: "e02", message: "quanto fica pra gente? somos 30 pessoas e precisamos disso pra ontem", expect: { flow: "precos", fields: { tamanho: "11-50" } } },
  { id: "e03", message: "quero entender o produto, pode mandar no rafael@bemviver.com.br também", expect: { flow: "triagem", fields: { email: "rafael@bemviver.com.br" } } },
  { id: "e04", message: "a gente é de Curitiba, o sistema serve pra uma empresa daqui?", expect: { flow: "triagem", fields: { cidade: "curitiba" } } },
  { id: "e05", message: "tô sozinho no negócio por enquanto, quanto sai pra mim?", expect: { flow: "precos", fields: { tamanho: "1-10" } } },
  { id: "e06", message: "sem pressa, é pra o ano que vem, mas queria entender como funciona", expect: { flow: "triagem", fields: { urgencia: "sem prazo" } } },
  { id: "e07", message: "aqui na Padaria do Zé somos 8, serve pra nós?", expect: { flow: "triagem", fields: { empresa: "padaria do zé", tamanho: "1-10" } } },
  { id: "e08", message: "pode me chamar de Bia. quero marcar uma demonstração", expect: { flow: "agendamento", fields: { nome: "bia" } } },

  // Mentions beside the conversation
  { id: "m01", message: "o Pipedrive tá me cobrando 300 por mês, vcs são mais baratos?", expect: { flow: "precos", mentions: ["concorrente"] } },
  { id: "m02", message: "já usei o RD Station e achei confuso, o de vocês é mais simples?", expect: { flow: "triagem", mentions: ["concorrente"] } },
  { id: "m03", message: "faz três dias que ninguém me responde aqui, que descaso", expect: { flow: null, mentions: ["reclamacao"] } },
  { id: "m04", message: "mandei email semana passada e nada, quero falar com alguém", expect: { flow: "humano", mentions: ["reclamacao"] } },
  { id: "m05", message: "vi que a HubSpot tem app, vcs têm também? quero entender como funciona", expect: { flow: "triagem", mentions: ["concorrente"] } },
  { id: "m06", message: "atendimento péssimo, cancela tudo", expect: { flow: "cancelamento", mentions: ["reclamacao"] } },

  // A run is asking: the floor holds or a new flow takes over
  { id: "f01", setup: demo, message: "pode ser quinta às 15h", expect: { flow: null, fields: { horario: "quinta às 15h" } } },
  { id: "f02", setup: demo, message: "antes disso, quanto custa?", expect: { flow: "precos" } },
  { id: "f03", setup: demo, message: "na verdade quero cancelar, não marcar nada", expect: { flow: "cancelamento" } },
  { id: "f04", setup: demo, message: "sou a Carla da Vinhos & Cia", expect: { flow: null, fields: { nome: "carla", empresa: "vinhos & cia" } } },
  { id: "f05", setup: conhecer, message: "quanto tá o plano básico?", expect: { flow: "precos" } },
  { id: "f06", setup: conhecer, message: "aliás, o Pipedrive me cobra 300 por mês", expect: { flow: null, mentions: ["concorrente"] } },
  { id: "f07", setup: conhecer, message: "Rafael, da Bem Viver", expect: { flow: null, fields: { nome: "rafael", empresa: "bem viver" } } },
  { id: "f08", setup: conhecer, message: "somos 30 pessoas aqui, precisamos disso pra ontem", expect: { flow: null, fields: { tamanho: "11-50", urgencia: "agora" } } },
];
