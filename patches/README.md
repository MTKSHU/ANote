# 固定依赖的运行时补丁

`y-tiptap-position-lookup.mjs` 加速 `@tiptap/y-tiptap` **3.0.10** 的 `findMovedPosition`：用不可变节点的 occurrence 索引替代每个字符反复执行 `resolve`／`nodeAt`，保留上游候选顺序、唯一节点身份判断和位置迁移结果，不关闭评论锚点或撤销迁移。

`npm run build:packages` 会先执行 `scripts/apply-y-tiptap-performance-patch.mjs`。脚本只接受 manifest 固定的上游完整 SHA，分别修改 ESM 和 CommonJS，并核验补丁后 SHA；重复运行会检查精确嵌入的 helper。`--check` 仅验证补丁已生效。遵循项目约束，在 Docker 内执行这些构建与检查。

上游 `src/` 保留为比较参考；实际运行的 `dist/index.js` 和 `dist/index.cjs` 由脚本加补丁。脚本移除已失效的原始 `sourceMappingURL`，应用构建器从补丁后的源码生成自己的映射。API、网页、桌面、worker 和验证镜像的构建都必须包含相同脚本、factory 与 manifest，不能只复制已编译应用而遗漏依赖补丁。

升级或替换上游版本时，应重新审查并移除或更新该补丁，不能跳过 hash 检查。`validation/tests/y-position-lookup.test.mjs` 比较所有 UTF-16 位置的上游候选（包括中文、代理对、组合字符、重复节点、空节点及有子内容的原子节点）；`y-performance-patch.test.mjs` 检查双格式、幂等与未知改动拒绝。最终还需使用真实协作、评论、结构编辑、撤销及打包程序回归确认。
