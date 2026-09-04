const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { createAuth } = require("./auth");
const tonerMonitor = require("./toner-monitor");

const arquivoEnv = process.env.NXT_ENV_FILE || path.join(__dirname, ".env");
const dotenv = require("dotenv");
dotenv.config({ path: arquivoEnv });

const app = express();
const PORTA = Number(process.env.PORT || 3000);
const HOST = process.env.NXT_HOST || "127.0.0.1";

const pastaProjeto = __dirname;
const pastaPublica = path.join(pastaProjeto, "public");
const pastaDados = process.env.NXT_DATA_DIR
  ? path.resolve(process.env.NXT_DATA_DIR)
  : path.join(pastaProjeto, "dados");

fs.mkdirSync(pastaDados, { recursive: true });
const arquivoPlanilha = path.join(pastaDados, "estoque-atual.xlsx");
const arquivoAutomacao = path.join(
  pastaProjeto,
  "automacao.js"
);
const arquivoBanco = path.join(pastaDados, "controle-estoque.db");
const arquivoToner = path.join(pastaDados, "toner-atual.json");
const arquivoRestauracao = path.join(pastaDados, "restauracao-pendente.db");
if (fs.existsSync(arquivoRestauracao)) {
  try {
    const probe = new DatabaseSync(arquivoRestauracao, { readOnly:true });
    const integrity = probe.prepare("PRAGMA integrity_check").get();
    probe.close();
    if (!integrity || String(Object.values(integrity)[0]).toLowerCase() !== "ok") throw new Error("Banco inválido");
    if (fs.existsSync(arquivoBanco)) {
      fs.copyFileSync(arquivoBanco, path.join(pastaDados, "controle-estoque-antes-restauracao.db"));
      fs.rmSync(arquivoBanco);
      ["-wal","-shm"].forEach(function(suffix){try{fs.rmSync(arquivoBanco+suffix);}catch{}});
    }
    fs.renameSync(arquivoRestauracao, arquivoBanco);
  } catch (error) {
    console.error("Restauração pendente ignorada:", error.message);
  }
}

app.use(express.json({ limit: "80mb" }));
app.use("/assets", express.static(path.join(pastaPublica, "assets")));

const auth = createAuth({
  databasePath: arquivoBanco,
});
auth.seedPrinters(tonerMonitor.printers);

app.get(["/login", "/login.html"], (req, res) => {
  res.sendFile(path.join(pastaPublica, "login.html"));
});

app.get(["/setup", "/setup.html"], (req, res) => {
  res.sendFile(path.join(pastaPublica, "setup.html"));
});

app.use("/api/auth", auth.router);

app.get(["/admin", "/admin.html"], auth.requireAuth, (req, res) => {
  if (req.user.role !== "master") {
    return res.redirect("/");
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.sendFile(path.join(pastaPublica, "admin.html"));
});

app.use(auth.requireAuth);
app.use((req, res, next) => {
  if (/\.(?:html|js|css)$/i.test(req.path)) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(pastaPublica));

let estadoAtualizacao = {
  executando: false,
  sucesso: null,
  mensagem: "Nenhuma atualização executada.",
  inicio: null,
  fim: null,
  log: [],
};

let tonerExecutando = false;

function lerTonerAtual() {
  try {
    return JSON.parse(fs.readFileSync(arquivoToner, "utf8"));
  } catch {
    return {
      updatedAt: null,
      threshold: 20,
      summary: { total: auth.getPrinters().filter((item) => item.active).length, online: 0, offline: 0, critical: 0, warning: 0 },
      printers: auth.getPrinters().filter((item) => item.active).map(({ ip, model, location }) => ({
        ip,
        model,
        hostname: "",
        online: null,
        supplies: [],
        status: "unknown",
        location,
        cartridge: "Aguardando consulta SNMP",
      }))
    };
  }
}

function texto(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }

  return String(valor).trim();
}

function normalizar(valor) {
  return texto(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function obterLinhas(resultado) {
  if (!Array.isArray(resultado)) {
    return [];
  }

  /*
   * Algumas versões/bibliotecas retornam:
   * [{ sheet: "Sheet", data: [...] }]
   */
  if (
    resultado.length > 0 &&
    resultado[0] &&
    Array.isArray(resultado[0].data)
  ) {
    return resultado[0].data;
  }

  return resultado;
}

function encontrarColuna(cabecalho, nomes) {
  const cabecalhoNormalizado = cabecalho.map(normalizar);

  for (const nome of nomes) {
    const indice = cabecalhoNormalizado.findIndex(
      (coluna) => coluna === normalizar(nome)
    );

    if (indice >= 0) {
      return indice;
    }
  }

  return -1;
}

function valorDaColuna(linha, indice) {
  if (indice < 0 || indice >= linha.length) {
    return "";
  }

  return texto(linha[indice]);
}

function adicionarLog(mensagem) {
  const linhas = String(mensagem)
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter(Boolean);

  for (const linha of linhas) {
    console.log(`[AUTOMAÇÃO] ${linha}`);

    estadoAtualizacao.log.push(linha);

    /*
     * Evita que o histórico cresça indefinidamente.
     */
    if (estadoAtualizacao.log.length > 100) {
      estadoAtualizacao.log.shift();
    }
  }
}

async function lerPlanilha() {
  if (!fs.existsSync(arquivoPlanilha)) {
    throw new Error(
      "A planilha estoque-atual.xlsx ainda não foi encontrada."
    );
  }

  const modulo = await import("read-excel-file/node");
  const readXlsxFile = modulo.default || modulo;

  const resultado = await readXlsxFile(arquivoPlanilha);
  const linhas = obterLinhas(resultado);

  if (!linhas.length) {
    throw new Error("A planilha está vazia.");
  }

  /*
   * Localiza a linha real dos títulos da tabela.
   */
  const indiceCabecalho = linhas.findIndex((linha) => {
    const colunas = linha.map(normalizar);

    return (
      colunas.includes("CODIGO") &&
      colunas.includes("MODELO")
    );
  });

  if (indiceCabecalho < 0) {
    throw new Error(
      "Não foi possível localizar as colunas do relatório NXT4Insight."
    );
  }

  const cabecalho = linhas[indiceCabecalho];

  const colunaProprietario = encontrarColuna(
    cabecalho,
    ["Proprietário", "Proprietario"]
  );

  const colunaAlocado = encontrarColuna(
    cabecalho,
    ["Alocado para"]
  );

  const colunaCodigo = encontrarColuna(
    cabecalho,
    ["Código", "Codigo"]
  );

  const colunaFabricante = encontrarColuna(
    cabecalho,
    ["Fabricante"]
  );

  const colunaMarca = encontrarColuna(
    cabecalho,
    ["Marca"]
  );

  const colunaModelo = encontrarColuna(
    cabecalho,
    ["Modelo"]
  );

  const ativos = [];
  let categoriaAtual = "";

  for (
    let indice = indiceCabecalho + 1;
    indice < linhas.length;
    indice++
  ) {
    const linha = linhas[indice];

    if (!Array.isArray(linha)) {
      continue;
    }

    const conteudoLinha = linha
      .map(texto)
      .filter(Boolean)
      .join(" ");

    /*
     * Exemplo encontrado no relatório:
     * Tipo do ativo: CARREGADOR (Contagem: 13)
     */
    const categoriaEncontrada = conteudoLinha.match(
      /Tipo\s+do\s+ativo\s*:\s*(.+?)(?:\s*\(Contagem\s*:\s*\d+\))?$/i
    );

    if (categoriaEncontrada) {
      categoriaAtual = categoriaEncontrada[1]
        .replace(/\s*\(Contagem.*$/i, "")
        .trim();

      continue;
    }

    if (!categoriaAtual) {
      continue;
    }

    const codigo = valorDaColuna(
      linha,
      colunaCodigo
    );

    const modelo = valorDaColuna(
      linha,
      colunaModelo
    );

    const fabricante = valorDaColuna(
      linha,
      colunaFabricante
    );

    const marca = valorDaColuna(
      linha,
      colunaMarca
    );

    const proprietario = valorDaColuna(
      linha,
      colunaProprietario
    );

    const alocadoPara = valorDaColuna(
      linha,
      colunaAlocado
    );

    /*
     * Ignora linhas de agrupamento, filtros ou linhas vazias.
     */
    if (
      !codigo &&
      !modelo &&
      !fabricante &&
      !marca
    ) {
      continue;
    }

    ativos.push({
      categoria: categoriaAtual,
      proprietario,
      alocadoPara,
      codigo,
      fabricante,
      marca,
      modelo: modelo || "NÃO INFORMADO",
    });
  }

  if (!ativos.length) {
    throw new Error(
      "Nenhum ativo foi encontrado dentro da planilha."
    );
  }

  const mapaCategorias = new Map();

  for (const ativo of ativos) {
    const nomeCategoria =
      ativo.categoria || "SEM CATEGORIA";

    if (!mapaCategorias.has(nomeCategoria)) {
      mapaCategorias.set(nomeCategoria, {
        nome: nomeCategoria,
        atual: 0,
        quantidade: 0,
        modelos: new Map(),
      });
    }

    const categoria = mapaCategorias.get(
      nomeCategoria
    );

    categoria.atual++;
    categoria.quantidade++;

    const nomeModelo =
      ativo.modelo || "NÃO INFORMADO";

    categoria.modelos.set(
      nomeModelo,
      (categoria.modelos.get(nomeModelo) || 0) + 1
    );
  }

  const categorias = Array.from(
    mapaCategorias.values()
  )
    .map((categoria) => ({
      nome: categoria.nome,
      atual: categoria.atual,
      quantidade: categoria.quantidade,
      modelos: Array.from(
        categoria.modelos.entries()
      )
        .map(([nome, quantidade]) => ({
          nome,
          quantidade,
        }))
        .sort(
          (a, b) =>
            b.quantidade - a.quantidade ||
            a.nome.localeCompare(b.nome, "pt-BR")
        ),
    }))
    .sort(
      (a, b) =>
        b.atual - a.atual ||
        a.nome.localeCompare(b.nome, "pt-BR")
    );

  const informacoesArquivo =
    fs.statSync(arquivoPlanilha);

  return {
    sucesso: true,

    /*
     * Campos principais usados pelo dashboard.
     */
    totalAtivos: ativos.length,
    totalCategorias: categorias.length,
    categorias,
    ativos,

    arquivo: {
      nome: path.basename(arquivoPlanilha),
      atualizadoEm:
        informacoesArquivo.mtime.toISOString(),
    },

    /*
     * Campos alternativos para manter compatibilidade
     * com a primeira versão do dashboard.
     */
    total: ativos.length,
    nomeArquivo: path.basename(arquivoPlanilha),
    atualizadoEm:
      informacoesArquivo.mtime.toISOString(),
  };
}


function lerConfiguracaoEnv() {
  try {
    return dotenv.parse(fs.readFileSync(arquivoEnv, "utf8"));
  } catch {
    return {};
  }
}

function salvarConfiguracaoEnv(changes) {
  const current = { ...lerConfiguracaoEnv(), ...changes };
  const content = Object.entries(current)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => key + "=" + JSON.stringify(String(value).replace(/[\r\n]/g, "")))
    .join("\n") + "\n";
  fs.mkdirSync(path.dirname(arquivoEnv), { recursive: true });
  fs.writeFileSync(arquivoEnv, content, "utf8");
  Object.assign(process.env, changes);
}

function formatBytes(value) {
  const units=["B","KB","MB","GB","TB"];let n=Number(value)||0,index=0;
  while(n>=1024&&index<units.length-1){n/=1024;index++;}
  return n.toFixed(index?1:0)+" "+units[index];
}

app.get("/api/system/health", auth.requireMaster, (req,res) => {
  let disk={free:"Indisponível",total:"Indisponível"};
  try { const info=fs.statfsSync(pastaDados);disk={free:formatBytes(info.bavail*info.bsize),total:formatBytes(info.blocks*info.bsize)}; } catch {}
  let databaseOk=false,databaseMessage="";
  try { const result=auth.database.prepare("PRAGMA quick_check").get();databaseMessage=String(Object.values(result)[0]);databaseOk=databaseMessage.toLowerCase()==="ok"; } catch(error){databaseMessage=error.message;}
  let spreadsheet=null;try{spreadsheet=fs.statSync(arquivoPlanilha).mtime.toISOString();}catch{}
  const toner=lerTonerAtual();
  const recentErrors=auth.database.prepare("SELECT error,created_at AS createdAt FROM notification_log WHERE status='error' ORDER BY id DESC LIMIT 5").all();
  res.json({sucesso:true,health:{
    database:{ok:databaseOk,message:databaseMessage,path:arquivoBanco},
    lastSpreadsheet:spreadsheet,lastNxtUpdate:estadoAtualizacao.fim,lastSnmp:toner.updatedAt||null,
    disk:disk,server:{host:HOST,port:PORTA,url:"http://"+(HOST==="0.0.0.0"?os.hostname():HOST)+":"+PORTA},
    uptimeSeconds:Math.round(process.uptime()),node:process.version,recentErrors:recentErrors
  }});
});

app.get("/api/system/backup", auth.requireMaster, (req,res) => {
  const destination=path.join(pastaDados,"backup-"+Date.now()+".db");
  try {
    auth.database.exec("PRAGMA wal_checkpoint(FULL)");
    auth.database.exec("VACUUM INTO '"+destination.replace(/'/g,"''")+"'");
    res.download(destination,"central-operacoes-backup-"+new Date().toISOString().slice(0,10)+".db",function(){try{fs.rmSync(destination);}catch{}});
    auth.addAudit(req.user.id,"export","database","","Backup do banco baixado");
  } catch(error) { try{fs.rmSync(destination);}catch{} res.status(500).json({sucesso:false,mensagem:"Não foi possível gerar o backup: "+error.message}); }
});

app.post("/api/system/restore", auth.requireMaster, (req,res) => {
  try {
    const buffer=Buffer.from(String(req.body.databaseBase64||""),"base64");
    if(buffer.length<100||buffer.subarray(0,16).toString("utf8")!=="SQLite format 3\u0000")throw new Error("O arquivo não é um banco SQLite válido.");
    fs.writeFileSync(arquivoRestauracao,buffer);
    const probe=new DatabaseSync(arquivoRestauracao,{readOnly:true});
    const tables=probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function(row){return row.name;});
    const check=probe.prepare("PRAGMA integrity_check").get();probe.close();
    if(!tables.includes("users")||String(Object.values(check)[0]).toLowerCase()!=="ok")throw new Error("O backup está incompleto ou corrompido.");
    auth.addAudit(req.user.id,"restore","database","","Restauração agendada");
    res.json({sucesso:true,restartRequired:true,mensagem:"Backup validado. Reinicie o servidor para concluir a restauração."});
  } catch(error){try{fs.rmSync(arquivoRestauracao);}catch{}res.status(400).json({sucesso:false,mensagem:error.message});}
});

async function sendTeamsNotification(webhook,title,message,details) {
  const body=[
    {type:"TextBlock",weight:"Bolder",size:"Medium",color:"Good",text:title},
    {type:"TextBlock",wrap:true,text:message}
  ];
  const facts=Object.entries(details||{}).filter(function(entry){return entry[1]!==undefined&&entry[1]!==null&&String(entry[1]).trim();}).map(function(entry){return{title:String(entry[0]),value:String(entry[1])};});
  if(facts.length)body.push({type:"FactSet",facts:facts});
  body.push({type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:"Central de Operações de TI · "+new Date().toLocaleString("pt-BR")});
  const payload={type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{type:"AdaptiveCard",version:"1.4",body:body}}]};
  const response=await fetch(webhook,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  if(!response.ok)throw new Error("Teams respondeu HTTP "+response.status);
}

function sendEmailNotification(settings,title,message) {
  return new Promise(function(resolve,reject){
    const smtp=auth.getSetting("notifications_smtp_host",""),from=auth.getSetting("notifications_email_from",""),to=settings.emailTo;
    if(!smtp||!from||!to)return reject(new Error("Configure servidor SMTP, remetente e destinatário."));
    const script='$p=$env:NXT_SMTP_PORT; $c=New-Object Net.Mail.SmtpClient($env:NXT_SMTP_HOST,[int]$p); $c.EnableSsl=$env:NXT_SMTP_SSL -eq "1"; if($env:NXT_SMTP_USER){$c.Credentials=New-Object Net.NetworkCredential($env:NXT_SMTP_USER,$env:NXT_SMTP_PASS)}; $m=New-Object Net.Mail.MailMessage($env:NXT_MAIL_FROM,$env:NXT_MAIL_TO,$env:NXT_MAIL_SUBJECT,$env:NXT_MAIL_BODY); $c.Send($m)';
    const encoded=Buffer.from(script,"utf16le").toString("base64");
    const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],{windowsHide:true,env:{...process.env,NXT_SMTP_HOST:smtp,NXT_SMTP_PORT:auth.getSetting("notifications_smtp_port","587"),NXT_SMTP_SSL:auth.getSetting("notifications_smtp_ssl","1"),NXT_SMTP_USER:auth.getSetting("notifications_smtp_user",""),NXT_SMTP_PASS:auth.getSetting("notifications_smtp_password",""),NXT_MAIL_FROM:from,NXT_MAIL_TO:to,NXT_MAIL_SUBJECT:title,NXT_MAIL_BODY:message}});
    let error="";child.stderr.on("data",function(d){error+=d.toString();});child.on("error",reject);child.on("close",function(code){code===0?resolve():reject(new Error(error||"Falha SMTP"));});
  });
}

async function dispatchNotification(eventKey,eventType,title,message,force,details) {
  const db=auth.database;
  if(!force&&db.prepare("SELECT id FROM notification_log WHERE event_key=? AND status=\'sent\'").get(eventKey))return false;
  const enabled=auth.getSetting("notifications_enabled","0")==="1";if(!enabled&&!force)return false;
  const channel=auth.getSetting("notifications_channel","teams"),settings={emailTo:auth.getSetting("notifications_email_to","")};
  let status="sent",error="";
  try {
    if(channel==="teams"||channel==="both"){const hook=auth.getSetting("notifications_teams_webhook","");if(!hook)throw new Error("Webhook do Teams não configurado.");await sendTeamsNotification(hook,title,message,details);}
    if(channel==="email"||channel==="both")await sendEmailNotification(settings,title,message);
  } catch(e){status="error";error=e.message;}
  db.prepare("INSERT OR REPLACE INTO notification_log (event_key,event_type,title,message,channel,status,created_at,sent_at,error) VALUES (?,?,?,?,?,?,?,?,?)").run(eventKey,eventType,title,message,channel,status,new Date().toISOString(),status==="sent"?new Date().toISOString():"",error);
  return status==="sent";
}

function requestStatusLabel(status) {
  return ({draft:"Rascunho",awaiting_approval:"Aguardando aprovação",approved:"Aprovada",sc_open:"SC aberta",purchasing:"Em compra",partial_received:"Recebimento parcial",finished:"Finalizada"})[status]||status;
}
async function notifyRestockRequest(request, action) {
  if(!request)return false;
  const total=(request.items||[]).reduce(function(sum,item){return sum+Number(item.quantity||0);},0);
  const received=(request.items||[]).reduce(function(sum,item){return sum+Number(item.receivedQuantity||0);},0);
  const products=(request.items||[]).map(function(item){return item.categoryName+" ("+item.quantity+")";}).join(", ");
  const title=action==="created"?"Nova solicitação de compra":"Solicitação de compra atualizada";
  const message=action==="created"
    ?"Uma nova necessidade de reposição foi registrada e precisa de acompanhamento."
    :"O andamento da compra foi alterado. O canal está sendo atualizado automaticamente.";
  return dispatchNotification("purchase:"+request.id+":"+request.status+":"+String(request.updatedAt||Date.now()),"purchase",title,message,false,{
    "Solicitação":"#"+request.id,"Status":requestStatusLabel(request.status),"Itens":products||"Não informado",
    "Solicitado":total+" unidade(s)","Recebido":received+" unidade(s)","Pendente":Math.max(0,total-received)+" unidade(s)",
    "Número da SC":request.scNumber||"Ainda não informado","Responsável":request.buyer||request.updatedBy||"Não definido",
    "Previsão":request.expectedAt||"Não definida"
  });
}
async function sendStartupDigest(force) {
  if(auth.getSetting("notifications_enabled","0")!=="1"){if(force)throw new Error("Ative e salve as notificações antes de enviar o resumo.");return false;}
  let shortages=[],critical=0,openRequests=0;
  try{
    const stock=await lerPlanilha(),cats=stock.categorias||[];
    auth.getMinimums().filter(function(item){return item.monitored&&Number(item.minimum)>0;}).forEach(function(rule){
      const normalized=String(rule.categoryName||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
      const found=cats.find(function(cat){const name=String(cat.nome||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();return name===normalized||name.includes(normalized)||normalized.includes(name);});
      const current=found?Number(found.atual)||0:0,missing=Math.max(0,Number(rule.minimum)-current);
      if(missing)shortages.push(rule.categoryName+": comprar "+missing);
    });
  }catch{}
  try{const toner=lerTonerAtual();critical=Number(toner.summary&&toner.summary.critical)||0;}catch{}
  try{openRequests=auth.getRestockRequests().filter(function(item){return item.status!=="finished";}).length;}catch{}
  return dispatchNotification((force?"manual-digest:":"startup-digest:")+Date.now(),"startup","Servidor ativo · resumo operacional",
    shortages.length?"Existem itens abaixo do estoque mínimo que precisam de compra.":"O servidor foi iniciado e não existem faltas de estoque monitoradas.",false,{
      "Itens para comprar":shortages.length?shortages.join(" · "):"Nenhum",
      "Toners críticos":critical,"Solicitações abertas":openRequests,
      "Endereço":"http://"+(HOST==="0.0.0.0"?os.hostname():HOST)+":"+PORTA
    });
}

async function evaluateNotifications() {
  const events=[],today=new Date(),lead=Math.max(0,Number(auth.getSetting("notifications_task_lead_days","2"))||2),stale=Math.max(1,Number(auth.getSetting("notifications_stale_days","5"))||5);
  auth.database.prepare("SELECT id,title,due_date AS dueDate FROM operational_tasks WHERE status!='done' AND due_date!=''").all().forEach(function(task){const days=Math.ceil((new Date(task.dueDate+"T23:59:59")-today)/86400000);if(days<=lead)events.push({key:"task:"+task.id+":"+task.dueDate,type:"task",title:"Tarefa próxima do vencimento",message:task.title+" · "+(days<0?"atrasada há "+Math.abs(days)+" dia(s)":"vence em "+days+" dia(s)")});});
  auth.database.prepare("SELECT id,status,updated_at AS updatedAt FROM restock_requests WHERE status!='received'").all().forEach(function(item){const days=Math.floor((today-new Date(item.updatedAt))/86400000);if(days>=stale)events.push({key:"request:"+item.id+":"+item.updatedAt.slice(0,10),type:"request",title:"Solicitação sem atualização",message:"Solicitação #"+item.id+" está há "+days+" dia(s) sem atualização."});});
  auth.database.prepare("SELECT employee_key AS employeeKey,employee_name AS employeeName,activation_date AS activationDate FROM vacation_access_plans WHERE completed=0 AND activation_date!=''").all().forEach(function(plan){if(plan.activationDate<=today.toISOString().slice(0,10))events.push({key:"vacation:"+plan.employeeKey+":"+plan.activationDate,type:"vacation",title:"Retorno de férias",message:plan.employeeName+" retorna em "+plan.activationDate+". Confira a reativação dos acessos."});});
  try {
    const stock=await lerPlanilha(),rows=Array.isArray(stock.ativos)?stock.ativos:[],counts={};
    rows.forEach(function(item){const name=String(item.tipoAtivo||item.tipo||item.categoria||item.category||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();if(name)counts[name]=(counts[name]||0)+1;});
    auth.getMinimums().filter(function(item){return item.monitored&&item.minimum>0;}).forEach(function(item){const current=counts[item.categoryKey]||0;if(current<item.minimum)events.push({key:"stock:"+item.categoryKey+":"+today.toISOString().slice(0,10),type:"stock",title:"Estoque abaixo do mínimo",message:item.categoryName+" possui "+current+" unidade(s); mínimo definido: "+item.minimum+".",details:{"Item":item.categoryName,"Estoque atual":current,"Estoque mínimo":item.minimum,"Comprar":item.minimum-current}});});
  } catch {}
  const toner=lerTonerAtual();(toner.printers||[]).forEach(function(p){(p.supplies||[]).forEach(function(supply){if(Number(supply.level ?? supply.percent)<=Number(toner.threshold||20))events.push({key:"toner:"+p.ip+":"+String(supply.name||supply.description)+":"+today.toISOString().slice(0,10),type:"toner",title:"Toner em nível crítico",message:(p.model||p.ip)+" · "+(supply.name||"Suprimento")+" em "+supply.level+"%."});});});
  for(const event of events)await dispatchNotification(event.key,event.type,event.title,event.message,false,event.details);
  return events.length;
}
app.post("/api/notifications/test", auth.requireMaster, async(req,res)=>{const ok=await dispatchNotification("test:"+Date.now(),"test","Teste de notificações","A Central de Operações de TI está conectada.",true);res.status(ok?200:500).json({sucesso:ok,mensagem:ok?"Notificação enviada.":"Falha no envio. Consulte o histórico."});});
app.post("/api/notifications/run", auth.requireMaster, async(req,res)=>{const total=await evaluateNotifications();res.json({sucesso:true,total});});
app.post("/api/notifications/digest", auth.requireMaster, async(req,res)=>{try{await sendStartupDigest(true);res.json({sucesso:true,mensagem:"Resumo operacional enviado ao Teams."});}catch(error){res.status(500).json({sucesso:false,mensagem:error.message});}});
setTimeout(function(){
  evaluateNotifications().then(function(){return sendStartupDigest(false);}).catch(function(error){console.error("Notificações ao iniciar:",error.message);});
},5000).unref();
setInterval(function(){evaluateNotifications().catch(function(error){console.error("Notificações:",error.message);});},15*60*1000).unref();

app.get("/api/configuracao/nxt", auth.requireMaster, (req, res) => {
  res.json({
    sucesso: true,
    email: process.env.NXT_EMAIL || "",
    senhaConfigurada: Boolean(process.env.NXT_PASSWORD),
  });
});

app.put("/api/configuracao/nxt", auth.requireMaster, (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  if (!email) return res.status(400).json({ sucesso: false, mensagem: "Informe o usuário ou e-mail do NXT." });
  if (!password && !process.env.NXT_PASSWORD) {
    return res.status(400).json({ sucesso: false, mensagem: "Informe a senha do NXT." });
  }
  const changes = { NXT_EMAIL: email };
  if (password) changes.NXT_PASSWORD = password;
  salvarConfiguracaoEnv(changes);
  return res.json({ sucesso: true, email, senhaConfigurada: true });
});

/*
 * Regras de estoque mínimo persistidas no banco local.
 */
app.get("/api/minimos", auth.requirePermission("stock"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    itens: auth.getMinimums(),
    podeEditar: req.user.role === "master",
  });
});

app.put(
  "/api/minimos",
  auth.requireMaster,
  (req, res) => {
    const itens = Array.isArray(req.body.itens)
      ? req.body.itens.slice(0, 500)
      : [];

    const salvos = auth.saveMinimums(
      itens,
      Number(req.user.id)
    );

    res.json({
      sucesso: true,
      itens: salvos,
    });
  }
);

/*
 * Solicitações de reposição e acompanhamento de compra.
 */
app.get("/api/solicitacoes", auth.requirePermission("stock"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    solicitacoes: auth.getRestockRequests(),
    podeEditar: req.user.role === "master" || auth.userPermissions(req.user).create_requests,
  });
});

app.post(
  "/api/solicitacoes",
  auth.requirePermission("create_requests"),
  (req, res) => {
    try {
      const solicitacao = auth.createRestockRequest(
        req.body.itens,
        req.body.observacao,
        Number(req.user.id)
      );

      res.status(201).json({
        sucesso: true,
        solicitacao,
      });
      notifyRestockRequest(solicitacao, "created").catch(function(error){ console.error("Teams · solicitação:", error.message); });
    } catch (erro) {
      res.status(400).json({
        sucesso: false,
        mensagem: erro.message,
      });
    }
  }
);

app.patch(
  "/api/solicitacoes/:id",
  auth.requirePermission("create_requests"),
  (req, res) => {
    let solicitacao;

    try {
      solicitacao = auth.updateRestockRequest(
        Number(req.params.id),
        {
          status: req.body.status,
          notes: req.body.observacao,
          scNumber: req.body.numeroSc,
          openedAt: req.body.dataAbertura,
          buyer: req.body.responsavelCompra,
          expectedAt: req.body.previsaoEntrega,
          items: req.body.itens,
        },
        Number(req.user.id)
      );
    } catch (erro) {
      return res.status(400).json({
        sucesso: false,
        mensagem: erro.message,
      });
    }

    if (!solicitacao) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Solicitação não encontrada.",
      });
    }

    res.json({
      sucesso: true,
      solicitacao,
    });
    notifyRestockRequest(solicitacao, "updated").catch(function(error){ console.error("Teams · solicitação:", error.message); });
    return;
  }
);

app.delete(
  "/api/solicitacoes/:id",
  auth.requireMaster,
  (req, res) => {
    const existingRequest = auth.getRestockRequests().find(function(item){ return item.id === Number(req.params.id); });
    const removida = auth.deleteRestockRequest(
      Number(req.params.id)
    );

    if (!removida) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Solicitação não encontrada.",
      });
    }

    res.json({
      sucesso: true,
      mensagem: "Solicitação excluída.",
    });
    if(existingRequest)dispatchNotification("purchase-deleted:"+existingRequest.id+":"+Date.now(),"purchase","Solicitação de compra excluída","Uma solicitação foi removida pelo Master Admin.",false,{"Solicitação":"#"+existingRequest.id,"Responsável":req.user.username||"Master Admin"}).catch(function(error){console.error("Teams · exclusão:",error.message);});
    return;
  }
);


app.get("/api/impressoras", auth.requirePermission("toner"), (req, res) => {
  res.json({
    sucesso: true,
    impressoras: auth.getPrinters(),
    podeEditar: ["master", "operator"].includes(req.user.role),
  });
});

app.post("/api/impressoras", auth.requirePermission("toner"), (req, res) => {
  try {
    const impressora = auth.savePrinter(req.body, Number(req.user.id));
    auth.addAudit(req.user.id, "create", "printer", String(impressora.id), "Impressora cadastrada: " + impressora.ip);
    return res.status(201).json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.patch("/api/impressoras/:id", auth.requirePermission("toner"), (req, res) => {
  try {
    const impressora = auth.savePrinter(req.body, Number(req.user.id), Number(req.params.id));
    if (!impressora) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
    auth.addAudit(req.user.id, "update", "printer", String(impressora.id), "Impressora atualizada: " + impressora.ip);
    return res.json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.delete("/api/impressoras/:id", auth.requirePermission("toner"), (req, res) => {
  const deleted = auth.deletePrinter(Number(req.params.id));
  if (!deleted) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
  auth.addAudit(req.user.id, "delete", "printer", String(req.params.id), "Impressora removida");
  return res.json({ sucesso: true });
});

app.get("/api/configuracao/toner", auth.requireAuth, (req, res) => {
  const limite = Math.max(1, Math.min(99, Number(auth.getSetting("toner_threshold", "20")) || 20));
  res.json({ sucesso: true, limite, podeEditar: req.user.role === "master" });
});

app.put("/api/configuracao/toner", auth.requireMaster, (req, res) => {
  const limite = Number.parseInt(req.body?.limite, 10);
  if (!Number.isInteger(limite) || limite < 1 || limite > 99) {
    return res.status(400).json({ sucesso: false, mensagem: "Informe um limite entre 1% e 99%." });
  }
  auth.setSetting("toner_threshold", String(limite), Number(req.user.id));
  auth.addAudit(req.user.id, "update", "toner_threshold", "", "Limite de toner alterado para " + limite + "%");
  return res.json({ sucesso: true, limite });
});

/*
 * Monitoramento local das impressoras por SNMP.
 */
app.get("/api/toner", auth.requirePermission("toner"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    executando: tonerExecutando,
    ...lerTonerAtual(),
  });
});

app.post(
  "/api/toner/atualizar",
  auth.requirePermission("toner"),
  async (req, res) => {
    if (tonerExecutando) {
      return res.status(409).json({
        sucesso: false,
        mensagem: "A consulta das impressoras já está em andamento.",
      });
    }

    tonerExecutando = true;

    try {
      const impressoras = auth.getPrinters()
        .filter((item) => item.active)
        .map((item) => [item.ip, item.model]);
      const relatorio = await tonerMonitor.scan({
        threshold: Math.max(1, Math.min(99, Number(auth.getSetting("toner_threshold", "20")) || 20)),
        printers: impressoras,
      });

      fs.mkdirSync(path.dirname(arquivoToner), { recursive: true });
      fs.writeFileSync(
        arquivoToner,
        JSON.stringify(relatorio, null, 2),
        "utf8"
      );
      auth.recordTonerSnapshot(relatorio);

      return res.json({
        sucesso: true,
        executando: false,
        ...relatorio,
      });
    } catch (erro) {
      return res.status(500).json({
        sucesso: false,
        mensagem: "Não foi possível consultar as impressoras: " + erro.message,
      });
    } finally {
      tonerExecutando = false;
    }
  }
);

/*
 * Retorna os dados da planilha para o dashboard.
 */
app.get("/api/estoque", auth.requirePermission("stock"), async (req, res) => {
  try {
    const dados = await lerPlanilha();

    res.setHeader("Cache-Control", "no-store");
    res.json(dados);
  } catch (erro) {
    console.error(
      "Erro ao ler a planilha:",
      erro.message
    );

    res.status(500).json({
      sucesso: false,
      mensagem: erro.message,
    });
  }
});

/*
 * Informa se a automação ainda está trabalhando.
 */
app.get("/api/atualizacao", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(estadoAtualizacao);
});

/*
 * Inicia o Playwright.
 *
 * O dashboard recebe a resposta imediatamente e acompanha
 * o andamento pela rota /api/atualizacao.
 */
app.post(
  "/api/atualizar",
  auth.requireUpdatePermission,
  (req, res) => {
  if (estadoAtualizacao.executando) {
    return res.status(409).json({
      sucesso: false,
      mensagem: "A atualização já está em andamento.",
    });
  }

  if (!fs.existsSync(arquivoAutomacao)) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "O arquivo automacao.js não foi encontrado.",
    });
  }

  if (
    !process.env.NXT_EMAIL ||
    !process.env.NXT_PASSWORD
  ) {
    return res.status(400).json({
      sucesso: false,
      mensagem:
        "As credenciais do NXT não estão carregadas nesta janela do PowerShell.",
    });
  }

  estadoAtualizacao = {
    executando: true,
    sucesso: null,
    mensagem:
      "Abrindo o NXT4Insight e atualizando a planilha...",
    inicio: new Date().toISOString(),
    fim: null,
    log: [],
  };

  console.log("");
  console.log("Iniciando atualização pelo dashboard...");

  const processo = spawn(
    process.execPath,
    [arquivoAutomacao],
    {
      cwd: pastaProjeto,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : process.env.ELECTRON_RUN_AS_NODE,
      },
      windowsHide: process.env.NXT_AUTOMATION_HEADLESS === "1",
      shell: false,
    }
  );

  let finalizado = false;

  const limiteTempo = setTimeout(() => {
    if (finalizado) {
      return;
    }

    adicionarLog(
      "O tempo máximo da automação foi atingido."
    );

    processo.kill();

    estadoAtualizacao = {
      ...estadoAtualizacao,
      executando: false,
      sucesso: false,
      mensagem:
        "A automação ultrapassou o tempo máximo de 15 minutos.",
      fim: new Date().toISOString(),
    };
  }, 15 * 60 * 1000);

  processo.stdout.on("data", (dados) => {
    adicionarLog(dados.toString());
  });

  processo.stderr.on("data", (dados) => {
    adicionarLog(dados.toString());
  });

  processo.on("error", (erro) => {
    finalizado = true;
    clearTimeout(limiteTempo);

    estadoAtualizacao = {
      ...estadoAtualizacao,
      executando: false,
      sucesso: false,
      mensagem: `Não foi possível iniciar a automação: ${erro.message}`,
      fim: new Date().toISOString(),
    };

    console.error(estadoAtualizacao.mensagem);
  });

  processo.on("close", (codigo) => {
    if (finalizado) {
      return;
    }

    finalizado = true;
    clearTimeout(limiteTempo);

    if (codigo === 0) {
      estadoAtualizacao = {
        ...estadoAtualizacao,
        executando: false,
        sucesso: true,
        mensagem:
          "Planilha atualizada com sucesso. Atualizando o dashboard...",
        fim: new Date().toISOString(),
      };

      console.log(
        "Atualização finalizada com sucesso."
      );
    } else {
      estadoAtualizacao = {
        ...estadoAtualizacao,
        executando: false,
        sucesso: false,
        mensagem:
          "A automação não conseguiu concluir o download. Consulte o histórico apresentado no dashboard.",
        fim: new Date().toISOString(),
      };

      console.error(
        `Automação encerrada com o código ${codigo}.`
      );
    }
  });

  return res.status(202).json({
    sucesso: true,
    mensagem: "Atualização iniciada.",
  });
  }
);

/*
 * Se a pessoa digitar uma rota inexistente,
 * retorna o dashboard principal.
 */
app.use((req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }

  res.sendFile(
    path.join(pastaPublica, "index.html")
  );
});

const servidor = app.listen(PORTA, HOST, () => {
  const endereco = servidor.address();
  const portaAtiva = typeof endereco === "object" && endereco
    ? endereco.port
    : PORTA;

  console.log("");
  console.log("Servidor do dashboard iniciado.");
  const hostAcesso = HOST === "0.0.0.0" ? "IP-DO-SERVIDOR" : HOST;
  console.log(`Acesse: http://${hostAcesso}:${portaAtiva}`);
  console.log(`Dados: ${pastaDados}`);
  console.log(`Planilha: ${arquivoPlanilha}`);
  console.log("");
});

module.exports = { app, servidor };
