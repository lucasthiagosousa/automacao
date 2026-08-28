(function () {
  "use strict";

  const ROLE_LABELS = {
    master: "Master Admin",
    operator: "Operador",
    viewer: "Visualizador"
  };

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
    style.textContent =
      ".auth-account{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:5px 9px;"
      + "border:1px solid rgba(255,255,255,.18);border-radius:10px;color:inherit;background:rgba(255,255,255,.08)}"
      + ".auth-avatar{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;"
      + "background:#fff;color:#0b63ce;font-size:11px;font-weight:900}"
      + ".auth-copy{display:flex;flex-direction:column;line-height:1.15;text-align:left}"
      + ".auth-copy strong{font-size:11px}.auth-copy span{font-size:9px;opacity:.72}"
      + ".auth-link{cursor:pointer;text-decoration:none}"
      + "body>.wrap .auth-account{border-color:#d7e2ec;background:#fff;color:#102a43}"
      + "@media(max-width:720px){.auth-copy{display:none}.auth-account{padding:5px}}";
    document.head.appendChild(style);
  }

  function accountControl(user) {
    const element = document.createElement("div");
    element.className = "auth-account";
    element.title = ROLE_LABELS[user.role] || user.role;
    element.innerHTML = '<span class="auth-avatar">'
      + String(user.username || "U").slice(0, 2).toUpperCase()
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

  function decorate(user) {
    addStyles();
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
