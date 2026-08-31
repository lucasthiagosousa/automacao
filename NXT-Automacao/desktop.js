const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const APP_ID = "br.com.operacoesti.controle";
let janelaPrincipal = null;
let janelaConfiguracao = null;
let servidor = null;
let tray = null;
let encerrando = false;

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

function salvarConfiguracao({ email, password, skip = false }) {
  const destino = caminhos();
  fs.mkdirSync(destino.raiz, { recursive: true });
  const limpar = (valor) => String(valor || "").replace(/[\r\n]/g, "").trim();
  const conteudo = [
    `NXT_EMAIL=${limpar(email)}`,
    `NXT_PASSWORD=${limpar(password)}`,
    `NXT_SETUP_SKIPPED=${skip ? "1" : "0"}`,
    "",
  ].join("\n");
  fs.writeFileSync(destino.env, conteudo, { encoding: "utf8", mode: 0o600 });
  process.env.NXT_EMAIL = limpar(email);
  process.env.NXT_PASSWORD = limpar(password);
}

function configurarAmbiente() {
  const destino = caminhos();
  fs.mkdirSync(destino.dados, { recursive: true });
  process.env.NXT_DESKTOP_MODE = "1";
  process.env.NXT_BROWSER_CHANNEL = process.env.NXT_BROWSER_CHANNEL || "msedge";
  process.env.NXT_DATA_DIR = destino.dados;
  process.env.NXT_ENV_FILE = destino.env;
  process.env.PORT = "0";
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
  janelaConfiguracao.loadFile(path.join(__dirname, "desktop-setup.html"));
  janelaConfiguracao.on("closed", () => {
    janelaConfiguracao = null;
    if (primeiroAcesso && !janelaPrincipal) iniciarSistema();
  });
}

function criarTray() {
  const imagem = nativeImage.createFromPath(path.join(__dirname, "build", "icon.ico"));
  tray = new Tray(imagem);
  tray.setToolTip("Central de Operações de TI");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir sistema", click: () => janelaPrincipal?.show() },
    { label: "Configurar credenciais NXT", click: () => criarJanelaConfiguracao(false) },
    { label: "Abrir pasta de dados", click: () => shell.openPath(caminhos().dados) },
    { type: "separator" },
    { label: "Sair", click: () => { encerrando = true; app.quit(); } },
  ]));
  tray.on("double-click", () => janelaPrincipal?.show());
}

function iniciarSistema() {
  if (janelaPrincipal) return;
  configurarAmbiente();
  ({ servidor } = require("./server"));
  const abrir = () => {
    const endereco = servidor.address();
    const porta = typeof endereco === "object" && endereco ? endereco.port : 3000;
    janelaPrincipal = new BrowserWindow({
      width: 1500, height: 920, minWidth: 1040, minHeight: 680, show: false,
      autoHideMenuBar: true, backgroundColor: "#f4f7fb",
      icon: path.join(__dirname, "build", "icon.ico"), title: "Central de Operações de TI",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    janelaPrincipal.loadURL(`http://127.0.0.1:${porta}`);
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

ipcMain.handle("nxt-config:get", () => ({ email: carregarConfiguracao().NXT_EMAIL || "" }));
ipcMain.handle("nxt-config:save", (_evento, dados) => {
  if (!dados?.email || !dados?.password) throw new Error("Informe o e-mail e a senha do NXT.");
  salvarConfiguracao(dados);
  janelaConfiguracao?.close();
  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});
ipcMain.handle("nxt-config:skip", () => {
  salvarConfiguracao({ email: "", password: "", skip: true });
  janelaConfiguracao?.close();
  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});

app.on("second-instance", () => { janelaPrincipal?.show(); janelaPrincipal?.focus(); });
app.whenReady().then(() => {
  configurarAmbiente();
  const config = carregarConfiguracao();
  if (!config.NXT_EMAIL && config.NXT_SETUP_SKIPPED !== "1") criarJanelaConfiguracao(true);
  else iniciarSistema();
});
app.on("before-quit", () => { encerrando = true; if (servidor?.listening) servidor.close(); });
app.on("window-all-closed", () => {});
