using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

namespace CentralOperacoesTIService
{
    public sealed class CentralOperacoesService : ServiceBase
    {
        private readonly object logLock = new object();
        private Process child;
        private bool stopping;
        private string logFile;

        public CentralOperacoesService()
        {
            ServiceName = "CentralOperacoesTI";
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            StartBackend();
        }

        protected override void OnStop()
        {
            StopBackend();
        }

        protected override void OnShutdown()
        {
            StopBackend();
            base.OnShutdown();
        }

        private void StartBackend()
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var appDir = Path.Combine(baseDir, "resources", "app");
            var electronExe = Path.Combine(baseDir, "Central de Operações de TI.exe");
            var serviceScript = Path.Combine(appDir, "service.js");

            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            var logsDir = Path.Combine(programData, "NexoTI", "CentralOperacoes", "logs");
            Directory.CreateDirectory(logsDir);
            logFile = Path.Combine(logsDir, "service-wrapper.log");

            if (!File.Exists(electronExe))
            {
                throw new FileNotFoundException("Executável principal não encontrado.", electronExe);
            }

            if (!File.Exists(serviceScript))
            {
                throw new FileNotFoundException("Host do serviço não encontrado.", serviceScript);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = electronExe,
                Arguments = "\"" + serviceScript + "\"",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            startInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            startInfo.EnvironmentVariables["NXT_SERVICE_MODE"] = "1";

            child = new Process
            {
                StartInfo = startInfo,
                EnableRaisingEvents = true
            };

            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (!string.IsNullOrWhiteSpace(eventArgs.Data))
                {
                    WriteLog("OUT", eventArgs.Data);
                }
            };

            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (!string.IsNullOrWhiteSpace(eventArgs.Data))
                {
                    WriteLog("ERR", eventArgs.Data);
                }
            };

            child.Exited += delegate
            {
                int exitCode = -1;
                try
                {
                    exitCode = child.ExitCode;
                }
                catch { }

                WriteLog("SERVICE", "Backend encerrado com código " + exitCode + ".");

                if (!stopping)
                {
                    Environment.ExitCode = exitCode == 0 ? 1 : exitCode;
                    Environment.Exit(Environment.ExitCode);
                }
            };

            if (!child.Start())
            {
                throw new InvalidOperationException("Não foi possível iniciar o backend.");
            }

            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            WriteLog("SERVICE", "Backend iniciado. PID " + child.Id + ".");
        }

        private void StopBackend()
        {
            stopping = true;

            var process = child;
            if (process == null)
            {
                return;
            }

            try
            {
                if (!process.HasExited)
                {
                    WriteLog("SERVICE", "Encerrando backend.");

                    try
                    {
                        process.CloseMainWindow();
                    }
                    catch { }

                    if (!process.WaitForExit(5000))
                    {
                        process.Kill();
                        process.WaitForExit(5000);
                    }
                }
            }
            catch (Exception error)
            {
                WriteLog("SERVICE", "Erro ao encerrar backend: " + error.Message);
            }
            finally
            {
                try
                {
                    process.Dispose();
                }
                catch { }

                child = null;
            }
        }

        private void WriteLog(string level, string message)
        {
            try
            {
                lock (logLock)
                {
                    File.AppendAllText(
                        logFile,
                        "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] [" + level + "] " + message + Environment.NewLine
                    );
                }
            }
            catch
            {
                // O serviço não deve cair apenas porque o arquivo de log está indisponível.
            }
        }
    }

    internal static class Program
    {
        private static void Main()
        {
            ServiceBase.Run(new ServiceBase[] { new CentralOperacoesService() });
        }
    }
}
