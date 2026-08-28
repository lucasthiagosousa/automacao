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
      body.workspace-operational{--workspace-navy:#0b3654;--workspace-teal:#0b7d87;--workspace-line:#dce5ee;--workspace-blue:#1769e0}
      body.workspace-operational .header{position:relative;top:auto;padding:0!important;overflow:visible!important;background:linear-gradient(115deg,#0b3553,#0b6675)!important;color:#fff!important;border:0!important;box-shadow:none!important;backdrop-filter:none!important}
      body.workspace-operational .header:after{display:none!important}body.workspace-operational .content{margin:0 auto!important;padding-top:22px!important}
      body.workspace-operational .header-inner{width:min(100% - 40px,1460px)!important;max-width:1460px!important;margin:auto!important;padding:18px 0!important}
      body.workspace-operational .header .brand p,body.workspace-operational .header .brand-subtitle{color:rgba(255,255,255,.72)!important}
      body.workspace-operational .header .brand-icon,body.workspace-operational .header .mark{border:1px solid rgba(255,255,255,.27)!important;background:rgba(255,255,255,.11)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header{border-color:rgba(255,255,255,.25)!important;background:rgba(255,255,255,.1)!important;color:#fff!important;box-shadow:none!important}
      body.workspace-operational .header .btn-header:hover{background:rgba(255,255,255,.18)!important;border-color:rgba(255,255,255,.4)!important}
      body.workspace-operational .workspace-tabs-shell{background:#fff;border-bottom:1px solid var(--workspace-line);box-shadow:0 4px 14px rgba(16,42,67,.04)}
      .workspace-tabs{width:min(100% - 40px,1460px);height:58px;margin:auto;display:flex;align-items:center;gap:8px;overflow-x:auto;scrollbar-width:none}.workspace-tabs::-webkit-scrollbar{display:none}
      .workspace-tab{height:38px;padding:0 14px;display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:10px;color:#61758b;font-size:11px;font-weight:750;text-decoration:none;white-space:nowrap;transition:background .16s,border-color .16s,color .16s,transform .16s}
      .workspace-tab svg{width:17px;height:17px}.workspace-tab:hover{background:#f4f7fb;color:#173b5b;transform:translateY(-1px)}.workspace-tab.active{border-color:#cfe0f2;background:#edf5ff;color:#0b63ce;box-shadow:0 1px 2px rgba(16,42,67,.04)}
      .workspace-tab-copy{display:flex;flex-direction:column;line-height:1.12}.workspace-tab-copy small{margin-top:2px;color:#8a9aab;font-size:8px;font-weight:600}.workspace-tab.active small{color:#5c8fc8}
      body.workspace-page-colaboradores{padding-top:0!important}body.workspace-page-colaboradores .wrap{max-width:1280px}
      body.workspace-page-colaboradores .wrap>header{margin:0 calc((1280px - 100vw)/2) 0;padding:18px max(24px,calc((100vw - 1280px)/2));align-items:center;background:linear-gradient(115deg,#0b3553,#0b6675);color:#fff}
      body.workspace-page-colaboradores .wrap>header .brand p{color:rgba(255,255,255,.72)}body.workspace-page-colaboradores .brand-mark{border:1px solid rgba(255,255,255,.27);background:rgba(255,255,255,.11);box-shadow:none}
      body.workspace-page-colaboradores .header-right .back-link{border-color:rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;box-shadow:none}
      body.workspace-page-colaboradores .status-pill{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.09);color:rgba(255,255,255,.8)}
      body.workspace-page-colaboradores .workspace-tabs-shell{width:100vw;margin-left:calc((1280px - 100vw)/2);margin-bottom:26px}
      body.workspace-operational a[data-old-workspace-link]{display:none!important}
      @media(max-width:1328px){body.workspace-page-colaboradores .wrap>header{margin-left:-24px;margin-right:-24px;padding-left:24px;padding-right:24px}body.workspace-page-colaboradores .workspace-tabs-shell{width:calc(100% + 48px);margin-left:-24px}}
      @media(max-width:900px){body.workspace-operational .header-inner,body.workspace-page-colaboradores .wrap>header{align-items:flex-start!important;flex-direction:column!important}.header-actions,.header-right{width:100%;justify-content:flex-start!important}.workspace-tabs{width:calc(100% - 24px);height:55px}.workspace-tab{padding:0 12px}.workspace-tab-copy small{display:none}}
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
