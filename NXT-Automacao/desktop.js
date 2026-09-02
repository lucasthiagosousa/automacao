const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const APP_ID = "br.com.operacoesti.controle";
let janelaPrincipal = null;
let janelaConfiguracao = null;
let servidor = null;
let tray = null;
let encerrando = false;
let abrirCriacaoAdmin = false;

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();

function caminhos() {
  const raiz = app.getPath("userData");
  return { raiz, dados: path.join(raiz, "dados"), env: path.join(raiz, ".env") };
}

function carregarConfiguracao() {
  const { env } = caminhos();
  if (!fs.existsSync(env)) return {};
  const resultado = {};
  for (const linha of fs.readFileSync(env, "utf8").split(/\r?\n/)) {
    const separador = linha.indexOf("=");
    if (separador > 0) resultado[linha.slice(0, separador).trim()] = linha.slice(separador + 1).trim();
  }
  return resultado;
}

function salvarConfiguracao({ email, password, port = 3000, skip = false }) {
  const destino = caminhos();
  fs.mkdirSync(destino.raiz, { recursive: true });
  const limpar = (valor) => String(valor || "").replace(/[\r\n]/g, "").trim();
  const porta = Number.parseInt(port, 10);
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) {
    throw new Error("Escolha uma porta entre 1024 e 65535.");
  }
  const conteudo = [
    `NXT_EMAIL=${limpar(email)}`,
    `NXT_PASSWORD=${limpar(password)}`,
    `NXT_PORT=${porta}`,
    "NXT_CONFIG_VERSION=2",
    `NXT_SETUP_SKIPPED=${skip ? "1" : "0"}`,
    "",
  ].join("\n");
  fs.writeFileSync(destino.env, conteudo, { encoding: "utf8", mode: 0o600 });
  process.env.NXT_EMAIL = limpar(email);
  process.env.NXT_PASSWORD = limpar(password);
  process.env.PORT = String(porta);
}

function configurarAmbiente() {
  const destino = caminhos();
  fs.mkdirSync(destino.dados, { recursive: true });
  process.env.NXT_DESKTOP_MODE = "1";
  process.env.NXT_BROWSER_CHANNEL = process.env.NXT_BROWSER_CHANNEL || "msedge";
  process.env.NXT_AUTOMATION_HEADLESS = "1";
  process.env.NXT_DATA_DIR = destino.dados;
  process.env.NXT_ENV_FILE = destino.env;
  process.env.NXT_HOST = "0.0.0.0";
  const config = carregarConfiguracao();
  process.env.PORT = String(config.NXT_PORT || "3000");
}

function criarJanelaConfiguracao(primeiroAcesso = false) {
  if (janelaConfiguracao && !janelaConfiguracao.isDestroyed()) return janelaConfiguracao.focus();
  janelaConfiguracao = new BrowserWindow({
    width: 520, height: 650, minWidth: 460, minHeight: 600,
    autoHideMenuBar: true, backgroundColor: "#f5f8fc",
    parent: janelaPrincipal || undefined, modal: Boolean(janelaPrincipal),
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: { preload: path.join(__dirname, "desktop-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
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
  return Number.parseInt(process.env.PORT || carregarConfiguracao().NXT_PORT || "3000", 10);
}

function obterEnderecoRede() {
  const interfaces = os.networkInterfaces();
  for (const enderecos of Object.values(interfaces)) {
    for (const endereco of enderecos || []) {
      if (endereco.family === "IPv4" && !endereco.internal) return `http://${endereco.address}:${portaConfigurada()}`;
    }
  }
  return `http://IP-DO-SERVIDOR:${portaConfigurada()}`;
}

function criarTray() {
  const imagem = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACAUlEQVR4nO1b23ECMQw0DAWEvqAXqIT0QvoiHSQ/0Yw5/JCRVrId709mIHfWriVr7TtCWFj419hJLv44XX60ApHi++vzLS7NF/VEOocWMdj/OALxLThC7Dk3GpF8CLy4qwKMSp5Qi78owOjkCSUeWQFmIU/I8UkKYEX+cb89/UUjxetgMvIGKcL02fF8NY3lpU0gZ79lppFCxO2R1QY10JrmVmUBL4ESkXiWvcriqQQ0059LXOu6VlAZqAtQS10OCY171AARQHv2kNmgKgA6bREZoSKAVb0ixiMBIG0QtWoj7isSYBvQ8XyFtiyEN1DxAWj7iuwKYgG8ZlxrXJfNUA0WPoDQnQDWnaUbAayJE9wF8CJOMNsOt8LqYERFAEl/lngJDV+gVgLSvXvLdZqGSLwZygVjuReQbIZga4C2bUUdkamdB6BWc9R9XU6EtOq82xMhgsTKWtlgqACE1lm0NEUmAhBqxDzcoKkAhF6eDIWg3Aa5xLikpnaC9H0qeEviBHcn+LjfxMSHdoIesx5jOcH4w+UElxNcTnA5Qchof5jWCXKh7QQ1YPqWWAyJE5QifkvM7blAbImt3w2M4f5cwJN8CAkB3v3lxSjY8nPPAG8kBZg1C1K8shkwmwg5PsUSmEWEEo/qGjC6CLX4WYvgqCJw4l6/G5QM1JMYo2bpgjd+AQjsZlmiUMdBAAAAAElFTkSuQmCC").resize({ width: 32, height: 32 });
  tray = new Tray(imagem);
  tray.setToolTip("Central de Operações de TI");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir sistema", click: () => janelaPrincipal?.show() },
    { label: `Acesso na rede: ${obterEnderecoRede()}`, click: () => shell.openExternal(obterEnderecoRede()) },
    { label: "Configurar credenciais NXT", click: () => criarJanelaConfiguracao(false) },
    { label: "Abrir pasta de dados", click: () => shell.openPath(caminhos().dados) },
    { type: "separator" },
    { label: "Sair", click: () => { encerrando = true; app.quit(); } },
  ]));
  tray.on("click", () => { janelaPrincipal?.show(); janelaPrincipal?.focus(); });
  tray.on("double-click", () => { janelaPrincipal?.show(); janelaPrincipal?.focus(); });
}

function iniciarSistema() {
  if (janelaPrincipal) return;
  configurarAmbiente();
  ({ servidor } = require("./server"));
  const abrir = () => {
    const endereco = servidor.address();
    const porta = typeof endereco === "object" && endereco ? endereco.port : portaConfigurada();
    janelaPrincipal = new BrowserWindow({
      width: 1500, height: 920, minWidth: 1040, minHeight: 680, show: false,
      autoHideMenuBar: true, backgroundColor: "#f4f7fb",
      icon: path.join(__dirname, "build", "icon.ico"), title: "Central de Operações de TI",
      webPreferences: { preload: path.join(__dirname, "desktop-main-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const paginaInicial = abrirCriacaoAdmin ? "/setup.html" : "/";
    abrirCriacaoAdmin = false;
    janelaPrincipal.loadURL(`http://127.0.0.1:${porta}${paginaInicial}`);
    janelaPrincipal.once("ready-to-show", () => { janelaPrincipal.show(); janelaPrincipal.focus(); });
    janelaPrincipal.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !url.startsWith(`http://127.0.0.1:${porta}`)) shell.openExternal(url);
      return { action: "deny" };
    });
    janelaPrincipal.on("close", (evento) => {
      if (!encerrando) { evento.preventDefault(); janelaPrincipal.hide(); }
    });
    criarTray();
  };
  if (servidor.listening) abrir(); else servidor.once("listening", abrir);
}

ipcMain.handle("report:save-pdf", async (_evento, options = {}) => {
  if (!janelaPrincipal || janelaPrincipal.isDestroyed()) throw new Error("Janela principal indisponível.");
  const suggestedName = String(options.fileName || "relatorio.pdf").replace(/[\\/:*?"<>|]/g, "-");
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
  return { email: config.NXT_EMAIL || "", port: Number(config.NXT_PORT || 3000) };
});
ipcMain.handle("nxt-config:save", (_evento, dados) => {
  if (!dados?.email || !dados?.password) throw new Error("Informe o e-mail e a senha do NXT.");
  salvarConfiguracao(dados);
  abrirCriacaoAdmin = Boolean(dados?.primeiroAcesso);
  janelaConfiguracao?.close();
  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});
ipcMain.handle("nxt-config:skip", () => {
  salvarConfiguracao({ email: "", password: "", port: 3000, skip: true });
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
  const config = carregarConfiguracao();
  const configuracaoAtual = config.NXT_CONFIG_VERSION === "2";
  const credenciaisCompletas = Boolean(config.NXT_EMAIL && config.NXT_PASSWORD);
  if (!configuracaoAtual || !credenciaisCompletas) criarJanelaConfiguracao(true);
  else iniciarSistema();
});
app.on("before-quit", () => { encerrando = true; if (servidor?.listening) servidor.close(); });
app.on("window-all-closed", () => {});
