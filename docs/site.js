const storageKey = "anote-site:locale";
const elements = [...document.querySelectorAll("[data-en]")].map(element => ({ element, zh: element.textContent, en: element.dataset.en }));
const attributes = [...document.querySelectorAll("[data-en-alt],[data-en-aria]")].flatMap(element => [
  ...(element.dataset.enAlt ? [{ element, name: "alt", zh: element.getAttribute("alt"), en: element.dataset.enAlt }] : []),
  ...(element.dataset.enAria ? [{ element, name: "aria-label", zh: element.getAttribute("aria-label"), en: element.dataset.enAria }] : []),
]);
const descriptions = {
  write: { zh: "文字、表格、代码和可视化，共同表达一个想法。", en: "Text, tables, code and visual content give an idea the right form." },
  team: { zh: "知识库、目录和评论，把分散的记录放在同一个语境里。", en: "Libraries, folders and comments bring scattered notes into a shared context." },
  ai: { zh: "本地 MCP 连接个人目录；远程 MCP 按服务器授权检索、阅读和准备修改。", en: "Local MCP connects to your personal folder; remote MCP searches, reads and prepares edits within server permissions." },
  local: { zh: "个人 App 无需账号或服务器，笔记和附件保存在自选目录；也可开启本地 MCP。", en: "The personal app needs no account or server. Notes and attachments stay in your folder; local MCP is available too." },
};
let language = "zh";
let branch = "write";
let copyTimer;
const languageButton = document.getElementById("language-toggle");
const range = document.getElementById("comparison-range");
const comparison = document.getElementById("comparison");
const copyButton = document.getElementById("copy-clone");
function initialLanguage() {
  try {
    const requested = new URL(location.href).searchParams.get("lang");
    if (requested === "en" || requested === "zh") return requested;
    const saved = localStorage.getItem(storageKey);
    if (saved === "en" || saved === "zh") return saved;
  } catch {}
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
function renderMap() {
  document.querySelectorAll("[data-branch]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.branch === branch)));
  document.getElementById("map-description").textContent = descriptions[branch][language];
}
function updateComparison() {
  const value = Math.min(100, Math.max(0, Number(range.value)));
  comparison.style.setProperty("--split", `${value}%`);
  range.setAttribute("aria-valuetext", language === "en" ? `${value}% after, ${100 - value}% original` : `${value}% 处理后，${100 - value}% 原图`);
}
function setLanguage(next) {
  language = next;
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  elements.forEach(({ element, zh, en }) => { element.textContent = next === "zh" ? zh : en; });
  attributes.forEach(({ element, name, zh, en }) => { element.setAttribute(name, next === "zh" ? zh : en); });
  languageButton.textContent = next === "zh" ? "EN" : "中文";
  languageButton.setAttribute("aria-label", next === "zh" ? "Switch to English" : "切换为简体中文");
  document.title = next === "zh" ? "ANote · 本地个人笔记与团队协作" : "ANote · Local notes & team collaboration";
  document.querySelector('meta[name="description"]').content = next === "zh" ? "ANote：无需账号或服务器的本地个人笔记 App，也可自托管为团队协作平台。支持富文本、笔记链接、全景媒体、Markdown/PDF 导出与本地/远程 MCP。" : "ANote is a standalone personal notes app with no account or server required, and a self-hosted team platform with collaboration, offline copies, Markdown/PDF export and local or remote MCP.";
  document.querySelector('meta[property="og:title"]').content = document.title;
  document.querySelector('meta[property="og:description"]').content = document.querySelector('meta[name="description"]').content;
  try { localStorage.setItem(storageKey, next); } catch {}
  clearTimeout(copyTimer);
  copyButton.textContent = next === "zh" ? "复制" : "Copy";
  renderMap();
  updateComparison();
}
languageButton.addEventListener("click", () => setLanguage(language === "zh" ? "en" : "zh"));
range.addEventListener("input", updateComparison);
document.querySelectorAll("[data-branch]").forEach(button => button.addEventListener("click", () => { branch = button.dataset.branch; renderMap(); }));
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("clone-command").textContent);
    copyButton.textContent = language === "zh" ? "已复制" : "Copied";
  } catch {
    copyButton.textContent = language === "zh" ? "请手动复制" : "Copy manually";
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyButton.textContent = language === "zh" ? "复制" : "Copy"; }, 2200);
});
if ("IntersectionObserver" in window) {
  const links = [...document.querySelectorAll('.contents > a[href^="#"]')];
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      links.forEach(link => {
        const active = link.getAttribute("href") === `#${entry.target.id}`;
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "location"); else link.removeAttribute("aria-current");
      });
    }
  }, { rootMargin: "-10% 0px -65% 0px", threshold: 0 });
  document.querySelectorAll(".chapter").forEach(section => observer.observe(section));
}
setLanguage(initialLanguage());
