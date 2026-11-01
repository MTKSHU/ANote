# 界面语言 / Interface languages

ANote 的网页与桌面界面支持简体中文（`zh-CN`）和英文（`en`）。首次打开时按浏览器语言选择，后续优先使用本机保存的偏好。登录页和「设置 → 账号与偏好」都提供语言选择。切换时会保存当前笔记并重新载入界面；保存失败时保留原语言，避免丢失编辑。

语言设置只影响应用界面、控件标签和日期显示。笔记正文、评论、知识库名称及其他用户内容保持原样。语言偏好保存在 `anote:locale`，桌面原生对话框随当前界面语言显示。环境变量 `ANOTE_LOCALE` 可指定桌面启动语言。

## 翻译维护

共享文案层位于 `packages/i18n`。`t(source, values)` 使用中文源文案作为键，在英文资源 `en.mjs` 中查找译文；动态值使用 `{0}`、`{1}` 等占位符，避免把用户内容拼入翻译键。日期格式通过 `getLocale()` 取得当前语言。新增文案应同时补充英文译文，无障碍标签也使用同一套资源。

共享包直接提供 JavaScript 模块及类型声明，不需要额外的编译步骤。翻译检查位于 `validation/tests/i18n.test.mjs`。

## English

The web and desktop interfaces support English and Simplified Chinese. ANote initially uses the browser language, then remembers the language chosen on the sign-in screen or in **Settings → Account and preferences**. A language change saves the open note before reloading the interface. If saving fails, the language stays unchanged.

Note bodies, comments, library names and other user content are not translated. The preference is stored locally as `anote:locale`. Desktop native dialogs follow the interface language; `ANOTE_LOCALE` can set the initial desktop language.

Translations live in `packages/i18n/en.mjs`. Use `t(source, values)` with numbered placeholders for dynamic values and `getLocale()` for date formatting. Keep user-provided text outside translation keys and include accessible labels when adding interface text.
