(function () {
  "use strict";

  const ROLE_LABELS = { master: "Master Admin", operator: "Operador", viewer: "Visualizador" };
  const WORKSPACE_PAGES = ["/central.html", "/", "/index.html", "/toner.html", "/colaboradores.html"];

  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });

  async function requestUser() {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    if (response.status === 401) {
      window.location.replace("/login.html");
      throw new Error("Sessão expirada.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.mensagem || "Não foi possível validar a sessão.");
    return result.user;
  }

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .auth-account{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:5px 9px;border:1px solid rgba(255,255,255,.22);border-radius:10px;color:inherit;background:rgba(255,255,255,.1)}
      .auth-avatar{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;background:#fff;color:#087a45;font-size:11px;font-weight:900}
      .auth-copy{display:flex;flex-direction:column;line-height:1.15;text-align:left}.auth-copy strong{font-size:11px}.auth-copy span{font-size:9px;opacity:.72}.auth-link{cursor:pointer;text-decoration:none}
      body.workspace-operational{--workspace-navy:#00180c;--workspace-navy-2:#04351c;--workspace-teal:#087a45;--workspace-line:#dce5ee;--workspace-blue:#08a85d;background:radial-gradient(1050px 430px at 88% -70px,rgba(0,198,92,.16) 0%,rgba(223,244,233,.48) 39%,transparent 68%),linear-gradient(180deg,#edf6f1 0,#f3f6fa 300px,#f3f6fa 100%)!important;background-attachment:fixed!important;color:#172b3f}
      body.workspace-operational .header{position:relative;isolation:isolate;top:auto;padding:0!important;overflow:hidden!important;background:linear-gradient(112deg,#001109 0%,#042b17 52%,#087a45 100%)!important;color:#fff!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important}
      body.workspace-operational .header:before{content:"";position:absolute;z-index:-1;width:520px;height:520px;right:-130px;top:-390px;border-radius:50%;background:rgba(0,255,119,.18);filter:blur(2px)}
      body.workspace-operational .header:after{display:none!important}body.workspace-operational .content{margin:0 auto!important;padding-top:22px!important}
      body.workspace-operational .header-inner{width:calc(100% - 48px)!important;max-width:none!important;margin:auto!important;padding:18px 0!important}
      body.workspace-operational .header .brand p,body.workspace-operational .header .brand-subtitle{color:rgba(255,255,255,.72)!important}
      body.workspace-operational .header .brand-icon,body.workspace-operational .header .mark{border:1px solid rgba(255,255,255,.27)!important;background:rgba(255,255,255,.11)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header{border-color:rgba(255,255,255,.25)!important;background:rgba(255,255,255,.1)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header:hover{background:rgba(255,255,255,.18)!important;border-color:rgba(255,255,255,.4)!important}
      body.workspace-operational .workspace-tabs-shell{position:relative;z-index:4;background:linear-gradient(112deg,#001109 0%,#042b17 52%,#087a45 100%);border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(0,86,42,.28);box-shadow:0 12px 28px rgba(0,48,24,.16)}body.workspace-operational .workspace-tabs-shell:after{content:"";position:absolute;left:0;right:0;bottom:-18px;height:18px;pointer-events:none;background:linear-gradient(180deg,rgba(0,180,83,.10),transparent)}
      .workspace-tabs{width:calc(100% - 48px);max-width:none;height:58px;margin:auto;display:flex;align-items:center;gap:8px;overflow-x:auto;scrollbar-width:none}.workspace-tabs::-webkit-scrollbar{display:none}
      .workspace-tab{height:39px;padding:0 14px;display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:11px;color:rgba(231,242,250,.7);font-size:11px;font-weight:650;text-decoration:none;white-space:nowrap;transition:background .16s,border-color .16s,color .16s,transform .16s}
      .workspace-tab svg{width:17px;height:17px}.workspace-tab:hover{background:rgba(255,255,255,.09);color:#fff;transform:translateY(-1px)}.workspace-tab.active{border-color:rgba(72,236,147,.38);background:rgba(15,201,101,.18);color:#fff;box-shadow:inset 0 1px rgba(255,255,255,.08),0 5px 14px rgba(0,0,0,.1)}
      .workspace-tab-copy{display:flex;flex-direction:column;line-height:1.12}.workspace-tab-copy small{margin-top:2px;color:rgba(199,235,215,.55);font-size:8px;font-weight:500}.workspace-tab.active small{color:rgba(220,255,235,.78)}
      body.workspace-page-stock .content{max-width:1460px!important}body.workspace-page-stock .kpi,body.workspace-page-stock .panel,body.workspace-page-toner .kpi,body.workspace-page-toner .panel,body.workspace-page-colaboradores .card,body.workspace-page-colaboradores .table-wrap{border-color:#dde5ed!important;box-shadow:0 8px 26px rgba(19,45,68,.055)!important}
      .workspace-page-heading{margin:1px 0 18px;padding:2px 1px;display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.workspace-page-heading span{display:block;margin-bottom:6px;color:#078b4e;font-size:9px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.workspace-page-heading h2{margin:0;color:#102f4a;font-size:25px;font-weight:650;letter-spacing:-.035em}.workspace-page-heading p{max-width:580px;margin:0;color:#718096;font-size:10px;line-height:1.6;text-align:right}
      body.workspace-page-toner{--blue:#1769e0!important;--text:#172b3f!important;--muted:#718096!important;--line:#dce5ee!important;background:#f3f6fa!important;background-image:radial-gradient(750px 320px at 94% -10%,#d9f2f4,transparent 65%)!important}
      body.workspace-page-toner .page{max-width:1460px!important}body.workspace-page-toner .kpi{border-top:1px solid #dde5ed!important;border-left:4px solid #1769e0!important}body.workspace-page-toner .kpi:nth-child(2){border-left-color:#10aab8!important}body.workspace-page-toner .kpi:nth-child(3){border-left-color:#e5484d!important}body.workspace-page-toner .kpi:nth-child(4){border-left-color:#e79b24!important}body.workspace-page-toner .kpi:nth-child(5){border-left-color:#748197!important}
      body.workspace-page-toner .card:before{background:#748197}body.workspace-page-toner .card:has(.badge-ok):before{background:#10a36d}body.workspace-page-toner .card:has(.badge-warning):before{background:#e79b24}body.workspace-page-toner .card:has(.badge-critical):before{background:#e5484d}
      body.workspace-page-toner .toolbar{display:flex!important;grid-template-columns:none!important;align-items:center;flex-wrap:wrap;gap:9px}body.workspace-page-toner .toolbar #search{flex:1 1 390px;min-width:220px}body.workspace-page-toner .toolbar #status{flex:0 1 190px;width:190px}body.workspace-page-toner .toolbar .btn{flex:0 0 auto;width:auto!important;white-space:nowrap}body.workspace-page-toner .btn-pdf{background:#0b3553!important;border-color:#0b3553!important;color:#fff!important}
      body.workspace-page-colaboradores{padding:0!important}body.workspace-page-colaboradores .wrap{max-width:none!important;width:100%!important;margin:0!important}
      body.workspace-page-colaboradores .wrap>header{position:relative;isolation:isolate;overflow:hidden;width:100%;margin:0!important;padding:18px 24px;align-items:center;background:linear-gradient(112deg,#001109 0%,#042b17 52%,#087a45 100%);color:#fff}
      body.workspace-page-colaboradores .wrap>header:before{content:"";position:absolute;z-index:-1;width:520px;height:520px;right:-130px;top:-390px;border-radius:50%;background:rgba(0,255,119,.18);filter:blur(2px)}
      body.workspace-page-colaboradores .wrap>header .brand p{color:rgba(255,255,255,.72)}body.workspace-page-colaboradores .brand-mark{border:1px solid rgba(255,255,255,.27);background:rgba(255,255,255,.11);box-shadow:none}
      body.workspace-page-colaboradores .brand-mark svg{width:21px;height:21px}
      body.workspace-page-colaboradores .header-right .back-link{border-color:rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;box-shadow:none}
      body.workspace-page-colaboradores .status-pill{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.09);color:rgba(255,255,255,.8)}
      body.workspace-page-colaboradores .workspace-tabs-shell{width:100%;margin:0 0 26px}
      body.workspace-page-colaboradores .wrap>#dropzone,body.workspace-page-colaboradores .wrap>#app,body.workspace-page-colaboradores .wrap>footer{width:min(calc(100% - 48px),1280px);margin-left:auto;margin-right:auto}
      body.workspace-operational a[data-old-workspace-link]{display:none!important}
      @media(max-width:1328px){body.workspace-page-colaboradores .wrap>header{padding-left:24px;padding-right:24px}}
      @media(max-width:900px){body.workspace-operational .header-inner,body.workspace-page-colaboradores .wrap>header{align-items:flex-start!important;flex-direction:column!important}.header-actions,.header-right{width:100%;justify-content:flex-start!important}.workspace-tabs{width:calc(100% - 24px);height:55px}.workspace-tab{padding:0 12px}.workspace-tab-copy small{display:none}.workspace-page-heading{align-items:flex-start;flex-direction:column;gap:7px}.workspace-page-heading p{text-align:left}}
      /* Identidade verde global: ações e estados interativos */
      body.workspace-operational{--blue:#0aad63!important;--accent:#0aad63!important;--accent-dim:#e4f8ee!important}
      body.workspace-operational .content .btn-primary,body.workspace-operational main .btn-primary,body.workspace-operational .modal .btn-primary,body.workspace-operational #saveVacationPlan{border-color:#0a9b59!important;background:linear-gradient(135deg,#12cc78,#079854)!important;color:#fff!important;box-shadow:0 7px 18px rgba(5,143,79,.18)!important}
      body.workspace-operational .content .btn-primary:hover,body.workspace-operational main .btn-primary:hover,body.workspace-operational .modal .btn-primary:hover{background:linear-gradient(135deg,#18d982,#087f49)!important;transform:translateY(-1px)}
      body.workspace-operational .btn-soft,body.workspace-operational .btn-action{border-color:#bce8d2!important;background:#f3fcf7!important;color:#087747!important}
      body.workspace-operational .btn-soft:hover,body.workspace-operational .btn-action:hover{border-color:#7bd5a7!important;background:#e6f8ef!important}
      body.workspace-operational input:focus,body.workspace-operational select:focus,body.workspace-operational textarea:focus,body.workspace-operational .control:focus{border-color:#35b97b!important;box-shadow:0 0 0 3px rgba(10,173,99,.11)!important;outline:none!important}
      body.workspace-operational input[type="checkbox"],body.workspace-operational input[type="radio"]{accent-color:#0aad63!important}
      body.workspace-operational .result-count,body.workspace-operational .count,body.workspace-operational .access-tag{background:#e4f8ee!important;color:#087747!important;border-color:#bce8d2!important}
      body.workspace-operational .code,body.workspace-operational .browse,body.workspace-operational .workspace-page-heading span{color:#088b50!important}
      body.workspace-page-colaboradores .tab.active,body.workspace-page-colaboradores .chip.active{border-color:#0aad63!important;background:#0aad63!important;color:#fff!important;box-shadow:0 6px 16px rgba(10,173,99,.18)!important}
      body.workspace-page-colaboradores #dropzone:hover,body.workspace-page-colaboradores #dropzone.drag{border-color:#29b974!important;background:#f1fbf6!important}
      body.workspace-operational ::selection{background:#bdebd2;color:#063e25}
      .btn-primary{border-color:#0a9b59!important;background:linear-gradient(135deg,#12cc78,#079854)!important;color:#fff!important}
      @media(max-width:560px){body.workspace-operational .header-inner,.workspace-tabs{width:calc(100% - 24px)!important}body.workspace-page-colaboradores .wrap>#dropzone,body.workspace-page-colaboradores .wrap>#app,body.workspace-page-colaboradores .wrap>footer{width:calc(100% - 24px)}body.workspace-page-toner .toolbar #search,body.workspace-page-toner .toolbar #status,body.workspace-page-toner .toolbar .btn{flex:1 1 100%;width:100%!important}.auth-copy{display:none}.auth-account{padding:5px}.header-actions,.header-right{gap:6px!important}.header-actions>.btn,.header-right>.btn,.header-right>.back-link{min-height:36px!important;padding:7px 9px!important;font-size:10px!important}.workspace-tabs{gap:4px}.workspace-tab{flex:0 0 auto;height:37px;font-size:10px}}
    `;
    document.head.appendChild(style);
  }

  function accountControl(user) {
    const element = document.createElement("a");
    element.className = "auth-account";
    element.href = "/profile.html";
    element.title = "Minha conta · " + (ROLE_LABELS[user.role] || user.role);
    element.innerHTML = '<span class="auth-avatar">' + String(user.username || "U").slice(0, 2).toUpperCase()
      + '</span><span class="auth-copy"><strong></strong><span></span></span>';
    element.querySelector("strong").textContent = user.username;
    element.querySelector(".auth-copy span").textContent = ROLE_LABELS[user.role] || user.role;
    return element;
  }

  function link(label, href) {
    const element = document.createElement("a");
    element.className = "btn btn-header back-link auth-link";
    element.href = href;
    element.textContent = label;
    return element;
  }

  function workspaceIcon(type) {
    if (type === "central") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M14 17h7M17.5 13.5v7"/></svg>';
    if (type === "stock") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-9 5 9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>';
    if (type === "toner") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>';
  }

  function installWorkspaceNavigation() {
    const path = window.location.pathname;
    if (!WORKSPACE_PAGES.includes(path)) return;
    document.body.classList.add("workspace-operational");
    if (path === "/central.html") document.body.classList.add("workspace-page-central");
    if (path === "/" || path === "/index.html") document.body.classList.add("workspace-page-stock");
    if (path === "/toner.html") document.body.classList.add("workspace-page-toner");
    if (path === "/colaboradores.html") document.body.classList.add("workspace-page-colaboradores");

    document.querySelectorAll('a[href="/central.html"],a[href="/"],a[href="/index.html"],a[href="/toner.html"],a[href="/colaboradores.html"]').forEach(function (anchor) {
      if (anchor.closest(".header-actions, .header-right")) anchor.dataset.oldWorkspaceLink = "true";
    });

    const shell = document.createElement("div");
    shell.className = "workspace-tabs-shell";
    const nav = document.createElement("nav");
    nav.className = "workspace-tabs";
    nav.setAttribute("aria-label", "Módulos do sistema");
    [
      { href: "/central.html", type: "central", title: "Central", subtitle: "Pendências e indicadores", paths: ["/central.html"] },
      { href: "/", type: "stock", title: "Estoque", subtitle: "Ativos e solicitações", paths: ["/", "/index.html"] },
      { href: "/toner.html?v=20260828-9", type: "toner", title: "Toners", subtitle: "Impressoras e suprimentos", paths: ["/toner.html"] },
      { href: "/colaboradores.html", type: "people", title: "Colaboradores", subtitle: "Acessos e movimentações", paths: ["/colaboradores.html"] }
    ].forEach(function (item) {
      const anchor = document.createElement("a");
      anchor.className = "workspace-tab" + (item.paths.includes(path) ? " active" : "");
      anchor.href = item.href;
      if (item.paths.includes(path)) anchor.setAttribute("aria-current", "page");
      anchor.innerHTML = workspaceIcon(item.type) + '<span class="workspace-tab-copy"><span>'
        + item.title + "</span><small>" + item.subtitle + "</small></span>";
      nav.appendChild(anchor);
    });
    shell.appendChild(nav);

    const header = path === "/colaboradores.html"
      ? document.querySelector(".wrap > header")
      : document.querySelector(".header");
    if (header) header.insertAdjacentElement("afterend", shell);

    if (path === "/" || path === "/index.html") {
      const content = document.querySelector(".content");
      if (content) {
        const heading = document.createElement("section");
        heading.className = "workspace-page-heading";
        heading.innerHTML = '<div><span>Operação de ativos</span><h2>Visão geral do estoque</h2></div>'
          + '<p>Acompanhe disponibilidade, níveis mínimos e solicitações de reposição em uma única tela.</p>';
        content.insertBefore(heading, content.firstChild);
      }
    }
  }

  function decorate(user) {
    const actions = document.querySelector(".header-actions, .header-right");
    if (actions) {
      if (user.canManageUsers) actions.appendChild(link("Usuários", "/admin.html"));
      actions.appendChild(accountControl(user));
      const logout = link("Sair", "#");
      logout.addEventListener("click", async function (event) {
        event.preventDefault();
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.replace("/login.html");
      });
      actions.appendChild(logout);
    }
    const updateButton = document.getElementById("nxtUpdateButton");
    if (updateButton && !user.canUpdateNxt) updateButton.hidden = true;
    const uploadButton = document.getElementById("uploadButton");
    if (uploadButton && user.role === "viewer") uploadButton.hidden = true;
  }

  /*
   * O shell visual precisa existir antes da consulta ao usuário para evitar
   * que o navegador mostre por um instante o layout antigo de cada módulo.
   */
  addStyles();
  installWorkspaceNavigation();

  window.NXT_AUTH_PROMISE = requestUser().then(function (user) {
    window.NXT_CURRENT_USER = user;
    decorate(user);
    return user;
  });
})();
