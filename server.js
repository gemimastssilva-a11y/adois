/* A Dois — Backend v2: IA real + webhooks Meta + pagamentos
 * Rodar: node server.js (porta 3007)
 * Variáveis de ambiente (opcionais — tem fallback):
 *   LLM_API_KEY   → chave da API (OpenAI, OpenRouter, Anthropic-compatible)
 *   LLM_BASE_URL  → default https://api.openai.com/v1
 *   LLM_MODEL     → default gpt-4o-mini
 *   STRIPE_SECRET_KEY → checkout de assinaturas
 *   STRIPE_WEBHOOK_SECRET → validação dos webhooks de assinatura
 *   META_APP_ID / META_APP_SECRET → OAuth BYO da Meta
 *   VERIFY_TOKEN → handshake do webhook da Meta
 *   SUPABASE_URL / SUPABASE_KEY → persistência + limites freemium
 */
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3007;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "adois-dev-token";
const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WHSEC = process.env.STRIPE_WEBHOOK_SECRET || "";
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const ENC_KEY = process.env.ENC_KEY || crypto.createHash("sha256").update(META_APP_SECRET).digest("hex").slice(0, 32);
const SUPABASE_URL = process.env.SUPABASE_URL || "https://qeteccwfeefgsictgopv.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

/* ---------- Supabase (persistência) ---------- */
async function supaRPC(fn, args){
  if (!SUPABASE_KEY) return null;
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error("supabase " + fn + " HTTP " + r.status);
  return r.json();
}

/* limite do freemium: 50/1000/2000 por plano */
async function dentroDoLimite(){
  if (!SUPABASE_KEY) return true; // sem banco configurado, não bloqueia
  try {
    const data = await supaRPC("listar_usuarios_canal", { p_canal: "whatsapp" });
    if (!data || !data.length) return true;
    const lim = await supaRPC("checar_limite", { p_usuario: data[0] });
    return !lim || lim.uso_hoje < lim.limite;
  } catch (e) { console.error("limite:", e.message); return true; }
}

const PLANOS = {
  gratuito: { preco_centavos: 0, prompts_chat: 3, checkins_semana: 1, encontros_guiados: false, padroes_conflito: false },
  premium:  { preco_centavos: 2990, prompts_chat: Infinity, checkins_semana: Infinity, encontros_guiados: true, padroes_conflito: true },
  casal:    { preco_centavos: 4490, prompts_chat: Infinity, checkins_semana: Infinity, encontros_guiados: true, padroes_conflito: true, conta_compartilhada: true }
};

/* ---------- fila assíncrona ---------- */
const fila = [];
let processando = false;
function agendar(){ setImmediate(processar); }
async function processar(){
  if (processando || !fila.length) return;
  processando = true;
  const job = fila.shift();
  try { await job.fn(); } catch (e) { console.error("job erro:", e.message); }
  processando = false;
  agendar();
}

/* ---------- normalização Meta (WhatsApp/IG/Messenger) ---------- */
function normalizar(canal, payload){
  try {
    if (canal === "whatsapp"){
      const v = payload.entry[0].changes[0].value, m = v.messages && v.messages[0];
      if (!m) return null;
      return { canal, contatoId: m.from, nome: (v.contacts && v.contacts[0].profile.name) || m.from,
               texto: (m.text && m.text.body) || "[mídia]", ts: +m.timestamp * 1000, anexos: [] };
    }
    const e = payload.entry[0], m = e.messaging && e.messaging[0];
    if (!m || !m.message) return null;
    return { canal, contatoId: m.sender.id, nome: "Contato " + m.sender.id.slice(0,6),
             texto: m.message.text || "[mídia]", ts: m.timestamp, anexos: m.message.attachments || [] };
  } catch { return null; }
}

/* ---------- IA real: 3 sugestões de especialista ---------- */
/* DIFERENCIAL (referência: Connected — "IA fundamentada em ciência que conhece os dois"):
   a IA recebe os dados do Mapa de Calor de AMBOS, o estágio da relação e o Banco Emocional,
   e cita explicitamente os conceitos (Gottman/Chapman/Perel) quando ajuda. Nenhum concorrente
   faz isso no canal onde a conversa acontece (WhatsApp/IG/FB). */
const SYSTEM_PROMPT = `Você é o consultor de relacionamentos do app "A Dois" (Brasil) — o único assistente de relacionamentos que acompanha o casal DO MATCH AO CASAMENTO e responde no canal onde a conversa realmente acontece (WhatsApp, Instagram, Facebook).

FUNDAMENTAÇÃO (use explicitamente quando ajudar, citando o conceito na dica):
- John Gottman: validação emocional, convites de conexão (bids), Quatro Cavaleiros (crítica, desprezo, defensividade, muralha), tentativas de reparo, mapa do amor
- Gary Chapman: 5 linguagens do amor — adapte a sugestão à linguagem principal informada no contexto
- Esther Perel: desejo vive da distância e do mistério, individualidade, conversas difíceis com segurança

VOCÊ CONHECE O CASAL (dados do Mapa de Calor no contexto):
- Estilos de apego dos dois (seguro/ansioso/evitativo) → evite reforçar gatilhos: p/ ansioso, dê segurança; p/ evitativo, não abafe
- Linguagens do amor dos dois → a resposta deve "falar" a linguagem de QUEM RECEBE
- Estilo de conflito dos dois → em tensões, suavize conforme o padrão (evitador precisa de convite seguro p/ falar; volátil precisa de pausa)
- Estágio da relação (fase 0 a 5) → calibre o ritmo: conhecendo = sem pressa; comprometidos = profundidade
- Banco Emocional (%) → baixo (<50): priorize reparo e depósitos; alto: pode avançar

TAREFA: dada a última mensagem recebida e o contexto, gere EXATAMENTE 3 sugestões de resposta para o usuário enviar:
1. "empatica" — valida o que a pessoa disse e aprofunda a conexão (etiqueta: "Acolhe e aprofunda")
2. "leve" — mantém o clima agradável com naturalidade e humor leve (etiqueta: "Leve e descontraída")
3. "estrategica" — avança a conversa: tema mais pessoal ou convite (etiqueta: "Avança a conversa")

REGRAS DE TOM:
- Português brasileiro natural, como um amigo inteligente escreveria no WhatsApp. Sem formalidade.
- Empático, estratégico, NUNCA agressivo, NUNCA manipulador, NUNCA possessivo, NUNCA clichê de autoajuda.
- Cada sugestão: 1-3 frases curtas, pronta para enviar, personalizada com o contexto do casal (não genérica).
- A "dica" deve explicar QUAL opção escolher e POR QUÊ, citando o conceito científico (ex.: "Desabafo é bid de conexão — Gottman diz para virar em direção, não away").

SEGURANÇA:
- Se a mensagem indicar sofrimento intenso (autolesão, crise grave), NÃO sugira resposta comum: acolha com seriedade nas 3 e recomende o CVV (188).
- Nunca aconselhe a permanecer em relação abusiva; diante de sinais de abuso, sugira apoio profissional (CVV 188 / Centro de Valorização da Mulher 180).

SAÍDA: SOMENTE JSON válido, sem markdown:
{"intencao":"desabafo|convite|flerte|pergunta|neutro|crise","sugestoes":[{"tipo":"empatica","etiqueta":"Acolhe e aprofunda","texto":"..."},{"tipo":"leve","etiqueta":"Leve e descontraída","texto":"..."},{"tipo":"estrategica","etiqueta":"Avança a conversa","texto":"..."}],"dica":"qual escolher e por quê, citando a teoria"}`;

/* guardrails: bloqueia saída inadequada */
const RUIM = /(se mate|desapareça|ninguém te quer|manipul|faça ciúme|vinganç)/i;
const CRISE = /(me matar|suicid|não quero mais viver|me cortar|autoles)/i;
function guardrails(json, ultima){
  if (CRISE.test(ultima)){
    json.sugestoes = ["empatica","leve","estrategica"].map((tipo, i) => ({
      tipo, etiqueta: { empatica: "Acolhe e aprofunda", leve: "Leve e descontraída", estrategica: "Avança a conversa" }[tipo],
      texto: [
        "Estou aqui com você, do seu lado. Isso que você está sentindo é sério e você não precisa passar por isso sozinha(o) — podemos ligar juntas(os) pro CVV (188) agora?",
        "Obrigada por me contar algo tão difícil. Sua vida importa demais pra mim. Vamos buscar ajuda juntos — o CVV (188) atende agora, sem julgamento.",
        "Meu lugar é com você nisso. Que tal a gente ligar pro CVV (188) agora e, amanhã, eu te acompanho numa conversa com um profissional?"
      ][i]
    }));
    json.dica = "🚨 Sinal de crise detectado: acolha com seriedade e incentive ajuda profissional (CVV 188). Não minimize.";
    return json;
  }
  json.sugestoes = (json.sugestoes || []).filter(s => !RUIM.test(s.texto || ""));
  return json;
}

async function chamarLLM(ultima, ctx){
  const user = JSON.stringify({
    ultima_mensagem: ultima,
    historico_recente: (ctx.historico || []).slice(-8),
    /* DIFERENCIAL "A Dois": a IA conhece o casal (nada de conselho genérico) */
    mapa_de_calor: ctx.mapa || null,
    estagio_relacao: ctx.estagio || "conhecendo",
    banco_emocional: ctx.banco_emocional ?? null,
    tom_preferido: ctx.tom || "casual"
  });
  const r = await fetch(LLM_BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + LLM_KEY },
    body: JSON.stringify({ model: LLM_MODEL, messages: [
      { role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user } ],
      temperature: 0.8, max_tokens: 600 })
  });
  if (!r.ok) throw new Error("LLM HTTP " + r.status);
  const d = await r.json();
  let txt = d.choices[0].message.content.trim().replace(/^```(json)?/, "").replace(/```$/, "");
  return guardrails(JSON.parse(txt), ultima);
}

/* ---------- fallback: motor de regras (sem chave LLM) ---------- */
function classificar(txt){
  const t = txt.toLowerCase();
  if (CRISE.test(t)) return "crise";
  if (/(triste|cansad|ansios|medo|sozinh|desanimad|estress|difícil|dificil|exaust)/.test(t)) return "desabafo";
  if (/(jantar|café|cinema|sair|encontrar|marcar|rolê|role)/.test(t)) return "convite";
  if (/(linda|fofa|gostei|saudade|adoro|incrível|maravilhos)/.test(t)) return "flerte";
  if (t.includes("?")) return "pergunta";
  return "neutro";
}
function fallback(ultima){
  const intent = classificar(ultima);
  const B = {
    desabafo: { empatica: "Que bom que você me contou. Semana pesada, né? Estou aqui — sem pressa.",
      leve: "Regra de hoje: zero cobrança. Chá, sofá e levezinha 😄",
      estrategica: "Quero cuidar de você. Sábado eu cozinho e a gente desliga do mundo — topa?",
      dica: "Desabafo é convite para conexão (Gottman): valide ANTES de propor soluções." },
    convite: { empatica: "Adorei o convite! É exatamente o tipo de plano que eu valorizo.",
      leve: "Aceito! Mas aviso: perco em trívial e ganho em sobremesa 😄",
      estrategica: "Topo! Sábado, 19h? Você escolhe o lugar, eu a sobremesa 😄",
      dica: "Convite pede resposta calorosa e rápida — a Estratégica fecha dia e hora." },
    flerte: { empatica: "Que bom ler isso. Também tenho gostado bastante de você.",
      leve: "Olha o elogio... já ganhou pontos 😄",
      estrategica: "Gosto de você também. Vamos transformar isso num jantar? Sábado?",
      dica: "Reciprocidade com leveza (Perel): o desejo vive do mistério — não acelere demais." },
    pergunta: { empatica: "Gosto que você pergunte. Vou responder de verdade: ...",
      leve: "Resposta curta: sim 😄 A longa custa um café!",
      estrategica: "Essa pergunta merece conversa olho no olho. Café esta semana?",
      dica: "Pergunta é interesse: responda com história pessoal (Gottman — mapa do amor)." },
    neutro: { empatica: "Gostei de saber isso. Me conta mais?",
      leve: "Só eu que sorrio lendo suas mensagens? 😄",
      estrategica: "Adoro conversar com você. Que tal continuar isso pessoalmente?",
      dica: "Mensagem neutra = oportunidade de avançar devagar." },
    crise: { empatica: "Estou aqui com você. Isso é sério e você não precisa passar por isso sozinha(o) — vamos ligar pro CVV (188) juntos?",
      leve: "Estou do seu lado agora. Respira comigo — e vamos buscar ajuda juntos, sim?",
      estrategica: "Sua vida importa demais. Vamos ligar pro CVV (188) agora e buscar um profissional amanhã — eu te acompanho.",
      dica: "🚨 Crise detectada: acolha com seriedade e incentive ajuda profissional imediata." }
  }[intent];
  return { intencao: intent,
    sugestoes: ["empatica","leve","estrategica"].map(t => ({ tipo: t,
      etiqueta: { empatica: "Acolhe e aprofunda", leve: "Leve e descontraída", estrategica: "Avança a conversa" }[t],
      texto: B[t] })), dica: B.dica, motor: "regras" };
}

async function gerar(ultima, ctx){
  const t0 = Date.now();
  let out;
  if (LLM_KEY){
    try {
      out = await chamarLLM(ultima, ctx);
      out.motor = "llm:" + LLM_MODEL;
    } catch (e) {
      console.error("LLM falhou, usando fallback:", e.message);
      out = fallback(ultima);
    }
  } else out = fallback(ultima);
  out.latencia_ms = Date.now() - t0;
  return out;
}

/* ---------- Stripe (checkout + webhook) ---------- */
async function stripeCheckout(plano, email){
  if (!STRIPE_KEY) return { erro: "STRIPE_SECRET_KEY não configurada" };
  const p = PLANOS[plano];
  if (!p || plano === "gratuito") return { erro: "plano inválido" };
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price_data][currency]": "brl",
    "line_items[0][price_data][product_data][name]": "A Dois — Plano " + (plano === "casal" ? "Casal" : "Premium"),
    "line_items[0][price_data][unit_amount]": String(p.preco_centavos),
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][quantity]": "1",
    success_url: "https://adois.app/obrigado?plano=" + plano,
    cancel_url: "https://adois.app/planos"
  });
  if (email) body.set("customer_email", email);
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST", headers: { Authorization: "Bearer " + STRIPE_KEY,
      "Content-Type": "application/x-www-form-urlencoded" }, body });
  const d = await r.json();
  return d.url ? { url: d.url, id: d.id } : { erro: (d.error && d.error.message) || "erro stripe" };
}
function stripeWebhookValido(raw, sig){
  if (!STRIPE_WHSEC) return false;
  const parts = {};
  sig.split(",").forEach(p => { const [k, v] = p.split("="); parts[k] = v; });
  const assinado = crypto.createHmac("sha256", STRIPE_WHSEC)
    .update(parts.t + "." + raw).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(assinado), Buffer.from(parts.v1 || "x")); }
  catch { return false; }
}

/* ---------- OAuth BYO (Meta) — o usuário conecta a PRÓPRIA conta ---------- */
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT_URI || "https://SEU-DOMINIO/oauth/callback";
const PERMS_WHATSAPP = "whatsapp_business_messaging,whatsapp_business_management,business_management";

/* contas conectadas (produção: tabela canais no Supabase, token criptografado) */
const contasConectadas = [];

function oauthURL(){
  if (!META_APP_ID) return null;
  const p = new URLSearchParams({
    client_id: META_APP_ID, redirect_uri: OAUTH_REDIRECT,
    scope: PERMS_WHATSAPP, response_type: "code"
  });
  return "https://www.facebook.com/v21.0/dialog/oauth?" + p.toString();
}

async function trocarPorToken(code){
  const p = new URLSearchParams({
    client_id: META_APP_ID, client_secret: META_APP_SECRET,
    redirect_uri: OAUTH_REDIRECT, code
  });
  const r = await fetch("https://graph.facebook.com/v21.0/oauth/access_token?" + p.toString());
  if (!r.ok) throw new Error("OAuth HTTP " + r.status);
  return r.json();
}

/* ---------- assinatura X-Hub-Signature-256 (webhook Meta) ---------- */
function metaWebhookValido(raw, sigHeader){
  if (!META_APP_SECRET || !sigHeader) return false;
  const sig = String(sigHeader).replace(/^sha256=/, "");
  const calc = crypto.createHmac("sha256", META_APP_SECRET).update(raw).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc)); }
  catch { return false; }
}

/* ---------- métricas/monitoramento ---------- */
const metricas = { msgs_recebidas: 0, analises: 0, erros: 0, latencia_total_ms: 0, iniciado_em: new Date().toISOString() };

/* ---------- servidor ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const corpo = cb => { let b = ""; req.on("data", c => b += c); req.on("end", () => cb(b)); };

  /* verificação de webhook Meta */
  if (url.pathname === "/webhook" && req.method === "GET"){
    if (url.searchParams.get("hub.verify_token") === VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe"){
      res.writeHead(200); res.end(url.searchParams.get("hub.challenge"));
    } else { res.writeHead(403); res.end(); }
    return;
  }

  /* mensagens recebidas (Meta) → valida assinatura → fila → IA → persistência */
  if (url.pathname === "/webhook" && req.method === "POST"){
    corpo(b => {
      if (META_APP_SECRET && !metaWebhookValido(b, req.headers["x-hub-signature-256"])) {
        metricas.erros++;
        return json(401, { erro: "assinatura inválida" });
      }
      let p; try { p = JSON.parse(b); } catch { return json(400, {}); }
      const canal = url.searchParams.get("canal") || "whatsapp";
      const msg = normalizar(canal, p);
      if (!msg) return json(200, {});
      fila.push({ fn: async () => {
        const sug = await gerar(msg.texto, {});
        metricas.msgs_recebidas++; metricas.analises++; metricas.latencia_total_ms += sug.latencia_ms;
        console.log(`[${msg.canal}] ${msg.nome}: "${msg.texto}" -> ${sug.intencao} (${sug.latencia_ms}ms, ${sug.motor})`);
        // persistência completa no Supabase (conversa + mensagem + 3 sugestões)
        try {
          if (await dentroDoLimite()) {
            const conv = await supaRPC("registrar_webhook", {
              p_canal: msg.canal, p_contato_id: msg.contatoId, p_contato_nome: msg.nome,
              p_texto: msg.texto, p_resultado: sug
            });
            if (conv) console.log("  → salvo no Supabase (conversa " + conv.slice(0,8) + ")");
          } else console.log("  → limite do plano atingido, sugestão não gerada");
        } catch (e) { console.error("  persistência:", e.message); }
      }});
      agendar();
      json(200, { ok: true });
    });
    return;
  }

  /* gerar sugestões (painel chama; também modo manual) */
  if (url.pathname === "/sugerir" && req.method === "POST"){
    corpo(b => {
      let d; try { d = JSON.parse(b || "{}"); } catch { return json(400, { erro: "json inválido" }); }
      gerar(d.texto || "", d.ctx || {}).then(out => json(200, out));
    });
    return;
  }

  /* planos e limites (freemium) */
  if (url.pathname === "/planos" && req.method === "GET") return json(200, PLANOS);

  /* checkout de assinatura (Stripe) */
  if (url.pathname === "/assinar" && req.method === "POST"){
    corpo(b => {
      let d; try { d = JSON.parse(b || "{}"); } catch { return json(400, { erro: "json inválido" }); }
      stripeCheckout(d.plano, d.email).then(out => json(out.erro ? 400 : 200, out));
    });
    return;
  }

  /* webhook Stripe (renovação, cancelamento, inadimplência) */
  if (url.pathname === "/webhook-stripe" && req.method === "POST"){
    corpo(b => {
      const sig = req.headers["stripe-signature"] || "";
      if (!stripeWebhookValido(b, sig)) return json(400, { erro: "assinatura inválida" });
      const ev = JSON.parse(b);
      console.log("stripe event:", ev.type);
      json(200, { ok: true });
    });
    return;
  }

  /* OAuth: iniciar conexão BYO do WhatsApp */
  if (url.pathname === "/oauth/whatsapp" && req.method === "GET"){
    const u = oauthURL();
    if (!u) return json(400, { erro: "META_APP_ID não configurada", como_resolver: "Criar app em developers.facebook.com e definir META_APP_ID/META_APP_SECRET" });
    res.writeHead(302, { Location: u }); res.end();
    return;
  }

  /* OAuth: callback (troca code por token, criptografa e salva no Supabase) */
  if (url.pathname === "/oauth/callback" && req.method === "GET"){
    const code = url.searchParams.get("code");
    if (!code) return json(400, { erro: "sem code" });
    trocarPorToken(code).then(async tok => {
      // AES-256-GCM: token nunca fica em claro nem em RAM persistente
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENC_KEY, "hex"), iv);
      const enc = Buffer.concat([cipher.update(tok.access_token, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const tokenCriptografado = iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
      let salvo = false;
      try {
        const data = await supaRPC("listar_usuarios_canal", { p_canal: "whatsapp" });
        if (data && data.length) {
          await supaRPC("salvar_canal", { p_usuario: data[0], p_canal: "whatsapp", p_conta_id: "oauth_" + Date.now(), p_token_criptografado: tokenCriptografado });
          salvo = true;
        }
      } catch (e) { console.error("salvar_canal:", e.message); }
      contasConectadas.push({ canal: "whatsapp", conectado_em: new Date().toISOString(), salvo_no_banco: salvo });
      json(200, { ok: true, canal: "whatsapp", token_salvo_criptografado: salvo, mensagem: "Conta conectada! Nenhuma mensagem é enviada por nós — só analisamos." });
    }).catch(e => json(500, { erro: e.message }));
    return;
  }

  /* monitoramento */
  if (url.pathname === "/health" && req.method === "GET"){
    return json(200, { status: "ok", uptime_s: Math.round(process.uptime()),
      ia: LLM_KEY ? LLM_MODEL : "fallback-regras", stripe: !!STRIPE_KEY, meta_oauth: !!META_APP_ID,
      contas_conectadas: contasConectadas.length, ...metricas,
      latencia_media_ms: metricas.analises ? Math.round(metricas.latencia_total_ms / metricas.analises) : null });
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`A Dois backend v2 :${PORT}`);
  console.log(`  IA: ${LLM_KEY ? LLM_MODEL + " (" + LLM_BASE + ")" : "MODO FALLBACK (regras) — defina LLM_API_KEY"}`);
  console.log(`  Stripe: ${STRIPE_KEY ? "configurado" : "não configurado — defina STRIPE_SECRET_KEY"}`);
  console.log(`  Meta OAuth: ${META_APP_ID ? "configurado" : "não configurado — defina META_APP_ID/META_APP_SECRET"}`);
  console.log(`  Supabase: ${SUPABASE_KEY ? "persistência ativa" : "sem persistência — defina SUPABASE_KEY"}`);
});
