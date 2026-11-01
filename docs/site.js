const storageKey = "anote-site:locale";
const elements = [...document.querySelectorAll("[data-en]")].map(element => ({ element, zh: element.textContent, en: element.dataset.en }));
const attributes = [...document.querySelectorAll("[data-en-alt],[data-en-aria]")].flatMap(element => [
  ...(element.dataset.enAlt ? [{ element, name: "alt", zh: element.getAttribute("alt"), en: element.dataset.enAlt }] : []),
  ...(element.dataset.enAria ? [{ element, name: "aria-label", zh: element.getAttribute("aria-label"), en: element.dataset.enAria }] : []),
]);
const descriptions = {
  write: { zh: "文字、表格、代码和可视化，共同表达一个想法。", en: "Text, tables, code and visual content give an idea the right form." },
  team: { zh: "知识库、目录和评论，把分散的记录放在同一个语境里。", en: "Libraries, folders and comments bring scattered notes into a shared context." },
  ai: { zh: "让兼容的 AI 工具在授权范围内检索、阅读和准备修改。", en: "Compatible AI tools can search, read and prepare edits within your permissions." },
  local: { zh: "个人笔记保存在自己的设备上，也能在离线时继续使用。", en: "Personal notes stay on your device and remain available offline." },
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
  document.title = next === "zh" ? "ANote · 把知识连起来" : "ANote · Connected knowledge";
  document.querySelector('meta[name="description"]').content = next === "zh" ? "ANote：面向个人和团队的开源笔记与知识管理应用。富文本、实时协作、离线使用、Markdown 同步与 MCP。" : "ANote is an open-source, self-hosted notes and knowledge workspace with rich text, collaboration, offline use, Markdown sync and MCP.";
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
