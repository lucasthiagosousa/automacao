# Nexo TI — instalação no servidor Windows

Este é o projeto **NXT-Automacao / Central de Operações de TI**. O instalador gera um aplicativo para abrir a interface e uma tarefa `NexoTICentral` executada como `SYSTEM` a cada inicialização do Windows. Fechar a janela ou sair da sessão não interrompe o servidor. A porta é **3000** e o acesso dos demais computadores é `http://IP-DO-SERVIDOR:3000` nas redes de domínio/privadas.

1. Gere `Central-Operacoes-TI-Setup-1.2.0.exe` no fluxo `Gerar instalador Windows` do GitHub Actions e execute no servidor como administrador. Esta versão do código não inclui os dados de produção nem credenciais.
2. No próprio servidor, abra `http://127.0.0.1:3000/setup.html` e crie o administrador inicial. A criação do primeiro administrador só é aceita a partir do próprio servidor.
3. Abra um PowerShell **como administrador** e execute `& "C:\Program Files\Central de Operações de TI\resources\configure-server.ps1"` para fornecer as credenciais NXT e a comunidade SNMP. Se escolher outro diretório durante a instalação, ajuste o caminho.
4. Confira `Get-ScheduledTask NexoTICentral`, `Get-NetTCPConnection -LocalPort 3000` e os arquivos de log em `C:\ProgramData\NexoTI\CentralOperacoes\logs`. Teste o endereço IP em outro computador da mesma rede.

Os dados e os backups ficam em `C:\ProgramData\NexoTI\CentralOperacoes\dados` e permanecem após a desinstalação. **Antes de migrar dados existentes**, pare qualquer instância antiga e faça backup integral da pasta `dados`, incluindo `controle-estoque.db`, `controle-estoque.db-wal` e `controle-estoque.db-shm`; copie o conjunto somente com a aplicação parada. Nunca copie apenas o arquivo `.db` enquanto a aplicação está em execução. Não instale duas instâncias escrevendo no mesmo banco.

O serviço usa o Microsoft Edge instalado no servidor para a automação Playwright. O pacote não instala o navegador. A configuração padrão é porta 3000; caso a porta esteja ocupada, libere-a antes da instalação. O instalador ainda precisa ser gerado e testado em Windows: a sintaxe JavaScript foi verificada aqui, mas o ambiente atual não executa NSIS nem tarefas agendadas do Windows.
