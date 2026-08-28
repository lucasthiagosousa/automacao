(function () {
  "use strict";

  const ROLE_LABELS = { master: "Master Admin", operator: "Operador", viewer: "Visualizador" };
  const WORKSPACE_PAGES = ["/", "/index.html", "/toner.html", "/colaboradores.html"];

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
      .auth-avatar{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;background:#fff;color:#0b63ce;font-size:11px;font-weight:900}
      .auth-copy{display:flex;flex-direction:column;line-height:1.15;text-align:left}.auth-copy strong{font-size:11px}.auth-copy span{font-size:9px;opacity:.72}.auth-link{cursor:pointer;text-decoration:none}
      body.workspace-operational{--workspace-navy:#071b2e;--workspace-navy-2:#0b3553;--workspace-teal:#087684;--workspace-line:#dce5ee;--workspace-blue:#1769e0;background:#f3f6fa!important;color:#172b3f}
      body.workspace-operational .header{position:relative;isolation:isolate;top:auto;padding:0!important;overflow:hidden!important;background:linear-gradient(112deg,#071a2d 0%,#0a3552 52%,#08727c 100%)!important;color:#fff!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important}
      body.workspace-operational .header:before{content:"";position:absolute;z-index:-1;width:520px;height:520px;right:-130px;top:-390px;border-radius:50%;background:rgba(80,211,222,.16);filter:blur(2px)}
      body.workspace-operational .header:after{display:none!important}body.workspace-operational .content{margin:0 auto!important;padding-top:22px!important}
      body.workspace-operational .header-inner{width:min(100% - 40px,1460px)!important;max-width:1460px!important;margin:auto!important;padding:18px 0!important}
      body.workspace-operational .header .brand p,body.workspace-operational .header .brand-subtitle{color:rgba(255,255,255,.72)!important}
      body.workspace-operational .header .brand-icon,body.workspace-operational .header .mark{border:1px solid rgba(255,255,255,.27)!important;background:rgba(255,255,255,.11)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header{border-color:rgba(255,255,255,.25)!important;background:rgba(255,255,255,.1)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header:hover{background:rgba(255,255,255,.18)!important;border-color:rgba(255,255,255,.4)!important}
      body.workspace-operational .workspace-tabs-shell{position:relative;background:linear-gradient(112deg,#071a2d 0%,#0a3552 52%,#08727c 100%);border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(5,24,40,.35);box-shadow:0 9px 24px rgba(7,27,46,.13)}
      .workspace-tabs{width:min(100% - 40px,1460px);height:58px;margin:auto;display:flex;align-items:center;gap:8px;overflow-x:auto;scrollbar-width:none}.workspace-tabs::-webkit-scrollbar{display:none}
      .workspace-tab{height:39px;padding:0 14px;display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:11px;color:rgba(231,242,250,.7);font-size:11px;font-weight:650;text-decoration:none;white-space:nowrap;transition:background .16s,border-color .16s,color .16s,transform .16s}
      .workspace-tab svg{width:17px;height:17px}.workspace-tab:hover{background:rgba(255,255,255,.09);color:#fff;transform:translateY(-1px)}.workspace-tab.active{border-color:rgba(134,221,230,.28);background:rgba(255,255,255,.14);color:#fff;box-shadow:inset 0 1px rgba(255,255,255,.08),0 5px 14px rgba(0,0,0,.1)}
      .workspace-tab-copy{display:flex;flex-direction:column;line-height:1.12}.workspace-tab-copy small{margin-top:2px;color:rgba(213,232,243,.48);font-size:8px;font-weight:500}.workspace-tab.active small{color:rgba(222,244,249,.72)}
      body.workspace-page-stock .content{max-width:1460px!important}body.workspace-page-stock .kpi,body.workspace-page-stock .panel,body.workspace-page-toner .kpi,body.workspace-page-toner .panel,body.workspace-page-colaboradores .card,body.workspace-page-colaboradores .table-wrap{border-color:#dde5ed!important;box-shadow:0 8px 26px rgba(19,45,68,.055)!important}
      .workspace-page-heading{margin:1px 0 18px;padding:2px 1px;display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.workspace-page-heading span{display:block;margin-bottom:6px;color:#1670d2;font-size:9px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.workspace-page-heading h2{margin:0;color:#102f4a;font-size:25px;font-weight:650;letter-spacing:-.035em}.workspace-page-heading p{max-width:580px;margin:0;color:#718096;font-size:10px;line-height:1.6;text-align:right}
      body.workspace-page-toner{--blue:#1769e0!important;--text:#172b3f!important;--muted:#718096!important;--line:#dce5ee!important;background:#f3f6fa!important;background-image:radial-gradient(750px 320px at 94% -10%,#d9f2f4,transparent 65%)!important}
      body.workspace-page-toner .page{max-width:1460px!important}body.workspace-page-toner .kpi{border-top:1px solid #dde5ed!important;border-left:4px solid #1769e0!important}body.workspace-page-toner .kpi:nth-child(2){border-left-color:#10aab8!important}body.workspace-page-toner .kpi:nth-child(3){border-left-color:#e5484d!important}body.workspace-page-toner .kpi:nth-child(4){border-left-color:#e79b24!important}body.workspace-page-toner .kpi:nth-child(5){border-left-color:#748197!important}
      body.workspace-page-toner .card:before{background:#748197}body.workspace-page-toner .card:has(.badge-ok):before{background:#10a36d}body.workspace-page-toner .card:has(.badge-warning):before{background:#e79b24}body.workspace-page-toner .card:has(.badge-critical):before{background:#e5484d}body.workspace-page-toner .btn-pdf{background:#0b3553!important;border-color:#0b3553!important}
      body.workspace-page-colaboradores{padding-top:0!important}body.workspace-page-colaboradores .wrap{max-width:1280px}
      body.workspace-page-colaboradores .wrap>header{margin:0 calc((1280px - 100vw)/2) 0;padding:18px max(24px,calc((100vw - 1280px)/2));align-items:center;background:linear-gradient(115deg,#0b3553,#0b6675);color:#fff}
      body.workspace-page-colaboradores .wrap>header .brand p{color:rgba(255,255,255,.72)}body.workspace-page-colaboradores .brand-mark{border:1px solid rgba(255,255,255,.27);background:rgba(255,255,255,.11);box-shadow:none}
      body.workspace-page-colaboradores .header-right .back-link{border-color:rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;box-shadow:none}
      body.workspace-page-colaboradores .status-pill{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.09);color:rgba(255,255,255,.8)}
      body.workspace-page-colaboradores .workspace-tabs-shell{width:100vw;margin-left:calc((1280px - 100vw)/2);margin-bottom:26px}
      body.workspace-operational a[data-old-workspace-link]{display:none!important}
      @media(max-width:1328px){body.workspace-page-colaboradores .wrap>header{margin-left:-24px;margin-right:-24px;padding-left:24px;padding-right:24px}body.workspace-page-colaboradores .workspace-tabs-shell{width:calc(100% + 48px);margin-left:-24px}}
      @media(max-width:900px){body.workspace-operational .header-inner,body.workspace-page-colaboradores .wrap>header{align-items:flex-start!important;flex-direction:column!important}.header-actions,.header-right{width:100%;justify-content:flex-start!important}.workspace-tabs{width:calc(100% - 24px);height:55px}.workspace-tab{padding:0 12px}.workspace-tab-copy small{display:none}.workspace-page-heading{align-items:flex-start;flex-direction:column;gap:7px}.workspace-page-heading p{text-align:left}}
      @media(max-width:560px){.auth-copy{display:none}.auth-account{padding:5px}.header-actions,.header-right{gap:6px!important}.header-actions>.btn,.header-right>.btn,.header-right>.back-link{min-height:36px!important;padding:7px 9px!important;font-size:10px!important}.workspace-tabs{gap:4px}.workspace-tab{flex:0 0 auto;height:37px;font-size:10px}}
    `;
    document.head.appendChild(style);
  }

  function accountControl(user) {
    const element = document.createElement("div");
    element.className = "auth-account";
    element.title = ROLE_LABELS[user.role] || user.role;
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
    if (type === "stock") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-9 5 9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>';
    if (type === "toner") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>';
  }

  function installWorkspaceNavigation() {
    const path = window.location.pathname;
    if (!WORKSPACE_PAGES.includes(path)) return;
    document.body.classList.add("workspace-operational");
    if (path === "/" || path === "/index.html") document.body.classList.add("workspace-page-stock");
    if (path === "/toner.html") document.body.classList.add("workspace-page-toner");
    if (path === "/colaboradores.html") document.body.classList.add("workspace-page-colaboradores");

    document.querySelectorAll('a[href="/"],a[href="/index.html"],a[href="/toner.html"],a[href="/colaboradores.html"]').forEach(function (anchor) {
      if (anchor.closest(".header-actions, .header-right")) anchor.dataset.oldWorkspaceLink = "true";
    });

    const shell = document.createElement("div");
    shell.className = "workspace-tabs-shell";
    const nav = document.createElement("nav");
    nav.className = "workspace-tabs";
    nav.setAttribute("aria-label", "Módulos do sistema");
    [
      { href: "/", type: "stock", title: "Estoque", subtitle: "Ativos e solicitações", paths: ["/", "/index.html"] },
      { href: "/toner.html", type: "toner", title: "Toners", subtitle: "Impressoras e suprimentos", paths: ["/toner.html"] },
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
    addStyles();
    installWorkspaceNavigation();
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

  window.NXT_AUTH_PROMISE = requestUser().then(function (user) {
    window.NXT_CURRENT_USER = user;
    decorate(user);
    return user;
  });
})();
