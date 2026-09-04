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
auth.database.exec(
  "CREATE TABLE IF NOT EXISTS stock_snapshots ("
  + "id INTEGER PRIMARY KEY AUTOINCREMENT,snapshot_date TEXT NOT NULL,captured_at TEXT NOT NULL,"
  + "categories_json TEXT NOT NULL,assets_json TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL DEFAULT 'manual'"
  + ");"
  + "CREATE INDEX IF NOT EXISTS idx_stock_snapshots_date ON stock_snapshots(snapshot_date,captured_at);"
);
const stockSnapshotColumns=auth.database.prepare("PRAGMA table_info(stock_snapshots)").all().map(function(column){return column.name;});
if(!stockSnapshotColumns.includes("assets_json"))auth.database.exec("ALTER TABLE stock_snapshots ADD COLUMN assets_json TEXT NOT NULL DEFAULT '[]'");

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

app.get(["/configuracoes", "/configuracoes.html"], auth.requireAuth, (req, res) => {
  if (req.user.role !== "master") return res.redirect("/");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  return res.sendFile(path.join(pastaPublica, "configuracoes.html"));
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

async function sendTeamsNotification(webhook,title,message,details,eventType) {
  const visual={
    "stock-summary":{icon:"📦",color:"Attention"},"toner-summary":{icon:"🖨️",color:"Attention"},
    "purchase":{icon:"🛒",color:"Accent"},"daily-stock":{icon:"📊",color:"Good"},
    "vacation":{icon:"👤",color:"Accent"},"task":{icon:"⏰",color:"Warning"},
    "request":{icon:"⚠️",color:"Warning"},"startup":{icon:"✅",color:"Good"},"test":{icon:"✅",color:"Good"}
  }[eventType]||{icon:"ℹ️",color:"Accent"};
  const body=[
    {type:"TextBlock",weight:"Bolder",size:"Medium",color:visual.color,text:visual.icon+" "+title}
  ];
  const printerGroups=eventType==="toner-summary"&&details&&Array.isArray(details.printerGroups)?details.printerGroups:null;
  if(printerGroups){
    body.push({type:"TextBlock",wrap:true,isSubtle:true,text:"Leve os consumíveis indicados abaixo para realizar cada troca."});
    printerGroups.forEach(function(item,index){
      const items=[
        {type:"TextBlock",weight:"Bolder",size:"Default",wrap:true,text:"Impressora "+(index+1)+" — "+item.printer},
        {type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:(item.ip?"IP: "+item.ip+"  •  ":"")+"Modelo: "+(item.model||"Não identificado")}
      ];
      (item.supplies||[]).forEach(function(supply){
        const brandMatch=String(supply.description||"").match(/\b(HP|Samsung|Epson|Brother|Lexmark|Xerox|Canon)\b/i);
        const fallback=supply.kind==="Toner"?item.cartridge:"Confirmar pelo código do consumível";
        const take=supply.code?((brandMatch?brandMatch[1].toUpperCase()+" ":"")+supply.code):fallback;
        const unitName=supply.kind==="Toner"?"toner":"consumível";
        items.push(
          {type:"TextBlock",wrap:true,spacing:"Medium",weight:"Bolder",color:"Attention",text:"• "+supply.description},
          {type:"FactSet",spacing:"Small",facts:[
            {title:"Nível",value:String(supply.level)+"%"},
            {title:"LEVAR PARA TROCA",value:"1 unidade do "+unitName+" "+take}
          ]}
        );
      });
      body.push({type:"Container",separator:true,spacing:"Medium",style:index%2?"emphasis":"default",items:items});
    });
  } else {
    body.push({type:"TextBlock",wrap:true,text:message});
    const facts=Object.entries(details||{}).filter(function(entry){return entry[1]!==undefined&&entry[1]!==null&&String(entry[1]).trim();}).map(function(entry){return{title:String(entry[0]),value:String(entry[1])};});
    if(facts.length)body.push({type:"FactSet",facts:facts});
  }
  body.push({type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:"Central de Operações de TI · "+new Date().toLocaleString("pt-BR")});
  const dashboardUrl="http://"+(HOST==="0.0.0.0"?os.hostname():HOST)+":"+PORTA+"/central.html";
  const payload={type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{type:"AdaptiveCard",version:"1.4",body:body,actions:[{type:"Action.OpenUrl",title:"Abrir Central de Operações",url:dashboardUrl}]}}]};
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
    if(channel==="teams"||channel==="both"){const hook=auth.getSetting("notifications_teams_webhook","");if(!hook)throw new Error("Webhook do Teams não configurado.");await sendTeamsNotification(hook,title,message,details,eventType);}
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

async function buildOperationalSummaryEvents(force, selectedTypes) {
  const types=Array.isArray(selectedTypes)&&selectedTypes.length?selectedTypes:["stock","toner"];
  const events=[],timestamp=Date.now(),day=new Date().toISOString().slice(0,10);
  const keySuffix=force?String(timestamp):day;
  const stockAlerts=[];
  if(types.includes("stock"))try {
    const stock=await lerPlanilha(),categories=Array.isArray(stock.categorias)?stock.categorias:[],rows=Array.isArray(stock.ativos)?stock.ativos:[],counts={};
    rows.forEach(function(item){
      const name=String(item.tipoAtivo||item.tipo||item.categoria||item.category||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();
      if(name)counts[name]=(counts[name]||0)+1;
    });
    auth.getMinimums().filter(function(item){return item.monitored&&Number(item.minimum)>0;}).forEach(function(rule){
      const key=String(rule.categoryKey||rule.categoryName||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();
      const category=categories.find(function(item){
        const name=String(item.nome||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();
        return name===key||name.includes(key)||key.includes(name);
      });
      const current=category?Number(category.atual)||0:counts[key]||0;
      const buy=Math.max(0,Number(rule.minimum)-current);
      if(buy)stockAlerts.push({name:rule.categoryName,current:current,minimum:Number(rule.minimum),buy:buy});
    });
  } catch(error) { console.error("Resumo de estoque:",error.message); }
  if(stockAlerts.length){
    const details={};
    stockAlerts.forEach(function(item){details[item.name]="Atual: "+item.current+" · mínimo: "+item.minimum+" · comprar: "+item.buy;});
    events.push({
      key:"stock-summary:"+keySuffix,type:"stock-summary",title:"Estoque mínimo · compra necessária",
      message:stockAlerts.map(function(item){return "• "+item.name+": solicitar "+item.buy+" unidade(s)";}).join("\n"),
      details:details
    });
  }

  const tonerAlerts=[],toner=types.includes("toner")?lerTonerAtual():{printers:[],threshold:20},threshold=Number(toner.threshold||20);
  function supplyCode(description) {
    const matches=String(description||"").toUpperCase().match(/\b(?=[A-Z0-9-]{5,14}\b)(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]+\b/g)||[];
    return matches.length?matches[matches.length-1]:"";
  }
  (toner.printers||[]).forEach(function(printer){
    if(printer.online===false)return;
    const criticalSupplies=[];
    (printer.supplies||[]).forEach(function(supply){
      if(supply.isToner===false)return;
      const level=Number(supply.level??supply.percent);
      if(!Number.isFinite(level)||level>threshold)return;
      const description=String(supply.name||supply.description||"Toner");
      const code=String(supply.partNumber||supply.model||supplyCode(description));
      const collection=/(coleta|collection|waste|residu)/i.test(description);
      criticalSupplies.push({
        description:description,level:level,code:code,
        kind:collection?"Unidade de coleta":"Toner"
      });
    });
    if(criticalSupplies.length)tonerAlerts.push({
      printer:printer.hostname||printer.model||printer.ip,
      ip:printer.ip||"",model:printer.model||"",cartridge:printer.cartridge||"",
      supplies:criticalSupplies
    });
  });
  if(tonerAlerts.length){
    const message=tonerAlerts.map(function(item,index){
      const identity="Impressora "+(index+1)+" — "+item.printer+(item.ip?" ("+item.ip+")":"");
      const lines=item.supplies.map(function(supply){
        const fallback=supply.kind==="Toner"?item.cartridge:"Confirmar pelo código do consumível";
        const brandMatch=supply.description.match(/\b(HP|Samsung|Epson|Brother|Lexmark|Xerox|Canon)\b/i);
        const take=supply.code?((brandMatch?brandMatch[1].toUpperCase()+" ":"")+supply.code):fallback;
        return "• "+supply.description+": "+supply.level+"%\n  LEVAR PARA TROCA: "+take;
      });
      if(item.model)lines.push("  Modelo da impressora: "+item.model);
      return identity+"\n"+lines.join("\n");
    }).join("\n\n");
    events.push({
      key:"toner-summary:"+keySuffix,type:"toner-summary",title:"Impressoras · consumíveis em nível crítico",
      message:message,
      details:{printerGroups:tonerAlerts}
    });
  }
  return events;
}

async function sendOperationalSummaries(force, selectedTypes) {
  if(auth.getSetting("notifications_enabled","0")!=="1"){
    if(force)throw new Error("Ative e salve as notificações antes de enviar o resumo.");
    return 0;
  }
  const events=await buildOperationalSummaryEvents(Boolean(force),selectedTypes);
  for(const event of events)await dispatchNotification(event.key,event.type,event.title,event.message,false,event.details);
  return events.length;
}

async function evaluateNotifications() {
  const events=[],today=new Date(),lead=Math.max(0,Number(auth.getSetting("notifications_task_lead_days","2"))||2),stale=Math.max(1,Number(auth.getSetting("notifications_stale_days","5"))||5);
  auth.database.prepare("SELECT id,title,due_date AS dueDate FROM operational_tasks WHERE status!='done' AND due_date!=''").all().forEach(function(task){
    const days=Math.ceil((new Date(task.dueDate+"T23:59:59")-today)/86400000);
    if(days<=lead)events.push({key:"task:"+task.id+":"+task.dueDate,type:"task",title:"Tarefa próxima do vencimento",message:task.title+" · "+(days<0?"atrasada há "+Math.abs(days)+" dia(s)":"vence em "+days+" dia(s)")});
  });
  auth.database.prepare("SELECT id,status,updated_at AS updatedAt FROM restock_requests WHERE status!='received'").all().forEach(function(item){
    const days=Math.floor((today-new Date(item.updatedAt))/86400000);
    if(days>=stale)events.push({key:"request:"+item.id+":"+item.updatedAt.slice(0,10),type:"request",title:"Solicitação sem atualização",message:"Solicitação #"+item.id+" está há "+days+" dia(s) sem atualização."});
  });
  auth.database.prepare("SELECT employee_key AS employeeKey,employee_name AS employeeName,activation_date AS activationDate FROM vacation_access_plans WHERE completed=0 AND activation_date!=''").all().forEach(function(plan){
    if(plan.activationDate<=today.toISOString().slice(0,10))events.push({key:"vacation:"+plan.employeeKey+":"+plan.activationDate,type:"vacation",title:"Retorno de férias",message:plan.employeeName+" retorna em "+plan.activationDate+". Confira a reativação dos acessos."});
  });
  const summaries=await buildOperationalSummaryEvents(false,[auth.getSetting("notifications_stock","1")==="1"?"stock":"",auth.getSetting("notifications_toner","1")==="1"?"toner":""].filter(Boolean));
  events.push.apply(events,summaries);
  for(const event of events)await dispatchNotification(event.key,event.type,event.title,event.message,false,event.details);
  return events.length;
}
app.post("/api/notifications/test", auth.requireMaster, async(req,res)=>{const ok=await dispatchNotification("test:"+Date.now(),"test","Teste de notificações","A Central de Operações de TI está conectada.",true);res.status(ok?200:500).json({sucesso:ok,mensagem:ok?"Notificação enviada.":"Falha no envio. Consulte o histórico."});});
app.post("/api/notifications/run", auth.requireMaster, async(req,res)=>{const total=await evaluateNotifications();res.json({sucesso:true,total});});
app.post("/api/notifications/digest", auth.requireMaster, async(req,res)=>{try{const types=(Array.isArray(req.body&&req.body.types)?req.body.types:[]).filter(function(type){return type==="stock"||type==="toner";});const total=await sendOperationalSummaries(true,types);res.json({sucesso:true,total:total,mensagem:total?"Resumos de estoque e impressoras enviados ao Teams.":"Não há itens abaixo do mínimo nem toners críticos."});}catch(error){res.status(500).json({sucesso:false,mensagem:error.message});}});
setTimeout(function(){sendOperationalSummaries(true,[auth.getSetting("notifications_stock","1")==="1"?"stock":"",auth.getSetting("notifications_toner","1")==="1"?"toner":""].filter(Boolean)).then(function(total){console.log("Resumos operacionais enviados:",total);}).catch(function(error){console.error("Notificações ao iniciar:",error.message);});},5000).unref();
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
      captureStockSnapshot("manual").catch(function(error){console.error("Snapshot:",error.message);});
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

function localDateKey(value){const d=value||new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
async function captureStockSnapshot(source) {
  const stock=await lerPlanilha(),categories=(stock.categorias||[]).map(function(item){return{name:String(item.nome||""),quantity:Number(item.atual)||0};}).filter(function(item){return item.name;});
  const assets=(stock.ativos||[]).map(function(item){return{code:String(item.codigo||""),category:String(item.categoria||""),owner:String(item.proprietario||""),allocatedTo:String(item.alocadoPara||""),model:String(item.modelo||"")};});
  const now=new Date(),date=localDateKey(now);
  auth.database.prepare("INSERT INTO stock_snapshots (snapshot_date,captured_at,categories_json,assets_json,source) VALUES (?,?,?,?,?)").run(date,now.toISOString(),JSON.stringify(categories),JSON.stringify(assets),source||"manual");
  auth.database.prepare("DELETE FROM stock_snapshots WHERE captured_at < datetime('now','-60 days')").run();
  return categories;
}
function scheduledNxtUpdate() {
  if(estadoAtualizacao.executando||!fs.existsSync(arquivoAutomacao)||!process.env.NXT_EMAIL||!process.env.NXT_PASSWORD)return false;
  estadoAtualizacao={executando:true,sucesso:null,mensagem:"Atualização automática do NXT em andamento...",inicio:new Date().toISOString(),fim:null,log:[]};
  auth.setSetting("nxt_auto_update_last_attempt",new Date().toISOString(),null);
  const child=spawn(process.execPath,[arquivoAutomacao],{cwd:pastaProjeto,env:{...process.env,ELECTRON_RUN_AS_NODE:process.versions.electron?"1":process.env.ELECTRON_RUN_AS_NODE,NXT_AUTOMATION_HEADLESS:"1"},windowsHide:true,shell:false});
  const timeout=setTimeout(function(){child.kill();},15*60*1000);
  child.stdout.on("data",function(data){adicionarLog(data.toString());});
  child.stderr.on("data",function(data){adicionarLog(data.toString());});
  child.on("error",function(error){clearTimeout(timeout);estadoAtualizacao={...estadoAtualizacao,executando:false,sucesso:false,mensagem:"Falha na atualização automática: "+error.message,fim:new Date().toISOString()};});
  child.on("close",function(code){
    clearTimeout(timeout);
    estadoAtualizacao={...estadoAtualizacao,executando:false,sucesso:code===0,mensagem:code===0?"Atualização automática concluída.":"A atualização automática não foi concluída.",fim:new Date().toISOString()};
    if(code===0){auth.setSetting("nxt_auto_update_last_success",new Date().toISOString(),null);captureStockSnapshot("automatic").catch(function(error){console.error("Snapshot automático:",error.message);});}
  });
  return true;
}
async function sendDailyStockMovementReport() {
  if(auth.getSetting("notifications_enabled","0")!=="1"||auth.getSetting("daily_stock_report","0")!=="1")return false;
  const date=localDateKey(),rows=auth.database.prepare("SELECT categories_json AS categoriesJson,assets_json AS assetsJson,captured_at AS capturedAt FROM stock_snapshots WHERE snapshot_date=? ORDER BY captured_at").all(date);
  if(!rows.length)return false;
  function parse(row){try{return JSON.parse(row.categoriesJson||"[]");}catch{return[];}}
  const first=parse(rows[0]),last=parse(rows[rows.length-1]),names=new Set(first.concat(last).map(function(item){return item.name;})),changed=[],unchanged=[];
  names.forEach(function(name){const before=(first.find(function(item){return item.name===name;})||{quantity:0}).quantity,after=(last.find(function(item){return item.name===name;})||{quantity:0}).quantity,difference=after-before;const item={name:name,before:before,after:after,difference:difference};(difference?changed:unchanged).push(item);});
  function parseAssets(row){try{return JSON.parse(row.assetsJson||"[]");}catch{return[];}}
  const firstAssets=parseAssets(rows[0]),lastAssets=parseAssets(rows[rows.length-1]),assetKey=function(item,index){return item.code||[item.category,item.model,index].join("|");},beforeMap=new Map(firstAssets.map(function(item,index){return[assetKey(item,index),item];})),afterMap=new Map(lastAssets.map(function(item,index){return[assetKey(item,index),item];})),movements=[];
  afterMap.forEach(function(item,key){const previous=beforeMap.get(key);if(!previous)movements.push("Entrada · "+(item.code||item.model)+" · "+item.category);else if(previous.allocatedTo!==item.allocatedTo||previous.owner!==item.owner||previous.category!==item.category)movements.push("Movimentação · "+(item.code||item.model)+" · "+(previous.allocatedTo||previous.owner||previous.category||"Estoque")+" → "+(item.allocatedTo||item.owner||item.category||"Estoque"));});
  beforeMap.forEach(function(item,key){if(!afterMap.has(key))movements.push("Saída · "+(item.code||item.model)+" · "+item.category);});
  const details={"Período":new Date(rows[0].capturedAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})+" até "+new Date(rows[rows.length-1].capturedAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}),"Ativos movimentados":movements.length,"Categorias com variação":changed.length,"Categorias sem variação":unchanged.length};
  movements.slice(0,12).forEach(function(item,index){details["Movimento "+(index+1)]=item;});
  changed.slice(0,12).forEach(function(item){details[item.name]=item.before+" → "+item.after+" ("+(item.difference>0?"+":"")+item.difference+")";});
  const message=movements.length?movements.slice(0,15).map(function(item){return "• "+item;}).join("\n"):(changed.length?changed.map(function(item){return "• "+item.name+": "+item.before+" → "+item.after+" ("+(item.difference>0?"+":"")+item.difference+")";}).join("\n"):"Nenhuma movimentação de ativo foi identificada hoje.");
  if(unchanged.length)details["Sem alteração de quantidade"]=unchanged.slice(0,15).map(function(item){return item.name+" ("+item.after+")";}).join(", ");
  await dispatchNotification("daily-stock:"+date,"daily-stock","Fechamento diário · movimentação do estoque",message,false,details);
  auth.setSetting("daily_stock_report_last_date",date,null);
  return true;
}
setTimeout(function(){captureStockSnapshot("startup").catch(function(error){console.error("Snapshot inicial:",error.message);});},10000).unref();
setInterval(function(){
  const now=new Date(),enabled=auth.getSetting("nxt_auto_update","0")==="1",hours=Math.max(1,Number(auth.getSetting("nxt_auto_update_hours","1"))||1),last=Date.parse(auth.getSetting("nxt_auto_update_last_attempt",""))||0;
  if(enabled&&Date.now()-last>=hours*3600000)scheduledNxtUpdate();
  const reportEnabled=auth.getSetting("daily_stock_report","0")==="1",reportTime=auth.getSetting("daily_stock_report_time","18:00"),today=localDateKey(now),current=String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
  if(reportEnabled&&current>=reportTime&&auth.getSetting("daily_stock_report_last_date","")!==today)sendDailyStockMovementReport().catch(function(error){console.error("Relatório diário:",error.message);});
},60000).unref();

async function scheduledTonerScan() {
  if(tonerExecutando)return false;
  tonerExecutando=true;
  try{
    const printers=auth.getPrinters().filter(function(item){return item.active;}).map(function(item){return[item.ip,item.model];});
    if(!printers.length)return false;
    const report=await tonerMonitor.scan({threshold:Math.max(1,Math.min(99,Number(auth.getSetting("toner_threshold","20"))||20)),printers:printers});
    fs.mkdirSync(path.dirname(arquivoToner),{recursive:true});
    fs.writeFileSync(arquivoToner,JSON.stringify(report,null,2),"utf8");
    auth.recordTonerSnapshot(report);
    auth.setSetting("toner_last_automatic_scan",new Date().toISOString(),null);
    await sendOperationalSummaries(false,["toner"]);
    console.log("Leitura automática de toners concluída.");
    return true;
  }catch(error){
    console.error("Leitura automática de toners:",error.message);
    return false;
  }finally{tonerExecutando=false;}
}
setTimeout(function(){scheduledTonerScan();},30000).unref();
setInterval(function(){scheduledTonerScan();},15*60*1000).unref();

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
