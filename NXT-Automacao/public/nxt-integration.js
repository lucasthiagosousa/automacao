(function () {
  "use strict";

  const MINIMUM_STORAGE_KEY = "nxt-minimum-stock-rules-v1";
  let updateTimer = null;

  function loadSavedMinimums() {
    try {
      return JSON.parse(localStorage.getItem(MINIMUM_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function applySavedMinimums() {
    const saved = loadSavedMinimums();
    minimumStockRules.forEach(function (rule) {
      const key = norm(rule.item);
      if (Number.isFinite(Number(saved[key]))) {
        rule.minimum = Math.max(0, Number(saved[key]));
      }
    });
  }

  function saveMinimums() {
    const values = {};
    minimumStockRules.forEach(function (rule) {
      values[norm(rule.item)] = Math.max(0, Number(rule.minimum) || 0);
    });
    localStorage.setItem(MINIMUM_STORAGE_KEY, JSON.stringify(values));
  }

  function countRule(rule, inventory) {
    return inventory
      .filter(function (stock) {
        return rule.aliases.some(function (alias) {
          const stockName = norm(stock.name);
          const aliasName = norm(alias);
          return stockName === aliasName
            || stockName.includes(aliasName)
            || aliasName.includes(stockName);
        });
      })
      .reduce(function (sum, stock) { return sum + stock.value; }, 0);
  }

  function stockRuleMetrics() {
    const inventory = countBy(rawData, "type");
    const rules = minimumStockRules
      .filter(function (rule) { return Number(rule.minimum) > 0; })
      .map(function (rule) {
        const current = countRule(rule, inventory);
        return {
          current: current,
          minimum: Number(rule.minimum),
          shortage: Math.max(0, Number(rule.minimum) - current)
        };
      });
    const shortage = rules.reduce(function (sum, rule) { return sum + rule.shortage; }, 0);
    const below = rules.filter(function (rule) { return rule.shortage > 0; }).length;
    const total = sumQty(filteredData);
    const coverage = total + shortage > 0
      ? Math.min(100, Math.round(total / (total + shortage) * 100))
      : 100;
    return { below: below, shortage: shortage, coverage: coverage };
  }

  function updateKpiLabels() {
    const cards = document.querySelectorAll(".kpi");
    if (cards.length < 5) return;
    cards[2].style.setProperty("--accent", "var(--red)");
    cards[2].querySelector(".kpi-label").textContent = "Abaixo do mínimo";
    cards[2].querySelector(".kpi-sub").textContent = "categorias que precisam de reposição";
    cards[3].querySelector(".kpi-label").textContent = "Total a solicitar";
    cards[3].querySelector(".kpi-sub").textContent = "unidades para atingir os mínimos";
    cards[4].style.setProperty("--accent", "var(--green)");
    cards[4].querySelector(".kpi-label").textContent = "Cobertura do estoque";
    cards[4].querySelector(".kpi-sub").textContent = "em relação aos mínimos definidos";
  }

  renderKPIs = function () {
    const total = sumQty(filteredData);
    const types = unique(filteredData, "type").length;
    const ruleMetrics = stockRuleMetrics();
    $("kpiTotal").textContent = total.toLocaleString("pt-BR");
    $("kpiTotalSub").textContent = filteredData.length.toLocaleString("pt-BR")
      + " registro" + (filteredData.length === 1 ? "" : "s") + " visível"
      + (filteredData.length === 1 ? "" : "eis");
    $("kpiTypes").textContent = types.toLocaleString("pt-BR");
    $("kpiActive").textContent = ruleMetrics.below.toLocaleString("pt-BR");
    $("kpiActiveSub").textContent = "categorias que precisam de reposição";
    $("kpiModels").textContent = ruleMetrics.shortage.toLocaleString("pt-BR");
    $("kpiWarranty").textContent = ruleMetrics.coverage + "%";
    $("kpiWarrantySub").textContent = "em relação aos mínimos definidos";
  };

  function mapServerAsset(asset) {
    return {
      "Empresa": asset.proprietario || "NXT4Insight",
      "Tipo do ativo": asset.categoria || "SEM CATEGORIA",
      "Código": asset.codigo || "",
      "HostName": "",
      "Fabrica": asset.fabricante || "",
      "Marca": asset.marca || "",
      "Modelo": asset.modelo || "NÃO INFORMADO",
      "Status": asset.alocadoPara ? "Alocado" : "Disponível",
      "Alocado para": asset.alocadoPara || ""
    };
  }

  function setUpdateButton(running) {
    const button = $("nxtUpdateButton");
    const text = $("nxtUpdateText");
    if (!button || !text) return;
    button.disabled = running;
    text.textContent = running ? "Atualizando..." : "Atualizar NXT";
    button.classList.toggle("button-loading", running);
  }

  async function loadServerData(showSuccess) {
    try {
      $("sourceName").textContent = "Lendo a planilha do NXT4Insight...";
      const response = await fetch("/api/estoque?t=" + Date.now(), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.sucesso === false) {
        throw new Error(data.mensagem || "Não foi possível carregar a planilha.");
      }
      rawData = (data.ativos || []).map(mapServerAsset);
      filteredData = rawData.slice();
      const file = data.arquivo || {};
      const updated = file.atualizadoEm || data.atualizadoEm;
      const updatedText = updated ? new Date(updated).toLocaleString("pt-BR") : "data não informada";
      $("sourceName").textContent = (file.nome || data.nomeArquivo || "estoque-atual.xlsx")
        + " · atualizado em " + updatedText;
      resetFilters();
      if (showSuccess) toast("Dashboard atualizado com os dados mais recentes.");
    } catch (error) {
      $("sourceName").textContent = "Falha ao carregar a planilha";
      toast(error.message);
    }
  }

  function describeProgress(state) {
    const latest = (state.log || []).slice(-1)[0];
    return latest || state.mensagem || "Atualização em andamento...";
  }

  async function checkUpdate() {
    try {
      const response = await fetch("/api/atualizacao?t=" + Date.now(), { cache: "no-store" });
      const state = await response.json();
      setUpdateButton(Boolean(state.executando));
      if (state.executando) {
        $("sourceName").textContent = describeProgress(state);
        return;
      }
      if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
      }
      if (state.sucesso === true) {
        await loadServerData(true);
      } else if (state.sucesso === false) {
        toast(state.mensagem || "A automação não conseguiu concluir.");
      }
    } catch (error) {
      if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = null;
      }
      setUpdateButton(false);
      toast(error.message);
    }
  }

  async function startUpdate() {
    try {
      setUpdateButton(true);
      $("sourceName").textContent = "Iniciando acesso ao NXT4Insight...";
      const response = await fetch("/api/atualizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.mensagem || "Não foi possível iniciar a atualização.");
      }
      toast("Automação iniciada. Acompanhe o andamento no cabeçalho.");
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = setInterval(checkUpdate, 2000);
      await checkUpdate();
    } catch (error) {
      setUpdateButton(false);
      toast(error.message);
    }
  }

  function createMinimumSettings() {
    const panel = $("criticalList").closest(".chart-panel");
    const heading = panel.querySelector(".panel-head");
    const button = document.createElement("button");
    button.className = "btn btn-soft";
    button.type = "button";
    button.textContent = "Configurar mínimos";
    heading.appendChild(button);

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML =
      '<div class="modal-card" role="dialog" aria-modal="true">'
      + '<div class="modal-head"><button class="modal-close" type="button" aria-label="Fechar">×</button>'
      + '<div class="modal-eyebrow">Parâmetros de reposição</div>'
      + '<div class="modal-title">Estoques mínimos</div></div>'
      + '<div class="details" id="minimumSettingsList"></div>'
      + '<div style="display:flex;justify-content:flex-end;gap:8px;padding:0 18px 18px">'
      + '<button class="btn" type="button" data-cancel-minimum>Cancelar</button>'
      + '<button class="btn btn-primary" type="button" data-save-minimum>Salvar alterações</button>'
      + '</div></div>';
    document.body.appendChild(modal);

    function openSettings() {
      const list = modal.querySelector("#minimumSettingsList");
      list.innerHTML = "";
      minimumStockRules.forEach(function (rule, index) {
        const field = document.createElement("label");
        field.className = "detail";
        const label = document.createElement("span");
        label.className = "detail-label";
        label.textContent = rule.item;
        const input = document.createElement("input");
        input.className = "control";
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.value = rule.minimum;
        input.dataset.ruleIndex = String(index);
        field.appendChild(label);
        field.appendChild(input);
        list.appendChild(field);
      });
      modal.classList.add("show");
      document.body.style.overflow = "hidden";
    }

    function closeSettings() {
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }

    button.addEventListener("click", openSettings);
    modal.querySelector(".modal-close").addEventListener("click", closeSettings);
    modal.querySelector("[data-cancel-minimum]").addEventListener("click", closeSettings);
    modal.querySelector("[data-save-minimum]").addEventListener("click", function () {
      modal.querySelectorAll("[data-rule-index]").forEach(function (input) {
        minimumStockRules[Number(input.dataset.ruleIndex)].minimum =
          Math.max(0, Number.parseInt(input.value, 10) || 0);
      });
      saveMinimums();
      render();
      closeSettings();
      toast("Estoques mínimos atualizados.");
    });
    modal.addEventListener("click", function (event) {
      if (event.target === modal) closeSettings();
    });
  }

  updateKpiLabels();
  applySavedMinimums();
  createMinimumSettings();
  $("nxtUpdateButton").addEventListener("click", startUpdate);
  loadServerData(false);
  checkUpdate();
})();
