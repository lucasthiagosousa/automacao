(function () {
  "use strict";

  let updateTimer = null;
  let activeDetailType = "";
  let minimumSettingsController = null;
  let currentUser = null;
  let minimumsConfigured = false;

  function applyMinimumValues(saved) {
    minimumStockRules.forEach(function (rule) {
      const key = norm(rule.item);
      if (Number.isFinite(Number(saved[key]))) {
        rule.minimum = Math.max(0, Number(saved[key]));
      }
    });
  }

  async function loadMinimums() {
    const response = await fetch("/api/minimos?t=" + Date.now(), { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.mensagem || "Não foi possível carregar os estoques mínimos.");
    const values = {};
    (result.itens || []).forEach(function (item) {
      const key = norm(item.categoryKey || item.categoryName);
      values[key] = Math.max(0, Number(item.minimum) || 0);
      if (!minimumStockRules.some(function (rule) { return norm(rule.item) === key; })) {
        minimumStockRules.push({
          item: item.categoryName || item.categoryKey,
          minimum: values[key],
          aliases: [item.categoryName || item.categoryKey]
        });
      }
    });
    minimumsConfigured = Boolean((result.itens || []).length);
    applyMinimumValues(values);
  }

  async function saveMinimums() {
    if (!currentUser || !currentUser.canEditMinimum) {
      throw new Error("Apenas o Master Admin pode alterar o estoque mínimo.");
    }
    const response = await fetch("/api/minimos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itens: minimumStockRules.map(function (rule) {
          return {
            categoryKey: norm(rule.item),
            categoryName: rule.item,
            minimum: Math.max(0, Number(rule.minimum) || 0)
          };
        })
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.mensagem || "Não foi possível salvar os estoques mínimos.");
    minimumsConfigured = true;
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
    const summaries = inventorySummaries(rawData).filter(function (item) {
      return item.minimum > 0;
    });
    const shortage = summaries.reduce(function (sum, item) {
      return sum + item.request;
    }, 0);
    const below = summaries.filter(function (item) {
      return item.request > 0;
    }).length;
    const total = sumQty(filteredData);
    const coverage = total + shortage > 0
      ? Math.min(100, Math.round(total / (total + shortage) * 100))
      : 100;
    return { below: below, shortage: shortage, coverage: coverage };
  }

  function ruleForType(type, createIfMissing) {
    const typeName = norm(type);
    let bestRule = null;
    let bestScore = -1;
    minimumStockRules.forEach(function (rule) {
      rule.aliases.forEach(function (alias) {
        const aliasName = norm(alias);
        let score = -1;
        if (typeName === aliasName) score = 1000 + aliasName.length;
        else if (typeName.includes(aliasName)) score = 100 + aliasName.length;
        else if (aliasName.includes(typeName)) score = 10 + typeName.length;
        if (score > bestScore) {
          bestScore = score;
          bestRule = rule;
        }
      });
    });
    if (!bestRule && createIfMissing) {
      bestRule = { item: type || "Sem categoria", minimum: 0, aliases: [type || "Sem categoria"] };
      minimumStockRules.push(bestRule);
    }
    return bestRule;
  }

  function inventorySummaries(source) {
    const typeField = getField("type");
    const modelField = getField("model");
    if (!typeField) return [];
    const grouped = new Map();
    source.forEach(function (row) {
      const type = clean(row[typeField]) || "Não informado";
      const key = norm(type);
      if (!grouped.has(key)) {
        grouped.set(key, { type: type, rows: [] });
      }
      grouped.get(key).rows.push(row);
    });
    return Array.from(grouped.values()).map(function (group) {
      const current = sumQty(group.rows);
      const rule = ruleForType(group.type, true);
      const minimum = Math.max(0, Number(rule.minimum) || 0);
      const request = Math.max(0, minimum - current);
      let status = "Adequado";
      let badge = "badge-green";
      if (request > 0) {
        status = current === 0 ? "Crítico" : "Repor";
        badge = "badge-red";
      } else if (minimum > 0 && current === minimum) {
        status = "No limite";
        badge = "badge-amber";
      }
      const models = new Map();
      group.rows.forEach(function (row) {
        const model = modelField ? clean(row[modelField]) || "Não informado" : "Não informado";
        models.set(model, (models.get(model) || 0) + qty(row));
      });
      return {
        type: group.type,
        current: current,
        minimum: minimum,
        request: request,
        status: status,
        badge: badge,
        rule: rule,
        models: Array.from(models.entries()).map(function (entry) {
          return { name: entry[0], quantity: entry[1] };
        }).sort(function (a, b) { return b.quantity - a.quantity; })
      };
    }).sort(function (a, b) {
      return b.request - a.request || a.type.localeCompare(b.type, "pt-BR");
    });
  }

  function installInventoryTable() {
    const panel = document.querySelector(".table-panel");
    const charts = document.querySelector(".dashboard-grid");
    if (panel && charts) {
      charts.parentNode.insertBefore(panel, charts);
      panel.style.marginBottom = "14px";
      panel.querySelector(".panel-title").textContent = "Visão rápida do estoque";
      panel.querySelector(".panel-desc").textContent =
        "Veja o estoque atual, o mínimo necessário e o que deve ser solicitado";
    }

    const detailPanel = document.createElement("section");
    detailPanel.className = "panel stock-detail-panel";
    detailPanel.id = "stockDetailPanel";
    detailPanel.hidden = true;
    detailPanel.innerHTML =
      '<div class="table-head"><div><h2 class="panel-title" id="stockDetailTitle">Ativos da categoria</h2>'
      + '<p class="panel-desc">Dados individuais encontrados na planilha do NXT4Insight</p></div>'
      + '<div class="stock-detail-actions"><span class="result-count" id="stockDetailCount">0 ativos</span>'
      + '<button class="btn btn-soft" type="button" id="stockDetailClose">Fechar</button></div></div>'
      + '<div class="table-scroll"><table><thead><tr>'
      + '<th>Código</th><th>Modelo</th><th>Marca</th><th>Fabricante</th>'
      + '<th>Status</th><th>Alocado para</th><th>Proprietário / empresa</th><th>Qtd.</th>'
      + '</tr></thead><tbody id="stockDetailBody"></tbody></table></div>';
    if (panel) panel.insertAdjacentElement("afterend", detailPanel);

    const style = document.createElement("style");
    style.textContent =
      ".stock-minimum-input{width:70px;min-height:34px;border:1px solid #d5e0ea;"
      + "border-radius:9px;background:#f8fafc;color:#102a43;font-weight:800;text-align:center;outline:none}"
      + ".stock-minimum-input:focus{border-color:#1677ff;box-shadow:0 0 0 3px rgba(22,119,255,.1)}"
      + ".stock-minimum-input:disabled{border-color:transparent;background:transparent;color:#344054;cursor:not-allowed}"
      + ".stock-request{min-width:38px;display:inline-flex;justify-content:center;padding:5px 8px;"
      + "border-radius:8px;background:#eaecf0;color:#475467;font-weight:800}"
      + ".stock-request.needed{background:#fee4e2;color:#b42318}"
      + ".stock-models{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#526b82}"
      + ".stock-category-button{padding:0;border:0;background:transparent;color:#0b63ce;"
      + "font-weight:800;cursor:pointer;text-align:left}"
      + ".stock-category-button:hover{text-decoration:underline;text-underline-offset:3px}"
      + ".stock-detail-panel{margin-bottom:14px;overflow:hidden}"
      + ".stock-detail-panel[hidden]{display:none}"
      + ".stock-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}"
      + ".stock-detail-panel td{max-width:260px}"
      + "@media(max-width:720px){.stock-detail-actions{width:100%;justify-content:space-between}}";
    document.head.appendChild(style);

    function fieldByAliases(aliasesList) {
      const keys = rawData[0] ? Object.keys(rawData[0]) : [];
      return keys.find(function (key) {
        return aliasesList.some(function (alias) {
          return norm(key) === norm(alias);
        });
      }) || null;
    }

    function renderAssetDetails(type, shouldScroll) {
      if (!type || !rawData.length) {
        detailPanel.hidden = true;
        return;
      }
      const typeField = getField("type");
      if (!typeField) {
        detailPanel.hidden = true;
        return;
      }
      const assets = rawData.filter(function (row) {
        return norm(row[typeField]) === norm(type);
      });
      if (!assets.length) {
        detailPanel.hidden = true;
        return;
      }

      activeDetailType = type;
      const codeField = getField("code");
      const modelField = getField("model");
      const brandField = getField("brand");
      const manufacturerField = getField("manufacturer");
      const statusField = getField("status");
      const ownerField = fieldByAliases(["Proprietário", "Proprietario", "Empresa"]);
      const allocatedField = fieldByAliases(["Alocado para", "Responsável", "Responsavel", "Colaborador"]);

      $("stockDetailTitle").textContent = "Ativos da categoria: " + type;
      $("stockDetailCount").textContent = assets.length + " ativo"
        + (assets.length === 1 ? "" : "s");
      $("stockDetailBody").innerHTML = assets.map(function (asset) {
        const code = codeField ? clean(asset[codeField]) : "";
        const model = modelField ? clean(asset[modelField]) : "";
        const brand = brandField ? clean(asset[brandField]) : "";
        const manufacturer = manufacturerField ? clean(asset[manufacturerField]) : "";
        const status = statusField ? clean(asset[statusField]) : "";
        const allocated = allocatedField ? clean(asset[allocatedField]) : "";
        const owner = ownerField ? clean(asset[ownerField]) : "";
        return "<tr>"
          + "<td class=\"code\">" + esc(code || "—") + "</td>"
          + "<td>" + esc(model || "—") + "</td>"
          + "<td>" + esc(brand || "—") + "</td>"
          + "<td>" + esc(manufacturer || "—") + "</td>"
          + "<td><span class=\"badge " + statusClass(status) + "\">" + esc(status || "Sem status") + "</span></td>"
          + "<td>" + esc(allocated || "—") + "</td>"
          + "<td>" + esc(owner || "—") + "</td>"
          + "<td><strong>" + qty(asset) + "</strong></td>"
          + "</tr>";
      }).join("");
      detailPanel.hidden = false;
      if (shouldScroll) {
        detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    $("stockDetailClose").addEventListener("click", function () {
      activeDetailType = "";
      detailPanel.hidden = true;
    });

    renderTable = function () {
      const summaries = inventorySummaries(filteredData);
      $("tableHead").innerHTML =
        "<th>Categoria</th><th>Atual</th><th>Mínimo</th><th>Solicitar</th><th>Status</th><th>Modelos encontrados</th>";
      $("tableBody").innerHTML = summaries.length
        ? summaries.map(function (item, index) {
          const models = item.models.map(function (model) {
            return esc(model.name) + " (" + model.quantity + ")";
          }).join(", ");
          return "<tr>"
            + "<td><button class=\"stock-category-button\" type=\"button\" data-detail-index=\"" + index + "\">"
            + esc(item.type) + "</button></td>"
            + "<td><strong>" + item.current + "</strong></td>"
            + "<td><input class=\"stock-minimum-input\" type=\"number\" min=\"0\" step=\"1\""
            + " value=\"" + item.minimum + "\" data-stock-index=\"" + index + "\""
            + (currentUser && currentUser.canEditMinimum ? "" : " disabled")
            + " aria-label=\"Estoque mínimo de " + esc(item.type) + "\"></td>"
            + "<td><span class=\"stock-request " + (item.request > 0 ? "needed" : "") + "\">"
            + item.request + "</span></td>"
            + "<td><span class=\"badge " + item.badge + "\">" + item.status + "</span></td>"
            + "<td class=\"stock-models\" title=\"" + models + "\">" + (models || "Modelo não informado") + "</td>"
            + "</tr>";
        }).join("")
        : "<tr><td colspan=\"6\"><div class=\"empty\">Nenhuma categoria encontrada para os filtros informados.</div></td></tr>";
      $("resultCount").textContent = summaries.length + " categoria"
        + (summaries.length === 1 ? "" : "s");
      document.querySelectorAll("[data-stock-index]").forEach(function (input) {
        input.addEventListener("change", async function () {
          const currentSummaries = inventorySummaries(filteredData);
          const item = currentSummaries[Number(input.dataset.stockIndex)];
          if (!item) return;
          const previous = item.rule.minimum;
          item.rule.minimum = Math.max(0, Number.parseInt(input.value, 10) || 0);
          input.disabled = true;
          try {
            await saveMinimums();
            render();
            toast("Estoque mínimo de " + item.type + " atualizado.");
          } catch (error) {
            item.rule.minimum = previous;
            render();
            toast(error.message);
          }
        });
      });
      document.querySelectorAll("[data-detail-index]").forEach(function (button) {
        button.addEventListener("click", function () {
          const currentSummaries = inventorySummaries(filteredData);
          const item = currentSummaries[Number(button.dataset.detailIndex)];
          if (item) renderAssetDetails(item.type, true);
        });
      });

      const selectedTypes = filters.type || [];
      const searchText = clean($("searchInput").value);
      if (selectedTypes.length === 1) {
        renderAssetDetails(selectedTypes[0], false);
      } else if (searchText && summaries.length === 1) {
        renderAssetDetails(summaries[0].type, false);
      } else if (activeDetailType) {
        renderAssetDetails(activeDetailType, false);
      } else {
        detailPanel.hidden = true;
      }
    };

    renderCritical = function () {
      const items = inventorySummaries(rawData).filter(function (item) {
        return item.minimum > 0 && item.request > 0;
      });
      $("criticalList").innerHTML = items.length
        ? items.map(function (item) {
          return "<div class=\"critical-item\"><div><strong>" + esc(item.type)
            + "</strong><span>Faltam " + item.request
            + " para atingir o mínimo</span></div><div class=\"stock-numbers\">"
            + "<span class=\"stock-number stock-current\">" + item.current
            + "</span><span>de</span><span class=\"stock-number stock-minimum\">"
            + item.minimum + "</span></div></div>";
        }).join("")
        : "<div class=\"empty\">Nenhum tipo de ativo está abaixo do limite definido.</div>";
    };
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
      if (!minimumsConfigured && currentUser && currentUser.canEditMinimum && minimumSettingsController) {
        setTimeout(function () {
          minimumSettingsController.open(true);
        }, 80);
      }
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
    if (!currentUser || !currentUser.canEditMinimum) return null;
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
      + '<div class="modal-title" id="minimumSettingsTitle">Estoques mínimos</div></div>'
      + '<p id="minimumSettingsDescription" style="margin:16px 18px 0;color:#6b7c93;font-size:12px;line-height:1.55">'
      + 'Defina a quantidade mínima necessária para cada categoria do inventário.</p>'
      + '<div class="details" id="minimumSettingsList"></div>'
      + '<div style="display:flex;justify-content:flex-end;gap:8px;padding:0 18px 18px">'
      + '<button class="btn" type="button" data-cancel-minimum>Cancelar</button>'
      + '<button class="btn btn-primary" type="button" data-save-minimum>Salvar alterações</button>'
      + '</div></div>';
    document.body.appendChild(modal);

    function openSettings(requiredSetup) {
      const required = Boolean(requiredSetup);
      modal.dataset.required = required ? "true" : "false";
      modal.querySelector(".modal-close").style.display = required ? "none" : "";
      modal.querySelector("[data-cancel-minimum]").style.display = required ? "none" : "";
      modal.querySelector("#minimumSettingsTitle").textContent = required
        ? "Defina as regras do estoque"
        : "Estoques mínimos";
      modal.querySelector("#minimumSettingsDescription").textContent = required
        ? "Antes de abrir o painel, informe quanto deve existir no estoque para cada categoria. O sistema calculará automaticamente quanto solicitar e o status atual."
        : "Altere a quantidade mínima necessária para cada categoria do inventário.";
      modal.querySelector("[data-save-minimum]").textContent = required
        ? "Salvar e abrir o painel"
        : "Salvar alterações";

      const summaries = inventorySummaries(rawData);
      const list = modal.querySelector("#minimumSettingsList");
      list.innerHTML = "";
      const visibleRules = minimumStockRules.filter(function (rule) {
        return summaries.some(function (item) { return item.rule === rule; })
          || Number(rule.minimum) > 0;
      });
      visibleRules.forEach(function (rule) {
        const index = minimumStockRules.indexOf(rule);
        const summary = summaries.find(function (item) { return item.rule === rule; });
        const field = document.createElement("label");
        field.className = "detail";
        const label = document.createElement("span");
        label.className = "detail-label";
        label.textContent = rule.item + " · atual: " + (summary ? summary.current : 0);
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
      if (modal.dataset.required === "true") return;
      modal.classList.remove("show");
      document.body.style.overflow = "";
    }

    button.addEventListener("click", function () { openSettings(false); });
    modal.querySelector(".modal-close").addEventListener("click", closeSettings);
    modal.querySelector("[data-cancel-minimum]").addEventListener("click", closeSettings);
    modal.querySelector("[data-save-minimum]").addEventListener("click", async function () {
      const saveButton = modal.querySelector("[data-save-minimum]");
      const previousValues = minimumStockRules.map(function (rule) { return rule.minimum; });
      modal.querySelectorAll("[data-rule-index]").forEach(function (input) {
        minimumStockRules[Number(input.dataset.ruleIndex)].minimum =
          Math.max(0, Number.parseInt(input.value, 10) || 0);
      });
      saveButton.disabled = true;
      saveButton.textContent = "Salvando...";
      try {
        await saveMinimums();
        modal.dataset.required = "false";
        render();
        closeSettings();
        toast("Regras de estoque mínimo salvas.");
      } catch (error) {
        minimumStockRules.forEach(function (rule, index) {
          rule.minimum = previousValues[index];
        });
        toast(error.message);
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = "Salvar alterações";
      }
    });
    modal.addEventListener("click", function (event) {
      if (event.target === modal) closeSettings();
    });

    return {
      open: openSettings
    };
  }

  async function initialize() {
    try {
      currentUser = await window.NXT_AUTH_PROMISE;
      await loadMinimums();
      updateKpiLabels();
      installInventoryTable();
      minimumSettingsController = createMinimumSettings();
      const updateButton = $("nxtUpdateButton");
      if (updateButton && currentUser.canUpdateNxt) {
        updateButton.addEventListener("click", startUpdate);
      }
      await loadServerData(false);
      await checkUpdate();
    } catch (error) {
      toast(error.message || "Não foi possível iniciar o painel.");
    }
  }

  initialize();
})();
