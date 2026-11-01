import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useRef, useState } from "react";
import { newId } from "@anote/document-model/id";
type Kind = "experiments" | "meetings";
const statusNames: Record<string, string> = {
  planned: translateUI("待开始"),
  running: translateUI("进行中"),
  complete: translateUI("已完成"),
  failed: translateUI("失败"),
  held: translateUI("已举行"),
  cancelled: translateUI("已取消"),
};
async function api(endpoint: string, method = "GET", body?: any) {
  const response = await fetch("/api/" + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || value.message || translateUI("请求失败")), {
      status: response.status,
    });
  return value;
}
export function TeamRecords({
  kind,
  space,
  editable,
  query,
  onError,
  onOpenNote,
}: {
  kind: Kind;
  space: string;
  editable: boolean;
  query: string;
  onError: (error: unknown) => void;
  onOpenNote: (id: string) => void;
}) {
  const [records, setRecords] = useState<any[]>([]),
    [archived, setArchived] = useState(false),
    [modal, setModal] = useState<any>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [members, setMembers] = useState<any[]>([]),
    [comparing, setComparing] = useState(false),
    [updating, setUpdating] = useState<string[]>([]);
  const generation = useRef(0);
  async function refresh() {
    const version = ++generation.current;
    try {
      const values = await api(
        `${kind}?space_id=${space}&q=${encodeURIComponent(query)}&archived=${archived}`,
      );
      if (generation.current === version) setRecords(values);
    } catch (error) {
      onError(error);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [kind, space, query, archived]);
  useEffect(() => {
    api(`spaces/${space}/members`).then(setMembers).catch(onError);
  }, [space]);
  const selected = records.filter((record) => chosen.includes(record.id));
  return (
    <section className="records-page">
      <div className="home-heading">
        <div>
          <p className="kicker">
            {kind === "experiments"
              ? "EVERY EXPERIMENT, REPRODUCIBLE"
              : "IDEAS BECOME NEXT STEPS"}
          </p>
          <h1>
            {kind === "experiments" ? translateUI("让实验有据可循。") : translateUI("让讨论继续向前。")}
          </h1>
          <p>
            {kind === "experiments"
              ? translateUI("参数、指标与输入输出，共同记录每一次探索。")
              : translateUI("从议程到纪要，再到有负责人的下一步。")}
          </p>
        </div>
        <button
          className="primary"
          disabled={!editable}
          onClick={() => setModal({})}
        >
          {kind === "experiments" ? translateUI("＋ 新建实验") : translateUI("＋ 新建会议")}
        </button>
      </div>
      <div className="resource-filters">
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{translateUI("显示已归档 ")}</label>
        <button onClick={() => void refresh()}>{translateUI("刷新")}</button>
        {kind === "experiments" && (
          <button
            disabled={selected.length < 2}
            onClick={() => setComparing(true)}
          >{translateUI("对比 ")}{selected.length}{translateUI(" 个实验 ")}</button>
        )}
        <span>{records.length}{translateUI(" 条记录")}</span>
      </div>
      {records.length ? (
        kind === "experiments" ? (
          <div className="records-table-wrap">
            <table className="records-table">
              <thead>
                <tr>
                  <th>{translateUI("对比")}</th>
                  <th>{translateUI("实验")}</th>
                  <th>{translateUI("模型 / 数据集")}</th>
                  <th>{translateUI("关键指标")}</th>
                  <th>{translateUI("状态")}</th>
                  <th>{translateUI("更新")}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={translateUI("对比 {0}", [record.title])}
                        checked={chosen.includes(record.id)}
                        disabled={
                          !chosen.includes(record.id) && chosen.length >= 8
                        }
                        onChange={(e) =>
                          setChosen(
                            e.target.checked
                              ? [...chosen, record.id]
                              : chosen.filter((id) => id !== record.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="record-title"
                        onClick={() => setModal(record)}
                      >
                        {record.title}
                      </button>
                      <div className="card-tags">
                        {record.tags.map((tag: string) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {record.model || "—"}
                      <small>{record.dataset || translateUI("未填写数据集")}</small>
                    </td>
                    <td>
                      <div className="metric-pills">
                        {Object.entries(record.metrics)
                          .slice(0, 3)
                          .map(([name, value]) => (
                            <span key={name}>
                              {name} <b>{String(value)}</b>
                            </span>
                          ))}
                      </div>
                    </td>
                    <td>
                      <span className={"record-status " + record.status}>
                        {statusNames[record.status]}
                      </span>
                    </td>
                    <td>
                      {new Date(record.updated_at).toLocaleDateString(uiLocale())}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="meeting-grid">
            {records.map((record) => (
              <article className="meeting-card" key={record.id}>
                <div className="meeting-card-heading">
                  <span>
                    {new Date(record.starts_at).toLocaleString(uiLocale(), {
                      month: "short",
                      day: "numeric",
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <small className="record-status">
                    {statusNames[record.status]}
                  </small>
                </div>
                <h3>
                  <button onClick={() => setModal(record)}>
                    {record.title}
                  </button>
                </h3>
                <p>{record.agenda || translateUI("议程待补充")}</p>
                {record.document_id && (
                  <button
                    className="meeting-note"
                    onClick={() => onOpenNote(record.document_id)}
                  >{translateUI("▤ 打开协作纪要 ↗ ")}</button>
                )}
                <div className="meeting-actions">
                  {record.actions.map((action: any) => (
                    <label key={action.id}>
                      <input
                        type="checkbox"
                        aria-label={translateUI("完成 {0}", [action.title])}
                        checked={action.done}
                        disabled={
                          !editable ||
                          record.archived ||
                          updating.includes(record.id)
                        }
                        onChange={async (e) => {
                          const actions = record.actions.map((item: any) =>
                            item.id === action.id
                              ? { ...item, done: e.target.checked }
                              : item,
                          );
                          setRecords((values) =>
                            values.map((value) =>
                              value.id === record.id
                                ? { ...value, actions }
                                : value,
                            ),
                          );
                          setUpdating((values) => [...values, record.id]);
                          try {
                            const saved = await api(
                              `meetings/${record.id}`,
                              "PATCH",
                              {
                                revision: record.revision,
                                actions,
                              },
                            );
                            setRecords((values) =>
                              values.map((value) =>
                                value.id === record.id ? saved : value,
                              ),
                            );
                          } catch (error) {
                            setRecords((values) =>
                              values.map((value) =>
                                value.id === record.id ? record : value,
                              ),
                            );
                            onError(error);
                          } finally {
                            setUpdating((values) =>
                              values.filter((id) => id !== record.id),
                            );
                          }
                        }}
                      />
                      <span className={action.done ? "done" : ""}>
                        {action.title}
                        <small>
                          {members.find(
                            (member) => member.id === action.assignee,
                          )?.name || translateUI("未分配")}
                          {action.due ? " · " + action.due : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <footer>
                  {record.actions.filter((action: any) => action.done).length} /{" "}
                  {record.actions.length}{translateUI(" 行动项完成 · ")}{record.asset_ids.length}{" "}{translateUI("份材料 ")}</footer>
              </article>
            ))}
          </div>
        )
      ) : (
        <div className="empty-notes">
          <span>{kind === "experiments" ? "⌁" : "◷"}</span>
          <h3>{translateUI("还没有匹配的")}{kind === "experiments" ? translateUI("实验") : translateUI("会议")}</h3>
          <p>
            {kind === "experiments"
              ? translateUI("从一组参数和指标开始，留下可以复现的研究记录。")
              : translateUI("安排下一次组会，关联材料并记录讨论结果。")}
          </p>
        </div>
      )}
      {modal && (
        <RecordForm
          key={modal.id || "new"}
          kind={kind}
          space={space}
          record={modal}
          editable={editable}
          members={members}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void refresh();
          }}
          onError={onError}
          onOpenNote={onOpenNote}
        />
      )}
      {comparing && (
        <Comparison records={selected} onClose={() => setComparing(false)} />
      )}
    </section>
  );
}
function Comparison({
  records,
  onClose,
}: {
  records: any[];
  onClose: () => void;
}) {
  const keys = [
    ...new Set<string>(
      records.flatMap((record) => Object.keys(record.metrics)),
    ),
  ];
  return (
    <div className="modal">
      <section
        className="experiment-comparison"
        role="dialog"
        aria-label={translateUI("实验对比")}
      >
        <div className="modal-heading">
          <div>
            <p className="kicker">EXPERIMENT COMPARISON</p>
            <h2>{translateUI("放在一起，看清差异。")}</h2>
          </div>
          <button aria-label={translateUI("关闭实验对比")} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="records-table-wrap">
          <table className="records-table">
            <thead>
              <tr>
                <th>{translateUI("比较项")}</th>
                {records.map((record) => (
                  <th key={record.id}>{record.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>{translateUI("模型")}</th>
                {records.map((record) => (
                  <td key={record.id}>{record.model || "—"}</td>
                ))}
              </tr>
              <tr>
                <th>{translateUI("数据集")}</th>
                {records.map((record) => (
                  <td key={record.id}>{record.dataset || "—"}</td>
                ))}
              </tr>
              {keys.map((key) => (
                <tr key={key}>
                  <th>{key}</th>
                  {records.map((record) => (
                    <td key={record.id} className="comparison-value">
                      {record.metrics[key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th>{translateUI("参数")}</th>
                {records.map((record) => (
                  <td key={record.id}>
                    <pre>{JSON.stringify(record.parameters, null, 2)}</pre>
                  </td>
                ))}
              </tr>
              <tr>
                <th>{translateUI("环境")}</th>
                {records.map((record) => (
                  <td key={record.id}>
                    <pre>{record.environment || "—"}</pre>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p>{translateUI("请结合各指标的定义及数据集判断结果。")}</p>
      </section>
    </div>
  );
}
function localTime(iso?: string) {
  const date = iso ? new Date(iso) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function RecordForm({
  kind,
  space,
  record,
  editable,
  members,
  onClose,
  onSaved,
  onError,
  onOpenNote,
}: {
  kind: Kind;
  space: string;
  record: any;
  editable: boolean;
  members: any[];
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
  onOpenNote: (id: string) => void;
}) {
  const [title, setTitle] = useState<string>(record.title || ""),
    [status, setStatus] = useState<string>(record.status || "planned"),
    [doc, setDoc] = useState<string>(record.document_id || ""),
    [assets, setAssets] = useState<any[]>([]),
    [documents, setDocuments] = useState<any[]>([]),
    [model, setModel] = useState<string>(record.model || ""),
    [dataset, setDataset] = useState<string>(record.dataset || ""),
    [parameters, setParameters] = useState(
      JSON.stringify(record.parameters || {}, null, 2),
    ),
    [metrics, setMetrics] = useState(
      JSON.stringify(record.metrics || {}, null, 2),
    ),
    [environment, setEnvironment] = useState<string>(record.environment || ""),
    [tags, setTags] = useState<string>((record.tags || []).join(", ")),
    [inputs, setInputs] = useState<string[]>(record.input_asset_ids || []),
    [outputs, setOutputs] = useState<string[]>(record.output_asset_ids || []),
    [materials, setMaterials] = useState<string[]>(record.asset_ids || []),
    [starts, setStarts] = useState(localTime(record.starts_at)),
    [agenda, setAgenda] = useState<string>(record.agenda || ""),
    [actions, setActions] = useState<any[]>(record.actions || []),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const disabled = !editable || busy;
  useEffect(() => {
    Promise.all([
      api(`assets?space_id=${space}`),
      api(`documents?space_id=${space}`),
    ])
      .then(async ([a, d]) => {
        const references = [
          ...new Set<string>([
            ...(record.asset_ids || []),
            ...(record.input_asset_ids || []),
            ...(record.output_asset_ids || []),
          ]),
        ];
        const missing = await Promise.all(
          references
            .filter((id) => !a.some((asset: any) => asset.id === id))
            .map((id) => api("assets/" + id)),
        );
        if (
          record.document_id &&
          !d.some((document: any) => document.id === record.document_id)
        )
          d.push(await api("documents/" + record.document_id));
        setAssets([...a, ...missing]);
        setDocuments(d);
      })
      .catch(onError);
  }, [space]);
  function updateAction(index: number, value: any) {
    setActions(
      actions.map((action, i) =>
        i === index ? { ...action, ...value } : action,
      ),
    );
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const value =
        kind === "experiments"
          ? {
              model,
              dataset,
              parameters: JSON.parse(parameters),
              metrics: JSON.parse(metrics),
              environment,
              tags: tags
                .split(/[,，]/)
                .map((v) => v.trim())
                .filter(Boolean),
              input_asset_ids: inputs,
              output_asset_ids: outputs,
            }
          : {
              starts_at: new Date(starts).toISOString(),
              agenda,
              actions,
              asset_ids: materials,
            };
      await api(
        kind + (record.id ? "/" + record.id : ""),
        record.id ? "PATCH" : "POST",
        {
          space_id: space,
          revision: record.revision,
          title,
          status,
          document_id: doc || null,
          ...value,
        },
      );
      onSaved();
    } catch (error) {
      setError(
        translateUI(error instanceof SyntaxError
          ? translateUI("参数或指标不是有效的 JSON，请检查后保存。")
          : (error as Error).message),
      );
      if ((error as any).status === 401) onError(error);
    } finally {
      setBusy(false);
    }
  }
  const selectAssets = (
    label: string,
    values: string[],
    set: (values: string[]) => void,
  ) => (
    <label>
      {label}
      <select
        multiple
        aria-label={label}
        size={5}
        disabled={disabled}
        value={values}
        onChange={(e) =>
          set([...e.target.selectedOptions].map((option) => option.value))
        }
      >
        {assets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.title} · {asset.kind}
          </option>
        ))}
      </select>
      <small>{translateUI("按 Ctrl / Command 可多选")}</small>
    </label>
  );
  return (
    <div className="modal">
      <form
        className="record-form"
        role="dialog"
        aria-label={kind === "experiments" ? translateUI("实验记录") : translateUI("会议记录")}
        onSubmit={save}
      >
        <div className="modal-heading">
          <div>
            <p className="kicker">
              {kind === "experiments" ? "RESEARCH LOG" : "TEAM MEETING"}
            </p>
            <h2>
              {record.id ? translateUI("整理") : translateUI("新建")}
              {kind === "experiments" ? translateUI("实验记录") : translateUI("会议记录")}
            </h2>
          </div>
          <button type="button" aria-label={translateUI("关闭记录")} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="record-form-scroll">
          <div className="record-form-grid">
            <label>{translateUI("标题 ")}<input
                aria-label={translateUI("记录标题")}
                value={title}
                maxLength={200}
                required
                disabled={disabled}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>{translateUI("状态 ")}<select
                aria-label={translateUI("记录状态")}
                value={status}
                disabled={disabled}
                onChange={(e) => setStatus(e.target.value)}
              >
                {(kind === "experiments"
                  ? ["planned", "running", "complete", "failed"]
                  : ["planned", "held", "cancelled"]
                ).map((value) => (
                  <option key={value} value={value}>
                    {statusNames[value]}
                  </option>
                ))}
              </select>
            </label>
            {kind === "experiments" ? (
              <>
                <label>{translateUI("模型 ")}<input
                    aria-label={translateUI("实验模型")}
                    value={model}
                    maxLength={300}
                    disabled={disabled}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </label>
                <label>{translateUI("数据集 ")}<input
                    aria-label={translateUI("实验数据集")}
                    value={dataset}
                    maxLength={300}
                    disabled={disabled}
                    onChange={(e) => setDataset(e.target.value)}
                  />
                </label>
                <label>{translateUI("参数 JSON ")}<textarea
                    aria-label={translateUI("实验参数")}
                    rows={7}
                    value={parameters}
                    disabled={disabled}
                    onChange={(e) => setParameters(e.target.value)}
                  />
                </label>
                <label>{translateUI("指标 JSON ")}<textarea
                    aria-label={translateUI("实验指标")}
                    rows={7}
                    value={metrics}
                    disabled={disabled}
                    onChange={(e) => setMetrics(e.target.value)}
                  />
                </label>
                <label>{translateUI("运行环境 ")}<textarea
                    aria-label={translateUI("运行环境")}
                    rows={4}
                    value={environment}
                    maxLength={12000}
                    disabled={disabled}
                    onChange={(e) => setEnvironment(e.target.value)}
                    placeholder={translateUI("GPU、驱动、容器镜像、代码版本与运行命令…")}
                  />
                </label>
                <label>{translateUI("标签 ")}<input
                    aria-label={translateUI("实验标签")}
                    value={tags}
                    disabled={disabled}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </label>
                {selectAssets(translateUI("输入素材"), inputs, setInputs)}
                {selectAssets(translateUI("输出结果"), outputs, setOutputs)}
              </>
            ) : (
              <>
                <label>{translateUI("会议时间 ")}<input
                    aria-label={translateUI("会议时间")}
                    type="datetime-local"
                    value={starts}
                    required
                    disabled={disabled}
                    onChange={(e) => setStarts(e.target.value)}
                  />
                </label>
                <label className="record-span">{translateUI("议程 ")}<textarea
                    aria-label={translateUI("会议议程")}
                    rows={5}
                    maxLength={30000}
                    value={agenda}
                    disabled={disabled}
                    onChange={(e) => setAgenda(e.target.value)}
                  />
                </label>
                {selectAssets(translateUI("会议材料"), materials, setMaterials)}
              </>
            )}
            <label>{translateUI("关联")}{kind === "meetings" ? translateUI("协作纪要") : translateUI("研究笔记")}
              <select
                aria-label={translateUI("关联笔记")}
                value={doc}
                disabled={disabled}
                onChange={(e) => setDoc(e.target.value)}
              >
                <option value="">{translateUI("暂不关联")}</option>
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="record-note-actions">
              <button
                type="button"
                disabled={disabled || !!doc}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const document = await api("documents", "POST", {
                      space_id: space,
                      title:
                        (title || translateUI("未命名")) +
                        (kind === "meetings" ? translateUI(" · 会议纪要") : translateUI(" · 实验笔记")),
                    });
                    setDocuments([...documents, document]);
                    setDoc(document.id);
                  } catch (error) {
                    setError(translateUI((error as Error).message));
                  } finally {
                    setBusy(false);
                  }
                }}
              >{translateUI("新建")}{kind === "meetings" ? translateUI("协作纪要") : translateUI("研究笔记")}
              </button>
              <button
                type="button"
                disabled={!doc}
                onClick={() => {
                  window.open(
                    "/?doc=" + encodeURIComponent(doc),
                    "_blank",
                    "noopener",
                  );
                }}
              >{translateUI("打开关联笔记 ↗ ")}</button>
            </div>
          </div>
          {kind === "meetings" && (
            <section className="action-editor">
              <div>
                <h3>{translateUI("下一步行动")}</h3>
                <button
                  type="button"
                  disabled={disabled || actions.length >= 100}
                  onClick={() =>
                    setActions([
                      ...actions,
                      {
                        id: newId(),
                        title: "",
                        assignee: null,
                        due: null,
                        done: false,
                      },
                    ])
                  }
                >{translateUI("＋ 添加行动项 ")}</button>
              </div>
              {actions.map((action, index) => (
                <div className="action-editor-row" key={action.id}>
                  <input
                    type="checkbox"
                    aria-label={translateUI("完成行动项 {0}", [(index + 1)])}
                    checked={action.done}
                    disabled={disabled}
                    onChange={(e) =>
                      updateAction(index, { done: e.target.checked })
                    }
                  />
                  <input
                    aria-label={translateUI("行动项 {0}", [(index + 1)])}
                    value={action.title}
                    required
                    maxLength={500}
                    disabled={disabled}
                    placeholder={translateUI("具体要做什么…")}
                    onChange={(e) =>
                      updateAction(index, { title: e.target.value })
                    }
                  />
                  <select
                    aria-label={translateUI("负责人 {0}", [(index + 1)])}
                    value={action.assignee || ""}
                    disabled={disabled}
                    onChange={(e) =>
                      updateAction(index, { assignee: e.target.value || null })
                    }
                  >
                    <option value="">{translateUI("未分配")}</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={translateUI("截止日期 {0}", [(index + 1)])}
                    type="date"
                    value={action.due || ""}
                    disabled={disabled}
                    onChange={(e) =>
                      updateAction(index, { due: e.target.value || null })
                    }
                  />
                  <button
                    type="button"
                    aria-label={translateUI("移除行动项 {0}", [(index + 1)])}
                    disabled={disabled}
                    onClick={() =>
                      setActions(actions.filter((_, i) => i !== index))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          )}
          {error && (
            <div className="record-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="record-form-footer">
          <span>
            {record.id ? translateUI("版本 {0}", [record.revision]) : translateUI("保存在当前知识库")}
          </span>
          {record.id && (
            <button
              type="button"
              disabled={disabled}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`${kind}/${record.id}`, "PATCH", {
                    revision: record.revision,
                    archived: !record.archived,
                  });
                  onSaved();
                } catch (error) {
                  setError(translateUI((error as Error).message));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {record.archived ? translateUI("恢复记录") : translateUI("归档记录")}
            </button>
          )}
          <button type="button" onClick={onClose}>{translateUI("取消 ")}</button>
          <button className="primary" disabled={disabled}>{translateUI("保存记录 ")}</button>
        </footer>
      </form>
    </div>
  );
}
