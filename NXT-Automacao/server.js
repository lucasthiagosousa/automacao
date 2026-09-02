const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
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

app.use(express.json());
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
app.get("/api/minimos", (req, res) => {
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
app.get("/api/solicitacoes", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    solicitacoes: auth.getRestockRequests(),
    podeEditar: ["master", "operator"].includes(req.user.role),
  });
});

app.post(
  "/api/solicitacoes",
  auth.requireUpdatePermission,
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
  auth.requireUpdatePermission,
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

    return res.json({
      sucesso: true,
      solicitacao,
    });
  }
);

app.delete(
  "/api/solicitacoes/:id",
  auth.requireMaster,
  (req, res) => {
    const removida = auth.deleteRestockRequest(
      Number(req.params.id)
    );

    if (!removida) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Solicitação não encontrada.",
      });
    }

    return res.json({
      sucesso: true,
      mensagem: "Solicitação excluída.",
    });
  }
);


app.get("/api/impressoras", (req, res) => {
  res.json({
    sucesso: true,
    impressoras: auth.getPrinters(),
    podeEditar: ["master", "operator"].includes(req.user.role),
  });
});

app.post("/api/impressoras", auth.requireUpdatePermission, (req, res) => {
  try {
    const impressora = auth.savePrinter(req.body, Number(req.user.id));
    return res.status(201).json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.patch("/api/impressoras/:id", auth.requireUpdatePermission, (req, res) => {
  try {
    const impressora = auth.savePrinter(req.body, Number(req.user.id), Number(req.params.id));
    if (!impressora) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
    return res.json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.delete("/api/impressoras/:id", auth.requireUpdatePermission, (req, res) => {
  const deleted = auth.deletePrinter(Number(req.params.id));
  if (!deleted) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
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
  return res.json({ sucesso: true, limite });
});

/*
 * Monitoramento local das impressoras por SNMP.
 */
app.get("/api/toner", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    executando: tonerExecutando,
    ...lerTonerAtual(),
  });
});

app.post(
  "/api/toner/atualizar",
  auth.requireUpdatePermission,
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
app.get("/api/estoque", async (req, res) => {
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
