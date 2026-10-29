const login = document.querySelector("#login");
const app = document.querySelector("#app");
const loginError = document.querySelector("#login-error");

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Fehler ${response.status}`);
  return body;
}

function showApp() {
  login.hidden = true;
  app.hidden = false;
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#password").value }),
    });
    showApp();
    await refresh();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

document.querySelector("#start").addEventListener("click", () => api("/api/start", { method: "POST" }).then(refresh).catch(showError));
document.querySelector("#stop").addEventListener("click", () => api("/api/stop", { method: "POST" }).then(refresh).catch(showError));
document.querySelector("#sell").addEventListener("click", () => api("/api/sell", { method: "POST" }).then(refresh).catch(showError));

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

function showError(error) {
  document.querySelector("#warnings").textContent = error.message;
}

function phaseText(position) {
  if (!position) return "Keine offene Position. Der nächste Coin startet erst nach einem abgeschlossenen Dump.";
  const labels = {
    creating: "Coin wird erstellt und mit 1 SOL gekauft",
    watching: "Wartet auf den ersten Kauf des Mayhem-Bots",
    selling: "Verkauft sofort in den Mayhem-Kauf",
    collecting: "Zieht die Creator-Fee on-chain auf dieses Wallet",
  };
  return `${labels[position.phase] || position.phase}: ${position.symbol} · ${position.mint}`;
}

async function refresh() {
  const state = await api("/api/state");
  document.querySelector("#status").textContent = state.running ? "läuft" : "steht";
  document.querySelector("#balance").textContent = state.balanceSol == null ? "—" : `${state.balanceSol} SOL`;
  document.querySelector("#word").textContent = `${state.wordIndex + 1} / ${state.wordCount}`;
  document.querySelector("#pnl").textContent = `${state.totals.profitSol} SOL aus ${state.totals.dumps} Dumps`;
  document.querySelector("#phase").textContent = phaseText(state.position);
  document.querySelector("#warnings").textContent = [...state.blockers, ...state.warnings].join(" ");
  document.querySelector("#log").innerHTML = state.log.map((entry) => `<li><code>${entry.at.slice(11, 19)}</code> ${escapeText(entry.message)}</li>`).join("");
  const wallets = await api("/api/wallets");
  document.querySelector("#wallets").innerHTML = wallets.wallets.map((wallet) => `
    <div class="wallet">
      <div><code>${wallet.publicKey}</code><div class="muted">${wallet.role} · ${wallet.launched ? "deployed" : "frisch"}</div></div>
      <button type="button" data-id="${wallet.id}">Key zeigen</button>
    </div>`).join("");
}

document.querySelector("#wallets").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const revealed = await api(`/api/wallets/${encodeURIComponent(button.dataset.id)}/reveal`, { method: "POST" });
  button.parentElement.querySelector("code").textContent = `${revealed.publicKey}\n${revealed.secretKey}`;
});

api("/api/state").then(() => {
  showApp();
  refresh();
  setInterval(() => refresh().catch(() => {}), 2000);
}).catch(() => {});
