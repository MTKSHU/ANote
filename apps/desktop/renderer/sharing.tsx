import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useResearchEditor, ResearchEditorContent } from "@anote/editor";
import { schema } from "@anote/document-model";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { request } from "./native";
import { useDialog, DialogClose } from "./dialog";
import { Icon } from "./icons";

export function Sharing({
  id,
  space,
  serverURL,
  onClose,
  onChanged,
}: {
  id: string;
  space: string;
  serverURL: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState<any>(null),
    [members, setMembers] = useState<any[]>([]),
    [error, setError] = useState(""),
    [url, setURL] = useState(""),
    [days, setDays] = useState<number | null>(7),
    [busy, setBusy] = useState(false);
  const dialog = useDialog(onClose, {disabled:busy});
  const currentId = useRef(id); currentId.current = id;
  async function refresh() {
    const next = await request(`documents/${id}/sharing`);
    if (currentId.current !== id) return;
    setValue(next);
    if (next.can_manage && next.space_kind === "team") {
      const people = await request(`documents/${id}/share-candidates`);
      if (currentId.current === id) setMembers(people);
    } else setMembers([]);
  }
  useEffect(() => {
    setValue(null); setMembers([]);
    void refresh().catch((e) => setError(translateUI(e.message)));
  }, [id]);
  async function save(onlyMe = false) {
    setBusy(true);
    try {
      setValue(
        await request(`documents/${id}/sharing`, "PATCH", {
          ...value,
          only_me: onlyMe,
          visibility: onlyMe ? "private" : value.visibility,
        }),
      );
      if (onlyMe) setURL("");
      onChanged();
    } catch (e) {
      setError(translateUI((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const roles = [
    ["viewer", translateUI("只读")],
    ["reviewer", translateUI("可评论")],
    ["editor", translateUI("可编辑")],
  ];
  return (
    <div className="modal">
      <section ref={dialog} className="share-dialog" role="dialog" aria-label={translateUI("分享笔记")}>
        <header>
          <h2>{translateUI("分享笔记")}</h2>
          <DialogClose onClick={onClose} disabled={busy}/>
        </header>
        <div className="dialog-body">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <label>{translateUI("内部链接 ")}<div className="copy-row">
            <input readOnly value={serverURL + "/?doc=" + id} />
            <button
              onClick={() =>
                navigator.clipboard
                  .writeText(serverURL + "/?doc=" + id)
                  .catch(() => setError(translateUI("复制失败，请手动复制")))
              }
            >{translateUI("复制 ")}</button>
          </div>
        </label>
        <p className="muted">{translateUI("内部链接仅限拥有笔记权限的已登录成员。")}</p>
        {value?.can_manage ? (
          <>
            {value.space_kind === "team" ? <>
            <label>{translateUI("可见范围 ")}<select
                aria-label={translateUI("可见范围")}
                value={value.visibility}
                onChange={(e) =>
                  setValue({ ...value, visibility: e.target.value })
                }
              >
                <option value="private">
                  {value.space_kind === "team"
                    ? translateUI("作者、指定成员与团队管理员")
                    : translateUI("仅自己与指定成员")}
                </option>
                <option value="team" disabled={value.space_kind === "personal"}>{translateUI("团队可见（默认可阅读、评论） ")}</option>
              </select>
            </label>
            <h3>{translateUI("指定成员")}</h3>
            {value.collaborators.map((c: any) => (
              <div className="collaborator" key={c.user_id}>
                <span>
                  {members.find((m) => m.id === c.user_id)?.name || c.name}
                </span>
                <select
                  aria-label={translateUI("权限 {0}", [c.user_id])}
                  value={c.role}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      collaborators: value.collaborators.map((v: any) =>
                        v.user_id === c.user_id
                          ? { ...v, role: e.target.value }
                          : v,
                      ),
                    })
                  }
                >
                  {roles.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    setValue({
                      ...value,
                      collaborators: value.collaborators.filter(
                        (v: any) => v.user_id !== c.user_id,
                      ),
                    })
                  }
                >{translateUI("移除 ")}</button>
              </div>
            ))}
            <select
              aria-label={translateUI("邀请成员")}
              value=""
              onChange={(e) => {
                if (e.target.value)
                  setValue({
                    ...value,
                    collaborators: [
                      ...value.collaborators,
                      { user_id: e.target.value, role: "viewer" },
                    ],
                  });
              }}
            >
              <option value="">{translateUI("选择成员…")}</option>
              {members
                .filter(
                  (m) =>
                    m.id !== value.owner_id &&
                    !value.collaborators.some((c: any) => c.user_id === m.id),
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
            <div className="share-actions">
              <button
                disabled={busy}
                className="primary"
                onClick={() => void save()}
              >{translateUI("保存权限 ")}</button>
              <button disabled={busy} onClick={() => void save(true)}>
                {value.space_kind === "team"
                  ? translateUI("恢复作者与团队管理员可见")
                  : translateUI("恢复仅自己可见")}
              </button>
            </div>
            <p className="muted">{translateUI("恢复仅自己可见会移除指定成员，并撤销所有外链。 ")}</p>
            </> : <>
              <p className="muted">{translateUI("个人笔记默认仅自己可见，可以生成只读外部链接。")}</p>
              {value.collaborators.length > 0 && <p className="muted">{translateUI("此笔记已有 ")}{value.collaborators.length}{translateUI(" 项协作授权，可恢复仅自己可见以关闭授权与外链。")}</p>}
              <button disabled={busy} onClick={() => void save(true)}>{translateUI("恢复仅自己可见")}</button>
            </>}
            <hr />
            <h3>{translateUI("只读外部链接")}</h3>
            <p>{translateUI("持有链接的人可阅读正文及其中的附件。评论和历史版本不公开。")}</p>
            <div className="copy-row">
              <select
                aria-label={translateUI("外链有效期")}
                value={days ?? "permanent"}
                onChange={(e) => setDays(e.target.value === "permanent" ? null : Number(e.target.value))}
              >
                {[1, 7, 30].map((v) => (
                  <option key={v} value={v}>
                    {v}{translateUI(" 天有效 ")}</option>
                ))}
                <option value="permanent">{translateUI("永久有效")}</option>
              </select>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const link = await request(
                      `documents/${id}/sharing/links`,
                      "POST",
                      { days },
                    );
                    setURL(link.url || serverURL + link.path);
                    await refresh();
                    onChanged();
                  } catch (e) {
                    setError(translateUI((e as Error).message));
                  } finally {
                    setBusy(false);
                  }
                }}
              >{translateUI("生成外链 ")}</button>
            </div>
            {url && (
              <label>{translateUI("请复制保存新链接 ")}<div className="copy-row">
                  <input aria-label={translateUI("外部链接")} readOnly value={url} />
                  <button
                    onClick={() =>
                      navigator.clipboard
                        .writeText(url)
                        .catch(() => setError(translateUI("复制失败，请手动复制")))
                    }
                  >{translateUI("复制外链 ")}</button>
                </div>
              </label>
            )}
            {value.links.map((l: any) => (
              <div className="collaborator" key={l.id}>
                <small>{l.expires_at === null ? translateUI("永久有效") : translateUI("{0} 到期", [new Date(l.expires_at).toLocaleString(uiLocale())])}</small>
                <button
                  onClick={async () => {
                    try {
                      await request(
                        `documents/${id}/sharing/links/${l.id}`,
                        "DELETE",
                      );
                      setURL("");
                      await refresh();
                      onChanged();
                    } catch (e) {
                      setError(translateUI((e as Error).message));
                    }
                  }}
                >{translateUI("撤销 ")}</button>
              </div>
            ))}
          </>
        ) : (
          value && <p>{translateUI("当前笔记由所有者管理共享权限。")}</p>
        )}
        </div>
      </section>
    </div>
  );
}
export function ReadOnlyNote({ snapshot }: { snapshot: any }) {
  const doc = useMemo(
    () => prosemirrorJSONToYDoc(schema, snapshot, "default"),
    [snapshot],
  );
  useEffect(() => () => doc.destroy(), [doc]);
  const editor = useResearchEditor({
    document: doc,
    user: { id: "public", name: translateUI("访客") },
    editable: false,
  });
  return <ResearchEditorContent editor={editor} />;
}
export function PublicNote({ token }: { token: string }) {
  const [siteName,setSiteName] = useState("ANote");
  useEffect(() => {let live=true;void request("platform/public").then(config=>{if(live)setSiteName(config.site_name || "ANote");}).catch(()=>{});return()=>{live=false;};},[]);
  const [note, setNote] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const n = await request(`public/notes/${encodeURIComponent(token)}`);
        if (live) {
          setNote((v: any) =>
            JSON.stringify(v) === JSON.stringify(n) ? v : n,
          );
          setError("");
        }
      } catch (e) {
        if (live) {
          setNote(null);
          setError(translateUI((e as Error).message));
        }
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [token]);
  return (
    <main className="public-note">
      <header className="public-banner"><a className="public-home" href="/" title={translateUI("返回首页")} aria-label={translateUI("{0}首页", [siteName])}><span><Icon name="book" size={24}/></span><strong>{siteName}</strong></a><span>{translateUI("只读分享")}</span></header>
      {note ? (
        <>
          <h1>{note.title}</h1>
          <ReadOnlyNote snapshot={note.snapshot} />
        </>
      ) : (
        <p role="status">{error || translateUI("正在打开笔记…")}</p>
      )}
    </main>
  );
}
