const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const APP_ID = "br.com.operacoesti.controle";
const PORTA_SERVICO = 3000;
let janelaPrincipal = null;
let janelaConfiguracao = null;
let tray = null;
let encerrando = false;
let abrirCriacaoAdmin = false;
let iniciandoSistema = false;

function caminhos() {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const raiz = path.join(programData, "NexoTI", "CentralOperacoes");
  return {
    raiz,
    dados: path.join(raiz, "dados"),
    logs: path.join(raiz, "logs"),
    env: path.join(raiz, ".env"),
  };
}

const arquivoLog = path.join(caminhos().logs, "Central-Operacoes-TI-desktop.log");

function registrarErroInicializacao(error) {
  const mensagem = error?.stack || error?.message || String(error);
  try {
    fs.mkdirSync(path.dirname(arquivoLog), { recursive: true });
    fs.appendFileSync(arquivoLog, `[${new Date().toISOString()}] ${mensagem}\n\n`, "utf8");
  } catch {}
}

process.on("uncaughtException", registrarErroInicializacao);
process.on("unhandledRejection", registrarErroInicializacao);

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();

function carregarConfiguracao() {
  const { env } = caminhos();
  if (!fs.existsSync(env)) return {};
  const resultado = {};
  for (const linha of fs.readFileSync(env, "utf8").split(/\r?\n/)) {
    const separador = linha.indexOf("=");
    if (separador > 0) {
      let valor = linha.slice(separador + 1).trim();
      if (
        (valor.startsWith('"') && valor.endsWith('"')) ||
        (valor.startsWith("'") && valor.endsWith("'"))
      ) {
        valor = valor.slice(1, -1);
      }
      resultado[linha.slice(0, separador).trim()] = valor;
    }
  }
  return resultado;
}

function salvarConfiguracao({ email, password, skip = false }) {
  const destino = caminhos();
  fs.mkdirSync(destino.raiz, { recursive: true });
  fs.mkdirSync(destino.dados, { recursive: true });
  fs.mkdirSync(destino.logs, { recursive: true });

  const limpar = (valor) => String(valor || "").replace(/[\r\n]/g, "").trim();
  const conteudo = [
    `NXT_EMAIL=${limpar(email)}`,
    `NXT_PASSWORD=${limpar(password)}`,
    `NXT_PORT=${PORTA_SERVICO}`,
    "NXT_CONFIG_VERSION=3",
    `NXT_SETUP_SKIPPED=${skip ? "1" : "0"}`,
    "",
  ].join("\n");

  fs.writeFileSync(destino.env, conteudo, { encoding: "utf8", mode: 0o600 });
  process.env.NXT_EMAIL = limpar(email);
  process.env.NXT_PASSWORD = limpar(password);
  process.env.PORT = String(PORTA_SERVICO);
}

function configurarAmbiente() {
  const destino = caminhos();
  fs.mkdirSync(destino.dados, { recursive: true });
  fs.mkdirSync(destino.logs, { recursive: true });

  process.env.NXT_DESKTOP_MODE = "1";
  process.env.NXT_BROWSER_CHANNEL = process.env.NXT_BROWSER_CHANNEL || "msedge";
  process.env.NXT_AUTOMATION_HEADLESS = "1";
  process.env.NXT_DATA_DIR = destino.dados;
  process.env.NXT_ENV_FILE = destino.env;
  process.env.NXT_HOST = "0.0.0.0";
  process.env.PORT = String(PORTA_SERVICO);
}

function criarJanelaConfiguracao(primeiroAcesso = false) {
  if (janelaConfiguracao && !janelaConfiguracao.isDestroyed()) {
    janelaConfiguracao.show();
    janelaConfiguracao.focus();
    return;
  }

  janelaConfiguracao = new BrowserWindow({
    width: 520,
    height: 650,
    minWidth: 460,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#f5f8fc",
    parent: janelaPrincipal || undefined,
    modal: Boolean(janelaPrincipal),
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "desktop-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  janelaConfiguracao.loadFile(path.join(__dirname, "desktop-setup.html"), {
    query: { primeiroAcesso: primeiroAcesso ? "1" : "0" },
  });

  janelaConfiguracao.on("closed", () => {
    janelaConfiguracao = null;
    if (primeiroAcesso && !janelaPrincipal) iniciarSistema();
  });
}

function portaConfigurada() {
  return PORTA_SERVICO;
}

function obterEnderecoRede() {
  const interfaces = os.networkInterfaces();
  for (const enderecos of Object.values(interfaces)) {
    for (const endereco of enderecos || []) {
      if (endereco.family === "IPv4" && !endereco.internal) {
        return `http://${endereco.address}:${PORTA_SERVICO}`;
      }
    }
  }
  return `http://IP-DO-SERVIDOR:${PORTA_SERVICO}`;
}

function verificarServidor() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: PORTA_SERVICO,
        path: "/api/health",
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function aguardarServidor(tentativas = 20) {
  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    if (await verificarServidor()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function criarTray() {
  if (tray) return;

  const imagem = nativeImage
    .createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACAUlEQVR4nO1b23ECMQw0DAWEvqAXqIT0QvoiHSQ/0Yw5/JCRVrId709mIHfWriVr7TtCWFj419hJLv44XX60ApHi++vzLS7NF/VEOocWMdj/OALxLThC7Dk3GpF8CLy4qwKMSp5Qi78owOjkCSUeWQFmIU/I8UkKYEX+cb89/UUjxetgMvIGKcL02fF8NY3lpU0gZ79lppFCxO2R1QY10JrmVmUBL4ESkXiWvcriqQQ0059LXOu6VlAZqAtQS10OCY171AARQHv2kNmgKgA6bREZoSKAVb0ixiMBIG0QtWoj7isSYBvQ8XyFtiyEN1DxAWj7iuwKYgG8ZlxrXJfNUA0WPoDQnQDWnaUbAayJE9wF8CJOMNsOt8LqYERFAEl/lngJDV+gVgLSvXvLdZqGSLwZygVjuReQbIZga4C2bUUdkamdB6BWc9R9XU6EtOq82xMhgsTKWtlgqACE1lm0NEUmAhBqxDzcoKkAhF6eDIWg3Aa5xLikpnaC9H0qeEviBHcn+LjfxMSHdoIesx5jOcH4w+UElxNcTnA5Qchof5jWCXKh7QQ1YPqWWAyJE5QifkvM7blAbImt3w2M4f5cwJN8CAkB3v3lxSjY8nPPAG8kBZg1C1K8shkwmwg5PsUSmEWEEo/qGjC6CLX4WYvgqCJw4l6/G5QM1JMYo2bpgjd+AQjsZlmiUMdBAAAAAElFTkSuQmCC"
    )
    .resize({ width: 32, height: 32 });

  tray = new Tray(imagem);
  tray.setToolTip("Central de Operações de TI");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Abrir sistema",
        click: () => {
          if (janelaPrincipal && !janelaPrincipal.isDestroyed()) {
            janelaPrincipal.show();
            janelaPrincipal.focus();
          } else {
            iniciarSistema();
          }
        },
      },
      {
        label: `Acesso na rede: ${obterEnderecoRede()}`,
        click: () => shell.openExternal(obterEnderecoRede()),
      },
      {
        label: "Configurar credenciais NXT",
        click: () => criarJanelaConfiguracao(false),
      },
      {
        label: "Abrir pasta de dados",
        click: () => shell.openPath(caminhos().dados),
      },
      {
        label: "Abrir logs do serviço",
        click: () => shell.openPath(caminhos().logs),
      },
      { type: "separator" },
      {
        label: "Fechar interface",
        click: () => {
          encerrando = true;
          app.quit();
        },
      },
    ])
  );

  tray.on("click", () => {
    if (janelaPrincipal && !janelaPrincipal.isDestroyed()) {
      janelaPrincipal.show();
      janelaPrincipal.focus();
    } else {
      iniciarSistema();
    }
  });
  tray.on("double-click", () => {
    if (janelaPrincipal && !janelaPrincipal.isDestroyed()) {
      janelaPrincipal.show();
      janelaPrincipal.focus();
    } else {
      iniciarSistema();
    }
  });
}

async function iniciarSistema() {
  if (janelaPrincipal || iniciandoSistema) return;

  iniciandoSistema = true;
  configurarAmbiente();
  criarTray();

  try {
    const disponivel = await aguardarServidor();
    if (!disponivel) {
      throw new Error(
        "O serviço Central de Operações de TI não respondeu na porta 3000. Verifique o serviço CentralOperacoesTI e os logs em " +
          caminhos().logs
      );
    }

    janelaPrincipal = new BrowserWindow({
      width: 1500,
      height: 920,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#f4f7fb",
      icon: path.join(__dirname, "build", "icon.ico"),
      title: "Central de Operações de TI",
      webPreferences: {
        preload: path.join(__dirname, "desktop-main-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const paginaInicial = abrirCriacaoAdmin ? "/setup.html" : "/";
    abrirCriacaoAdmin = false;
    janelaPrincipal.loadURL(
      `http://127.0.0.1:${PORTA_SERVICO}${paginaInicial}`
    );

    janelaPrincipal.once("ready-to-show", () => {
      janelaPrincipal.show();
      janelaPrincipal.focus();
    });

    janelaPrincipal.webContents.setWindowOpenHandler(({ url }) => {
      if (
        /^https?:/i.test(url) &&
        !url.startsWith(`http://127.0.0.1:${PORTA_SERVICO}`)
      ) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });

    janelaPrincipal.on("close", (evento) => {
      if (!encerrando) {
        evento.preventDefault();
        janelaPrincipal.hide();
      }
    });

    janelaPrincipal.on("closed", () => {
      janelaPrincipal = null;
    });
  } catch (error) {
    registrarErroInicializacao(error);
    dialog.showErrorBox(
      "Serviço indisponível",
      `${error.message}\n\nA interface pode ser fechada sem interromper o servidor. Se o serviço estiver parado, abra services.msc e verifique "Central de Operações de TI".`
    );
  } finally {
    iniciandoSistema = false;
  }
}

ipcMain.handle("report:save-pdf", async (_evento, options = {}) => {
  if (!janelaPrincipal || janelaPrincipal.isDestroyed()) {
    throw new Error("Janela principal indisponível.");
  }

  const suggestedName = String(options.fileName || "relatorio.pdf").replace(
    /[\\/:*?"<>|]/g,
    "-"
  );
  const selection = await dialog.showSaveDialog(janelaPrincipal, {
    title: "Salvar relatório em PDF",
    defaultPath: path.join(app.getPath("documents"), suggestedName),
    filters: [{ name: "Documento PDF", extensions: ["pdf"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });

  if (selection.canceled || !selection.filePath) return { canceled: true };

  const pdf = await janelaPrincipal.webContents.printToPDF({
    printBackground: true,
    landscape: true,
    pageSize: "A4",
    margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 },
  });

  fs.writeFileSync(selection.filePath, pdf);
  return { canceled: false, filePath: selection.filePath };
});

ipcMain.handle("nxt-config:get", () => {
  const config = carregarConfiguracao();
  return {
    email: config.NXT_EMAIL || "",
    port: PORTA_SERVICO,
  };
});

ipcMain.handle("nxt-config:save", (_evento, dados) => {
  if (!dados?.email || !dados?.password) {
    throw new Error("Informe o e-mail e a senha do NXT.");
  }

  salvarConfiguracao(dados);
  abrirCriacaoAdmin = Boolean(dados?.primeiroAcesso);
  janelaConfiguracao?.close();

  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});

ipcMain.handle("nxt-config:skip", () => {
  salvarConfiguracao({
    email: "",
    password: "",
    skip: true,
  });
  janelaConfiguracao?.close();
  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});

app.on("second-instance", () => {
  if (janelaConfiguracao && !janelaConfiguracao.isDestroyed()) {
    janelaConfiguracao.show();
    janelaConfiguracao.restore();
    janelaConfiguracao.focus();
    return;
  }

  if (janelaPrincipal && !janelaPrincipal.isDestroyed()) {
    janelaPrincipal.show();
    janelaPrincipal.restore();
    janelaPrincipal.focus();
    return;
  }

  iniciarSistema();
});

app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  configurarAmbiente();
  criarTray();

  const config = carregarConfiguracao();
  const configuracaoAtual = config.NXT_CONFIG_VERSION === "3";
  const credenciaisCompletas = Boolean(config.NXT_EMAIL && config.NXT_PASSWORD);

  if (!configuracaoAtual || !credenciaisCompletas) {
    criarJanelaConfiguracao(true);
  } else {
    iniciarSistema();
  }
});

app.on("before-quit", () => {
  encerrando = true;
});

app.on("window-all-closed", () => {});
