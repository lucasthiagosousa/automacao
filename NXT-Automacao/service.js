"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const pastaProgramData = process.env.ProgramData || "C:\\ProgramData";
const raiz = path.join(pastaProgramData, "NexoTI", "CentralOperacoes");
const pastaDados = path.join(raiz, "dados");
const pastaLogs = path.join(raiz, "logs");
const arquivoEnv = path.join(raiz, ".env");

fs.mkdirSync(pastaDados, { recursive: true });
fs.mkdirSync(pastaLogs, { recursive: true });

process.env.NXT_SERVICE_MODE = "1";
process.env.NXT_DESKTOP_MODE = "1";
process.env.NXT_AUTOMATION_HEADLESS = "1";
process.env.NXT_BROWSER_CHANNEL = process.env.NXT_BROWSER_CHANNEL || "msedge";
process.env.NXT_DATA_DIR = pastaDados;
process.env.NXT_ENV_FILE = arquivoEnv;
process.env.NXT_HOST = "0.0.0.0";
process.env.PORT = "3000";

dotenv.config({ path: arquivoEnv });

console.log("[SERVIÇO] Iniciando Central de Operações de TI.");
console.log("[SERVIÇO] Dados:", pastaDados);
console.log("[SERVIÇO] Porta: 3000");

let servidor;

function encerrar(codigo = 0) {
  if (!servidor || !servidor.listening) {
    process.exit(codigo);
    return;
  }

  const limite = setTimeout(() => process.exit(codigo || 1), 10000);
  limite.unref();

  servidor.close(() => {
    clearTimeout(limite);
    process.exit(codigo);
  });
}

process.on("SIGTERM", () => encerrar(0));
process.on("SIGINT", () => encerrar(0));
process.on("uncaughtException", (erro) => {
  console.error("[SERVIÇO] Erro não tratado:", erro?.stack || erro);
  encerrar(1);
});
process.on("unhandledRejection", (erro) => {
  console.error("[SERVIÇO] Promise rejeitada:", erro?.stack || erro);
  encerrar(1);
});

({ servidor } = require("./server"));
